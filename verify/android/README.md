# Android build check

This folder builds the Kotlin that Omnintent generates against the real
`androidx.appfunctions` 1.0.0 library and its KSP compiler. The unit tests only compile the
generated code against hand-written stubs; this check proves the real compiler accepts it.

It runs on GitHub Actions (`.github/workflows/android-verify.yml`) whenever the generator,
the test fixtures or this folder change.

## What it builds

`prepare.mjs` writes one Android app module per manifest that exposes at least one function into `modules/` (not committed):

| Module | Manifest | Why |
| --- | --- | --- |
| `todo` | `examples/todo/omnintent.json` | The example, exactly as developers see it. |
| `optin` | The example with `delete_item` and `share_list` opted in | `isEnabled = false`, `Unit` returns, `Uri` results. |
| `fieldnotes` | `packages/cli/test/fixtures/field-notes.json` | Every parameter and result type: nullable scalars, defaults, `Long`, `Double`, `Instant`, `LocalDate`, `Uri`, primitive arrays, lists, enums. |

Each module contains the generated `src/` unchanged, an `AndroidManifest.xml` built around the
generated snippet, the test handlers from `packages/cli/test/fixtures/kotlin-impl`, and a small
`Application` class that provides them.

`check.mjs` then confirms that KSP generated each concrete service class and a schema XML that
lists every function, and prints the example's schema XML.

## Run it yourself

You need Node.js 22, JDK 17 or later, the Android SDK (Android Studio installs it; set
`ANDROID_HOME`), and Gradle 9.

```sh
npm ci && npm run build
node verify/android/prepare.mjs
gradle -p verify/android assembleDebug
node verify/android/check.mjs
```

Versions under test are pinned in `build.gradle.kts`: Android Gradle Plugin 9.5.1, Kotlin
2.4.21, KSP 2.3.13. The AppFunctions version comes from the generator.

## On an emulator

The workflow's `device` job installs the APKs on an Android 17 (API 37) emulator and runs
`device-check.sh`, which lists the registered functions and calls them with
`adb shell cmd app_function execute-app-function`. To run it yourself, start an API 37 emulator,
build as above, then:

```sh
sh verify/android/device-check.sh
```

An Android 16 QPR2 (API 36.1) emulator job also runs, for information only: on that image the system
does not index the functions. See `docs/LIMITATIONS.md`.

## What it does not check

Real agents. Whether Gemini chooses and calls these functions needs the Connected Apps Platform
developer preview.
