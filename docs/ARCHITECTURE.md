# Architecture

## Components

```
                 OpenAPI file or codebase
                           │
                 omnintent discover ── (optional) Claude, Messages API, structured output
                           │
                           ▼
   schema/omnintent.schema.json ──►  omnintent.json  ◄── human review and edits
                                           │
                                 omnintent validate   (JSON Schema + rule book OI1xx)
                                 omnintent test       (utterance checks T00x, --plan)
                                           │
                                 omnintent generate
                 ┌─────────────────────────┼──────────────────────────┐
                 ▼                         ▼                          ▼
        swift/ App Intents        kotlin/ AppFunctions        mcp/ Cloudflare Worker
        @AppIntent(.tool)         @AppFunctionDeclaration      Streamable HTTP /mcp
        OmnintentHandlers ──►     OmnintentHandlers ──►        proxy ──► developer backend
        the app's code            the app's code
```

| Component | Path | Role |
| --- | --- | --- |
| Rule book | `SPEC.md` | The open standard: what a manifest means and how each platform must treat it. |
| JSON Schema | `schema/omnintent.schema.json` | The manifest's structure, for editors and other implementations. |
| Model and rules | `packages/cli/src/manifest.ts`, `safety.ts`, `schema.ts` | Types, the safety table (one source of truth for every generator), and schema projections such as the agent-visible properties and MCP schemas. |
| Validator | `packages/cli/src/validate.ts` | Ajv (2020-12) structure check, then semantic rules with stable IDs. |
| Generators | `packages/cli/src/generators/` | Pure functions from manifest to file list. They are deterministic and covered by golden-file tests. |
| MCP runtime | `generators/mcp-runtime.ts` | The server code written into every generated Worker: tool registration, confirmation by elicitation, backend proxy, output projection, and inbound auth: a shared token, or per-user OAuth 2.1 sign-in (consent page, backend sign-in, scopes, token refresh) through `@cloudflare/workers-oauth-provider`. |
| Discovery | `packages/cli/src/discover/` | An OpenAPI drafter (deterministic), a codebase summariser, and the Claude path (a closed proposal schema converted, validated and repaired). |
| Test command | `packages/cli/src/testcmd.ts` | Static utterance checks and test-plan export. |
| Watcher agent | `packages/cli/src/agents/watch/` | Source list, extractors (npm, Jetpack release notes, MCP revision, Markdown sections) and the report. |
| Submission helper | `packages/cli/src/agents/submit/` | Store and host drafts from a manifest, reading the same safety table as the generators. |

Design choices:

- **The manifest is MCP-shaped.** Actions are MCP tools plus phone-specific fields, so the MCP
  target is a near-identity mapping and the phone targets add what MCP lacks.
- **Static generation, dynamic handlers.** Apple and Android both index declarations at build time,
  so generated code is static and calls a developer-implemented interface.
- **Safety as data.** A safety level drives MCP annotations, server-side confirmation, Siri's
  authentication policy and confirmation, and whether Android exposes the action at all.
- **Fail closed.** Discovery never writes an invalid manifest. Generators omit an action from a
  platform rather than weaken a safety rule. MCP servers refuse to serve without inbound credentials
  unless explicitly told otherwise, and return only declared fields.

## The agentic roadmap

The goal is that agents do the integration work and people approve it. Each agent below has one
job, works through pull requests or reports, and stops at a human gate. None of them may merge,
deploy, publish or submit on its own.

1. **Discovery agent** (v0.1: `omnintent discover`). Reads a codebase or OpenAPI file and drafts
   `omnintent.json`: actions, safety levels, entities, privacy, descriptions and sample utterances.
   Output is a diff for review. *Human gate:* a developer approves the manifest.
2. **Builder agent** (`omnintent build`, see `docs/BUILDER.md`). On an approved manifest change, it runs `omnintent generate`. It then wires the
   handlers into the app's existing code (Swift `OmnintentHandlers`, Kotlin `OmnintentHandlers`,
   backend routes) and opens a pull request per platform, with a checklist from the generated
   READMEs. *Human gate:* code review and merge.
3. **Tester agent.** Runs the manifest's sample utterances against real agents:
   - Siri, through Apple's SiriEvaluations framework and AppIntentsTesting.
   - Android, through `adb shell cmd app_function` and the AppFunctions testing agent.
   - MCP hosts, through an MCP client driving a model.

   It reports which action each agent chose and with which arguments, compared with
   `expectedTool`/`expectedArguments` from `omnintent test --plan`. *Human gate:* the developer
   decides whether failures block a release.
4. **Optimizer agent.** Uses those results, plus opt-in usage analytics (misrouted requests,
   clarification turns, errors), to propose better titles, descriptions, parameter docs and
   utterances, within the rule book's writing rules. It proves each proposal by re-running the
   tester. *Human gate:* the developer approves manifest diffs; descriptions are product copy.
5. **Watcher agent** (v0.1: `omnintent watch`, `.github/workflows/watcher.yml`). Tracks platform
   changes: the Siri AI Developer Preview and App Intents pages, AppFunctions releases and guides,
   the MCP specification's latest revision and key pages, and the npm versions of the MCP SDK and
   Cloudflare packages (`packages/cli/src/agents/watch/sources.ts`). Version facts are read out of
   `docs/RESEARCH.md` itself and compared with the live value; pages are compared section by section
   with the last snapshot (`docs/watch-state.json`). Every Monday the workflow opens one issue
   listing what moved, with links and the files to re-check, and a pull request that updates the
   snapshot. It does not interpret changes or edit the rule book, generators or `RESEARCH.md`.
   *Human gate:* maintainers read the sources and make spec changes.
6. **Submission helper** (v0.1: `omnintent submit-prep`). Prepares, but does not send (it has no
   network code):
   - App Store and TestFlight notes (remembering that Siri AI preview features only reach internal
     testers).
   - Google Connected Console entries for Gemini (an Android MCP connected app and tester lists).
   - Connector listings for MCP hosts.

   *Human gate:* a person submits.

Constraints that apply to every agent:

- Agents use least privilege: read access to code, write access only to branches, and no production
  secrets.
- Every change is a reviewable diff with sources.
- An agent never weakens a safety level, removes a confirmation, or widens what data leaves the
  device without an explicit human decision recorded in the manifest.

## What a request looks like at runtime

```
Person: "Delete the eggs item"
  Siri:    picks DeleteItemIntent ─► resolves item via TodoItemEntityQuery ─► requestConfirmation
           ─► OmnintentHandlers.deleteItem(itemId:) ─► app code
  Android: (not exposed: destructive actions need an app-provided confirmation)
  MCP:     host calls tools/call delete_item ─► server returns input_required (elicitation)
           ─► user confirms ─► client retries ─► DELETE /items/item-2 on the backend
```
