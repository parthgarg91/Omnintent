# What is verified, and what is not

Omnintent v0.1 is experimental. Everything below was checked on November 24, 2026, in a Linux
container with Node.js 22.23, no Swift toolchain, no Android SDK, and Google Maven blocked by the
network policy.

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

The 7 end-to-end checks run on each runtime:

1. Requests without the access token get 401.
2. `tools/list` returns 6 tools with the right annotations and schemas.
3. Add, list and complete change the backend state; internal `notes` never appear.
4. `delete_item` asks through elicitation; a decline leaves the item and an accept deletes it.
5. The opted-in confirmation on `share_list` works, and an undeclared backend field is stripped.
6. Bad arguments and a backend 404 come back as tool errors, and the backend is unchanged.
7. A 2025-era client lists and calls tools through the stateless fallback.

Total: 175 tests across 10 files (`npm test`). 174 passed in this run; the Kotlin compile test was skipped because `kotlinc` was not downloaded this time.

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
- **OAuth is not implemented.** Inbound access is a single pre-shared bearer token
  (`MCP_ACCESS_TOKEN`), and every caller shares one backend account (`BACKEND_TOKEN`). The OAuth 2.1
  path (`@cloudflare/workers-oauth-provider`, Protected Resource Metadata) is documented as the next
  step, not generated. Whether each host accepts a static bearer header was not verified.
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
