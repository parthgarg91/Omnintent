// Android adapter. There is no public way to script Gemini, so the plan has
// two parts, following developer.android.com/ai/appfunctions/add-appfunctions
// ("Verify AppFunction integration", November 2026):
//
// 1. run-functions.sh: checks with adb that the platform indexed the
//    functions, then executes each sample's expected call, so the developer
//    sees that the handlers accept model-shaped arguments. Write actions run
//    only with RUN_WRITES=1.
// 2. agent-checklist.md + results.json: the sample utterances to try in the
//    open-source AppFunctions testing agent or Gemini (Connected Apps
//    Platform preview), and a template to record what the agent chose.

import type { Manifest } from "../../manifest.js";
import { camelCase } from "../../naming.js";
import { isEnabledFor } from "../../safety.js";
import { adbExecute, kotlinNames } from "../../generators/kotlin.js";
import { lines, type GeneratedFile } from "../../generators/types.js";
import { exampleCases } from "./cases.js";
import { resultsTemplate } from "./import.js";
import { siriPlan } from "./siri.js";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function androidRunScript(manifest: Manifest): string {
  const names = kotlinNames(manifest);
  const pkg = manifest.app.android?.packageName ?? names.packageName;
  const byName = new Map(manifest.actions.map((a) => [a.name, a]));
  const steps = exampleCases(manifest, "android")
    .filter((c) => c.exposed)
    .flatMap((c): (string | false)[] => {
      const action = byName.get(c.expectedTool)!;
      const write = action.safety !== "read";
      const cmd = adbExecute(manifest, names, action, c.expectedArguments);
      return [
        `# ${c.id}: ${c.utterance.replace(/\n/g, " ")}`,
        write ? 'if [ "$RUN_WRITES" = "1" ]; then' : false,
        `${write ? "  " : ""}run ${shellQuote(c.id)} ${cmd}`,
        write ? `else echo "skip ${c.id} (${action.safety}; set RUN_WRITES=1 to run)"; fi` : false,
        "",
      ];
    });
  return lines([
    "#!/bin/sh",
    `# Checks ${manifest.app.name}'s AppFunctions on a connected device or emulator with adb.`,
    "# Read actions run by default. Write actions change app data, so they run only with RUN_WRITES=1;",
    "# use a test device with fictional data whose IDs match the samples.",
    "# Outputs go to ./results/. A failed call is reported and the script continues.",
    'cd "$(dirname "$0")"',
    "mkdir -p results",
    "failures=0",
    "run() {",
    '  id="$1"; shift',
    '  file="results/$(echo "$id" | tr "#" "_").txt"',
    '  if "$@" > "$file" 2>&1; then echo "ok   $id"; else echo "FAIL $id (see $file)"; failures=$((failures + 1)); fi',
    "}",
    "",
    `adb shell cmd app_function list-app-functions --package ${pkg} > results/app-functions.txt`,
    `for fn in ${manifest.actions.filter((a) => isEnabledFor(a, "android")).map((a) => camelCase(a.name)).join(" ")}; do`,
    '  grep -q "#$fn" results/app-functions.txt || echo "missing: $fn is not listed by list-app-functions"',
    "done",
    "",
    ...steps,
    'echo "$failures failure(s)"',
    '[ "$failures" -eq 0 ]',
  ]);
}

export function androidChecklist(manifest: Manifest): string {
  const names = kotlinNames(manifest);
  const rows = exampleCases(manifest, "android").map((c) => {
    const esc = (s: string) => s.replace(/\|/g, "\\|");
    const expected = c.exposed ? `\`${camelCase(c.expectedTool)}\` ${esc(JSON.stringify(c.expectedArguments))}` : "nothing that changes data (not exposed on Android)";
    return `| ${c.id} | ${esc(c.utterance)} | ${expected} |`;
  });
  return lines([
    `# Android agent checklist: ${manifest.app.name}`,
    "",
    "Try each request in an agent that can call AppFunctions and record what it did in",
    "`results.json` (`chosenTool` and `chosenArguments`; `\"none\"` if it called nothing). Then run",
    "`omnintent agent-test omnintent.json --import android/results.json` to score it.",
    "",
    "Agents to try:",
    "",
    "- The open-source AppFunctions testing agent, installed on the device.",
    "- Gemini, after joining the Connected Apps Platform developer preview and adding yourself as a",
    "  tester of an Android MCP connected app in Google Connected Console.",
    "- Your app's own agent, if it calls `AppFunctionManager`.",
    "",
    `Functions live in \`${names.servicePackage}.${names.baseClass}\`. Actions that need confirmation are`,
    "generated disabled; enable them with `AppFunctionManager.setAppFunctionEnabled` on the test device",
    "first, or expect the agent to say it cannot do them.",
    "",
    "| Case | Request | Expected call |",
    "| --- | --- | --- |",
    ...rows,
  ]);
}

/** Every platform plan the tester agent writes for devices it cannot drive itself. */
export function devicePlans(manifest: Manifest): GeneratedFile[] {
  return [
    ...siriPlan(manifest),
    { path: "siri/results.json", content: `${JSON.stringify(resultsTemplate(manifest, "ios", "Siri"), null, 2)}\n` },
    { path: "android/run-functions.sh", content: androidRunScript(manifest) },
    { path: "android/agent-checklist.md", content: androidChecklist(manifest) },
    { path: "android/results.json", content: `${JSON.stringify(resultsTemplate(manifest, "android", "AppFunctions testing agent"), null, 2)}\n` },
  ];
}
