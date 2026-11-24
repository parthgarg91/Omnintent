// Copies the repository's schema/omnintent.schema.json into the package so the
// published CLI carries the exact schema it validates against.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, "../../../schema/omnintent.schema.json");
const to = resolve(here, "../schema/omnintent.schema.json");
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
