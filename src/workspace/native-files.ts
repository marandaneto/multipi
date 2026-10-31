import {
  Files,
  SandboxFileError,
  type SandboxFileStat,
} from "@cloudflare/sandbox";
import {
  FileError,
  LineScanner,
  err,
  ok,
  getOrThrow,
  type BinaryReader,
  type DirReader,
  type FileInfo,
  type FileSystem,
  type FileWatcher,
  type Result,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { posix as path } from "node:path";

const MAX_FILE = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function failure(error: unknown, p?: string): FileError {
  if (error instanceof FileError) return error;
  const code = (error as { code?: string })?.code;
  const codes = {
    ENOENT: "not_found",
    EACCES: "permission_denied",
    EPERM: "permission_denied",
    ENOTDIR: "not_directory",
    EISDIR: "is_directory",
    EINVAL: "invalid",
    ELOOP: "invalid",
  } as const;
  return new FileError(
    code && code in codes
      ? codes[code as keyof typeof codes]
      : error instanceof TypeError
        ? "invalid"
        : "unknown",
    String(error),
    p,
  );
}
function check(context: Context) {
  if (context.abortSignal?.aborted)
    throw new FileError("aborted", "Filesystem operation aborted");
}
function valid(n: number) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new FileError("invalid", "Expected a non-negative integer");
}
function b64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}

/** One trusted helper with one opened inode; never executes repository code. */
class FileChannel {
  private pending = "";
  private decoder = new TextDecoder();
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    private process: ExecProcess,
    private fence: () => Promise<void>,
  ) {
    this.reader = process.stdout!.getReader();
    this.writer = process.stdin!.getWriter();
    void process.exitCode.catch(() => {});
  }
  call<T>(op: string, args: unknown[], context: Context): Promise<T> {
    const run = async () => {
      check(context);
      if (this.closed) throw new FileError("invalid", "Reader is closed");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const stopped = new Promise<never>((_, reject) => {
        const stop = () => {
          void this.fence();
          reject(
            new FileError(
              context.abortSignal?.aborted ? "aborted" : "unknown",
              "Filesystem helper did not complete",
            ),
          );
        };
        timer = setTimeout(stop, 30000);
        abort = stop;
        context.abortSignal?.addEventListener("abort", stop, { once: true });
      });
      try {
        return await Promise.race([
          stopped,
          (async () => {
            await this.writer.write(
              encoder.encode(JSON.stringify({ op, args }) + "\n"),
            );
            while (!this.pending.includes("\n")) {
              const chunk = await this.reader.read();
              if (chunk.done) throw new Error("Filesystem helper exited");
              this.pending += this.decoder.decode(chunk.value, {
                stream: true,
              });
              if (this.pending.length > 2 * 1024 * 1024)
                throw new Error("Filesystem helper response exceeded limit");
            }
            const end = this.pending.indexOf("\n");
            const reply = JSON.parse(this.pending.slice(0, end));
            this.pending = this.pending.slice(end + 1);
            if (!reply.ok)
              throw Object.assign(new Error(reply.error.message), {
                code: reply.error.code,
              });
            return reply.value as T;
          })(),
        ]);
      } finally {
        clearTimeout(timer);
        if (abort) context.abortSignal?.removeEventListener("abort", abort);
      }
    };
    const result = this.tail.then(run);
    this.tail = result.catch(() => {});
    return result;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.writer.close();
    // Trusted helper has no descendants; failure still fences rather than native kill.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.process.exitCode.then((code) => {
          if (code !== 0) throw new Error("Filesystem helper failed");
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.fence();
            reject(new Error("Filesystem helper close timed out"));
          }, 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.reader.releaseLock();
      this.writer.releaseLock();
    }
  }
}

export class NativeFiles implements FileSystem {
  protected readonly files: Files;
  cwd = "/workspace/repo";
  private writesStarted = 0;
  get writeAttempts() {
    return this.writesStarted;
  }
  protected fenced = false;
  private channels = new Set<FileChannel>();
  private watchers = new Set<() => Promise<void>>();
  constructor(
    protected readonly container: Container,
    readonly id: string,
  ) {
    if (!id.trim())
      throw new TypeError("A stable room-specific environment id is required");
    this.files = new Files(container);
  }
  /** Permanently invalidates this adapter, including if native destroy rejects. Restore with a new generation/adapter. */
  async fence(): Promise<void> {
    this.fenced = true;
    await this.container.destroy();
  }
  protected async result<T>(
    p: string | undefined,
    context: Context,
    run: () => Promise<T> | T,
  ): Promise<Result<T, FileError>> {
    try {
      check(context);
      if (this.fenced)
        throw new FileError(
          "unknown",
          "Workspace is fenced; recovery required",
        );
      return ok(await run());
    } catch (error) {
      return err(
        context.abortSignal?.aborted
          ? new FileError("aborted", "Filesystem operation aborted", p)
          : failure(error, p),
      );
    }
  }
  private options(context: Context) {
    return { cwd: this.cwd, signal: context.abortSignal };
  }
  private absolute(p: string) {
    if (p.includes("\0")) throw new TypeError("NUL in path");
    if (!path.isAbsolute(this.cwd)) throw new TypeError("cwd must be absolute");
    return path.resolve(this.cwd, p);
  }
  async absolutePath(p: string, c: Context) {
    return this.result(p, c, () => this.absolute(p));
  }
  async joinPath(parts: string[], c: Context) {
    return this.result(undefined, c, () => {
      if (parts.some((p) => p.includes("\0")))
        throw new TypeError("NUL in path");
      return path.join(...parts);
    });
  }
  async readBinaryFile(p: string, c: Context) {
    return this.result(p, c, async () => {
      const response = await this.files.readFile(p, this.options(c));
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          check(c);
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > MAX_FILE)
            throw new FileError("invalid", "File exceeds 16 MiB read limit", p);
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    });
  }
  async readTextFile(p: string, c: Context) {
    return this.result(p, c, async () =>
      decoder.decode(getOrThrow(await this.readBinaryFile(p, c))),
    );
  }
  async readTextLines(
    p: string,
    options: { maxLines?: number } | undefined,
    c: Context,
  ) {
    return this.result(p, c, async () => {
      if (options?.maxLines !== undefined && options.maxLines <= 0) return [];
      const lines = getOrThrow(await this.readTextFile(p, c)).split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
      return lines.slice(0, options?.maxLines);
    });
  }
  async openTextLineReader(
    p: string,
    c: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    return this.result(p, c, async () => {
      // Full reads are explicitly capped; CodingTools use positional readers for large files.
      const text = getOrThrow(await this.readTextFile(p, c));
      let offset = 0;
      let closed = false;
      return {
        readLine: async (context) =>
          this.result(p, context, () => {
            if (closed) throw new FileError("invalid", "Reader is closed");
            if (offset >= text.length) return undefined;
            const end = text.indexOf("\n", offset);
            const terminated = end >= 0;
            const line = text
              .slice(offset, terminated ? end : undefined)
              .replace(/\r$/, "");
            offset = terminated ? end + 1 : text.length;
            return { text: line, terminated };
          }),
        close: async () => {
          closed = true;
        },
      };
    });
  }
  async writeFile(p: string, content: string | Uint8Array, c: Context) {
    this.writesStarted++;
    return this.result(p, c, async () => {
      if (
        (typeof content === "string"
          ? encoder.encode(content).length
          : content.length) > MAX_FILE
      )
        throw new FileError("invalid", "Write exceeds 16 MiB limit");
      await this.files.mkdir(path.dirname(this.absolute(p)), {
        ...this.options(c),
        recursive: true,
      });
      await this.files.writeFile(p, content, this.options(c));
    });
  }
  private async channel(c: Context) {
    check(c);
    const process = await this.container.exec(
      ["node", "/opt/multipi/files-helper.mjs"],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    const channel = new FileChannel(process, () => this.fence());
    this.channels.add(channel);
    return channel;
  }
  private async call<T>(op: string, args: unknown[], c: Context): Promise<T> {
    const channel = await this.channel(c);
    try {
      return await channel.call<T>(op, args, c);
    } finally {
      await channel.close();
      this.channels.delete(channel);
    }
  }
  async appendFile(p: string, content: string | Uint8Array, c: Context) {
    return this.result(p, c, async () => {
      const bytes =
        typeof content === "string" ? encoder.encode(content) : content;
      if (bytes.length > 1024 * 1024)
        throw new FileError("invalid", "Append exceeds 1 MiB limit");
      await this.files.mkdir(path.dirname(this.absolute(p)), {
        ...this.options(c),
        recursive: true,
      });
      await this.call("append", [this.absolute(p), b64(bytes)], c);
    });
  }
  async truncateFile(p: string, size: number, c: Context) {
    return this.result(p, c, async () => {
      valid(size);
      await this.call("truncate", [this.absolute(p), size], c);
    });
  }
  async flushFile(p: string, c: Context) {
    return this.result(p, c, () =>
      this.call<void>("flush", [this.absolute(p)], c),
    );
  }
  async canonicalPath(p: string, c: Context) {
    return this.result(p, c, () =>
      this.call<string>("realpath", [this.absolute(p)], c),
    );
  }
  async renameFile(from: string, to: string, c: Context) {
    return this.result(from, c, () =>
      this.files.rename(from, to, this.options(c)),
    );
  }
  private info(p: string, s: SandboxFileStat): FileInfo {
    if (!["file", "directory", "symlink"].includes(s.type))
      throw new FileError("invalid", "Unsupported file kind", p);
    return {
      path: this.absolute(p),
      name: path.basename(this.absolute(p)),
      kind: s.type as FileInfo["kind"],
      size: Number(s.size),
      mtimeMs: s.modifiedAt.getTime(),
    };
  }
  async fileInfo(p: string, c: Context) {
    return this.result(p, c, async () =>
      this.info(p, await this.files.lstat(p, this.options(c))),
    );
  }
  async listDir(p: string, c: Context) {
    return this.result(p, c, async () => {
      const names = await this.files.readDirectory(p, this.options(c));
      if (names.length > 10000)
        throw new FileError("invalid", "Directory exceeds 10000 entries");
      const entries: FileInfo[] = [];
      for (const name of names) {
        if (!["file", "directory", "symlink"].includes(name.type)) continue;
        const entry = await this.fileInfo(path.join(p, name.name), c);
        if (entry.ok) entries.push(entry.value);
        else if (entry.error.code !== "not_found") throw entry.error;
      }
      return entries;
    });
  }
  async openDirReader(
    p: string,
    c: Context,
  ): Promise<Result<DirReader, FileError>> {
    return this.result(p, c, async () => {
      const names = await this.files.readDirectory(p, this.options(c));
      if (names.length > 10000)
        throw new FileError("invalid", "Directory exceeds 10000 entries");
      let index = 0;
      let closed = false;
      return {
        next: (max, context) =>
          this.result(p, context, async () => {
            valid(max);
            if (!max || closed)
              throw new FileError(
                "invalid",
                "Invalid directory reader request",
              );
            const entries: FileInfo[] = [];
            while (index < names.length && entries.length < max) {
              const name = names[index++];
              if (!["file", "directory", "symlink"].includes(name.type))
                continue;
              const entry = await this.fileInfo(
                path.join(p, name.name),
                context,
              );
              if (entry.ok) entries.push(entry.value);
              else if (entry.error.code !== "not_found") throw entry.error;
            }
            return { entries, done: index === names.length };
          }),
        close: async () => {
          closed = true;
        },
      };
    });
  }
  async exists(p: string, c: Context) {
    return this.result(p, c, async () => {
      try {
        await this.files.stat(p, this.options(c));
        return true;
      } catch (error) {
        if (SandboxFileError.is(error) && error.code === "ENOENT") return false;
        throw error;
      }
    });
  }
  async createDir(
    p: string,
    options: { recursive?: boolean } | undefined,
    c: Context,
  ) {
    return this.result(p, c, () =>
      this.files.mkdir(p, { ...this.options(c), ...options }),
    );
  }
  async remove(
    p: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    c: Context,
  ) {
    return this.result(p, c, () =>
      this.files.remove(p, { ...this.options(c), ...options }),
    );
  }
  async createTempDir(prefix = "multipi-", c: Context) {
    return this.result(undefined, c, () => {
      if (prefix.includes("/") || prefix.includes("\0"))
        throw new TypeError("Invalid temp prefix");
      return this.call<string>("tempDir", [prefix], c);
    });
  }
  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    c: Context,
  ) {
    return this.result(undefined, c, () => {
      const { prefix = "multipi-", suffix = "" } = options ?? {};
      if ([prefix, suffix].some((s) => s.includes("/") || s.includes("\0")))
        throw new TypeError("Invalid temp name");
      return this.call<string>("tempFile", [prefix, suffix], c);
    });
  }
  async openBinaryReader(
    p: string,
    options: { noFollow?: boolean } | undefined,
    c: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    return this.result(p, c, async () => {
      const channel = await this.channel(c);
      try {
        await channel.call(
          "open",
          [this.absolute(p), options?.noFollow ?? false],
          c,
        );
      } catch (error) {
        await channel.close();
        this.channels.delete(channel);
        throw error;
      }
      const read = (offset: number, length: number, context: Context) =>
        this.result(p, context, async () => {
          valid(offset);
          valid(length);
          if (length > 1024 * 1024)
            throw new FileError("invalid", "Positional read exceeds 1 MiB");
          return new Uint8Array(
            Buffer.from(
              await channel.call<string>("read", [offset, length], context),
              "base64",
            ),
          );
        });
      return {
        info: (context) =>
          this.result(p, context, () =>
            channel.call<FileInfo>("info", [], context),
          ),
        read,
        scanLines: (options, context) =>
          this.result(p, context, async () => {
            valid(options.startLine);
            if (options.endLine !== undefined) {
              valid(options.endLine);
              if (options.endLine <= options.startLine)
                throw new FileError("invalid", "Empty line range");
            }
            const scanner = new LineScanner(options.startLine, options.endLine);
            for (let offset = 0; ; offset += 65536) {
              const bytes = getOrThrow(await read(offset, 65536, context));
              if (!bytes.length) break;
              scanner.push(bytes);
            }
            return scanner.finish();
          }),
        close: async () => {
          await channel.close();
          this.channels.delete(channel);
        },
      };
    });
  }
  async watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    c: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    return this.result(undefined, c, async () => {
      const absolute = targets.map((t) => ({
        ...t,
        path: this.absolute(t.path),
      }));
      const snapshot = () => this.call<unknown[]>("snapshot", [absolute], c);
      let previous = await snapshot();
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pending: Promise<void> = Promise.resolve();
      const poll = async () => {
        try {
          const current = await snapshot();
          const changed = absolute
            .filter(
              (_, i) =>
                JSON.stringify(current[i]) !== JSON.stringify(previous[i]),
            )
            .map((t) => t.path);
          previous = current;
          if (!closed && changed.length) onChange({ paths: changed });
        } catch (error) {
          if (!closed) {
            closed = true;
            onChange({ error: failure(error) });
          }
        }
        if (!closed)
          timer = setTimeout(() => {
            pending = poll();
          }, 250);
      };
      const close = async () => {
        closed = true;
        clearTimeout(timer);
        await pending;
        this.watchers.delete(close);
      };
      this.watchers.add(close);
      timer = setTimeout(() => {
        pending = poll();
      }, 250);
      return { mode: "polling", close };
    });
  }
  async cleanup(_c: Context): Promise<void> {
    await Promise.all([...this.watchers].map((close) => close()));
    await Promise.all([...this.channels].map((channel) => channel.close()));
    this.channels.clear();
  }
}
