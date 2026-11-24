// Summarises a codebase for the AI discovery path: file tree, README, manifest
// files, OpenAPI files and HTTP routes found by pattern, within a size budget.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "Pods", ".gradle", ".idea", "DerivedData", "vendor", "coverage", ".wrangler", "target", "__pycache__", ".venv"]);
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|py|go|rb|kt|java|swift|php|cs|rs)$/;
const MAX_FILE = 200_000;
const BUDGET = 80_000;

const ROUTE_PATTERNS: RegExp[] = [
  /\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`]*)['"`]/gi, // Express, Hono, Fastify, Koa routers
  /@(?:app|router|api|bp)\.(get|post|put|patch|delete|route)\(\s*['"](\/[^'"]*)['"]/gi, // FastAPI, Flask
  /@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*)?["'](\/[^"']*)["']/g, // Spring
  /\b(GET|POST|PUT|PATCH|DELETE)\s*\(\s*["'](\/[^"']*)["']/g, // Gin, Echo, Chi
];

export interface CodebaseSummary {
  text: string;
  openApiFiles: string[];
  routes: number;
}

function walk(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, out);
    else if (st.size <= MAX_FILE) out.push(relative(root, full));
  }
}

export function summarizeCodebase(root: string): CodebaseSummary {
  const files: string[] = [];
  walk(root, root, files);
  const openApiFiles = files.filter((f) => /(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i.test(f));
  const sections: string[] = [];
  let used = 0;
  const add = (title: string, body: string) => {
    const room = BUDGET - used;
    if (room <= 200) return;
    const text = `## ${title}\n${body.slice(0, room - title.length - 10)}\n`;
    sections.push(text);
    used += text.length;
  };

  add("Files", files.slice(0, 300).join("\n") + (files.length > 300 ? `\n... ${files.length - 300} more` : ""));
  const readme = files.find((f) => /^readme(\.md)?$/i.test(basename(f)) && !f.includes("/"));
  if (readme) add(readme, readFileSync(join(root, readme), "utf8").slice(0, 6000));
  for (const f of files.filter((f) => /(^|\/)(package\.json|build\.gradle(\.kts)?|Package\.swift|pyproject\.toml|go\.mod)$/.test(f)).slice(0, 5)) {
    add(f, readFileSync(join(root, f), "utf8").slice(0, 2500));
  }

  let routes = 0;
  const snippets: string[] = [];
  for (const f of files.filter((f) => CODE_EXT.test(f))) {
    const text = readFileSync(join(root, f), "utf8");
    const fileLines = text.split("\n");
    for (const pattern of ROUTE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        routes++;
        const line = text.slice(0, m.index).split("\n").length;
        const snippet = fileLines.slice(line - 1, line + 14).join("\n");
        snippets.push(`### ${m[1].toUpperCase()} ${m[2]}  (${f}:${line})\n${snippet}`);
      }
    }
  }
  if (snippets.length) add("HTTP routes found in code", snippets.join("\n\n"));
  for (const f of openApiFiles.slice(0, 2)) add(f, readFileSync(join(root, f), "utf8").slice(0, 30000));
  return { text: sections.join("\n"), openApiFiles, routes };
}
