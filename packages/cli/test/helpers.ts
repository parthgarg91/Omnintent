import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../src/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "../../..");
export const EXAMPLE_DIR = resolve(REPO, "examples/todo");
export const EXAMPLE_MANIFEST = resolve(EXAMPLE_DIR, "omnintent.json");
export const GENERATED_DIR = resolve(EXAMPLE_DIR, "generated");

export function loadExample(): Manifest {
  return JSON.parse(readFileSync(EXAMPLE_MANIFEST, "utf8")) as Manifest;
}

/** A deep copy of the example, changed by `edit`. */
export function variant(edit: (m: Manifest) => void): Manifest {
  const m = structuredClone(loadExample());
  edit(m);
  return m;
}

export const FIXTURES = resolve(here, "fixtures");

function loadFixture(name: string): Manifest {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as Manifest;
}

/** A small manifest with a payment action, for safety-mapping tests. */
export function paymentManifest(): Manifest {
  return loadFixture("coffee-shop.json");
}

/** A manifest that uses every parameter and result type, for compile checks. */
export function fieldNotesManifest(): Manifest {
  return loadFixture("field-notes.json");
}

/** The example with delete_item and share_list opted in on Android. */
export function optInManifest(): Manifest {
  return variant((m) => {
    m.app.android = { packageName: "com.example.optin" };
    m.actions[4].platforms = { android: { enabled: true } };
    m.actions[5].platforms = { android: { enabled: true } };
  });
}
