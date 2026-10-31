import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import {
  assert,
  GitHubError,
  concat,
  gitHash,
  LIMITS,
  parseRepository,
  utf8,
  validateText,
  validatePrepared,
  type PreparedPublish,
} from "./manifest.js";
import { planTree } from "./tree.js";

export interface AppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}
export type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
export interface SelectedRepository {
  id: number;
  repository: string;
  defaultBranch: string;
  baseSha: string;
}
export interface PublishResult {
  headSha: string;
  branch: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  digest: string;
}
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const refSchema = z.object({
  object: z.object({ sha: shaSchema, type: z.literal("commit") }),
});
const commitSchema = z.object({
  sha: shaSchema,
  tree: z.object({ sha: shaSchema }),
  parents: z.array(z.object({ sha: shaSchema })),
});
const pullSchema = z.object({
  title: z.string(),
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  body: z.string().nullable(),
  head: z.object({
    sha: shaSchema,
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }),
  }),
});
type Pull = z.infer<typeof pullSchema>;
const API = "https://api.github.com";
const shaResult = z.object({ sha: shaSchema });

/** Trusted Worker-only service. Membership, approval, serialization and durable receipts belong to the caller. */
export class GitHubService {
  private readonly fetcher: Fetch;
  constructor(
    private readonly config: AppConfig,
    fetcher: Fetch,
  ) {
    assert(
      /^\d+$/.test(config.appId) && /^\d+$/.test(config.installationId),
      "Invalid App/installation ID",
    );
    this.fetcher = (input, init) => fetcher(input, init);
  }
  private async json(
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
    allow404 = false,
  ): Promise<unknown | null> {
    const response = await this.fetcher(`${API}${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "multipi-github",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok)
      throw new GitHubError(
        `GitHub ${method} request failed (${response.status}); reconcile before retrying`,
        "github_http",
        response.status,
      );
    return response.json();
  }
  /** Token never crosses the Worker boundary; each mint is scoped to one installation repository. */
  private async token(
    repository: string,
    access: "read" | "publish",
  ): Promise<string> {
    parseRepository(repository);
    const now = Math.floor(Date.now() / 1000);
    const key = await importPKCS8(this.config.privateKey, "RS256");
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(this.config.appId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 540)
      .sign(key);
    const result = z
      .object({
        token: z.string().min(1),
        permissions: z
          .object({
            contents: z.string(),
            pull_requests: z.string().optional(),
          })
          .passthrough(),
      })
      .parse(
        await this.json(
          `/app/installations/${this.config.installationId}/access_tokens`,
          jwt,
          "POST",
          {
            repositories: [repository.split("/")[1]],
            permissions:
              access === "read"
                ? { contents: "read" }
                : { contents: "write", pull_requests: "write" },
          },
        ),
      );
    assert(
      result.permissions.contents === (access === "read" ? "read" : "write"),
      "Unexpected installation token permissions",
    );
    assert(
      access !== "read" ||
        !Object.entries(result.permissions).some(
          ([k, v]) => k !== "contents" && k !== "metadata" && v !== "read",
        ),
      "Read token has write permissions",
    );
    assert(
      access !== "publish" || result.permissions.pull_requests === "write",
      "Missing PR permission",
    );
    return result.token;
  }
  private async resolve(
    repository: string,
    base: string,
    token: string,
  ): Promise<SelectedRepository> {
    parseRepository(repository);
    assert(
      base.length > 0 && base.length <= 256 && !/[\x00-\x1f]/.test(base),
      "Invalid base ref",
    );
    const repo = z
      .object({
        id: z.number().int().positive(),
        full_name: z.string(),
        default_branch: z.string(),
        fork: z.boolean(),
        archived: z.boolean(),
        disabled: z.boolean().optional(),
      })
      .parse(await this.json(`/repos/${repository}`, token));
    // Installation-token scopes and authenticated reads establish access, not user permission flags.
    assert(
      repo.full_name === repository &&
        !repo.fork &&
        !repo.archived &&
        !repo.disabled,
      "Repository is not canonical/accessible",
      "repository_policy",
    );
    const commit = z
      .object({ sha: shaSchema })
      .parse(
        await this.json(
          `/repos/${repository}/commits/${encodeURIComponent(base)}`,
          token,
        ),
      );
    return {
      id: repo.id,
      repository,
      defaultBranch: repo.default_branch,
      baseSha: commit.sha,
    };
  }
  /** Caller must enforce repo-sharing policy; installation scope is not user authorization. */
  async resolveRepository(
    repository: string,
    base: string,
  ): Promise<SelectedRepository> {
    return this.resolve(repository, base, await this.token(repository, "read"));
  }
  /** Only Git smart-HTTP upload-pack. No client headers/credentials are forwarded, and redirects are never followed. */
  async brokerRead(repository: string, request: Request): Promise<Response> {
    parseRepository(repository);
    const root = `https://github.com/${repository}.git`;
    const discovery =
      request.method === "GET" &&
      request.url === `${root}/info/refs?service=git-upload-pack`;
    const upload =
      request.method === "POST" && request.url === `${root}/git-upload-pack`;
    assert(
      discovery || upload,
      "Only selected repository upload-pack endpoints are permitted",
      "broker_denied",
    );
    assert(
      !upload ||
        request.headers.get("Content-Type")?.toLowerCase() ===
          "application/x-git-upload-pack-request",
      "Invalid upload-pack content type",
      "broker_denied",
    );
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (upload && request.body) {
      const reader = request.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          assert(
            size <= LIMITS.uploadPackBytes,
            "Upload-pack request size limit exceeded",
            "broker_denied",
          );
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }
    const token = await this.token(repository, "read");
    const headers = new Headers({
      Authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
      "User-Agent": "multipi-github",
    });
    if (upload)
      headers.set("Content-Type", "application/x-git-upload-pack-request");
    if (request.headers.get("Git-Protocol") === "version=2")
      headers.set("Git-Protocol", "version=2");
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      ...(upload ? { body: new Uint8Array(concat(...chunks)).buffer } : {}),
    });
    assert(
      response.ok,
      `Git upload-pack failed (${response.status})`,
      "broker_upstream",
    );
    const contentType = discovery
      ? "application/x-git-upload-pack-advertisement"
      : "application/x-git-upload-pack-result";
    assert(
      response.headers.get("Content-Type")?.split(";")[0] === contentType,
      "Unexpected upload-pack response",
      "broker_upstream",
    );
    return new Response(response.body, {
      status: 200,
      headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
    });
  }
  private async ref(
    repository: string,
    branch: string,
    token: string,
  ): Promise<string | null> {
    const result = await this.json(
      `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
      token,
      "GET",
      undefined,
      true,
    );
    return result === null ? null : refSchema.parse(result).object.sha;
  }
  private async pulls(
    repository: string,
    owner: string,
    branch: string,
    token: string,
  ): Promise<Pull[]> {
    const query = new URLSearchParams({
      state: "all",
      head: `${owner}:${branch}`,
      per_page: "100",
    });
    const pulls = z
      .array(pullSchema)
      .parse(await this.json(`/repos/${repository}/pulls?${query}`, token));
    assert(pulls.length < 100, "PR reconciliation result limit exceeded");
    return pulls;
  }
  /**
   * Publish only the persisted, approved prepared payload; this confers no approval authority.
   * Commits are unsigned. Caller must surface incompatible signing/ruleset requirements before delivery.
   */
  async publish(input: PreparedPublish): Promise<PublishResult> {
    const prepared = await validatePrepared(input);
    const { manifest: m, actor, timestamp, digest } = prepared;
    const token = await this.token(m.repository, "publish");
    const repo = await this.resolve(m.repository, m.baseSha, token);
    assert(repo.baseSha === m.baseSha, "Base SHA changed");
    const branch = `multipi/${m.roomId}`;
    assert(branch !== repo.defaultBranch, "Cannot write default branch");
    const prefix = `/repos/${m.repository}`;
    // Draft PRs target the canonical default branch; recorded base must still be in its history.
    const comparison = z
      .object({ status: z.enum(["ahead", "behind", "identical", "diverged"]) })
      .parse(
        await this.json(
          `${prefix}/compare/${encodeURIComponent(repo.defaultBranch)}...${m.baseSha}`,
          token,
        ),
      );
    assert(
      ["behind", "identical"].includes(comparison.status),
      "Base is not in default-branch history",
      "base_diverged",
    );
    const base = commitSchema.parse(
      await this.json(`${prefix}/git/commits/${m.baseSha}`, token),
    );
    assert(base.sha === m.baseSha, "Base commit mismatch");
    const tree = z
      .object({
        sha: shaSchema,
        truncated: z.boolean(),
        tree: z
          .array(
            z.object({
              path: z.string(),
              mode: z.enum(["040000", "100644", "100755", "120000", "160000"]),
              type: z.enum(["blob", "tree", "commit"]),
              sha: shaSchema,
            }),
          )
          .max(LIMITS.treeEntries),
      })
      .parse(
        await this.json(
          `${prefix}/git/trees/${base.tree.sha}?recursive=1`,
          token,
        ),
      );
    assert(
      !tree.truncated && tree.sha === base.tree.sha,
      "Incomplete repository tree",
    );
    const plan = await planTree(tree.tree, m);
    // Replacing/deleting an existing binary or LFS pointer is unsupported too.
    let oldBytes = 0;
    for (const file of m.files) {
      const old = tree.tree.find((e) => e.path === file.path);
      if (!old) continue;
      const blob = z
        .object({
          sha: shaSchema,
          size: z.number().int().nonnegative().max(LIMITS.fileBytes),
          encoding: z.literal("base64"),
          content: z.string().max(2 * LIMITS.fileBytes),
        })
        .parse(await this.json(`${prefix}/git/blobs/${old.sha}`, token));
      assert(blob.sha === old.sha, "Base blob SHA mismatch");
      const bytes = Uint8Array.from(
        atob(blob.content.replace(/\s/g, "")),
        (c) => c.charCodeAt(0),
      );
      assert(
        bytes.length === blob.size &&
          (await gitHash("blob", bytes)) === old.sha,
        "Base blob content mismatch",
      );
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new GitHubError("Binary base content is unsupported");
      }
      validateText(text);
      oldBytes += bytes.length;
      assert(oldBytes <= LIMITS.totalBytes, "Base content size limit exceeded");
    }
    const parent = m.expectedHead ?? m.baseSha;
    if (m.expectedHead !== null) {
      const history = z
        .object({ status: z.string() })
        .parse(
          await this.json(
            `${prefix}/compare/${m.baseSha}...${m.expectedHead}`,
            token,
          ),
        );
      assert(
        ["ahead", "identical"].includes(history.status),
        "Expected head diverges from base",
        "head_diverged",
      );
    }
    const marker = `<!-- multipi-operation:${digest} -->`;
    const message = `${m.title}\n\nmultipi-operation:${digest}`;
    const seconds = Math.floor(Date.parse(timestamp) / 1000);
    const ident = `${actor.name} <${actor.email}> ${seconds} +0000`;
    const expectedSha = await gitHash(
      "commit",
      utf8(
        `tree ${plan.sha}\nparent ${parent}\nauthor ${ident}\ncommitter ${ident}\n\n${message}\n`,
      ),
    );
    const body = `${m.body}\n\n${marker}`;
    const head = await this.ref(m.repository, branch, token);
    assert(
      head === expectedSha || head === m.expectedHead,
      "Branch differs from approved expected head",
      "head_conflict",
    );
    const pulls = await this.pulls(
      m.repository,
      m.repository.split("/")[0]!,
      branch,
      token,
    );
    assert(pulls.length <= 1, "Ambiguous branch PR history", "pr_conflict");
    const existing = pulls[0];
    if (existing) {
      assert(
        existing.state === "open" &&
          existing.draft &&
          existing.head.repo?.full_name === m.repository &&
          existing.base.repo.full_name === m.repository &&
          existing.head.ref === branch &&
          existing.base.ref === repo.defaultBranch &&
          existing.head.sha === head,
        "Existing PR does not match canonical draft destination",
        "pr_conflict",
      );
      assert(
        existing.body?.match(/<!-- multipi-operation:[0-9a-f]{64} -->/g)
          ?.length === 1,
        "Existing PR lacks unambiguous operation marker",
        "pr_conflict",
      );
      if (existing.body.includes(marker)) {
        assert(
          head === expectedSha &&
            existing.body === body &&
            existing.title === m.title,
          "Operation marker/payload mismatch",
          "pr_conflict",
        );
        return this.result(existing, expectedSha, branch, digest, m.repository);
      }
      assert(m.expectedHead !== null, "Unexpected existing PR", "pr_conflict");
    }
    if (head !== expectedSha) {
      for (const [i, file] of m.files.entries()) {
        if (file.content === null) continue;
        const blob = shaResult.parse(
          await this.json(`${prefix}/git/blobs`, token, "POST", {
            content: file.content,
            encoding: "utf-8",
          }),
        );
        assert(blob.sha === plan.changes[i]!.sha, "Blob SHA mismatch");
      }
      const createdTree = shaResult.parse(
        await this.json(`${prefix}/git/trees`, token, "POST", {
          base_tree: base.tree.sha,
          tree: plan.changes,
        }),
      );
      assert(createdTree.sha === plan.sha, "Tree SHA mismatch");
      const identity = {
        name: actor.name,
        email: actor.email,
        date: timestamp,
      };
      const commit = shaResult.parse(
        await this.json(`${prefix}/git/commits`, token, "POST", {
          message: `${message}\n`,
          tree: plan.sha,
          parents: [parent],
          author: identity,
          committer: identity,
        }),
      );
      assert(
        commit.sha === expectedSha,
        "Commit SHA mismatch; provider bytes must match prepared operation",
      );
      // Recheck immediately before mutation. GitHub has no ref CAS; force:false also prevents divergent races.
      assert(
        (await this.ref(m.repository, branch, token)) === m.expectedHead,
        "Branch changed during publication",
        "head_conflict",
      );
      if (m.expectedHead === null) {
        const ref = refSchema.parse(
          await this.json(`${prefix}/git/refs`, token, "POST", {
            ref: `refs/heads/${branch}`,
            sha: expectedSha,
          }),
        );
        assert(ref.object.sha === expectedSha, "Created ref SHA mismatch");
      } else {
        const ref = refSchema.parse(
          await this.json(
            `${prefix}/git/refs/heads/${encodeURIComponent(branch)}`,
            token,
            "PATCH",
            { sha: expectedSha, force: false },
          ),
        );
        assert(ref.object.sha === expectedSha, "Updated ref SHA mismatch");
      }
    }
    const pr = pullSchema.parse(
      await this.json(
        existing ? `${prefix}/pulls/${existing.number}` : `${prefix}/pulls`,
        token,
        existing ? "PATCH" : "POST",
        existing
          ? { title: m.title, body }
          : {
              title: m.title,
              body,
              head: branch,
              base: repo.defaultBranch,
              draft: true,
              maintainer_can_modify: false,
            },
      ),
    );
    assert(
      pr.state === "open" &&
        pr.draft &&
        pr.title === m.title &&
        pr.head.sha === expectedSha &&
        pr.body === body &&
        pr.head.ref === branch &&
        pr.head.repo?.full_name === m.repository &&
        pr.base.ref === repo.defaultBranch &&
        pr.base.repo.full_name === m.repository,
      "Published PR response mismatch",
    );
    return this.result(pr, expectedSha, branch, digest, m.repository);
  }
  private result(
    pr: Pull,
    headSha: string,
    branch: string,
    digest: string,
    repository: string,
  ): PublishResult {
    assert(
      pr.html_url === `https://github.com/${repository}/pull/${pr.number}`,
      "Unexpected PR URL",
    );
    return {
      headSha,
      branch,
      pullRequestNumber: pr.number,
      pullRequestUrl: pr.html_url,
      digest,
    };
  }
}
