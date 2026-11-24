// The safety table from SPEC.md section C. Every generator reads from here so
// the four platforms can never disagree about what a safety level means.

import type { Action, AuthLevel, Entity, Manifest, Privacy, Safety, Skill } from "./manifest.js";
import { swiftString } from "./naming.js";

export interface McpAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export type ConfirmationRule = "none" | "optional" | "required";

/**
 * How the generated MCP server confirms an action before it calls the backend.
 * - none: no server-side confirmation.
 * - elicit-or-host: ask through MCP elicitation (input_required) when the client
 *   supports it; otherwise rely on the host's own confirmation, which the
 *   annotations request.
 * - elicit-required: ask through elicitation; refuse when the client cannot.
 */
export type McpConfirmation = "none" | "elicit-or-host" | "elicit-required";

/** What the Android generator does with an action of this safety level. */
export type AndroidRule = "generate" | "opt-in" | "never";

export interface SafetyRule {
  confirmation: ConfirmationRule;
  minAuth: AuthLevel;
  android: AndroidRule;
  mcpAnnotations: (action: Pick<Action, "idempotent" | "openWorld">) => McpAnnotations;
  /** Default Siri confirmation action name (Swift expression) when confirming. */
  siriActionName: (acceptLabel: string | undefined) => string;
}

export const SAFETY: Record<Safety, SafetyRule> = {
  read: {
    confirmation: "none",
    minAuth: "none",
    android: "generate",
    mcpAnnotations: (a) => ({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: a.openWorld ?? false,
    }),
    siriActionName: () => ".continue",
  },
  write: {
    confirmation: "optional",
    minAuth: "authenticated",
    android: "generate",
    mcpAnnotations: (a) => ({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: a.idempotent ?? false,
      openWorldHint: a.openWorld ?? false,
    }),
    siriActionName: (label) =>
      label
        ? `.custom(acceptLabel: ${swiftString(label)}, acceptAlternatives: [], denyLabel: "Cancel", denyAlternatives: [], destructive: false)`
        : ".continue",
  },
  destructive: {
    confirmation: "required",
    minAuth: "authenticated",
    android: "opt-in",
    mcpAnnotations: (a) => ({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: a.idempotent ?? false,
      openWorldHint: a.openWorld ?? false,
    }),
    siriActionName: (label) =>
      `.custom(acceptLabel: ${swiftString(label ?? "Delete")}, acceptAlternatives: [], denyLabel: "Cancel", denyAlternatives: [], destructive: true)`,
  },
  payment: {
    confirmation: "required",
    minAuth: "local-device",
    android: "never",
    mcpAnnotations: () => ({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    }),
    siriActionName: (label) =>
      label
        ? `.custom(acceptLabel: ${swiftString(label)}, acceptAlternatives: [], denyLabel: "Cancel", denyAlternatives: [], destructive: true)`
        : ".pay",
  },
};

const AUTH_ORDER: AuthLevel[] = ["none", "authenticated", "local-device"];

export function maxAuth(...levels: (AuthLevel | undefined)[]): AuthLevel {
  let best = 0;
  for (const level of levels) {
    if (level) best = Math.max(best, AUTH_ORDER.indexOf(level));
  }
  return AUTH_ORDER[best];
}

export function authForPrivacy(privacy: Privacy | undefined): AuthLevel {
  switch (privacy ?? "personal") {
    case "public":
      return "none";
    case "personal":
      return "authenticated";
    case "sensitive":
      return "local-device";
  }
}

/** Entity-level authentication: explicit value wins, else derived from privacy. */
export function entityAuth(entity: Entity): AuthLevel {
  return entity.authentication ?? authForPrivacy(entity.privacy);
}

/** Names of entities an action's output refers to. */
export function outputEntities(action: Action): string[] {
  const out = action.outputSchema;
  if (!out) return [];
  if ("$ref" in out) return [refName(out.$ref)];
  if (out.type === "array") return [refName(out.items.$ref)];
  return [];
}

export function refName(ref: string): string {
  return ref.replace(/^#\/entities\//, "");
}

/**
 * Action-level authentication: the strictest of the safety level's minimum,
 * the explicit `authentication`, and the privacy of any entity the action
 * returns. On write actions an explicit value replaces the safety minimum (so
 * a harmless write can run while the device is locked); on destructive and
 * payment actions it can only raise the level.
 */
export function actionAuth(manifest: Manifest, action: Action): AuthLevel {
  const fromOutputs = outputEntities(action).map((name) => {
    const entity = manifest.entities?.[name];
    return entity ? entityAuth(entity) : undefined;
  });
  const floor = action.safety === "write" && action.authentication ? "none" : SAFETY[action.safety].minAuth;
  return maxAuth(floor, action.authentication, ...fromOutputs);
}

export function needsConfirmation(action: Action): boolean {
  const rule = SAFETY[action.safety].confirmation;
  if (rule === "required") return true;
  if (rule === "optional") return action.confirmation?.required === true;
  return false;
}

export function mcpConfirmation(action: Action): McpConfirmation {
  if (!needsConfirmation(action)) return "none";
  return action.safety === "payment" ? "elicit-required" : "elicit-or-host";
}

/** Default confirmation prompt when the manifest gives none (write actions that opt in). */
export function confirmationPrompt(action: Action): string {
  return action.confirmation?.prompt ?? `${action.title}?`;
}

/**
 * Android rule for one action. AppFunctions gives the app no confirmation
 * step, so anything that must be confirmed is opt-in there, and payment
 * actions are never exposed.
 */
export function androidRule(action: Action): AndroidRule {
  const rule = SAFETY[action.safety].android;
  if (rule === "generate" && needsConfirmation(action)) return "opt-in";
  return rule;
}

export function isEnabledFor(action: Action, platform: "ios" | "android" | "mcp"): boolean {
  const explicit = action.platforms?.[platform]?.enabled;
  if (platform === "android") {
    const rule = androidRule(action);
    if (rule === "never") return false;
    if (rule === "opt-in") return explicit === true;
    return explicit ?? true;
  }
  return explicit ?? true;
}

/**
 * Skills a platform can use: those whose listed actions are all available on
 * it. A skill that mentions an action the agent cannot call would mislead it.
 */
export function skillsFor(manifest: Manifest, platform: "ios" | "android" | "mcp"): Skill[] {
  const enabled = new Set(manifest.actions.filter((a) => isEnabledFor(a, platform)).map((a) => a.name));
  return (manifest.skills ?? []).filter((s) => (s.actions ?? []).every((a) => enabled.has(a)));
}
