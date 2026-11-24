# What is verified, and what is not

Omnintent v0.1 is experimental. Everything below was checked on November 24, 2026, in a Linux
container with Node.js 22.23, no Swift toolchain, no Android SDK, and Google Maven blocked by the
network policy. The Swift rows were then checked the same day on a Mac with **Xcode 26.6 (17F113),
the iOS 26.5 SDK, Swift 6.3.3 and Node.js 24.14**. Xcode 27 and the iOS 27 SDK, which the generated
code targets, were not installed, so the iOS 27-only parts are still unchecked (see below).

## Verified by running it

| Area | How | Result |
| --- | --- | --- |
| CLI | `tsc` 5.9.3, strict mode, for sources and tests | No errors. |
| Validator | 21 tests: schema errors, every error rule, CLI exit codes | Pass. |
| Generators | Golden files: the example's Swift, Kotlin and MCP output must equal the committed files byte for byte; regenerating twice gives identical output | Pass. |
| MCP Worker types | `tsc --noEmit` on the generated project against the real `@modelcontextprotocol/server` 2.4.0, `agents` 0.34.0 and `@cloudflare/workers-types` 5.x declarations (a planted type error is caught) | No errors. |
| MCP end to end on Node | Generated `scripts/serve-node.mjs` (the Worker's own `fetch` handler), the example mock backend, the official `@modelcontextprotocol/client` 2.4.0 pinned to protocol 2026-07-28 | 7 tests pass (see the list below). |
| MCP end to end on workerd | The same 7 tests against `wrangler dev` 4.167.0, which runs the Worker in local workerd | Pass. |
| Payment rules on MCP | A generated payment server: refuses without elicitation (2026 and 2025 clients); pays after confirmation; strips `sensitive` fields | Pass. |
| Kotlin | `kotlinc` 2.4.21 (from GitHub releases) compiles the generated code for three manifests, plus handler implementations, against hand-written **stubs** of the AppFunctions and Android APIs (`packages/cli/test/fixtures/kotlin-stubs`) | Compiles. |
| Swift syntax | `tree-sitter-swift` 0.7.1 parses every generated Swift file with no syntax errors (and does flag broken code) | Pass. |
| Swift types (Xcode 26.6, iOS 26.5 SDK) | `swiftc -typecheck` on the generated code for three manifests (the example with a handler implementation, a payment manifest, and `packages/cli/test/fixtures/swift/coverage.json`, which covers non-`id` ID properties, optional entity parameters, `Int`/`Double`/`Bool`/`Date`/`URL`, arrays, enum arrays, defaults, object results and no-output actions). Swift 6 language mode, complete strict concurrency, warnings as errors; once as is and once with MainActor default isolation plus approachable concurrency. iOS 27-only lines removed first (below) | Pass after one fix (below). |
| Swift in an app target (Xcode 26.6) | `scripts/xcode-build-check.mjs` (`npm run xcode:check`) builds the same code in a minimal iOS app target with `xcodebuild` for the simulator (Swift 6, MainActor default isolation, warnings as errors), which runs Xcode's App Intents metadata extraction. Every generated intent and entity appears in `Metadata.appintents` | Builds, for all three manifests. |
| Discovery, deterministic | The example OpenAPI file drafts a valid 6-action manifest whose backend calls equal the hand-written example's; all targets generate from it | Pass. |
| Discovery, AI path | Against a **fake** Messages API: request shape (URL, headers, `claude-opus-5-5`, `output_config.format`), conversion, the repair loop, giving up on persistent errors, and the CLI writing nothing when the draft stays invalid | Pass. |

The 7 end-to-end checks run on each runtime:

1. Requests without the access token get 401.
2. `tools/list` returns 6 tools with the right annotations and schemas.
3. Add, list and complete change the backend state; internal `notes` never appear.
4. `delete_item` asks through elicitation; a decline leaves the item and an accept deletes it.
5. The opted-in confirmation on `share_list` works, and an undeclared backend field is stripped.
6. Bad arguments and a backend 404 come back as tool errors, and the backend is unchanged.
7. A 2025-era client lists and calls tools through the stateless fallback.

Total: 81 tests across 5 files (`npm test`). The Swift type-check runs only on a Mac with Xcode, and
the Kotlin compile only when `kotlinc` is present; on the Mac above, 80 ran and the Kotlin compile
was skipped.

### Bug found by compiling

- Entity and result `displayRepresentation` was generated as a bare string (`"\(name)"`). Swift
  infers an interpolated literal there as `String`, so it did not compile ("cannot convert return
  expression of type 'String' to return type 'DisplayRepresentation'"). It is now
  `DisplayRepresentation(title: "\(name)")`. The example's golden files are updated.

## Not verified

### Swift / Siri

- **Not compiled with Xcode 27 or the iOS 27 SDK.** Only Xcode 26.6 with the iOS 26.5 SDK was
  available. That SDK does not have these iOS 27 additions, so the checks above removed them before
  compiling (`forOlderSdk` in `packages/cli/test/swift-sdk.ts`, which changes nothing else):
  - `@AppIntent(.tool)`. The iOS 26.5 SDK has only `@AppIntent(schema:)`. Whether `.tool` on a struct
    that also declares `: AppIntent` compiles (Apple's own example does this) is unconfirmed.
  - `@Property(title:description:)`, `visibility: .internal` and `authenticationPolicy:` on
    `@Property`. The iOS 26.5 SDK has only `@Property(title:)`.
- `static let authenticationPolicy` on `AppEntity` types compiles with the iOS 26.5 SDK, but there it
  is a plain static property that nothing reads (`authenticationPolicy` is only an `AppIntent`
  requirement in that SDK). Whether iOS 27 reads it, as Apple's `BankAccount` example suggests, is
  unconfirmed.
- Confirmed with the iOS 26.5 SDK (and expected to carry over to iOS 27, but not checked there):
  - `TransientAppEntity` result types with `init() {}` and non-optional `@Property` values.
  - `ReturnsValue<[Entity]>`.
  - Assigning `@Property` values in a memberwise `init` after `self.id`, including a computed `id`
    when the ID property has another name.
  - `EnumerableEntityQuery` conformance through the handler protocol.
  - `requestConfirmation(actionName: .custom(...), dialog:)` and `.pay`.
  - `@Parameter` defaults for enums, enum arrays, string arrays, numbers and booleans.
  - Swift 6 strict concurrency, both with and without Xcode's MainActor-by-default setting, with no
    warnings. The `@AppIntent(.tool)` macro's expansion was not part of this, so it could still add
    isolation issues on iOS 27.
- **Never run.** The intents were compiled and their metadata extracted, but not run in a simulator
  or on a device, and no AppIntentsTesting tests were written.
- The generated `Skills.skillsbundle/Skills/<name>/SKILL.md` folder mirrors Apple's documented
  layout. Apple says to create the bundle with Xcode's template; whether copying the folder works the
  same way is untested.
- Whether Siri actually chooses these tools for the sample utterances is untested. That needs a
  device running the Siri AI Developer Preview, the Siri Integration Advisor and SiriEvaluations.

### Kotlin / Android

- **Compiled only against stubs.** The real `androidx.appfunctions` 1.0.0 library and its KSP
  processor were not available (Google Maven is blocked here), and there was no Android SDK. The
  stubs follow the documentation, so the compile proves internal consistency (types, imports,
  nullability, named arguments, annotation parameter names as documented), not acceptance by the real
  processor.
- Unconfirmed against the real processor:
  - `Unit` returns for actions without output.
  - `Int?` and other nullable scalar parameters.
  - `@AppFunctionStringValueConstraint` on a nullable parameter.
  - Primitive-array parameters.
  - Default values in `@AppFunctionSerializable` constructors.
- The manifest snippet values (`app_functions_schema.xsd`, `android.app.appfunctions.v2`,
  `app_metadata`) and the KSP version (2.3.13, taken from Google's sample) are unconfirmed.
- Not run on a device: `adb shell cmd app_function …` was not executed, and the Gemini / Connected
  Apps Platform integration is untested.

### MCP / Cloudflare

- Not deployed to Cloudflare. Only local `wrangler dev` ran. Wrangler's attempt to fetch the
  `Request.cf` metadata fails here because of the network policy; this is harmless locally.
- Not tested with real hosts (Claude, ChatGPT, Gemini Spark, Meta Muse). Hosts that do not support
  protocol 2026-07-28 or form elicitation fall back to their own confirmation for destructive tools,
  and cannot run payment tools.
- **OAuth is not implemented.** Inbound access is a single pre-shared bearer token
  (`MCP_ACCESS_TOKEN`), and every caller shares one backend account (`BACKEND_TOKEN`). The OAuth 2.1
  path (`@cloudflare/workers-oauth-provider`, Protected Resource Metadata) is documented as the next
  step, not generated. Whether each host accepts a static bearer header was not verified.
- The server trusts the client's elicitation answer, as the protocol intends. There is no signed
  `requestState` binding a confirmation to specific arguments.
- MCP's Skills extension (in the SDK as `@modelcontextprotocol/server/ext/skills`) is not used.
  Skills are added to the server instructions instead.

### Discovery

- The AI path was never called against the real Anthropic API (there is no key in this
  environment). The request format follows the documentation (`anthropic-version: 2026-10-21`,
  `output_config.format`); the quality of real proposals is unmeasured.
- Codebase discovery without an OpenAPI file depends on Claude. The route detection that feeds it is
  a set of regular expressions for common web frameworks.

### Cloud agent facts

Meta Muse and Gemini Spark behaviour comes from dated third-party articles. The ChatGPT help page
could not be fetched. See `docs/RESEARCH.md`.

## Known gaps in v0.1 (by design)

- **Schema subset.** No nested objects in parameters or entities; no lists of entities as
  parameters; no files or images; no pagination convention; no API-key-header backend auth (bearer
  only).
- **Entity lookups.** Swift entity queries call `all<Entity>Entities()`. Large collections should be
  indexed in Spotlight instead, which is not generated.
- **Android confirmation.** Actions that need confirmation are opt-in and generated disabled. Google's
  sample shows a two-step preview-then-act pattern with A2UI confirmation components; generating it
  is future work.
- **Stale files.** `generate` does not delete files from earlier runs. Generate into a clean
  directory.
- **Live tests.** `omnintent test` is static. Driving live agents is the tester agent's job
  (`docs/ARCHITECTURE.md`).
- **Not published.** The CLI is not on npm. Run `node packages/cli/dist/cli.js` or `npm link`.
