// Trusted filesystem helper. JSON lines, bounded requests/responses, no shell.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import readline from "node:readline";
let file;
let opened;
const info = (s, p) => ({
  name: path.basename(p),
  path: p,
  kind: s.isDirectory() ? "directory" : s.isSymbolicLink() ? "symlink" : "file",
  size: s.size,
  mtimeMs: s.mtimeMs,
});
const invalid = () => {
  throw Object.assign(new Error("invalid filesystem request"), {
    code: "EINVAL",
  });
};
for await (const line of readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  try {
    if (line.length > 2 * 1024 * 1024) invalid();
    const { op, args: a } = JSON.parse(line);
    let value;
    switch (op) {
      case "open": {
        opened = a[0];
        file = await fs.open(
          opened,
          constants.O_RDONLY |
            (a[1] ? constants.O_NOFOLLOW : 0) |
            constants.O_NONBLOCK,
        );
        const s = await file.stat();
        if (!s.isFile())
          throw Object.assign(new Error("not a regular file"), {
            code: s.isDirectory() ? "EISDIR" : "EINVAL",
          });
        value = info(s, opened);
        break;
      }
      case "info":
        value = info(await file.stat(), opened);
        break;
      case "read": {
        if (
          !a.every(Number.isSafeInteger) ||
          a[0] < 0 ||
          a[1] < 0 ||
          a[1] > 1024 * 1024
        )
          invalid();
        const bytes = Buffer.alloc(a[1]);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, a[0]);
        value = bytes.subarray(0, bytesRead).toString("base64");
        break;
      }
      case "append":
        await fs.appendFile(a[0], Buffer.from(a[1], "base64"));
        break;
      case "truncate":
        await fs.truncate(a[0], a[1]);
        break;
      case "flush": {
        const f = await fs.open(a[0], "r+");
        try {
          await f.sync();
        } finally {
          await f.close();
        }
        break;
      }
      case "realpath":
        value = await fs.realpath(a[0]);
        break;
      case "tempDir":
        value = await fs.mkdtemp("/tmp/" + a[0]);
        break;
      case "tempFile": {
        value = "/tmp/" + a[0] + crypto.randomUUID() + a[1];
        await (await fs.open(value, "wx")).close();
        break;
      }
      case "snapshot": {
        let count = 0;
        const visit = async (p, recursive, exclude, follow) => {
          if (++count > 10000)
            throw Object.assign(new Error("watch tree exceeds 10000 entries"), {
              code: "EINVAL",
            });
          let s;
          try {
            s = await (follow ? fs.stat(p) : fs.lstat(p));
          } catch (e) {
            if (e.code === "ENOENT") return null;
            throw e;
          }
          const result = [s.ino, s.size, s.mtimeMs, s.ctimeMs];
          if (s.isDirectory()) {
            const entries = [];
            for (const name of (await fs.readdir(p)).sort()) {
              if (
                (exclude?.hidden && name.startsWith(".")) ||
                exclude?.names?.includes(name)
              )
                continue;
              const child = path.join(p, name);
              if (recursive)
                entries.push([name, await visit(child, true, exclude, false)]);
              else {
                try {
                  const item = await fs.lstat(child);
                  entries.push([
                    name,
                    item.isDirectory()
                      ? "directory"
                      : [item.ino, item.size, item.mtimeMs, item.ctimeMs],
                  ]);
                } catch (e) {
                  if (e.code !== "ENOENT") throw e;
                }
              }
            }
            // Directory timestamps include changes to excluded names: compare only allowed entries.
            return entries;
          }
          return result;
        };
        value = await Promise.all(
          a[0].map((t) => visit(t.path, t.recursive, t.exclude, true)),
        );
        break;
      }
      default:
        invalid();
    }
    process.stdout.write(JSON.stringify({ ok: true, value }) + "\n");
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: { code: e.code ?? "UNKNOWN", message: e.message },
      }) + "\n",
    );
  }
}
await file?.close();
