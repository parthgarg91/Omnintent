# The builder agent

`omnintent build` is agent 2 of the roadmap in `docs/ARCHITECTURE.md`. After a manifest change is
approved (merged), it:

1. Validates `omnintent.json` and compares it with the previous version (`--since <git-ref>`).
2. Regenerates each configured platform with the same generators as `omnintent generate`, and
   removes generated files for actions that no longer exist.
3. Asks Claude to write the glue between the generated code and your app:
   - **Swift:** a type that implements `OmnintentHandlers` with your existing models and services,
     plus `OmnintentRuntime.register(...)` at launch when the app entry point is visible.
   - **Kotlin:** an `OmnintentHandlers` implementation, plus `OmnintentHandlersProvider` on your
     `Application` class when it is visible.
   - **MCP:** the backend routes the MCP server calls. Routes that already exist are reported as
     "already present"; missing ones are added in your backend's own framework.
4. Opens **one draft pull request per platform**. Each has the manifest changes, the files, a
   coverage table (implemented, already present, or stub), and a checklist built from the generated
   README plus the model's own to-do items.

It stops there. A person reviews, builds, tests and merges.

## The human gate is built in

- The GitHub client can only read refs, create a branch under its own prefix
  (`omnintent/build/...` by default), commit to that new branch, and open a pull request. It has no
  merge, deploy, approve, delete or workflow-dispatch call, and it refuses any branch outside its
  prefix, including the base branch.
- It never rebuilds a manifest it already built. If you close its pull request, it does not reopen it;
  delete the branch to build again.
- The model gets **no tools**. It returns one JSON document (structured output) with the files it
  proposes. The agent rejects, and sends back for at most two repairs, any proposal that writes
  outside your configured source folders, edits generated code, uses an unexpected file type,
  touches `.github/`, `.env`, keys, lockfiles or files with "secret" or "credential" in the path,
  changes more than 8 files, or leaves a handler method or route unaccounted for. If it is still
  invalid, nothing is pushed.
- Your code is sent to the model as data, and the system prompt says to ignore instructions found in
  it. Folders such as `node_modules`, `build`, `Pods` and `.git` are never read, and at most about
  240 KB of the most relevant source files is sent per platform.

## Configure it

Add `omnintent.builder.json` next to your repository root:

```json
{
  "repo": "your-org/your-app",
  "baseBranch": "main",
  "manifest": "omnintent.json",
  "platforms": {
    "swift": {
      "generatedDir": "ios/OmnintentGenerated",
      "sourceDirs": ["ios/YourApp"],
      "handlersFile": "ios/YourApp/Omnintent/AppOmnintentHandlers.swift"
    },
    "kotlin": {
      "generatedDir": "android/app/omnintent",
      "sourceDirs": ["android/app/src/main/kotlin"]
    },
    "mcp": {
      "generatedDir": "mcp-server",
      "sourceDirs": ["server/src"]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `repo` | `owner/name` on GitHub. |
| `baseBranch` | Branch pull requests target (default `main`). Never written to. |
| `manifest` | Path of `omnintent.json` (default `omnintent.json`). |
| `branchPrefix` | Prefix for the agent's branches (default `omnintent/build`). |
| `draft` | Open pull requests as drafts (default `true`). |
| `platforms.<p>.generatedDir` | Where that platform's generated files live. |
| `platforms.<p>.sourceDirs` | Your hand-written code the agent may read and change. Must not be inside `generatedDir`. |
| `platforms.<p>.handlersFile` | Optional: where to put the handlers implementation. |

## Run it

```sh
# See what it would do, without GitHub (and without AI if no key is set):
omnintent build --since HEAD~1 --dry-run /tmp/omnintent-plan

# Real run:
ANTHROPIC_API_KEY=... GITHUB_TOKEN=... omnintent build --since HEAD~1
```

| Option or variable | Meaning |
| --- | --- |
| `--config <file>` | Config file (default `omnintent.builder.json`). Paths in it are relative to its folder. |
| `--since <git-ref>` | Compare with the manifest at that ref. Without it, every action counts as new. |
| `--platform swift,kotlin,mcp` | Only these configured platforms. |
| `--dry-run <dir>` | Write each planned branch (`files/`) and pull request (`PR.md`) to a folder instead. |
| `--no-ai` | Skip the wiring step; the pull request only updates generated code and lists the methods to write. |
| `--model <id>` | Model for wiring (default `claude-opus-5-5`). |
| `ANTHROPIC_API_KEY` | Enables wiring. Without it, the agent only regenerates code. |
| `GITHUB_TOKEN` (or `GH_TOKEN`) | Needed unless `--dry-run`. |
| `ANTHROPIC_BASE_URL`, `GITHUB_API_URL` | Other API origins (gateways, GitHub Enterprise, tests). |

The wiring request uses `claude-opus-5-5` with adaptive thinking, effort `high`, structured output,
streaming, and server-side refusal fallbacks (`fallbacks: "default"`, beta
`server-side-fallback-2026-07-01`). Fallbacks are not available on Amazon Bedrock, Vertex AI or
Microsoft Foundry; the library option `fallbacks: false` turns them off.

Node's built-in `fetch` ignores `HTTPS_PROXY` unless you set `NODE_USE_ENV_PROXY=1` (Node 22.21 and
later).

## Least privilege

Give the agent a token that can only do what it needs:

- A fine-grained personal access token or GitHub App limited to the one repository, with
  **Contents: read and write** (to create branches) and **Pull requests: read and write**. Nothing
  else.
- Protect your base branch with a ruleset that requires a pull request and a review, so that even a
  leaked token cannot push to it.
- No production secrets in the job. The agent needs only the Anthropic key and the GitHub token.

## Run it in GitHub Actions on every merged manifest change

This workflow is an example to copy into your app's repository; it is not installed in this one.

```yaml
name: omnintent-build
on:
  push:
    branches: [main]
    paths: [omnintent.json]
permissions:
  contents: write        # create omnintent/build/* branches
  pull-requests: write   # open the pull requests
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 2
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npx omnintent build --since ${{ github.event.before }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.OMNINTENT_BUILDER_TOKEN }}
```

Notes:

- Omnintent is not on npm yet, so `npx omnintent` needs the package installed from a checkout of
  this repository for now.
- With the built-in `GITHUB_TOKEN`, the repository setting "Allow GitHub Actions to create and
  approve pull requests" must be on, and pull requests it opens do not trigger your other workflows.
  A fine-grained token or GitHub App token (as above) avoids both.
