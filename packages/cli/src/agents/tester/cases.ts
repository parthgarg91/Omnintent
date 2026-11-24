// Test cases for the tester agent: every sample utterance in the manifest
// (the same cases `omnintent test --plan` writes to cases.json).

import type { Manifest, Safety } from "../../manifest.js";
import { isEnabledFor } from "../../safety.js";

export type Platform = "mcp" | "ios" | "android";

export interface AgentCase {
  /** Stable ID, e.g. "<action>#<example index>". */
  id: string;
  utterance: string;
  expectedTool: string;
  expectedArguments: Record<string, unknown>;
  safety: Safety;
  /** Where the case came from: the manifest's samples, or another source such as labelled usage data. */
  source: string;
  /**
   * Whether the expected action is available on the platform under test. When
   * it is not (for example a destructive action on Android), the case passes
   * only if the agent calls no write action at all.
   */
  exposed: boolean;
  /** False when only the tool choice should be scored (no expected arguments are known). */
  checkArguments: boolean;
}

export function exampleCases(manifest: Manifest, platform: Platform): AgentCase[] {
  return manifest.actions.flatMap((action) =>
    action.examples.map((ex, i) => ({
      id: `${action.name}#${i}`,
      utterance: ex.utterance,
      expectedTool: action.name,
      expectedArguments: ex.arguments,
      safety: action.safety,
      source: "example" as const,
      exposed: isEnabledFor(action, platform),
      checkArguments: true,
    })),
  );
}
