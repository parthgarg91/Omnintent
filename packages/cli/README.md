# omnintent (CLI)

The command-line tool for the [Omnintent Rule Book](../../SPEC.md). It validates `omnintent.json`,
generates Siri App Intents, Android AppFunctions and a Cloudflare Workers MCP server, drafts
manifests from OpenAPI files or code (optionally with Claude), and checks sample utterances.

```sh
omnintent validate omnintent.json
omnintent generate omnintent.json --target all --out generated
omnintent discover openapi.yaml --out omnintent.json
omnintent test omnintent.json --plan test-plan
omnintent agent-test omnintent.json --server <your-staging-mcp-url> --runs 3 --report agent-report.md
omnintent watch --report watch-report.md          # run from the repository root
omnintent submit-prep omnintent.json --out submission
```

Environment:

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `discover`, `agent-test` | Enables the Claude path (model `claude-opus-5-5`). Required by `agent-test` except with `--import`. |
| `ANTHROPIC_BASE_URL` | `discover`, `agent-test` | Alternative API origin, for gateways or tests. |
| `MCP_ACCESS_TOKEN` | `agent-test --server` | Bearer token for the MCP server under test (another variable with `--token-env`). |

The library API (`import { validateManifest, generate, discover } from "omnintent"`) mirrors the
commands. v0.1 is experimental and not yet published to npm; see the repository README.
