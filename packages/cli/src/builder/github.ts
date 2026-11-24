// The only GitHub operations the builder agent can perform. It creates a branch
// under its own prefix, commits files to it through the Git Data API, and opens
// a pull request. There is deliberately no merge, no deploy, no write to the
// base branch, no workflow dispatch and no review approval: the human gate is
// enforced by what this client can do, not by a setting.

export interface CommitFile {
  path: string;
  /** New file content, or null to delete the file on the branch. */
  content: string | null;
}

export interface PullRequestInfo {
  number: number;
  url: string;
}

/** The narrow interface the builder uses; tests substitute a fake. */
export interface GitHost {
  branchSha(branch: string): Promise<string | null>;
  commitToNewBranch(input: { branch: string; base: string; message: string; files: CommitFile[] }): Promise<string>;
  findOpenPullRequest(branch: string): Promise<PullRequestInfo | null>;
  openPullRequest(input: { branch: string; base: string; title: string; body: string; draft: boolean }): Promise<PullRequestInfo>;
}

export interface GitHubOptions {
  /** "owner/name". */
  repo: string;
  token: string;
  /** Every ref this client writes must start with `${branchPrefix}/`. */
  branchPrefix: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

export class GitHubRest implements GitHost {
  private readonly api: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GitHubOptions) {
    this.api = (opts.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private assertOwnBranch(branch: string): void {
    if (!branch.startsWith(`${this.opts.branchPrefix}/`)) {
      throw new Error(`refusing to write to branch "${branch}": the builder only writes branches under ${this.opts.branchPrefix}/`);
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, allow404 = false): Promise<T | null> {
    const response = await this.fetchImpl(`${this.api}/repos/${this.opts.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "omnintent-builder",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allow404 && response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed with ${response.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async branchSha(branch: string): Promise<string | null> {
    const ref = await this.request<{ object: { sha: string } }>("GET", `/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, "/")}`, undefined, true);
    return ref?.object.sha ?? null;
  }

  async commitToNewBranch(input: { branch: string; base: string; message: string; files: CommitFile[] }): Promise<string> {
    this.assertOwnBranch(input.branch);
    if (input.branch === input.base) throw new Error("refusing to commit to the base branch");
    if (await this.branchSha(input.branch)) throw new Error(`branch ${input.branch} already exists`);
    const baseSha = await this.branchSha(input.base);
    if (!baseSha) throw new Error(`base branch ${input.base} was not found in ${this.opts.repo}`);
    const baseCommit = (await this.request<{ tree: { sha: string } }>("GET", `/git/commits/${baseSha}`))!;
    const tree = (await this.request<{ sha: string }>("POST", "/git/trees", {
      base_tree: baseCommit.tree.sha,
      tree: input.files.map((f) =>
        f.content === null ? { path: f.path, mode: "100644", type: "blob", sha: null } : { path: f.path, mode: "100644", type: "blob", content: f.content },
      ),
    }))!;
    const commit = (await this.request<{ sha: string }>("POST", "/git/commits", { message: input.message, tree: tree.sha, parents: [baseSha] }))!;
    await this.request("POST", "/git/refs", { ref: `refs/heads/${input.branch}`, sha: commit.sha });
    return commit.sha;
  }

  async findOpenPullRequest(branch: string): Promise<PullRequestInfo | null> {
    const owner = this.opts.repo.split("/")[0];
    const list = (await this.request<{ number: number; html_url: string }[]>("GET", `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`))!;
    return list.length ? { number: list[0].number, url: list[0].html_url } : null;
  }

  async openPullRequest(input: { branch: string; base: string; title: string; body: string; draft: boolean }): Promise<PullRequestInfo> {
    this.assertOwnBranch(input.branch);
    const pr = (await this.request<{ number: number; html_url: string }>("POST", "/pulls", {
      title: input.title,
      head: input.branch,
      base: input.base,
      body: input.body,
      draft: input.draft,
      maintainer_can_modify: true,
    }))!;
    return { number: pr.number, url: pr.html_url };
  }
}
