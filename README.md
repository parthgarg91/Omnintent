# Omnintent

**Describe your app's actions once. Reach Siri, Gemini on Android, and every MCP agent.**

Status: **v0.1, experimental.** The platform APIs it targets are themselves previews or brand new.
Read [docs/LIMITATIONS.md](docs/LIMITATIONS.md) before you rely on it.

## The problem

AI agents now act inside apps, but every platform wants its own integration:

- **Siri** (Siri AI Developer Preview) calls App Intents that you mark as tools in Swift.
- **Gemini on Android** calls AppFunctions that you declare in Kotlin (Android 16+).
- **Cloud agents** (Claude, ChatGPT, Gemini Spark, Meta Muse and others) call MCP servers.

That is three codebases, three description formats and three sets of safety rules for the same
"add an item to my list". They drift apart, and the descriptions agents depend on get written three
times, badly.

## How it works

1. **Discover.** `omnintent discover` drafts `omnintent.json` from your OpenAPI file or codebase.
   With an Anthropic API key, Claude writes the descriptions and sample utterances; without one, a
   deterministic OpenAPI path still works. You review a draft instead of writing from scratch.
2. **Describe.** The manifest lists your actions as MCP-style tools (name, title, description, JSON
   Schema inputs and outputs). It adds what phones need: a safety level (read, write, destructive or
   payment), entities with privacy settings, confirmation prompts, and sample utterances.
3. **Check.** `omnintent validate` applies the [rule book](SPEC.md): unique snake_case names, real
   descriptions, at least two sample utterances per action, and confirmation for destructive and
   payment actions. `omnintent test` checks that each utterance matches its expected arguments.
   `omnintent agent-test` plays the utterances to Claude acting as an agent with your tools and
   reports which action it chose, with which arguments; `test --plan` writes the same cases for
   Siri (a SiriEvaluations test) and Android (adb and an agent checklist).
4. **Generate.** `omnintent generate` writes three things:
   - Swift `@AppIntent(.tool)` intents and entities.
   - A Kotlin `AppFunctionService` with KDoc written from your descriptions.
   - A Cloudflare Workers MCP server that forwards each tool call to your existing backend.

   Your app implements one small handler interface per platform. Safety levels become MCP
   annotations and server-side confirmation, Siri authentication policies and `requestConfirmation`,
   and Android rules about what may be exposed at all.

## Quickstart

Requires Node.js 22.18 or later.

```sh
npm install
npm run build

# Try the example: a to-do app with six actions.
node packages/cli/dist/cli.js validate examples/todo/omnintent.json
node packages/cli/dist/cli.js test examples/todo/omnintent.json --plan /tmp/todo-plan
node packages/cli/dist/cli.js generate examples/todo/omnintent.json --target all --out /tmp/todo-out

# See which action an agent picks for each sample (needs ANTHROPIC_API_KEY; makes API calls).
node packages/cli/dist/cli.js agent-test examples/todo/omnintent.json --fixtures examples/todo/tester-fixtures.json

# Draft a manifest from an OpenAPI file (set ANTHROPIC_API_KEY to let Claude refine it).
node packages/cli/dist/cli.js discover examples/todo/openapi.yaml --out /tmp/omnintent.json

# Run the generated MCP server against the mock backend, which has its own sign-in page.
PORT=8788 node examples/todo/mock-backend/server.mjs &
cd examples/todo/generated/mcp
PORT=8787 MCP_SERVER_URL=http://127.0.0.1:8787 BACKEND_OAUTH_CLIENT_ID=todo-mcp \
  BACKEND_OAUTH_CLIENT_SECRET=todo-mcp-secret npm run start:node   # or: npm run dev (wrangler)
# MCP endpoint: http://127.0.0.1:8787/mcp. An MCP client that supports OAuth opens a consent
# page, then the mock sign-in (any user name works). Each user gets their own to-do lists.
```

The example signs each person in with OAuth 2.1 (SPEC.md section E.5). A backend without its own
OAuth server can use one shared token instead (section E.4).

Run everything (build, type checks, 188 tests including end-to-end MCP with OAuth sign-in on Node and
workerd):

```sh
npm test
```

The Kotlin compile check runs when `kotlinc` is available. `scripts/fetch-kotlinc.sh` downloads it
from GitHub releases into `.tools/`.

## Commands

| Command | What it does |
| --- | --- |
| `omnintent validate <manifest> [--json]` | JSON Schema plus rule book checks, with rule IDs and paths. |
| `omnintent generate <manifest> --target swift\|kotlin\|mcp\|all --out <dir>` | Deterministic code generation. |
| `omnintent discover <openapi-file\|dir> [--out omnintent.json] [--no-ai] [--model <id>]` | Drafts a manifest. It never writes an invalid one. |
| `omnintent test <manifest> [--plan <dir>]` | Utterance checks, plus test plans for SiriEvaluations, adb and MCP. |
| `omnintent build [--since <ref>] [--dry-run <dir>]` | Builder agent: regenerates code, has Claude wire it into your app, and opens one draft pull request per platform. Never merges. See `docs/BUILDER.md`. |
| `omnintent agent-test <manifest> [--server <url>] [--platform mcp\|ios\|android] [--runs <n>]` | Claude plays the agent; reports the action and arguments it chose for each sample. `--import` reads results recorded on Siri or Android. |
| `omnintent watch [--update-state] [--report <file>]` | Watcher agent: checks Apple, Android, MCP and Cloudflare sources against `docs/RESEARCH.md` and reports what moved. Runs weekly in GitHub Actions and opens an issue. |
| `omnintent submit-prep <manifest> --out <dir>` | Submission helper: drafts TestFlight notes, a Google Connected Console entry and an MCP connector listing. It never sends anything. |

## Repository

```
SPEC.md                        Omnintent Rule Book v0.1 (the open standard)
schema/omnintent.schema.json   JSON Schema for omnintent.json
packages/cli/                  The omnintent CLI (TypeScript)
examples/todo/                 Example manifest, OpenAPI file, mock backend, generated output
docs/RESEARCH.md               Platform research with sources (November 2026)
docs/ARCHITECTURE.md           Components and the agentic roadmap
docs/BUILDER.md                The builder agent: setup, safety, GitHub Actions example
docs/LIMITATIONS.md            What is and is not verified
docs/watch-state.json          The watcher agent's last snapshot of the sources it tracks
.github/workflows/watcher.yml  Weekly watcher run that opens issues and snapshot pull requests
```

## Safety in one table

| Safety | MCP | Siri | Android |
| --- | --- | --- | --- |
| read | `readOnlyHint` | no confirmation | exposed |
| write | hints; optional confirmation | requires authentication; optional confirmation | exposed (opt-in if it needs confirmation) |
| destructive | `destructiveHint`; confirmation by elicitation, else the host confirms | `requestConfirmation`, destructive button | opt-in only, generated disabled |
| payment | confirmation by elicitation, refused otherwise | local-device authentication, `.pay` confirmation | never |

Details are in [SPEC.md section C](SPEC.md#c-safety-levels-and-confirmation).

## Contributing

The rule book is meant to be implemented by others. Issues and pull requests that improve the spec,
add a platform mapping, or report a platform API change (with a source) are welcome.

## License

MIT. Copyright (c) 2026 Omnintent contributors.
