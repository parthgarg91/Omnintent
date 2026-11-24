// What changed between the previously approved manifest and the new one, in
// terms a reviewer cares about: actions and entities added, changed, removed.

import type { Manifest } from "../manifest.js";

export interface ManifestChanges {
  /** True when there is no previous manifest (first build). */
  initial: boolean;
  addedActions: string[];
  changedActions: string[];
  removedActions: string[];
  addedEntities: string[];
  changedEntities: string[];
  removedEntities: string[];
  /** app, backend or skills changed. */
  otherChanges: string[];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compare<T>(before: Map<string, T>, after: Map<string, T>) {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...after.keys()].filter((k) => before.has(k) && stable(before.get(k)) !== stable(after.get(k)));
  return { added, removed, changed };
}

export function diffManifests(previous: Manifest | undefined, current: Manifest): ManifestChanges {
  const prev = previous ?? ({ actions: [], entities: {} } as unknown as Manifest);
  const actions = compare(new Map(prev.actions.map((a) => [a.name, a])), new Map(current.actions.map((a) => [a.name, a])));
  const entities = compare(new Map(Object.entries(prev.entities ?? {})), new Map(Object.entries(current.entities ?? {})));
  const otherChanges: string[] = [];
  if (previous) {
    for (const key of ["app", "backend", "skills"] as const) {
      if (stable(previous[key]) !== stable(current[key])) otherChanges.push(key);
    }
  }
  return {
    initial: !previous,
    addedActions: actions.added,
    changedActions: actions.changed,
    removedActions: actions.removed,
    addedEntities: entities.added,
    changedEntities: entities.changed,
    removedEntities: entities.removed,
    otherChanges,
  };
}

export function hasChanges(c: ManifestChanges): boolean {
  return (
    c.initial ||
    [c.addedActions, c.changedActions, c.removedActions, c.addedEntities, c.changedEntities, c.removedEntities, c.otherChanges].some(
      (list) => list.length > 0,
    )
  );
}

export function formatChanges(c: ManifestChanges): string {
  if (c.initial) return "First build: every action in the manifest is new.";
  const rows: string[] = [];
  const add = (label: string, list: string[]) => {
    if (list.length) rows.push(`- ${label}: ${list.map((n) => `\`${n}\``).join(", ")}`);
  };
  add("Actions added", c.addedActions);
  add("Actions changed", c.changedActions);
  add("Actions removed", c.removedActions);
  add("Entities added", c.addedEntities);
  add("Entities changed", c.changedEntities);
  add("Entities removed", c.removedEntities);
  add("Also changed", c.otherChanges);
  return rows.length ? rows.join("\n") : "No manifest changes.";
}
