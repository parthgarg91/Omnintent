// Writes one Android app module per test manifest into verify/android/modules/,
// using the current generator output, so Gradle can build it against the real
// androidx.appfunctions library and its KSP compiler.
//
//   npm run build && node verify/android/prepare.mjs
//
// Each module holds the generated Kotlin and resources unchanged, an
// AndroidManifest.xml built around the generated snippet, the test handler
// implementation from packages/cli/test/fixtures/kotlin-impl, and a small
// Application class that provides the handlers.

import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const fixtures = join(repo, "packages/cli/test/fixtures");
const { generateKotlin, writeFiles } = await import(join(repo, "packages/cli/dist/index.js"));
const { kotlinNames, APPFUNCTIONS_VERSION, KSP_VERSION } = await import(join(repo, "packages/cli/dist/generators/kotlin.js"));

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const example = () => readJson(join(repo, "examples/todo/omnintent.json"));

// Same edits as optInManifest() in packages/cli/test/helpers.ts.
const optIn = example();
optIn.app.android = { packageName: "com.example.optin" };
optIn.actions[4].platforms = { android: { enabled: true } };
optIn.actions[5].platforms = { android: { enabled: true } };

const MODULES = [
  { name: "todo", manifest: example(), impl: "TodoExampleHandlers.kt", handlers: "FakeTodoHandlers" },
  { name: "optin", manifest: optIn, impl: "OptInHandlers.kt", handlers: "FakeOptInHandlers" },
  { name: "fieldnotes", manifest: readJson(join(fixtures, "field-notes.json")), impl: "FieldNotesHandlers.kt", handlers: "FakeFieldNotesHandlers" },
  { name: "coffee", manifest: readJson(join(fixtures, "coffee-shop.json")), impl: "CoffeeShopHandlers.kt", handlers: "FakeCoffeeHandlers" },
];

// The root build pins the versions under test; they must match what the generator tells developers to use.
const rootBuild = readFileSync(join(here, "build.gradle.kts"), "utf8");
if (!rootBuild.includes(`id("com.google.devtools.ksp") version "${KSP_VERSION}"`)) {
  throw new Error(`verify/android/build.gradle.kts must use KSP ${KSP_VERSION}, as the generator does.`);
}

const modulesDir = join(here, "modules");
rmSync(modulesDir, { recursive: true, force: true });

for (const m of MODULES) {
  const dir = join(modulesDir, m.name);
  const names = kotlinNames(m.manifest);
  const files = generateKotlin(m.manifest);
  writeFiles(dir, files);

  const snippet = files.find((f) => f.path === "AndroidManifest.snippet.xml").content;
  writeFileSync(
    join(dir, "src/main/AndroidManifest.xml"),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
      '    xmlns:tools="http://schemas.android.com/tools">',
      `    <application android:name="${names.servicePackage}.VerifyApp" android:label="Omnintent verify ${m.name}">`,
      ...snippet.trimEnd().split("\n").map((l) => (l ? `        ${l}` : l)),
      "    </application>",
      "</manifest>",
      "",
    ].join("\n"),
  );

  const kotlinDir = join(dir, "src/main/kotlin", ...names.servicePackage.split("."));
  mkdirSync(kotlinDir, { recursive: true });
  copyFileSync(join(fixtures, "kotlin-impl", m.impl), join(kotlinDir, m.impl));
  writeFileSync(
    join(kotlinDir, "VerifyApp.kt"),
    [
      `package ${names.servicePackage}`,
      "",
      "import android.app.Application",
      "",
      "class VerifyApp : Application(), OmnintentHandlersProvider {",
      `    override val omnintentHandlers: OmnintentHandlers = ${m.handlers}()`,
      "}",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(dir, "build.gradle.kts"),
    [
      "// Written by verify/android/prepare.mjs.",
      "plugins {",
      '    id("com.android.application")',
      '    id("com.google.devtools.ksp")',
      "}",
      "",
      "android {",
      `    namespace = "${names.packageName}"`,
      "    compileSdk = 37",
      "    defaultConfig {",
      `        applicationId = "${names.packageName}"`,
      "        minSdk = 26",
      "        targetSdk = 36",
      "    }",
      "}",
      "",
      "dependencies {",
      `    implementation("androidx.appfunctions:appfunctions:${APPFUNCTIONS_VERSION}")`,
      `    ksp("androidx.appfunctions:appfunctions-compiler:${APPFUNCTIONS_VERSION}")`,
      "}",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(dir, "expect.json"),
    JSON.stringify(
      {
        serviceClass: `${names.servicePackage}.${names.serviceName}`,
        xmlFileName: `${names.xmlFileName}.xml`,
        functions: [...files.find((f) => f.path.endsWith(`/${names.baseClass}.kt`)).content.matchAll(/^    suspend fun (\w+)\(/gm)].map((x) => x[1]),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`modules/${m.name}: ${names.servicePackage}`);
}
