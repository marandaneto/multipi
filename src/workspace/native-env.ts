import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  err,
  ok,
  type ExecutionEnv,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { posix as path } from "node:path";
import { NativeFiles } from "./native-files";

const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 600;
type Receipt = {
  exitCode: number;
  error: string | null;
  detail: string;
  spillPath: string | null;
};

/** Already-started native ctx.container only. No start/restore/checkpoint/alarm ownership. */
export class NativeExecutionEnv extends NativeFiles implements ExecutionEnv {
  private active: Promise<unknown> | undefined;
  private stopActive: (() => void) | undefined;

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions = {},
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (this.fenced)
      return err(
        new ExecutionError("unknown", "Workspace fenced; recovery required"),
      );
    if (this.active)
      return err(
        new ExecutionError(
          "spawn_error",
          "Sequential command execution required",
        ),
      );
    if (context.abortSignal?.aborted)
      return err(new ExecutionError("aborted", "Command aborted before spawn"));
    const argv =
      typeof command === "string" ? ["/bin/bash", "-c", command] : [...command];
    if (
      !argv.length ||
      argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    )
      return err(new ExecutionError("spawn_error", "Invalid argv"));
    const timeout = options.timeout ?? MAX_TIMEOUT_SECONDS;
    if (
      !Number.isFinite(timeout) ||
      timeout <= 0 ||
      timeout > MAX_TIMEOUT_SECONDS
    )
      return err(
        new ExecutionError("timeout", "Timeout must be in (0, 600] seconds"),
      );
    if (
      options.spill &&
      (!Number.isSafeInteger(options.spill.afterBytes) ||
        options.spill.afterBytes < 0 ||
        options.spill.afterBytes > 1024 * 1024 ||
        !Number.isSafeInteger(options.spill.afterLines) ||
        options.spill.afterLines < 0 ||
        options.spill.afterLines > 100000)
    )
      return err(
        new ExecutionError(
          "spawn_error",
          "Spill thresholds exceed bounded buffer policy",
        ),
      );
    const operation = this.run(argv, options, timeout, context);
    this.active = operation;
    try {
      return await operation;
    } finally {
      this.active = undefined;
      this.stopActive = undefined;
    }
  }

  private async run(
    argv: string[],
    options: ShellExecOptions,
    timeout: number,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const receiptPath = `/tmp/multipi-${crypto.randomUUID()}.receipt`;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let stopRequested = false;
    let exited = false;
    let callbackFailed = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let watchdogFired = false;
    let rejectUncertain: (error: ExecutionError) => void;
    const armWatchdog = (ms: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        watchdogFired = true;
        this.fenced = true;
        void this.fence().catch(() => {});
        rejectUncertain(
          new ExecutionError(
            "unknown",
            "Supervisor did not prove quiescence; container fenced",
          ),
        );
      }, ms);
    };
    const encoder = new TextEncoder();
    const sendStop = () => {
      if (exited || stopRequested) return;
      stopRequested = true;
      armWatchdog(6000);
      // stdin is owned by the supervisor, never passed to repository commands.
      if (writer) void writer.write(encoder.encode("stop\n")).catch(() => {});
    };
    this.stopActive = sendStop;
    context.abortSignal?.addEventListener("abort", sendStop, { once: true });
    const uncertain = new Promise<never>((_, reject) => {
      rejectUncertain = reject;
    });
    armWatchdog((timeout + 6) * 1000);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      sendStop();
    }, timeout * 1000);
    try {
      const work = (async (): Promise<
        Result<ShellExecResult, ExecutionError>
      > => {
        const spec = {
          argv,
          cwd: path.resolve(this.cwd, options.cwd ?? "."),
          timeout,
          env: {
            ...(options.inheritEnv === false
              ? {}
              : {
                  PATH: "/usr/local/bin:/usr/bin:/bin",
                  HOME: "/root",
                  LANG: "C.UTF-8",
                  NODE_EXTRA_CA_CERTS:
                    "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
                  GIT_SSL_CAINFO:
                    "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
                }),
            ...options.env,
          },
          receipt: receiptPath,
          spill: options.spill,
          maxOutputBytes: MAX_OUTPUT,
        };
        const process = await this.container.exec(
          ["python3", "/opt/multipi/supervisor.py", JSON.stringify(spec)],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        );
        writer = process.stdin!.getWriter();
        if (stopRequested) await writer.write(encoder.encode("stop\n"));
        let bytes = 0;
        const pump = async (
          stream: ReadableStream<Uint8Array>,
          name: "stdout" | "stderr",
        ) => {
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          const output = (text: string) => {
            if (!text || callbackFailed) return;
            try {
              options.onOutput?.(text, context, { stream: name });
            } catch {
              callbackFailed = true;
              sendStop();
            }
          };
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.length;
              if (bytes > MAX_OUTPUT + 65536) {
                sendStop();
                throw new Error("Native output exceeded supervisor bound");
              }
              // Bound decoder/callback chunk size even if the transport coalesces packets.
              for (let offset = 0; offset < chunk.value.length; offset += 16384)
                output(
                  decoder.decode(chunk.value.subarray(offset, offset + 16384), {
                    stream: true,
                  }),
                );
            }
            output(decoder.decode());
          } finally {
            reader.releaseLock();
          }
        };
        const exit = process.exitCode.then((code) => {
          exited = true;
          clearTimeout(timeoutTimer);
          return code;
        });
        const [code] = await Promise.all([
          exit,
          pump(process.stdout!, "stdout"),
          pump(process.stderr!, "stderr"),
        ]);
        await writer.close();
        writer.releaseLock();
        writer = undefined;
        if (code !== 0)
          throw new Error("Supervisor exited without a quiescence receipt");
        const response = await this.files.readFile(receiptPath);
        const receipt = (await response.json()) as Receipt;
        if (
          !Number.isInteger(receipt.exitCode) ||
          !["spawn_error", "timeout", "aborted", "output_limit", null].includes(
            receipt.error,
          )
        )
          throw new Error("Invalid supervisor receipt");
        await this.files.remove(receiptPath);
        let error: ExecutionError | undefined;
        if (callbackFailed)
          error = new ExecutionError(
            "callback_error",
            "Output callback failed",
          );
        else if (context.abortSignal?.aborted || (stopRequested && !timedOut))
          error = new ExecutionError("aborted", "Command aborted");
        else if (timedOut || receipt.error === "timeout")
          error = new ExecutionError("timeout", "Command deadline exceeded");
        else if (receipt.error === "spawn_error")
          error = new ExecutionError("spawn_error", receipt.detail);
        else if (receipt.error === "output_limit")
          error = new ExecutionError(
            "unknown",
            "Command exceeded 16 MiB output limit",
          );
        else if (receipt.error)
          error = new ExecutionError("aborted", "Command stopped");
        if (error) {
          if (receipt.spillPath) error.spillPath = receipt.spillPath;
          return err(error);
        }
        return ok({
          exitCode: receipt.exitCode,
          ...(receipt.spillPath ? { spillPath: receipt.spillPath } : {}),
        });
      })();
      return await Promise.race([work, uncertain]);
    } catch (error) {
      if (!watchdogFired) await this.fence().catch(() => {});
      return err(
        error instanceof ExecutionError
          ? error
          : new ExecutionError(
              "unknown",
              "Command outcome uncertain; container fenced",
              error instanceof Error ? error : undefined,
            ),
      );
    } finally {
      clearTimeout(watchdog);
      clearTimeout(timeoutTimer);
      context.abortSignal?.removeEventListener("abort", sendStop);
    }
  }
  override async cleanup(context: Context): Promise<void> {
    this.stopActive?.();
    await this.active;
    await super.cleanup(context);
  }
}

/** Stable id names the room filesystem, not an invocation. Recreate after fencing only after parent recovery. */
export function createNativeExecutionEnv(
  container: Container,
  id: string,
): NativeExecutionEnv {
  return new NativeExecutionEnv(container, id);
}
