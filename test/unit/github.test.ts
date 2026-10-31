import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import {
  GitHubService,
  LIMITS,
  preparePublish,
  type AppConfig,
  type PreparedPublish,
  type PublishManifest,
} from "../../src/github/index.js";
import type { GitTreeEntry } from "../../src/github/tree.js";

const repository = "acme/project";
const roomId = "12345678-1234-4234-8234-123456789abc";
const branch = `multipi/${roomId}`;
const baseSha = "a".repeat(40);
const actor = {
  id: "user-7",
  name: "Human Reviewer",
  email: "reviewer@example.com",
};
const timestamp = "2026-01-02T03:04:05Z";
const manifest = (): PublishManifest => ({
  roomId,
  repository,
  baseSha,
  expectedHead: null,
  title: "Reviewed change",
  body: "Exact immutable change",
  files: [
    { path: "README.md", content: "new text\n", mode: "100644" },
    { path: "src/run.sh", content: "#!/bin/sh\necho ok\n", mode: "100755" },
  ],
});
const hash = (type: string, bytes: Buffer | string): string => {
  const data = Buffer.from(bytes);
  return createHash("sha1")
    .update(`${type} ${data.length}\0`)
    .update(data)
    .digest("hex");
};
function treeHash(entries: GitTreeEntry[], root = ""): string {
  const immediate = new Map<string, GitTreeEntry>();
  for (const entry of entries) {
    if (!entry.path.startsWith(root)) continue;
    const rest = entry.path.slice(root.length);
    const name = rest.split("/")[0]!;
    if (rest.includes("/"))
      immediate.set(name, { path: name, mode: "40000", type: "tree", sha: "" });
    else immediate.set(name, entry);
  }
  const items = [...immediate.entries()].sort(([an, a], [bn, b]) =>
    Buffer.compare(
      Buffer.from(an + (a.type === "tree" ? "/" : "")),
      Buffer.from(bn + (b.type === "tree" ? "/" : "")),
    ),
  );
  return hash(
    "tree",
    Buffer.concat(
      items.map(([name, entry]) =>
        Buffer.concat([
          Buffer.from(`${entry.mode.replace(/^0+/, "")} ${name}\0`),
          Buffer.from(
            entry.type === "tree"
              ? treeHash(entries, `${root}${name}/`)
              : entry.sha,
            "hex",
          ),
        ]),
      ),
    ),
  );
}
let config: AppConfig;
let publicKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  publicKey = pair.publicKey;
  config = {
    appId: "42",
    installationId: "77",
    privateKey: await exportPKCS8(pair.privateKey),
  };
});

class GitHubMock {
  calls: Array<{
    url: string;
    method: string;
    body: any;
    headers: Headers;
    redirect?: RequestRedirect;
  }> = [];
  baseEntries: GitTreeEntry[] = [
    {
      path: "README.md",
      mode: "100644",
      type: "blob",
      sha: hash("blob", "old text\n"),
    },
  ];
  blobs = new Map<string, Buffer>([
    [hash("blob", "old text\n"), Buffer.from("old text\n")],
  ]);
  head: string | null = null;
  pr: any = null;
  loseReply = "";
  divergentBase = false;
  divergentHistory = false;
  fork = false;
  userPullPermission = true;
  truncated = false;
  tamperCommit = false;
  tamperTree = false;
  readPermissions: Record<string, string> = {
    contents: "read",
    metadata: "read",
  };
  brokerStatus = 200;
  defaultBranch = "main";
  apiRedirect = false;
  beforeFinalRef: (() => void) | null = null;
  refReads = 0;
  commits: any[] = [];
  get writes() {
    return this.calls.filter(
      (c) =>
        c.method !== "GET" &&
        !c.url.endsWith("/access_tokens") &&
        !c.url.startsWith("https://github.com/"),
    );
  }
  addBase(
    path: string,
    content: Buffer,
    mode = "100644",
    type: "blob" | "commit" = "blob",
  ) {
    const sha = hash("blob", content);
    this.baseEntries.push({ path, mode, type, sha });
    this.blobs.set(sha, content);
  }
  makePr(body: any) {
    return {
      title: body.title,
      number: 9,
      html_url: `https://github.com/${repository}/pull/9`,
      state: "open",
      draft: true,
      body: body.body,
      head: { sha: this.head, ref: branch, repo: { full_name: repository } },
      base: { ref: "main", repo: { full_name: repository } },
    };
  }
  fetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = String(input),
      method = init.method ?? "GET";
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init.headers);
    this.calls.push({ url, method, body, headers, redirect: init.redirect });
    const finish = (value: any, status = 200) => {
      if (this.loseReply === `${method} ${new URL(url).pathname}`) {
        this.loseReply = "";
        throw new Error("lost reply");
      }
      return Response.json(value, { status });
    };
    if (url.endsWith("/access_tokens")) {
      const jwt = headers.get("Authorization")!.slice(7);
      const { payload, protectedHeader } = await jwtVerify(jwt, publicKey, {
        issuer: "42",
        algorithms: ["RS256"],
      });
      expect(protectedHeader.alg).toBe("RS256");
      expect(payload.exp! - payload.iat!).toBe(600);
      expect(body.repositories).toEqual(["project"]);
      expect(init.redirect).toBe("manual");
      const read = body.permissions.contents === "read";
      expect(body.permissions).toEqual(
        read
          ? { contents: "read" }
          : { contents: "write", pull_requests: "write" },
      );
      return finish({
        token: read ? "READ-TOKEN" : "WRITE-TOKEN",
        permissions: read
          ? this.readPermissions
          : { contents: "write", pull_requests: "write", metadata: "read" },
      });
    }
    if (url.startsWith("https://github.com/")) {
      expect(headers.get("Authorization")).toBe(
        `Basic ${btoa("x-access-token:READ-TOKEN")}`,
      );
      expect(init.redirect).toBe("manual");
      return new Response("001e# service=git-upload-pack\n", {
        status: this.brokerStatus,
        headers: {
          "Content-Type":
            method === "POST"
              ? "application/x-git-upload-pack-result"
              : "application/x-git-upload-pack-advertisement",
          Location: "https://evil.example/steal",
          "Set-Cookie": "nope",
        },
      });
    }
    expect(headers.get("Authorization")).toMatch(/^Bearer (READ|WRITE)-TOKEN$/);
    expect(init.redirect).toBe("manual");
    if (this.apiRedirect)
      return new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example" },
      });
    const path = new URL(url).pathname.replace(`/repos/${repository}`, "");
    if (path === "")
      return finish({
        id: 123,
        full_name: repository,
        default_branch: this.defaultBranch,
        fork: this.fork,
        archived: false,
        permissions: { pull: this.userPullPermission },
      });
    if (path.startsWith("/commits/")) return finish({ sha: baseSha });
    if (path.startsWith("/compare/"))
      return finish({
        status: path.includes("main...")
          ? this.divergentBase
            ? "diverged"
            : "behind"
          : this.divergentHistory
            ? "diverged"
            : "ahead",
      });
    if (path === `/git/commits/${baseSha}`)
      return finish({
        sha: baseSha,
        tree: { sha: treeHash(this.baseEntries) },
        parents: [],
      });
    if (path.startsWith("/git/trees/") && method === "GET") {
      const dirs = [
        ...new Set(
          this.baseEntries.flatMap((e) =>
            e.path
              .split("/")
              .slice(0, -1)
              .map((_, i) =>
                e.path
                  .split("/")
                  .slice(0, i + 1)
                  .join("/"),
              ),
          ),
        ),
      ];
      return finish({
        sha: treeHash(this.baseEntries),
        truncated: this.truncated,
        tree: [
          ...this.baseEntries,
          ...dirs.map((path) => ({
            path,
            type: "tree",
            mode: "040000",
            sha: treeHash(this.baseEntries, `${path}/`),
          })),
        ],
      });
    }
    if (path.startsWith("/git/blobs/") && method === "GET") {
      const sha = path.split("/").at(-1)!;
      const bytes = this.blobs.get(sha)!;
      return finish({
        sha,
        encoding: "base64",
        content: bytes.toString("base64"),
        size: bytes.length,
      });
    }
    if (path.startsWith("/git/ref/heads/")) {
      this.refReads++;
      if (this.refReads === 2) this.beforeFinalRef?.();
      return this.head
        ? finish({ object: { type: "commit", sha: this.head } })
        : finish({}, 404);
    }
    if (path === "/pulls" && method === "GET")
      return finish(this.pr ? [this.pr] : []);
    if (path === "/git/blobs" && method === "POST") {
      const sha = hash("blob", body.content);
      this.blobs.set(sha, Buffer.from(body.content));
      return finish({ sha });
    }
    if (path === "/git/trees" && method === "POST") {
      const entries = new Map(this.baseEntries.map((e) => [e.path, e]));
      for (const entry of body.tree)
        if (entry.sha === null) entries.delete(entry.path);
        else entries.set(entry.path, entry);
      return finish({
        sha: this.tamperTree ? "b".repeat(40) : treeHash([...entries.values()]),
      });
    }
    if (path === "/git/commits" && method === "POST") {
      const date = Math.floor(Date.parse(body.author.date) / 1000);
      const text = `tree ${body.tree}\nparent ${body.parents[0]}\nauthor ${body.author.name} <${body.author.email}> ${date} +0000\ncommitter ${body.committer.name} <${body.committer.email}> ${date} +0000\n\n${body.message}`;
      const sha = hash("commit", text);
      this.commits.push({ sha, text, body });
      return finish({ sha: this.tamperCommit ? "b".repeat(40) : sha });
    }
    if (path === "/git/refs" || path.startsWith("/git/refs/heads/")) {
      if (method === "PATCH") {
        expect(body.force).toBe(false);
        expect(this.head).not.toBeNull();
      } else expect(body.ref).toBe(`refs/heads/${branch}`);
      this.head = body.sha;
      if (this.pr) this.pr.head.sha = this.head;
      return finish({ object: { type: "commit", sha: this.head } });
    }
    if (
      (path === "/pulls" && method === "POST") ||
      (path === "/pulls/9" && method === "PATCH")
    ) {
      if (method === "POST") {
        expect(body.draft).toBe(true);
        expect(body.head).toBe(branch);
        expect(body.base).toBe("main");
      }
      this.pr = this.makePr(body);
      return finish(this.pr);
    }
    throw new Error(`Unexpected mock HTTP request: ${method} ${url}`);
  };
  service() {
    return new GitHubService(config, this.fetch);
  }
}
const prepared = (m = manifest()): Promise<PreparedPublish> =>
  preparePublish(m, actor, timestamp);

describe("preparePublish immutable reviewed payload", () => {
  it("canonicalizes order, snapshots inputs, freezes nested values and binds actor/time/content", async () => {
    const m = manifest();
    const p = await prepared(m);
    m.files[0]!.content = "mutated";
    expect(p.manifest.files[0]!.content).toBe("new text\n");
    expect(Object.isFrozen(p.manifest.files[0])).toBe(true);
    expect(
      (await prepared({ ...manifest(), files: manifest().files.reverse() }))
        .digest,
    ).toBe(p.digest);
    expect(
      (await preparePublish(manifest(), { ...actor, id: "other" }, timestamp))
        .digest,
    ).not.toBe(p.digest);
    expect(
      (await preparePublish(manifest(), actor, "2026-01-02T03:04:06Z")).digest,
    ).not.toBe(p.digest);
  });
  it.each([
    "../x",
    "/x",
    "a//x",
    "a/./x",
    "a\\x",
    ".git/config",
    "a/.GIT/config",
    ".github/workflows/ci.yml",
    ".GitHub/actions/run.js",
    ".gitmodules",
    "a/.gitattributes",
    "a/space ",
    "a/\u0000bad",
  ])("rejects unsafe/unsupported path %s", async (path) => {
    await expect(
      prepared({
        ...manifest(),
        files: [{ path, content: "text", mode: "100644" }],
      }),
    ).rejects.toThrow();
  });
  it.each([
    "nul\0binary",
    "\ud800",
    "version https://git-lfs.github.com/spec/v1\noid sha256:abc",
  ])("rejects binary/LFS text", async (content) => {
    await expect(
      prepared({
        ...manifest(),
        files: [{ path: "x", content, mode: "100644" }],
      }),
    ).rejects.toThrow();
  });
  it("enforces modes, per-file/total/file-count limits and duplicate/prefix paths", async () => {
    const m = manifest();
    await expect(
      prepared({
        ...m,
        files: [
          {
            path: "x",
            content: "x",
            mode: "120000" as PublishManifest["files"][number]["mode"],
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      prepared({
        ...m,
        files: [
          {
            path: "x",
            content: "x".repeat(LIMITS.fileBytes + 1),
            mode: "100644",
          },
        ],
      }),
    ).rejects.toThrow("File size");
    await expect(
      prepared({
        ...m,
        files: Array.from({ length: 5 }, (_, i) => ({
          path: `${i}`,
          content: "x".repeat(LIMITS.fileBytes),
          mode: "100644" as const,
        })),
      }),
    ).rejects.toThrow("Manifest size");
    await expect(
      prepared({
        ...m,
        files: Array.from({ length: 101 }, (_, i) => ({
          path: `${i}`,
          content: "",
          mode: "100644" as const,
        })),
      }),
    ).rejects.toThrow();
    for (const paths of [
      ["x", "X"],
      ["x", "x/y"],
    ])
      await expect(
        prepared({
          ...m,
          files: paths.map((path) => ({ path, content: "", mode: "100644" })),
        }),
      ).rejects.toThrow();
  });
  it("requires exact canonical repository, UUID, timestamp and clean actor identity", async () => {
    await expect(
      prepared({
        ...manifest(),
        repository: "https://github.com/acme/project",
      }),
    ).rejects.toThrow();
    await expect(
      prepared({ ...manifest(), roomId: "../main" }),
    ).rejects.toThrow();
    await expect(
      preparePublish(manifest(), actor, "2026-01-02T03:04:05.123Z"),
    ).rejects.toThrow();
    await expect(
      preparePublish(
        manifest(),
        { ...actor, name: "evil\nauthor foo" },
        timestamp,
      ),
    ).rejects.toThrow();
  });
});

describe("GitHubService selected-repo read broker", () => {
  it("uses installation-token scopes rather than user permission flags to prove read access", async () => {
    const mock = new GitHubMock();
    mock.userPullPermission = false;
    expect(
      await mock.service().resolveRepository(repository, "main"),
    ).toMatchObject({ repository, baseSha });
    expect(mock.calls.at(-1)?.url).toContain("/commits/main");
  });
  it("does not bind the native fetch transport to the service instance", async () => {
    const mock = new GitHubMock();
    const service = new GitHubService(config, function (
      this: unknown,
      input,
      init,
    ) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return mock.fetch(input, init);
    });
    expect((await service.resolveRepository(repository, "main")).id).toBe(123);
    const response = await service.brokerRead(
      repository,
      new Request(
        `https://github.com/${repository}.git/info/refs?service=git-upload-pack`,
      ),
    );
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });
  it("resolves a repo/base through repository-scoped READ token and verifies signed JWT", async () => {
    const mock = new GitHubMock();
    expect(await mock.service().resolveRepository(repository, "main")).toEqual({
      id: 123,
      repository,
      defaultBranch: "main",
      baseSha,
    });
    expect(mock.calls[1]!.headers.get("Authorization")).toBe(
      "Bearer READ-TOKEN",
    );
  });
  it.each([
    "https://github.com/other/project.git/info/refs?service=git-upload-pack",
    `https://github.com/${repository}.git/info/refs?service=git-receive-pack`,
    `https://github.com/${repository}.git/git-receive-pack`,
    `https://api.github.com/repos/${repository}`,
    `http://github.com/${repository}.git/info/refs?service=git-upload-pack`,
    `https://github.com/${repository}.git/info/refs?service=git-upload-pack&extra=1`,
    Object.assign(
      new URL(
        `https://github.com/${repository}.git/info/refs?service=git-upload-pack`,
      ),
      { username: "fixture", password: "not-a-credential" },
    ).href,
  ])("denies before minting credentials: %s", async (url) => {
    const mock = new GitHubMock();
    await expect(async () =>
      mock.service().brokerRead(repository, new Request(url)),
    ).rejects.toThrow();
    expect(mock.calls).toHaveLength(0);
  });
  it("forwards only protocol headers and READ credential, sanitizes response", async () => {
    const mock = new GitHubMock();
    const result = await mock.service().brokerRead(
      repository,
      new Request(
        `https://github.com/${repository}.git/info/refs?service=git-upload-pack`,
        {
          headers: {
            Authorization: "evil",
            Cookie: "evil",
            "X-Api-Key": "evil",
            "Git-Protocol": "version=2",
          },
        },
      ),
    );
    const forwarded = mock.calls.at(-1)!.headers;
    expect(forwarded.get("Cookie")).toBeNull();
    expect(forwarded.get("X-Api-Key")).toBeNull();
    expect(forwarded.get("Git-Protocol")).toBe("version=2");
    expect(result.headers.get("Set-Cookie")).toBeNull();
    expect(result.headers.get("Location")).toBeNull();
    expect(result.headers.get("Authorization")).toBeNull();
    expect(result.headers.get("Cache-Control")).toBe("no-store");
  });
  it("supports bounded POST upload-pack, not arbitrary content types", async () => {
    const mock = new GitHubMock();
    const url = `https://github.com/${repository}.git/git-upload-pack`;
    await mock.service().brokerRead(
      repository,
      new Request(url, {
        method: "POST",
        body: "0000",
        headers: { "Content-Type": "application/x-git-upload-pack-request" },
      }),
    );
    await expect(
      mock
        .service()
        .brokerRead(
          repository,
          new Request(url, { method: "POST", body: "{}" }),
        ),
    ).rejects.toThrow("content type");
    const tooLarge = new Request(url, {
      method: "POST",
      body: "x".repeat(LIMITS.uploadPackBytes + 1),
      headers: { "Content-Type": "application/x-git-upload-pack-request" },
    });
    await expect(
      mock.service().brokerRead(repository, tooLarge),
    ).rejects.toThrow("size limit");
    expect(mock.calls).toHaveLength(2);
  });
  it("denies redirects without a second outbound request or credential escape", async () => {
    const mock = new GitHubMock();
    mock.brokerStatus = 302;
    await expect(
      mock
        .service()
        .brokerRead(
          repository,
          new Request(
            `https://github.com/${repository}.git/info/refs?service=git-upload-pack`,
          ),
        ),
    ).rejects.toThrow("302");
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls.every((c) => c.redirect === "manual")).toBe(true);
  });
  it("rejects a widened read token", async () => {
    const mock = new GitHubMock();
    mock.readPermissions = { contents: "write" };
    await expect(
      mock.service().resolveRepository(repository, "main"),
    ).rejects.toThrow("permissions");
    expect(mock.calls).toHaveLength(1);
  });
});

describe("GitHubService immutable-manifest draft publication", () => {
  it("creates canonical blobs/tree/deterministic commit/ref/draft PR, with no fork/default writes", async () => {
    const mock = new GitHubMock();
    const p = await prepared();
    const result = await mock.service().publish(p);
    expect(result).toEqual({
      headSha: mock.head,
      branch,
      pullRequestNumber: 9,
      pullRequestUrl: `https://github.com/${repository}/pull/9`,
      digest: p.digest,
    });
    const commit = mock.commits[0];
    expect(
      execFileSync("git", ["hash-object", "-t", "commit", "--stdin"], {
        input: commit.text,
        encoding: "utf8",
      }).trim(),
    ).toBe(result.headSha);
    expect(commit.body.author.date).toBe(timestamp);
    expect(commit.body.committer).toEqual(commit.body.author);
    expect(
      mock.writes.map((c) => c.method + " " + new URL(c.url).pathname),
    ).toEqual([
      `POST /repos/${repository}/git/blobs`,
      `POST /repos/${repository}/git/blobs`,
      `POST /repos/${repository}/git/trees`,
      `POST /repos/${repository}/git/commits`,
      `POST /repos/${repository}/git/refs`,
      `POST /repos/${repository}/pulls`,
    ]);
    const tree = mock.writes.find((c) => c.url.endsWith("/git/trees"))!.body;
    expect(tree.tree[1]).toMatchObject({ path: "src/run.sh", mode: "100755" });
    expect(
      mock.calls.findIndex(
        (c) => c.method === "GET" && new URL(c.url).pathname.endsWith("/pulls"),
      ),
    ).toBeLessThan(mock.calls.findIndex((c) => c.url.endsWith("/git/blobs")));
  });
  it("supports deletions, text modifications, and modes against the recorded base", async () => {
    const mock = new GitHubMock();
    const m = manifest();
    m.files = [
      { path: "README.md", content: null, mode: "100644" },
      { path: "new", content: "new\n", mode: "100755" },
    ];
    await mock.service().publish(await prepared(m));
    expect(
      mock.writes.find((c) => c.url.endsWith("/git/trees"))!.body.tree[0],
    ).toEqual({ path: "README.md", mode: "100644", type: "blob", sha: null });
  });
  it.each(["/git/blobs", "/git/trees", "/git/commits", "/git/refs", "/pulls"])(
    "retries after lost POST %s reply without duplicate branch/PR",
    async (suffix) => {
      const mock = new GitHubMock();
      const p = await prepared();
      mock.loseReply = `POST /repos/${repository}${suffix}`;
      await expect(mock.service().publish(p)).rejects.toThrow("lost reply");
      const result = await mock.service().publish(p);
      expect(result.headSha).toBe(mock.head);
      expect(
        mock.writes.filter((c) => c.url.endsWith("/git/refs")),
      ).toHaveLength(1);
      expect(
        mock.writes.filter(
          (c) => c.url.endsWith("/pulls") && c.method === "POST",
        ),
      ).toHaveLength(1);
      expect(new Set(mock.commits.map((c) => c.sha)).size).toBe(1);
      const writes = mock.writes.length;
      await mock.service().publish(p);
      expect(mock.writes).toHaveLength(writes);
    },
  );
  it("adds a new approved commit without force, retains same draft PR, reconciles lost PATCH", async () => {
    const mock = new GitHubMock();
    await mock.service().publish(await prepared());
    const m = manifest();
    m.expectedHead = mock.head;
    m.files[0]!.content = "second reviewed content\n";
    const p = await prepared(m);
    mock.loseReply = `PATCH /repos/${repository}/pulls/9`;
    await expect(mock.service().publish(p)).rejects.toThrow("lost reply");
    const result = await mock.service().publish(p);
    expect(result.pullRequestNumber).toBe(9);
    expect(mock.commits[1]!.body.parents).toEqual([m.expectedHead]);
    expect(
      mock.writes.filter(
        (c) => c.url.endsWith("/pulls") && c.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      mock.writes.find((c) => c.url.includes("/git/refs/heads/"))!.body.force,
    ).toBe(false);
  });
  it("blocks a default branch named like the room destination", async () => {
    const mock = new GitHubMock();
    mock.defaultBranch = branch;
    await expect(mock.service().publish(await prepared())).rejects.toThrow(
      "default branch",
    );
    expect(mock.writes).toHaveLength(0);
  });
  it("does not follow authenticated API redirects", async () => {
    const mock = new GitHubMock();
    mock.apiRedirect = true;
    await expect(mock.service().publish(await prepared())).rejects.toThrow(
      "302",
    );
    expect(mock.calls).toHaveLength(2);
    expect(mock.writes).toHaveLength(0);
  });
  it("rejects marker-matching PR with mutated title/body instead of accepting a false receipt", async () => {
    for (const field of ["title", "body"]) {
      const mock = new GitHubMock();
      const p = await prepared();
      await mock.service().publish(p);
      mock.pr[field] += " external edit";
      const writes = mock.writes.length;
      await expect(mock.service().publish(p)).rejects.toThrow("marker/payload");
      expect(mock.writes).toHaveLength(writes);
    }
  });
  it("reconciles lost ref PATCH reply before another branch write", async () => {
    const mock = new GitHubMock();
    await mock.service().publish(await prepared());
    const m = manifest();
    m.expectedHead = mock.head;
    m.files[0]!.content = "second";
    const p = await prepared(m);
    mock.loseReply = `PATCH /repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`;
    await expect(mock.service().publish(p)).rejects.toThrow("lost reply");
    await mock.service().publish(p);
    expect(
      mock.writes.filter((c) => c.url.includes("/git/refs/heads/")),
    ).toHaveLength(1);
    expect(mock.writes.filter((c) => c.url.endsWith("/pulls/9"))).toHaveLength(
      1,
    );
  });
  it("rejects tampered payload before any HTTP, including actor/title/content/base", async () => {
    const mock = new GitHubMock();
    const p = await prepared();
    await expect(
      mock
        .service()
        .publish({ ...p, manifest: { ...p.manifest, title: "changed" } }),
    ).rejects.toThrow("digest mismatch");
    expect(mock.calls).toHaveLength(0);
  });
  it.each([
    "fork",
    "divergentBase",
    "truncated",
    "tamperCommit",
    "tamperTree",
  ] as const)(
    "fails closed on %s without branch or PR mutation",
    async (flag) => {
      const mock = new GitHubMock();
      mock[flag] = true;
      await expect(mock.service().publish(await prepared())).rejects.toThrow();
      expect(mock.head).toBeNull();
      expect(mock.pr).toBeNull();
    },
  );
  it("rejects divergent/missing expected heads and unexpected existing branch before writes", async () => {
    for (const existing of ["b".repeat(40), null]) {
      const mock = new GitHubMock();
      mock.head = existing;
      const m = manifest();
      m.expectedHead = "c".repeat(40);
      await expect(mock.service().publish(await prepared(m))).rejects.toThrow(
        "expected head",
      );
      expect(mock.writes).toHaveLength(0);
    }
    const mock = new GitHubMock();
    mock.head = "b".repeat(40);
    await expect(mock.service().publish(await prepared())).rejects.toThrow(
      "expected head",
    );
    expect(mock.writes).toHaveLength(0);
    const other = new GitHubMock();
    other.head = "c".repeat(40);
    other.divergentHistory = true;
    await expect(
      other
        .service()
        .publish(await prepared({ ...manifest(), expectedHead: other.head })),
    ).rejects.toThrow("diverges");
    expect(other.writes).toHaveLength(0);
  });
  it("rechecks head before ref writes", async () => {
    const mock = new GitHubMock();
    mock.beforeFinalRef = () => {
      mock.head = "d".repeat(40);
    };
    await expect(mock.service().publish(await prepared())).rejects.toThrow(
      "changed during",
    );
    expect(mock.writes.some((c) => c.url.endsWith("/git/refs"))).toBe(false);
    expect(mock.pr).toBeNull();
  });
  it.each(["closed", "ready", "fork", "marker", "base"])(
    "rejects conflicting existing PR (%s) before new writes",
    async (conflict) => {
      const mock = new GitHubMock();
      await mock.service().publish(await prepared());
      if (conflict === "closed") mock.pr.state = "closed";
      if (conflict === "ready") mock.pr.draft = false;
      if (conflict === "fork") mock.pr.head.repo.full_name = "other/project";
      if (conflict === "marker") mock.pr.body = "not ours";
      if (conflict === "base") mock.pr.base.ref = "release";
      const writes = mock.writes.length;
      const m = manifest();
      m.expectedHead = mock.head;
      m.files[0]!.content = "second";
      await expect(mock.service().publish(await prepared(m))).rejects.toThrow();
      expect(mock.writes).toHaveLength(writes);
    },
  );
  it.each([
    ["link", "120000", "blob"],
    ["module", "160000", "commit"],
  ] as const)("rejects replacing/traversing %s", async (path, mode, type) => {
    for (const target of [path, `${path}/file`]) {
      const mock = new GitHubMock();
      mock.addBase(path, Buffer.from("somewhere"), mode, type);
      await expect(
        mock.service().publish(
          await prepared({
            ...manifest(),
            files: [{ path: target, content: "text", mode: "100644" }],
          }),
        ),
      ).rejects.toThrow();
      expect(mock.writes).toHaveLength(0);
    }
  });
  it.each([
    Buffer.from([0, 1, 2]),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("version https://git-lfs.github.com/spec/v1\n"),
  ])("rejects binary/LFS base replacements and deletions", async (bytes) => {
    for (const content of [null, "text"]) {
      const mock = new GitHubMock();
      mock.addBase("asset", bytes);
      await expect(
        mock.service().publish(
          await prepared({
            ...manifest(),
            files: [{ path: "asset", content, mode: "100644" }],
          }),
        ),
      ).rejects.toThrow();
      expect(mock.writes).toHaveLength(0);
    }
  });
});
