import { DurableObject } from "cloudflare:workers";
import { DirectoryBackup } from "@cloudflare/sandbox";
import assert from "node:assert/strict";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import {
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createNativeExecutionEnv } from "../../src/workspace/native-env";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";
export class Probe extends DurableObject {
  async fetch(request: Request) {
    const container = this.ctx.container!;
    const url = new URL(request.url);
    try {
      container.start({
        image: container.images.workspace,
        enableInternet: false,
      });
      const env = createNativeExecutionEnv(container, "native-probe-room");
      if (url.pathname === "/conformance") {
        const results: { name: string; status: string; error?: string }[] = [];
        const cases = createEnvConformance({
          assertions: {
            ok: assert.ok,
            strictEqual: assert.strictEqual,
            deepEqual: assert.deepStrictEqual,
            partialDeepEqual: assert.partialDeepStrictEqual,
            greaterThan: (a, b) => assert.ok(a > b),
            rejects: async (promise, includes) => {
              await assert.rejects(promise, (error) =>
                String(error).includes(includes),
              );
            },
          },
          withEnv: async (use) => {
            const isolated = createNativeExecutionEnv(
              container,
              "native-probe-room",
            );
            isolated.cwd = getOrThrow(
              await isolated.createTempDir("native-conformance-", context),
            );
            try {
              await use(isolated);
            } finally {
              await isolated.cleanup(context);
            }
          },
        });
        const selected = url.searchParams.has("case")
          ? cases.filter((_, i) => i === Number(url.searchParams.get("case")))
          : cases;
        for (const c of selected) {
          try {
            await c.run();
            results.push({ name: c.name, status: "passed" });
          } catch (error) {
            results.push({
              name: c.name,
              status: "failed",
              error: String(error),
            });
          }
        }
        return Response.json(results);
      }
      if (url.pathname === "/cancel") {
        const controller = new AbortController();
        const running = env.exec(
          `python3 -c 'import os,signal,time; os.setsid(); signal.signal(signal.SIGTERM,signal.SIG_IGN); open("started","w").write("yes"); exec("while True: open(\\"ticks\\",\\"a\\").write(\\"x\\"); time.sleep(0.02)")' & wait`,
          {},
          withAbortSignal(controller.signal, context),
        );
        for (
          let i = 0;
          i < 100 && !getOrThrow(await env.exists("started", context));
          i++
        )
          await new Promise((r) => setTimeout(r, 30));
        assert.equal(getOrThrow(await env.exists("started", context)), true);
        controller.abort();
        const result = await running;
        assert.equal(result.ok ? "" : result.error.code, "aborted");
        const before = getOrThrow(await env.readTextFile("ticks", context));
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(
          getOrThrow(await env.readTextFile("ticks", context)),
          before,
        );
        getOrThrow(
          await env.exec(
            '(trap "" TERM; while true; do echo x >> normal-ticks; sleep 0.02; done) & echo done',
            { timeout: 0.8 },
            context,
          ),
        );
        const normal = getOrThrow(
          await env.readTextFile("normal-ticks", context),
        );
        await new Promise((r) => setTimeout(r, 1100));
        assert.equal(
          getOrThrow(await env.readTextFile("normal-ticks", context)),
          normal,
        );
        assert.equal(
          getOrThrow(await env.exec("true", undefined, context)).exitCode,
          0,
        );
        return Response.json({
          aborted: !result.ok,
          detachedWriterQuiescent: true,
          normalExitTimersCleared: true,
        });
      }
      if (url.pathname === "/uncertain") {
        const result = await env.exec("kill -KILL $PPID", undefined, context);
        assert.equal(result.ok, false);
        assert.equal((await env.exec("true", undefined, context)).ok, false);
        return Response.json({
          uncertainResultFenced: true,
          containerRunning: container.running,
        });
      }
      const backup = new DirectoryBackup(
        container,
        this.ctx.exports.DirectoryBackupGateway,
        { binding: "BACKUPS" },
      );
      getOrThrow(
        await env.exec(
          "git init -q; git config user.email fixture@example.invalid; git config user.name Fixture; printf original > old.txt; printf gone > deleted.txt; git add .; git commit -qm initial",
          undefined,
          context,
        ),
      );
      getOrThrow(await env.writeFile("old.txt", "changed", context));
      getOrThrow(await env.writeFile("untracked.txt", "new", context));
      getOrThrow(await env.remove("deleted.txt", undefined, context));
      const start = performance.now();
      const record = await backup.backup({
        dir: "/workspace/repo",
        gitignore: false,
        exclude: ["node_modules/"],
      });
      const backupMs = performance.now() - start;
      await container.destroy();
      container.start({
        image: container.images.workspace,
        enableInternet: false,
      });
      const restored = createNativeExecutionEnv(container, "native-probe-room");
      getOrThrow(
        await restored.writeFile("stale.txt", "must disappear", context),
      );
      const restoreStart = performance.now();
      await backup.restore(record);
      const restoreMs = performance.now() - restoreStart;
      assert.equal(
        getOrThrow(await restored.readTextFile("old.txt", context)),
        "changed",
      );
      assert.equal(
        getOrThrow(await restored.readTextFile("untracked.txt", context)),
        "new",
      );
      assert.equal(
        getOrThrow(await restored.exists("deleted.txt", context)),
        false,
      );
      assert.equal(
        getOrThrow(await restored.exists("stale.txt", context)),
        false,
      );
      assert.equal(
        getOrThrow(await restored.exists(".git/HEAD", context)),
        true,
      );
      let status = "";
      getOrThrow(
        await restored.exec(
          "git status --porcelain",
          {
            onOutput(text) {
              status += text;
            },
          },
          context,
        ),
      );
      assert.ok(
        status.includes(" D deleted.txt") &&
          status.includes(" M old.txt") &&
          status.includes("?? untracked.txt"),
      );
      await backup.delete(record);
      return Response.json({
        record,
        backupMs,
        restoreMs,
        status,
        verified: [
          ".git",
          "untracked",
          "changed",
          "deleted",
          "stale removal",
          "destroy and restart",
        ],
      });
    } catch (error) {
      return Response.json(
        { error: String(error), stack: (error as Error).stack },
        { status: 500 },
      );
    } finally {
      if (container.running) await container.destroy();
    }
  }
}
export default {
  fetch(request: Request, env: any) {
    return env.PROBE.get(env.PROBE.idFromName("native-probe")).fetch(request);
  },
};
