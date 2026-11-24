# What is verified, and what is not

Omnintent v0.1 is experimental. Everything below was checked on November 24, 2026, in a Linux
container with Node.js 22.23, no Swift toolchain, no Android SDK, and Google Maven blocked by the
network policy. The Android build and emulator checks ran on GitHub Actions
(`.github/workflows/android-verify.yml`, Ubuntu 26.04 runners), which can reach Google Maven. Per-user OAuth sign-in for the MCP server was added and checked the same day.

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
| Kotlin, stubs | `kotlinc` 2.4.21 compiles the generated code for three manifests, plus handler implementations, against hand-written stubs of the AppFunctions and Android APIs (`packages/cli/test/fixtures/kotlin-stubs`). Fast, runs with `npm test` | Compiles. |
| Kotlin, real compiler | `verify/android` on GitHub Actions: three generated apps (the example, the example with `delete_item` and `share_list` opted in, and `field-notes.json`, which uses every parameter and result type) built with `assembleDebug` against the real `androidx.appfunctions` 1.0.0 and `appfunctions-compiler` 1.0.0, AGP 9.5.1, Kotlin 2.4.21, KSP 2.3.13, compileSdk 37, minSdk 26. A script then checks KSP generated each service class and a schema XML listing every function | Builds. |
| Kotlin, on a device | The same APKs installed on an Android 17 (API 37) `google_apis` x86_64 emulator; `adb shell cmd app_function list-app-functions` and `execute-app-function` as the generated README describes (see the list below) | Pass. |
| Swift | `tree-sitter-swift` 0.7.1 parses every generated Swift file with no syntax errors (and does flag broken code) | Pass. |
| Discovery, deterministic | The example OpenAPI file drafts a valid 6-action manifest whose backend calls equal the hand-written example's; all targets generate from it | Pass. |
| Builder agent | 34 tests against a **fake** streaming Messages API and a **fake** GitHub API: request shape (`claude-opus-5-5`, adaptive thinking, effort `high`, structured output, `fallbacks: "default"`), SSE parsing (split chunks, fallback blocks, refusals, stream errors), proposal checks (paths, file types, coverage, missing methods), the repair loop, one draft pull request per platform, Git Data API call sequence, refusing writes outside its branch prefix, not rebuilding or reopening, stale-file removal, dry runs and the CLI | Pass. |
| Builder agent on real GitHub | `omnintent build` against the public `parthgarg91/Omnintent` repository from this container | The read calls worked (branch lookup, base commit). Creating the branch was refused by this environment's proxy (403 on `POST /git/trees`), so no real pull request was opened. |
| Watcher agent | 21 tests against a **fake** web: RESEARCH.md baselines are read from the real file, newer npm/AppFunctions/MCP versions are flagged, changed/added/removed page sections are named, unreadable sources keep their snapshot, the fingerprint is stable, and no real network is used | Pass. |
| Watcher, live run | `omnintent watch` from this container on November 24, 2026: 18 of 20 sources read and matched `RESEARCH.md`; two runs in a row gave identical page hashes. The two Cloudflare docs pages are blocked by this container's network policy | 18 of 20 read. |
| Submission helper | 13 tests: every draft file, internal-TestFlight-only wording, Apple's 4,000-byte App Review notes limit, Android exposure matching the safety table, MCP annotations and withheld fields, warnings, and that it works with `fetch` disabled | Pass. |
| Discovery, AI path | Against a **fake** Messages API: request shape (URL, headers, `claude-opus-5-5`, `output_config.format`), conversion, the repair loop, giving up on persistent errors, and the CLI writing nothing when the draft stays invalid | Pass. |
| Tester agent, scoring | **Fake** models: right and wrong actions, argument differences (case, quotes, defaults, dates, numbers), lookups answered from fixtures, one "Yes, go ahead." follow-up, refusals and API errors, write calls never executed, Android cases for hidden actions, repeated runs | Pass. |
| Tester agent, live MCP | The generated server on Node, the mock backend and the official MCP client 2.4.0, with a fake model: tools and read-only flags match `tools/list`, lookups return real (filtered) data, all 12 samples run with **no change to backend state**, edited descriptions over live data, drift between server and manifest | Pass. |
| Tester agent, Claude request | Against a **fake** Messages API: tools with `input_schema`, `tool_choice: auto`, `output_config.effort`, no sampling parameters, no fallback model, retry on 529, no retry on 400; the CLI end to end (report, Markdown, `--fail-under` exit code) | Pass. |
| Siri and Android plans | The SiriEvaluations file follows Apple's documentation (fetched November 24, 2026) and parses with `tree-sitter-swift`; `run-functions.sh` passes `sh -n`; imported results are scored | Pass. |

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

The emulator checks (`verify/android/device-check.sh`):

1. Every function of the three apps is registered with the system, under the ids the README's adb
   commands use (`<package>.omnintent.Base<App>AppFunctionService#<function>`).
2. Functions run and return the handler's data, including `Unit` results.
3. Omitted optional parameters get the manifest defaults (`Int`, `Long`, `Double`, `Boolean`, enum
   strings).
4. Every type decodes when sent as an agent would: nullable scalars, `Long` beyond 32 bits, `LocalDate`,
   `Instant`, `Uri`, primitive arrays, lists of strings, dates and URIs.
5. The generated blank-string check reaches the caller as an `AppFunctionException` with the message.
6. An enum value outside the list is refused by the platform before the app sees it.
7. Opted-in actions (`isEnabled = false`) are registered and refused until the app enables them.

Total: 190 tests across 10 files (`npm test`), all passing with `kotlinc` present, plus the Android GitHub Actions workflow.

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

- **Android 16 not confirmed.** Google says AppFunctions works on Android 16 and later. On the
  Android 16 QPR2 (API 36.1) and Android 16 (API 36) `google_apis` emulator images the system did not
  index the functions ("App function not found"), and the API 36 image has no `cmd app_function` at
  all. The manifest snippet matches Google's documentation exactly. Possibly these images predate the
  platform support, or a Play-updated system module is needed; untested on a real Android 16 phone.
- **Dates, times and links are objects on Android.** AppFunctions sends `LocalDate` as
  `{"year", "month", "dayOfMonth"}`, `Instant` as `{"epochSecond", "nanoAdjustment"}` and `Uri` as
  `{"uri"}`, not as strings. The generated KDoc examples and adb commands use these shapes. Avoid
  describing a format such as "YYYY-MM-DD" in a parameter's description, because Android agents do not
  send that string.
- The platform checks enum values itself, so the generated enum check in the function body only matters
  for callers that skip the platform.
- An app whose actions are all excluded from Android (for example payment-only) gets no Kotlin code,
  because the compiler rejects a service without functions.
- The KSP version (2.3.13) is the one Google's sample uses with Kotlin 2.4.21. Other Kotlin versions
  need the matching KSP release; untested.
- Not tested with Hilt, with the app's own `minSdk` above 26, or in release builds with R8 (shrinking
  could remove classes AppFunctions reads by reflection; untested).
- Not tested with a real agent: Gemini and the Connected Apps Platform integration are untested. The
  emulator run used the `cmd app_function` shell tool, which calls functions directly.

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

### Tester agent

- **Never run against the real Anthropic API** (no key here). Every scored run used fake models.
  How often Claude picks the right action for these samples is unmeasured.
- Claude stands in for the host's model. Real hosts (Claude apps, ChatGPT, Gemini, Meta Muse) add
  their own system prompts, tool-name prefixes, connector settings and confirmation steps, so a
  pass here is evidence, not a guarantee. The iOS and Android projections (`--platform`) only show
  which actions those platforms expose and what they are called; they are not Siri or Gemini.
- The tester answers one clarifying question with "Yes, go ahead." and gives up after that, so an
  agent that asks for a missing value counts as "no action".
- Reads are called for real on `--server`; the manifest's `read` safety and the server's
  `readOnlyHint` must both say read. Point it at staging data. Writes are never executed, so a
  case cannot check that the backend accepts the arguments.
- **The Siri test was not compiled or run.** No Xcode 27.3 or device here. Unconfirmed: that
  `Finds { … .expect(id:) }` can check entity identifiers, that enum, date and URL parameters need a
  report check instead of a matcher, and that a "Yes" turn satisfies confirmation in a scenario.
- **The Android script was not run.** No device or SDK here. The `grep` for each function in
  `list-app-functions` output assumes the output contains `Class#method` identifiers. Results from
  the AppFunctions testing agent and Gemini are recorded by hand; there is no API to script them.

### Discovery

- The AI path was never called against the real Anthropic API (there is no key in this
  environment). The request format follows the documentation (`anthropic-version: 2026-10-21`,
  `output_config.format`); the quality of real proposals is unmeasured.
- Codebase discovery without an OpenAPI file depends on Claude. The route detection that feeds it is
  a set of regular expressions for common web frameworks.

### Builder agent

- **Never called the real Anthropic API** (no key here). The streaming request follows the Claude
  API documentation as of November 24, 2026; whether the real API accepts every field together
  (structured output, adaptive thinking, effort, server-side fallbacks, streaming) is untested.
- **Never opened a real pull request.** The GitHub write path (`git/trees`, `git/commits`,
  `git/refs`, `pulls`) ran only against a fake; this container's proxy blocks those calls on
  github.com. The read calls worked against the real repository.
- **The quality of AI-written glue is unmeasured.** The agent checks paths, file types, coverage
  and that every handler method name appears, but it does not compile Swift or Kotlin or run the
  backend. Wrong types, wrong signatures or wrong business logic can pass these checks; the
  pull request checklist asks a person to build and test.
- The MCP "already present" status is the model's claim from reading the backend code; the agent
  does not call the routes.
- Only about 240 KB of the most relevant source files is sent per platform, ranked by file names.
  In a large app the right files can be missed; the model is told to write a marked stub instead
  of guessing, but that is not guaranteed.
- No shared agent runtime yet: the builder has its own small streaming client
  (`packages/cli/src/builder/claude.ts`). The tester, optimizer and watcher agents may want to
  share it.

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
- **Live tests.** `omnintent agent-test` drives a model; Siri and Android results are imported by
  hand. The optimizer agent is not part of this repository.
- **Not published.** The CLI is not on npm. Run `node packages/cli/dist/cli.js` or `npm link`.
