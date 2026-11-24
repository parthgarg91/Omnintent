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
| MCP runtime | `generators/mcp-runtime.ts` | The server code written into every generated Worker: tool registration, confirmation by elicitation, backend proxy, output projection and inbound auth. |
| Discovery | `packages/cli/src/discover/` | An OpenAPI drafter (deterministic), a codebase summariser, and the Claude path (a closed proposal schema converted, validated and repaired). |
| Test command | `packages/cli/src/testcmd.ts` | Static utterance checks and test-plan export. |
| Tester agent | `packages/cli/src/agents/` | `omnintent agent-test`: Claude plays the agent against the tools a host sees (live MCP server or manifest projection) and the tester reports the action and arguments it chose. Also the Siri and Android device plans and result import. |

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
2. **Builder agent.** On an approved manifest change, it runs `omnintent generate`. It then wires the
   handlers into the app's existing code (Swift `OmnintentHandlers`, Kotlin `OmnintentHandlers`,
   backend routes) and opens a pull request per platform, with a checklist from the generated
   READMEs. *Human gate:* code review and merge.
3. **Tester agent** (`omnintent agent-test`). Runs the manifest's sample utterances against agents:
   - MCP hosts: an MCP client lists the server's tools, and Claude (Messages API, tool use) plays
     the host's model. Read-only tools are called so the agent can look up IDs; the first call to
     any other tool is recorded as the decision and never executed. Without a server, the tools are
     projected from the manifest for MCP, iOS or Android, and lookups are answered from fixtures.
   - Siri: `omnintent test --plan` writes a SiriEvaluations test (Xcode 27.3+, physical device).
   - Android: the plan writes an adb script that runs each expected call, and a checklist for the
     AppFunctions testing agent or Gemini.

   Device results go into a `results.json` template, and `agent-test --import` reports them the
   same way. The report shows which action each agent chose and with which arguments, next to
   `expectedTool`/`expectedArguments`, with pass rates over repeated runs. *Human gate:* the
   developer decides whether failures block a release (`--fail-under` for CI).
4. **Optimizer agent.** Uses those results, plus opt-in usage analytics (misrouted requests,
   clarification turns, errors), to propose better titles, descriptions, parameter docs and
   utterances, within the rule book's writing rules. It proves each proposal by re-running the
   tester. *Human gate:* the developer approves manifest diffs; descriptions are product copy.
   The optimizer is part of the hosted Omnintent service and is not in this repository. It builds
   on the open tester: anyone can run `agent-test` and edit descriptions by hand.
5. **Watcher agent.** Tracks platform changes, such as Siri AI preview API changes, AppFunctions
   releases, MCP revisions and host connector requirements. It opens issues or pull requests against
   the rule book and generators, citing sources, the way `docs/RESEARCH.md` does. *Human gate:*
   maintainers review spec changes.
6. **Submission helper.** Prepares, but does not send:
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
