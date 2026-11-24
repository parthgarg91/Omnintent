# omnintent (CLI)

The command-line tool for the [Omnintent Rule Book](../../SPEC.md). It validates `omnintent.json`,
generates Siri App Intents, Android AppFunctions and a Cloudflare Workers MCP server, drafts
manifests from OpenAPI files or code (optionally with Claude), and checks sample utterances.

```sh
omnintent validate omnintent.json
omnintent generate omnintent.json --target all --out generated
omnintent discover openapi.yaml --out omnintent.json
omnintent test omnintent.json --plan test-plan
omnintent watch --report watch-report.md          # run from the repository root
omnintent submit-prep omnintent.json --out submission
```

Environment:

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `discover` | Enables the Claude path (model `claude-opus-5-5`). |
| `ANTHROPIC_BASE_URL` | `discover` | Alternative API origin, for gateways or tests. |

The library API (`import { validateManifest, generate, discover } from "omnintent"`) mirrors the
commands. v0.1 is experimental and not yet published to npm; see the repository README.
