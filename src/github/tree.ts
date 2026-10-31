import {
  assert,
  concat,
  gitHash,
  LIMITS,
  utf8,
  type PublishManifest,
} from "./manifest.js";

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}
export interface TreeChange {
  path: string;
  mode: "100644" | "100755";
  type: "blob";
  sha: string | null;
}
/** Compute the exact Git tree before writes, so a lost ref/commit reply can be reconciled by SHA. */
export async function planTree(
  entries: GitTreeEntry[],
  manifest: PublishManifest,
): Promise<{ sha: string; changes: TreeChange[] }> {
  assert(
    entries.length <= LIMITS.treeEntries,
    "Repository tree limit exceeded",
  );
  const original = new Map(entries.map((e) => [e.path, e]));
  assert(original.size === entries.length, "Duplicate repository tree entries");
  const leaves = new Map(
    entries.filter((e) => e.type !== "tree").map((e) => [e.path, { ...e }]),
  );
  const changes: TreeChange[] = [];
  for (const file of manifest.files) {
    const current = original.get(file.path);
    assert(
      !current ||
        (current.type === "blob" &&
          ["100644", "100755"].includes(current.mode)),
      "Cannot replace directories, symlinks or submodules",
    );
    const segments = file.path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const parent = original.get(segments.slice(0, i).join("/"));
      assert(
        !parent || parent.type === "tree",
        "Cannot traverse a file, symlink or submodule",
      );
    }
    if (file.content === null) {
      assert(current, "Cannot delete a nonexistent path");
      assert(
        current.mode === file.mode,
        "Deleted file mode does not match base",
      );
      leaves.delete(file.path);
      changes.push({
        path: file.path,
        mode: file.mode,
        type: "blob",
        sha: null,
      });
    } else {
      const sha = await gitHash("blob", utf8(file.content));
      leaves.set(file.path, {
        path: file.path,
        mode: file.mode,
        type: "blob",
        sha,
      });
      changes.push({ path: file.path, mode: file.mode, type: "blob", sha });
    }
  }
  type Node = { mode: string; sha?: string; children?: Map<string, Node> };
  const root: Node = { mode: "40000", children: new Map() };
  for (const entry of leaves.values()) {
    let node = root;
    const parts = entry.path.split("/");
    for (const name of parts.slice(0, -1)) {
      const children = node.children!;
      if (!children.has(name))
        children.set(name, { mode: "40000", children: new Map() });
      node = children.get(name)!;
      assert(node.children, "Invalid repository tree");
    }
    assert(
      !node.children!.has(parts.at(-1)!),
      "Invalid repository tree collision",
    );
    node.children!.set(parts.at(-1)!, {
      mode: entry.mode.replace(/^0+/, ""),
      sha: entry.sha,
    });
  }
  async function compute(node: Node): Promise<string> {
    if (node.sha) return node.sha;
    const items = [...node.children!.entries()].map(([name, child]) => ({
      name,
      child,
      sortKey: utf8(name + (child.children ? "/" : "")),
    }));
    items.sort((a, b) => {
      for (let i = 0; i < Math.min(a.sortKey.length, b.sortKey.length); i++)
        if (a.sortKey[i] !== b.sortKey[i]) return a.sortKey[i]! - b.sortKey[i]!;
      return a.sortKey.length - b.sortKey.length;
    });
    const chunks: Uint8Array[] = [];
    for (const { name, child } of items) {
      const sha = await compute(child);
      chunks.push(
        utf8(`${child.mode} ${name}\0`),
        Uint8Array.from(sha.match(/../g)!, (h) => parseInt(h, 16)),
      );
    }
    return gitHash("tree", concat(...chunks));
  }
  return { sha: await compute(root), changes };
}
