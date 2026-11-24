// Run after `gradle assembleDebug`. Confirms that, for every module, the
// AppFunctions KSP compiler produced the concrete service class named in the
// generated entry point and a function schema XML that lists every function.
// Prints the todo module's schema XML so the build log shows what agents see.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modulesDir = join(here, "modules");

function find(dir, match, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) find(full, match, out);
    else if (match(name, full)) out.push(full);
  }
  return out;
}

// One line per function and parameter: XML type code, nullability, required, enum values.
function summary(xml) {
  const out = [];
  for (const fn of xml.split("<appfunction>").slice(1)) {
    const body = fn.split("</appfunction>")[0];
    const id = body.match(/<id>([^<]*)<\/id>/)[1].split("#")[1];
    out.push(`     ${id} enabledByDefault=${body.match(/<enabledByDefault>(\w+)/)?.[1]}`);
    for (const p of body.split("<parameters>").slice(1).map((s) => s.split("</parameters>")[0])) {
      const get = (tag) => p.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
      const enums = [...p.matchAll(/<enumValues>([^<]*)<\/enumValues>/g)].map((m) => m[1]);
      out.push(`       ${get("name")}: type=${get("type")} ref=${get("dataTypeReference") ?? "-"} nullable=${get("isNullable")} required=${get("isRequired")}${enums.length ? ` enum=${enums.join("|")}` : ""}`);
    }
  }
  return out.join("\n");
}

let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`FAIL ${msg}`);
};

for (const name of readdirSync(modulesDir).sort()) {
  const dir = join(modulesDir, name);
  const expect = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8"));
  const build = join(dir, "build");
  const simpleName = expect.serviceClass.split(".").pop();

  const service = find(join(build, "generated"), (n) => n === `${simpleName}.kt` || n === `${simpleName}.java`);
  if (!service.length) fail(`${name}: KSP did not generate ${expect.serviceClass}`);
  else console.log(`ok   ${name}: ${relative(here, service[0])}`);

  const apk = find(join(build, "outputs/apk"), (n) => n.endsWith(".apk"));
  if (!apk.length) fail(`${name}: no APK was built`);

  const xml = find(build, (n) => n === expect.xmlFileName);
  if (!xml.length) {
    fail(`${name}: no ${expect.xmlFileName} found under build/`);
    continue;
  }
  const content = readFileSync(xml[0], "utf8");
  console.log(`ok   ${name}: ${relative(here, xml[0])} (${content.length} bytes)`);
  for (const fn of expect.functions) {
    if (!content.includes(`#${fn}`) && !content.includes(fn)) fail(`${name}: ${fn} is missing from ${expect.xmlFileName}`);
  }
  console.log(summary(content));
  if (name === "todo") console.log(`\n----- ${expect.xmlFileName} -----\n${content}\n-----\n`);
}

if (failed) process.exit(1);
console.log("All modules built and KSP output looks complete.");
