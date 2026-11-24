// Siri adapter: writes a Swift Testing file for Apple's SiriEvaluations
// framework (Xcode 27.3+, UI testing target, physical device). Siri cannot be
// driven from a server, so the tester agent produces the evaluation and the
// developer runs it on a device, then imports the outcome (see import.ts).
//
// API shapes follow developer.apple.com/documentation/sirievaluations as of
// November 2026: IntentDefinitions, SiriScenarioLoader, SiriScenario,
// UserTurn, Calls (.disallowed / .unordered), Finds, Evaluation,
// SiriExpectationEvaluator, SiriService.run(scenario:), .evaluates trait and
// the intentsAllPass metric. Not compiled here (no Xcode).

import type { Action, Manifest, ParameterSchema } from "../../manifest.js";
import { pascalCase, stripIdSuffix, swiftIdent, swiftString } from "../../naming.js";
import { isEnabledFor, needsConfirmation } from "../../safety.js";
import { HEADER, lines, lowerFirst, type GeneratedFile } from "../../generators/types.js";

const intentVar = (a: Action) => `${lowerFirst(pascalCase(a.name))}Intent`;
const entityVar = (name: string) => `${lowerFirst(name)}Entity`;

/** "Add milk to my list" -> "In Todo Example, add milk to my list". Apple recommends naming the app. */
export function siriUtterance(manifest: Manifest, utterance: string): string {
  const u = utterance.trim();
  const keepCase = /^(I\b|I'|[A-Z]{2})/.test(u);
  return `In ${manifest.app.name}, ${keepCase ? u : lowerFirst(u)}`;
}

interface Expectations {
  args: string[];
  finds: string[];
  unchecked: string[];
}

function expectationsFor(action: Action, args: Record<string, unknown>): Expectations {
  const props = action.inputSchema.properties ?? {};
  const out: Expectations = { args: [], finds: [], unchecked: [] };
  for (const [name, value] of Object.entries(args)) {
    const schema: ParameterSchema | undefined = props[name];
    if (!schema) continue;
    const entity = schema["x-omnintent-entity"];
    if (entity) {
      out.finds.push(`${entityVar(entity)}.expect(id: .equals(${swiftString(String(value))}))`);
      continue;
    }
    const label = swiftIdent(name);
    if (schema.type === "string" && !schema.enum && !schema.format && typeof value === "string") {
      out.args.push(`${label}: .equals(${swiftString(value)})`);
    } else if (schema.type === "integer" && typeof value === "number") {
      out.args.push(`${label}: .matches(#Predicate<Int> { $0 == ${value} })`);
    } else if (schema.type === "number" && typeof value === "number") {
      out.args.push(`${label}: .matches(#Predicate<Double> { $0 == ${value} })`);
    } else if (schema.type === "boolean" && typeof value === "boolean") {
      out.args.push(`${label}: .matches(#Predicate<Bool> { $0 == ${value} })`);
    } else {
      out.unchecked.push(`${name} = ${JSON.stringify(value)}`);
    }
  }
  return out;
}

export function siriEvaluationFile(manifest: Manifest): string {
  const actions = manifest.actions.filter((a) => isEnabledFor(a, "ios"));
  const risky = actions.filter((a) => a.safety === "destructive" || a.safety === "payment");
  const entityNames = new Set<string>();
  for (const a of actions) for (const p of Object.values(a.inputSchema.properties ?? {})) if (p["x-omnintent-entity"]) entityNames.add(p["x-omnintent-entity"]);
  const typeName = `${pascalCase(manifest.app.slug)}SiriEvaluation`;
  const bundleId = manifest.app.ios?.bundleId ?? "<YOUR_BUNDLE_ID>";

  const scenarios: string[] = [];
  for (const action of actions) {
    action.examples.forEach((ex, i) => {
      const e = expectationsFor(action, ex.arguments);
      const call = e.args.length ? `${intentVar(action)}\n                    .expect(${e.args.join(", ")})` : intentVar(action);
      const disallowed = risky.filter((r) => r.name !== action.name);
      const block = [
        `            Calls${needsConfirmation(action) ? "(.unordered)" : ""} {`,
        `                ${call}`,
        "            }",
        ...(disallowed.length
          ? ["            // Fails if Siri runs a destructive action, or asks to confirm one, for this request.", "            Calls(.disallowed) {", ...disallowed.map((d) => `                ${intentVar(d)}`), "            }"]
          : []),
      ];
      const finds = e.finds.length ? ["            Finds {", ...e.finds.map((f) => `                ${f}`), "            }"] : [];
      const comment = [`    // ${action.name}#${i}`, ...(e.unchecked.length ? [`    // Not checked by value (check the report): ${e.unchecked.join(", ")}`] : [])];
      if (needsConfirmation(action)) {
        // Siri asks for confirmation first; a call counts only once it runs.
        scenarios.push(
          lines([
            ...comment,
            "    SiriScenario {",
            `        UserTurn(${swiftString(siriUtterance(manifest, ex.utterance))})${finds.length ? " {" : ""}`,
            ...finds,
            finds.length ? "        }" : false,
            '        UserTurn("Yes")',
            "    } expectation: {",
            ...block.map((l) => l.slice(4)),
            "    }",
          ]).trimEnd(),
        );
      } else {
        scenarios.push(
          lines([
            ...comment,
            "    SiriScenario {",
            `        UserTurn(${swiftString(siriUtterance(manifest, ex.utterance))}) {`,
            ...block,
            ...finds,
            "        }",
            "    }",
          ]).trimEnd(),
        );
      }
    });
  }

  return lines([
    `// ${HEADER}`,
    "//",
    `// Siri evaluations for ${manifest.app.name}: every sample utterance in omnintent.json as a`,
    "// SiriEvaluations scenario. Add this file to a UI testing target (Xcode 27.3 or later, Swift",
    "// Testing). It runs only on a physical device with Siri set up, UI automation enabled, the app",
    "// installed from the same team, and fictional test data whose IDs match the ones below.",
    "// Siri runs the intents for real: use a dedicated test device.",
    "//",
    "// Then open the Report navigator, select Evaluations, and record what Siri did in",
    "// siri/results.json so `omnintent agent-test --import` can score it with the other platforms.",
    "//",
    "// Unverified: this file has not been compiled. Entity checks use `id`, which assumes Siri",
    "// reads your entities' identifiers; enum and date parameters are left to the report.",
    "",
    "import Testing",
    "import SiriEvaluations",
    "",
    `let appIntents = IntentDefinitions(bundleIdentifier: ${swiftString(bundleId)})`,
    ...actions.map((a) => `let ${intentVar(a)} = appIntents.intents[${swiftString(`${pascalCase(a.name)}Intent`)}]`),
    ...[...entityNames].sort().map((n) => `let ${entityVar(n)} = appIntents.entities[${swiftString(`${n}Entity`)}]`),
    "",
    `struct ${typeName}: Evaluation {`,
    "    let name: String",
    "    let dataset: SiriScenarioLoader",
    "",
    "    var evaluators: Evaluators {",
    "        SiriExpectationEvaluator()",
    "    }",
    "",
    "    func subject(from sample: SiriScenario) async throws -> SiriScenarioSubject {",
    "        // Reset your test data here (for example with a test-only intent) so runs do not affect each other.",
    "        try await SiriService.run(scenario: sample)",
    "    }",
    "",
    "    func aggregateMetrics(using aggregator: inout MetricsAggregator) {",
    "        Self.computeSiriMetrics(into: &aggregator)",
    "    }",
    "}",
    "",
    "let omnintentScenarios = SiriScenarioLoader {",
    scenarios.join("\n\n"),
    "}",
    "",
    "/// Siri's answers vary between runs. Run the suite more than once; lower this only deliberately.",
    "let requiredPassRate = 1.0",
    "",
    "@Suite(.serialized)",
    "struct OmnintentSiriEvaluations {",
    `    @Test(.evaluates(${typeName}(name: ${swiftString(`${manifest.app.name} sample utterances`)}, dataset: omnintentScenarios)))`,
    "    func sampleUtterances() async throws {",
    "        let result = EvaluationContext.current.result",
    "        #expect(result.aggregateValue(.mean(of: .intentsAllPass)) >= requiredPassRate)",
    "    }",
    "}",
  ]);
}

export function siriPlan(manifest: Manifest): GeneratedFile[] {
  return [{ path: "siri/OmnintentSiriEvaluations.swift", content: siriEvaluationFile(manifest) }];
}
