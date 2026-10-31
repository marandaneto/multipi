// TEST ONLY: Docker is not a production ExecutionEnv or a substitute for native API validation.
import { execFileSync, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
export class DockerTransport {
  readonly name = `multipi-test-${crypto.randomUUID()}`;
  destroyed = false;
  constructor() {
    execFileSync("docker", [
      "run",
      "-d",
      "--platform",
      "linux/amd64",
      "--name",
      this.name,
      "--network",
      "none",
      "multipi-workspace:phase0",
    ]);
  }
  async exec(
    argv: string[],
    options: ContainerExecOptions = {},
  ): Promise<ExecProcess> {
    const args = ["exec", "-i"];
    if (options.cwd) args.push("-w", options.cwd);
    if (options.user) args.push("-u", options.user);
    for (const [key, value] of Object.entries(options.env ?? {}))
      args.push("-e", `${key}=${value}`);
    const p = spawn("docker", [...args, this.name, ...argv], { stdio: "pipe" });
    if (options.stdin instanceof ReadableStream)
      void options.stdin.pipeTo(Writable.toWeb(p.stdin)).catch(() => {});
    else if (options.stdin !== "pipe") p.stdin.end();
    const exitCode = new Promise<number>((resolve, reject) => {
      p.on("error", reject);
      p.on("close", (code) => resolve(code ?? -1));
    });
    if (options.stdout === "ignore") p.stdout.resume();
    if (options.stderr === "ignore") p.stderr.resume();
    return {
      stdin: Writable.toWeb(p.stdin),
      stdout: Readable.toWeb(p.stdout),
      stderr: Readable.toWeb(p.stderr),
      pid: -1,
      isPty: false,
      exitCode,
      output() {
        throw new Error("Unbounded output forbidden");
      },
      kill() {
        throw new Error("Native kill forbidden");
      },
      resize() {
        throw new Error("No PTY");
      },
    } as ExecProcess;
  }
  async destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      execFileSync("docker", ["rm", "-f", this.name]);
    }
  }
  native(): Container {
    return this as unknown as Container;
  }
}
