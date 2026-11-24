// Submission helper (agent 6 in docs/ARCHITECTURE.md).
//
// Prepares, and never sends, the text a person pastes into:
// - App Store Connect: TestFlight "What to Test" and App Review notes.
// - Google Connected Console: an Android MCP connected app for Gemini testers.
// - MCP hosts: a connector listing.
//
// This module has no network code on purpose. It turns a valid manifest into files; a person
// reviews them and submits by hand. Field names on the store consoles are drafts: only the
// limits marked "checked" below were read on Apple's own pages.

import type { Action, Manifest } from "../../manifest.js";
import { kotlinNames, adbExecute } from "../../generators/kotlin.js";
import type { GeneratedFile } from "../../generators/types.js";
import { lines } from "../../generators/types.js";
import { camelCase } from "../../naming.js";
import { actionAuth, androidRule, isEnabledFor, mcpConfirmation, needsConfirmation, SAFETY } from "../../safety.js";

export type SubmitPlatform = "ios" | "android" | "mcp";
export const SUBMIT_PLATFORMS: SubmitPlatform[] = ["ios", "android", "mcp"];

export interface SubmitOptions {
  platforms?: SubmitPlatform[];
  /** ISO date stamped into the drafts; defaults to today. */
  date?: string;
}

export interface SubmitWarning {
  platform: SubmitPlatform | "all";
  message: string;
}

export interface SubmissionBundle {
  files: GeneratedFile[];
  warnings: SubmitWarning[];
}

/** Limits on App Store Connect fields. */
export const APPLE_LIMITS = {
  /** "The Notes field can contain up to 4000 bytes." Checked on 2026-11-24 at the URL below. */
  reviewNotesBytes: 4000,
  reviewNotesSource: "https://developer.apple.com/help/app-store-connect/reference/platform-version-information",
  /** TestFlight "What to Test". 4,000 characters is the commonly cited limit; not confirmed on Apple's page. */
  whatToTestChars: 4000,
} as const;

const AUTH_TEXT = {
  none: "no sign-in needed",
  authenticated: "works only while the device is unlocked",
  "local-device": "asks for Face ID, Touch ID or the passcode",
} as const;

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function placeholder(value: string | undefined, name: string): string {
  return value && value.trim() ? value : `<${name}>`;
}

function isPlaceholderUrl(url: string | undefined): boolean {
  return !url || /^<.*>$/.test(url) || /localhost|127\.0\.0\.1|example\.(com|org)/.test(url);
}

function firstUtterance(action: Action): string {
  return action.examples[0]?.utterance ?? action.title;
}

/** One-line summary of what an action needs from the person, from the safety table. */
function guardText(manifest: Manifest, action: Action): string {
  const parts: string[] = [];
  if (needsConfirmation(action)) parts.push("asks for confirmation first");
  const auth = actionAuth(manifest, action);
  if (auth !== "none") parts.push(AUTH_TEXT[auth]);
  return parts.length ? parts.join("; ") : "runs without a prompt";
}

// ---------------------------------------------------------------------------------------------
// Apple
// ---------------------------------------------------------------------------------------------

function whatToTest(manifest: Manifest, actions: Action[]): string {
  return lines([
    `Please try ${manifest.app.name} with Siri.`,
    "",
    "Before you start: this build uses the Siri AI Developer Preview. It works only on an Apple Intelligence device in a supported region, with Siri AI turned on. When the app is in the background, mention the app's name in your request.",
    "",
    "Try these requests:",
    ...actions.map((a) => `- "${firstUtterance(a)}" (${a.title}: ${guardText(manifest, a)})`),
    "",
    "Please report:",
    "- requests Siri did not understand or sent to the wrong action,",
    "- any action that ran without asking when it should have asked,",
    "- anything Siri said that showed data it should not have.",
  ]).trimEnd();
}

function confirmTitles(actions: Action[]): string | null {
  const titles = actions.filter(needsConfirmation).map((a) => a.title);
  if (!titles.length) return null;
  return `${titles.join(", ")} ${titles.length === 1 ? "asks" : "ask"} for confirmation before ${titles.length === 1 ? "it runs" : "they run"}.`;
}

function reviewNotes(manifest: Manifest, actions: Action[]): string {
  return lines([
    `${manifest.app.name} declares ${actions.length} App Intents for Siri and Shortcuts:`,
    ...actions.map((a) => `- ${a.title}: ${a.description} (${guardText(manifest, a)})`),
    "",
    "How to try them: open the Shortcuts app, search for the app's name, and run any action.",
    confirmTitles(actions),
    "",
    "Sign-in for review: <demo account username and password, or 'no account needed'>",
  ]).trimEnd();
}

function appleFiles(manifest: Manifest, date: string, warnings: SubmitWarning[]): GeneratedFile[] {
  const actions = manifest.actions.filter((a) => isEnabledFor(a, "ios"));
  if (!manifest.app.ios?.bundleId) warnings.push({ platform: "ios", message: "app.ios.bundleId is not set: App Store Connect needs the exact bundle ID." });
  const wtt = whatToTest(manifest, actions);
  const notes = reviewNotes(manifest, actions);
  if (wtt.length > APPLE_LIMITS.whatToTestChars) {
    warnings.push({ platform: "ios", message: `"What to Test" is ${wtt.length} characters; TestFlight is believed to allow ${APPLE_LIMITS.whatToTestChars}. Shorten it.` });
  }
  if (bytes(notes) > APPLE_LIMITS.reviewNotesBytes) {
    warnings.push({ platform: "ios", message: `App Review notes are ${bytes(notes)} bytes; Apple allows ${APPLE_LIMITS.reviewNotesBytes}. Shorten them.` });
  }
  return [
    {
      path: "apple/testflight-what-to-test.txt",
      content: `${wtt}\n`,
    },
    {
      path: "apple/app-review-notes.txt",
      content: `${notes}\n`,
    },
    {
      path: "apple/README.md",
      content: lines([
        `# App Store Connect drafts for ${manifest.app.name}`,
        "",
        `Prepared by \`omnintent submit-prep\` on ${date}. Nothing was uploaded or submitted.`,
        "",
        `- Bundle ID: \`${placeholder(manifest.app.ios?.bundleId, "bundle ID")}\``,
        `- Version: \`${placeholder(manifest.app.version, "version")}\``,
        `- Actions exposed to Siri: ${actions.map((a) => `\`${a.name}\``).join(", ") || "none"}`,
        "",
        "## Before you paste anything",
        "",
        "- **Siri AI Developer Preview features reach internal testers only.** Apple's page says the preview works in development builds and internal TestFlight builds, not for external testers or App Store builds. Add this build to an *internal* testing group. Do not ask external testers, or App Review, to test Siri AI behaviour.",
        "- Use `testflight-what-to-test.txt` for the internal group's \"What to Test\" text. Its length is " +
          `${wtt.length} characters (the commonly cited limit is ${APPLE_LIMITS.whatToTestChars}; not confirmed on Apple's page).`,
        `- Use \`app-review-notes.txt\` in App Review Information > Notes. It is ${bytes(notes)} bytes; Apple's limit is ${APPLE_LIMITS.reviewNotesBytes} bytes ([source](${APPLE_LIMITS.reviewNotesSource}), checked 2026-11-24). Replace the sign-in placeholder.`,
        "- Do not mention Siri AI preview features in \"What's New\" for an App Store release: customers cannot use them yet.",
        "- Adding tool intents makes the app's App Shortcuts unavailable to Siri (they stay in Spotlight and the Action button). Check that nothing in your App Store text promises a Siri phrase that no longer works.",
        "",
        "## Checklist (a person does these)",
        "",
        "- [ ] The build was made with the Xcode and SDK the Siri AI Developer Preview needs.",
        "- [ ] Every action was tried on a device, including the confirmation prompts.",
        "- [ ] The build is in an internal TestFlight group only.",
        "- [ ] The review notes' sign-in line is filled in.",
        "- [ ] You submitted it yourself in App Store Connect.",
      ]),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Android / Google Connected Console
// ---------------------------------------------------------------------------------------------

function androidReason(action: Action): string {
  const rule = androidRule(action);
  if (rule === "never") return `${action.safety} actions are never exposed on Android`;
  if (rule === "opt-in") return "needs confirmation, which AppFunctions cannot ask for; opt in with platforms.android.enabled after adding an in-app confirmation";
  return "disabled in the manifest (platforms.android.enabled: false)";
}

function androidFiles(manifest: Manifest, date: string, warnings: SubmitWarning[]): GeneratedFile[] {
  const names = kotlinNames(manifest);
  const exposed = manifest.actions.filter((a) => isEnabledFor(a, "android"));
  const hidden = manifest.actions.filter((a) => !isEnabledFor(a, "android"));
  if (!manifest.app.android?.packageName) {
    warnings.push({ platform: "android", message: `app.android.packageName is not set; the drafts use ${names.packageName}, which is probably not your real package.` });
  }
  if (!exposed.length) warnings.push({ platform: "android", message: "No actions are exposed on Android, so there is nothing for Gemini testers to try." });

  const entry = lines([
    `# Google Connected Console draft: ${manifest.app.name}`,
    "",
    `Prepared by \`omnintent submit-prep\` on ${date}. Nothing was sent to Google.`,
    "",
    "Google's AppFunctions overview says Gemini integration needs the Connected Apps Platform developer preview, and that testers use an \"Android MCP connected app\" in Google Connected Console. The console's exact form fields were **not** seen when this was written, so the headings below are the facts you will most likely need, not the console's field names.",
    "",
    "## App",
    "",
    `- App name: ${manifest.app.name}`,
    `- Package name: \`${names.packageName}\``,
    `- Description: ${manifest.app.description}`,
    `- Minimum Android version: Android 16 (API 36) for AppFunctions`,
    "",
    "## AppFunctions exposed",
    "",
    "| Function ID | What it does | Safety |",
    "| --- | --- | --- |",
    ...exposed.map((a) => `| \`${names.servicePackage}.${names.baseClass}#${camelCase(a.name)}\` | ${a.description.replace(/\|/g, "\\|")} | ${a.safety} |`),
    "",
    ...(hidden.length
      ? ["## Not exposed on Android", "", ...hidden.map((a) => `- \`${a.name}\`: ${androidReason(a)}.`), ""]
      : []),
    "## Testers",
    "",
    "List the Google accounts of your testers in the console. They are not stored in this repository on purpose.",
    "",
    "- `<tester Google account>`",
    "",
    "## Check on a device before you submit",
    "",
    "```sh",
    `adb shell cmd app_function list-app-functions --package ${names.packageName}`,
    ...exposed.map((a) => adbExecute(manifest, names, a)),
    "```",
    "",
    "## Checklist (a person does these)",
    "",
    "- [ ] Built against `androidx.appfunctions` 1.0.0 with the KSP compiler, and the function list above matches `list-app-functions`.",
    "- [ ] Every function was run with `adb` on a device.",
    "- [ ] The app follows Google's AppFunctions quality guidelines (no destructive actions without a confirmation step, no passwords or financial data).",
    "- [ ] Testers were added, and you created the connected app yourself in Google Connected Console.",
  ]);
  return [{ path: "android/connected-console.md", content: entry }];
}

// ---------------------------------------------------------------------------------------------
// MCP hosts
// ---------------------------------------------------------------------------------------------

/** What Omnintent knows about each host's connector flow, with how well it is sourced. */
const MCP_HOSTS: { name: string; status: string; notes: string }[] = [
  {
    name: "Claude",
    status: "not verified first-hand",
    notes: "Remote MCP servers are added as custom connectors by URL. Check Anthropic's current connector directory requirements before submitting a listing.",
  },
  {
    name: "ChatGPT",
    status: "not verified (the help article could not be fetched)",
    notes: "Developer mode and MCP apps exist according to search results. Read OpenAI's help article before submitting.",
  },
  {
    name: "Gemini (Spark / connected apps)",
    status: "third-party source (Flowith, August 2026)",
    notes: "Users add a custom MCP server URL in the Gemini web app; write actions from custom apps need manual confirmation.",
  },
  {
    name: "Meta Muse",
    status: "third-party source (parallel.ai, about September 2026)",
    notes: "The Muse app connects to remote Streamable HTTP servers and asks whether the server needs an API key or header. Muse Code supports OAuth 2.1 login.",
  },
];

function mcpFiles(manifest: Manifest, date: string, warnings: SubmitWarning[]): GeneratedFile[] {
  const tools = manifest.actions.filter((a) => isEnabledFor(a, "mcp"));
  if (isPlaceholderUrl(manifest.backend?.baseUrl)) {
    warnings.push({ platform: "mcp", message: `backend.baseUrl is "${manifest.backend?.baseUrl ?? "(unset)"}": point it at your production backend before you list the server.` });
  }
  warnings.push({
    platform: "mcp",
    message: "The generated server uses one shared bearer token, not OAuth. Hosts and directories that require OAuth will not accept it yet (see docs/LIMITATIONS.md).",
  });

  const privateFields = Object.entries(manifest.entities ?? {}).flatMap(([name, e]) =>
    Object.entries(e.properties)
      .filter(([, p]) => p.visibility === "internal" || p.privacy === "sensitive")
      .map(([prop, p]) => `\`${name}.${prop}\` (${p.visibility === "internal" ? "never returned" : "sensitive"})`),
  );

  const listing = lines([
    `# MCP connector listing draft: ${manifest.app.name}`,
    "",
    `Prepared by \`omnintent submit-prep\` on ${date}. Nothing was sent to any host or directory.`,
    "",
    "## Listing text",
    "",
    `- Name: ${manifest.app.name}`,
    `- Short description: ${manifest.app.description}`,
    "- Server URL: `<your deployed Worker URL>/mcp` (fill in after `wrangler deploy`; Omnintent does not choose a domain for you)",
    "- Transport: Streamable HTTP, MCP protocol 2026-07-28, with the stateless fallback for 2025-era clients",
    "- Authentication: a bearer token (`Authorization: Bearer <token>`) shared with the host. OAuth 2.1 is not generated yet.",
    "",
    ...(manifest.app.instructions ? ["### Long description", "", manifest.app.instructions, ""] : []),
    "## Tools",
    "",
    "| Tool | Title | Read-only | Destructive | Confirmation |",
    "| --- | --- | --- | --- | --- |",
    ...tools.map((a) => {
      const ann = SAFETY[a.safety].mcpAnnotations(a);
      const conf = mcpConfirmation(a);
      const confText = conf === "none" ? "none" : conf === "elicit-required" ? "server asks; refused if the host cannot ask" : "server asks, or the host confirms";
      return `| \`${a.name}\` | ${a.title} | ${ann.readOnlyHint ? "yes" : "no"} | ${ann.destructiveHint ? "yes" : "no"} | ${confText} |`;
    }),
    "",
    "## Data and privacy",
    "",
    "- The server returns only the fields declared in `omnintent.json`.",
    ...(privateFields.length ? [`- Withheld or sensitive fields: ${privateFields.join(", ")}.`] : []),
    "- Privacy policy URL: `<your privacy policy URL>`",
    "- Support contact: `<your support email or URL>`",
    "",
    "## Host notes",
    "",
    "| Host | How well this is sourced | Notes |",
    "| --- | --- | --- |",
    ...MCP_HOSTS.map((h) => `| ${h.name} | ${h.status} | ${h.notes} |`),
    "",
    "## Checklist (a person does these)",
    "",
    "- [ ] The Worker is deployed and `MCP_ACCESS_TOKEN` and `BACKEND_TOKEN` are set as secrets.",
    "- [ ] An MCP client listed the tools above from the deployed URL.",
    "- [ ] Each destructive tool asked for confirmation in the host you are listing on.",
    "- [ ] Privacy policy and support contact are filled in.",
    "- [ ] You submitted the listing yourself.",
  ]);
  return [{ path: "mcp/connector-listing.md", content: listing }];
}

// ---------------------------------------------------------------------------------------------

export function prepareSubmission(manifest: Manifest, options: SubmitOptions = {}): SubmissionBundle {
  const date = (options.date ?? new Date().toISOString()).slice(0, 10);
  const platforms = options.platforms ?? SUBMIT_PLATFORMS;
  const warnings: SubmitWarning[] = [];
  const files: GeneratedFile[] = [];
  if (platforms.includes("ios")) files.push(...appleFiles(manifest, date, warnings));
  if (platforms.includes("android")) files.push(...androidFiles(manifest, date, warnings));
  if (platforms.includes("mcp")) files.push(...mcpFiles(manifest, date, warnings));

  files.unshift({
    path: "README.md",
    content: lines([
      `# Submission drafts for ${manifest.app.name}`,
      "",
      `Prepared by \`omnintent submit-prep\` on ${date}.`,
      "",
      "**Nothing here was sent.** The submission helper only writes drafts. A person reviews them, fills in the `<placeholders>`, and submits each one by hand.",
      "",
      ...files.map((f) => `- \`${f.path}\``),
      "",
      ...(warnings.length ? ["## Warnings", "", ...warnings.map((w) => `- ${w.platform}: ${w.message}`)] : ["No warnings."]),
    ]),
  });
  files.push({
    path: "submission.json",
    content: `${JSON.stringify({ app: manifest.app.slug, preparedOn: date, sent: false, platforms, files: files.map((f) => f.path), warnings }, null, 2)}\n`,
  });
  return { files, warnings };
}

export function parseSubmitPlatforms(value: string): SubmitPlatform[] {
  if (value === "all") return SUBMIT_PLATFORMS;
  const out = value.split(",").map((s) => s.trim()) as SubmitPlatform[];
  const bad = out.filter((p) => !SUBMIT_PLATFORMS.includes(p));
  if (bad.length) throw new Error(`unknown platform(s): ${bad.join(", ")} (use ios, android, mcp or all)`);
  return out;
}
