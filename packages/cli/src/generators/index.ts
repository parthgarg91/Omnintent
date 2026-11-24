import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Manifest } from "../manifest.js";
import { generateKotlin } from "./kotlin.js";
import { generateMcp } from "./mcp.js";
import { generateSwift } from "./swift.js";
import { TARGETS, type GeneratedFile, type Generator, type Target } from "./types.js";

export const GENERATORS: Record<Target, Generator> = {
  swift: generateSwift,
  kotlin: generateKotlin,
  mcp: generateMcp,
};

export function parseTargets(value: string): Target[] {
  if (value === "all") return [...TARGETS];
  const targets = value.split(",").map((t) => t.trim());
  for (const t of targets) {
    if (!(TARGETS as string[]).includes(t)) throw new Error(`Unknown target "${t}". Use swift, kotlin, mcp or all.`);
  }
  return targets as Target[];
}

/** Generates files for each target under <target>/ so `--target all` keeps them apart. */
export function generate(manifest: Manifest, targets: Target[]): GeneratedFile[] {
  return targets.flatMap((target) =>
    GENERATORS[target](manifest).map((f) => ({ path: `${target}/${f.path}`, content: f.content })),
  );
}

export function writeFiles(outDir: string, files: GeneratedFile[]): void {
  for (const file of files) {
    const full = join(outDir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
  }
}

export type { GeneratedFile, Target } from "./types.js";
