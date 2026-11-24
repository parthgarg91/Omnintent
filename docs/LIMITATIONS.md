# What is verified, and what is not

Omnintent v0.1 is experimental. Everything below was checked on November 24, 2026, in a Linux
container with Node.js 22.23, no Swift toolchain, no Android SDK, and Google Maven blocked by the
network policy. Per-user OAuth sign-in for the MCP server was added and checked the same day.

## Verified by running it

| Area | How | Result |
| --- | --- | --- |
| CLI | `tsc` 5.9.3, strict mode, for sources and tests | No errors. |
| Validator | 22 tests: schema errors, every error rule, CLI exit codes | Pass. |
| Generators | Golden files: the example's Swift, Kotlin and MCP output must equal the committed files byte for byte; regenerating twice gives identical output | Pass. |
| MCP Worker types | `tsc --noEmit` on both kinds of generated project (OAuth sign-in and shared token) against the real `@modelcontextprotocol/server` 2.4.0, `agents` 0.34.0, `@cloudflare/workers-oauth-provider` 1.3.0 and `@cloudflare/workers-types` 5.x declarations | No errors. |
| MCP with OAuth, end to end on Node | Generated `scripts/serve-node.mjs` (the Worker's own `fetch` handler, KV in memory), the example mock backend acting as the app's own OAuth server, the official `@modelcontextprotocol/client` 2.4.0 doing discovery, registration and PKCE, and a scripted browser for the consent and sign-in pages | 11 tests pass (see the list below). |
| MCP with OAuth, end to end on workerd | The same 11 tests against `wrangler dev` 4.167.0, which runs the Worker in local workerd with local KV | Pass. |
| MCP with a shared token | A generated payment server (bearer backend): type-checks; refuses requests without the token; refuses to pay without elicitation (2026 and 2025 clients); pays after confirmation; strips `sensitive` fields | Pass. |
| Kotlin | `kotlinc` 2.4.21 (from GitHub releases) compiles the generated code for three manifests, plus handler implementations, against hand-written **stubs** of the AppFunctions and Android APIs (`packages/cli/test/fixtures/kotlin-stubs`) | Compiles. |
| Swift | `tree-sitter-swift` 0.7.1 parses every generated Swift file with no syntax errors (and does flag broken code) | Pass. |
| Discovery, deterministic | The example OpenAPI file drafts a valid 6-action manifest whose backend calls equal the hand-written example's; all targets generate from it | Pass. |
| Watcher agent | 21 tests against a **fake** web: RESEARCH.md baselines are read from the real file, newer npm/AppFunctions/MCP versions are flagged, changed/added/removed page sections are named, unreadable sources keep their snapshot, the fingerprint is stable, and no real network is used | Pass. |
| Watcher, live run | `omnintent watch` from this container on November 24, 2026: 18 of 20 sources read and matched `RESEARCH.md`; two runs in a row gave identical page hashes. The two Cloudflare docs pages are blocked by this container's network policy | 18 of 20 read. |
| Submission helper | 13 tests: every draft file, internal-TestFlight-only wording, Apple's 4,000-byte App Review notes limit, Android exposure matching the safety table, MCP annotations and withheld fields, warnings, and that it works with `fetch` disabled | Pass. |
| Discovery, AI path | Against a **fake** Messages API: request shape (URL, headers, `claude-opus-5-5`, `output_config.format`), conversion, the repair loop, giving up on persistent errors, and the CLI writing nothing when the draft stays invalid | Pass. |

The 11 end-to-end checks run on each runtime:

1. Requests without a token, or with a made-up one, get 401 with a `resource_metadata` pointer.
   The Protected Resource Metadata and authorization server metadata name the right URLs, scopes
   and PKCE method.
2. A person signs in: the official client registers, opens the consent page, the person allows and
   signs in to the backend, and the client gets a token for `mcp:read mcp:write`. The consent page
   escapes the client's name, shows the redirect host, warns about a local app, and cannot be
   framed. `tools/list` returns 6 tools with the right annotations and schemas.
3. Add, list and complete change that person's backend data; internal `notes` never appear. A
   second person sees only their own data.
4. The backend never receives the MCP token; it only sees backend tokens.
5. `delete_item` asks through elicitation; a decline leaves the item and an accept deletes it.
6. The opted-in confirmation on `share_list` works, and an undeclared backend field is stripped.
7. Bad arguments and a backend 404 come back as tool errors, and the backend is unchanged.
8. Unticking "Make changes" gives a read-only token: read tools work, `add_item` gets `403`
   `insufficient_scope` naming both scopes, and nothing changes.
9. "Deny" sends the client `access_denied` with the issuer (`iss`).
10. Refreshing the MCP token refreshes a nearly expired backend token. After the backend revokes
    access, the refresh fails with `invalid_grant` and the grant's tokens stop working.
11. A 2025-era client lists and calls tools through the stateless fallback.

Total: 126 tests across 7 files (`npm test`), all passing on November 24, 2026, with the Kotlin
compile included.

## Not verified

### Swift / Siri

- **Never compiled or type-checked.** There was no Swift compiler, Xcode 27 or iOS 27 SDK here. The
  syntax parse cannot catch type errors, wrong labels or missing conformances.
- The code follows Apple's documented examples, but these points are unconfirmed:
  - `@AppIntent(.tool)` on a struct that also declares `: AppIntent` (Apple's own example does this).
  - `static let authenticationPolicy` on `AppEntity` types (Apple's `BankAccount` example).
  - `TransientAppEntity` result types with `init() {}` and non-optional `@Property` values.
  - `ReturnsValue<[Entity]>`.
  - Assigning `@Property` values in a memberwise `init` after `self.id`.
  - `EnumerableEntityQuery` conformance through the handler protocol.
- Behaviour under Swift 6 strict concurrency and Xcode's MainActor-by-default app setting is
  unconfirmed. The generated code avoids `nonisolated(unsafe)` and uses `try await` for every
  handler call, but has not been compiled with either setting.
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
- **OAuth sign-in was tested only locally, against the mock backend.** Not verified:
  - With any real MCP host. Whether Claude, ChatGPT, Gemini Spark or Meta Muse complete the flow,
    which registration method each uses, and whether each handles the `403` `insufficient_scope`
    step-up (or simply fails) are untested.
  - Client ID Metadata Documents. `wrangler dev` advertises CIMD support, but no test registers a
    client that way; every test client uses Dynamic Client Registration. On the Node adapter CIMD is
    off, because it needs the Workers `global_fetch_strictly_public` flag.
  - With a real backend OAuth server (for example Auth0, Clerk, Supabase or your own). The mock
    accepts any user name. Providers that need extra parameters (such as `audience`), return the
    user ID only in an `id_token`, or do not support PKCE are not handled.
  - Deployed on Cloudflare. KV was the local simulation in `wrangler dev` and an in-memory stand-in
    on Node. The generated `wrangler.jsonc` needs a real KV namespace ID before deploy.
  - Remembered consent (`CONSENT_SECRET`) is generated but has no test.
- Shared-token servers (`bearer` or `none` backends) still use one pre-shared token
  (`MCP_ACCESS_TOKEN`), and every caller shares one backend account. Whether each host accepts a
  static bearer header was not verified.
- The consent page appears before the backend sign-in, so it cannot show who is signing in. That is
  the order MCP's guidance on proxy servers requires (consent per client before the redirect).
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

### Watcher agent

- **The GitHub Actions workflow has not run yet.** It runs on a schedule only from the default
  branch, so it first runs after this change is merged. Until then the issue step, the duplicate
  check and the snapshot pull request are untested.
- Opening the snapshot pull request needs the repository setting "Allow GitHub Actions to create and
  approve pull requests". Without it the branch is pushed and the run shows a warning.
- The Cloudflare docs pages were not reachable from this container, so they have no snapshot yet.
  The first workflow run records one (reported as "first snapshot", which opens no issue).
- Page checks are section hashes. Any edit, including a typo fix, counts as a change; the watcher
  cannot tell an API change from a wording change. A person reads the source.
- Version checks depend on regular expressions over `docs/RESEARCH.md`. Rewording a tracked fact
  makes the watcher report "RESEARCH.md fact missing" until the pattern in `sources.ts` is updated.
- Not watched: host connector requirements (Claude, ChatGPT, Gemini, Meta Muse), Google Connected
  Console, Expo, and the Anthropic API. Their pages were either not readable or not stable enough
  to diff.

### Submission helper

- Nothing was submitted anywhere, by design.
- Checked on Apple's App Store Connect help page (November 24, 2026): App Review notes allow up to
  4,000 bytes. **Not confirmed:** the 4,000-character limit used for TestFlight "What to Test"; the
  page that should state it did not show it as text.
- The Google Connected Console form was never seen. The Android draft lists the facts the console is
  likely to ask for, not its field names.
- The MCP listing's host notes repeat `RESEARCH.md`: only Gemini Spark and Meta Muse have (third-party)
  sources; Claude and ChatGPT directory requirements were not checked.
- Whether App Review can see `@AppIntent(.tool)` intents in the Shortcuts app, as the review notes
  suggest, is unconfirmed.

### Cloud agent facts

Meta Muse and Gemini Spark behaviour comes from dated third-party articles. The ChatGPT help page
could not be fetched. See `docs/RESEARCH.md`.

## Known gaps in v0.1 (by design)

- **OAuth needs the backend's own OAuth server.** A backend that only has its own login (sessions,
  API keys) and no OAuth endpoints cannot use per-user sign-in yet. Signing in through a third
  party (Google, GitHub) and telling the backend who the user is, is not generated.
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
