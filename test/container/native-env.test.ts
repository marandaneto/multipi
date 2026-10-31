import { beforeAll, afterAll, test, expect } from "vitest";
import assert from "node:assert/strict";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import {
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createNativeExecutionEnv } from "../../src/workspace/native-env";
import { DockerTransport } from "./docker-transport";

let docker: DockerTransport;
beforeAll(() => {
  docker = new DockerTransport();
});
afterAll(async () => {
  await docker?.destroy();
});
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
    const env = createNativeExecutionEnv(docker.native(), "docker-test-room");
    env.cwd = getOrThrow(await env.createTempDir("conformance-", context));
    try {
      await use(env);
    } finally {
      await env.cleanup(context);
    }
  },
});
for (const c of cases) test(c.name, c.run, c.timeoutMs ?? 30000);

async function environment() {
  const env = createNativeExecutionEnv(docker.native(), "docker-test-room");
  env.cwd = getOrThrow(await env.createTempDir("focused-", context));
  return env;
}
test("Stop kills TERM-ignoring grandchildren and detached setsid writers", async () => {
  const env = await environment();
  const abort = new AbortController();
  const running = env.exec(
    `python3 -c 'import os,signal,time; os.setsid(); signal.signal(signal.SIGTERM,signal.SIG_IGN); open("started","w").write("yes"); exec("while True: open(\\"ticks\\",\\"a\\").write(\\"x\\"); time.sleep(0.02)")' & wait`,
    {},
    withAbortSignal(abort.signal, context),
  );
  for (
    let i = 0;
    i < 100 && !getOrThrow(await env.exists("started", context));
    i++
  )
    await new Promise((r) => setTimeout(r, 30));
  expect(getOrThrow(await env.exists("started", context))).toBe(true);
  abort.abort();
  const result = await running;
  expect(result.ok ? "" : result.error.code).toBe("aborted");
  const first = getOrThrow(await env.readTextFile("ticks", context));
  await new Promise((r) => setTimeout(r, 400));
  expect(getOrThrow(await env.readTextFile("ticks", context))).toBe(first);
  await env.cleanup(context);
});
test("normal exit quiesces unsupported background work and clears cancellation timers", async () => {
  const env = await environment();
  expect(
    getOrThrow(
      await env.exec(
        '(trap "" TERM; while true; do echo x >> ticks; sleep 0.02; done) & echo done',
        { timeout: 0.8 },
        context,
      ),
    ).exitCode,
  ).toBe(0);
  const first = getOrThrow(await env.readTextFile("ticks", context));
  await new Promise((r) => setTimeout(r, 1100));
  expect(getOrThrow(await env.readTextFile("ticks", context))).toBe(first);
  expect(
    getOrThrow(await env.exec("printf next", undefined, context)).exitCode,
  ).toBe(0);
  await env.cleanup(context);
});
test("spills complete output and reports callback failure without orphaning", async () => {
  const env = await environment();
  const result = getOrThrow(
    await env.exec(
      "printf abcdef; printf xyz >&2",
      { spill: { afterBytes: 3, afterLines: 1 } },
      context,
    ),
  );
  const text = getOrThrow(await env.readTextFile(result.spillPath!, context));
  expect(text.length).toBe(9);
  expect(text).toContain("abcdef");
  expect(text).toContain("xyz");
  const failed = await env.exec(
    "while true; do echo x; done",
    {
      onOutput() {
        throw new Error("callback");
      },
    },
    context,
  );
  expect(failed.ok ? "" : failed.error.code).toBe("callback_error");
  expect(getOrThrow(await env.exec("true", undefined, context)).exitCode).toBe(
    0,
  );
  await env.cleanup(context);
});
test("output over 16 MiB terminates explicitly and keeps callback chunks bounded", async () => {
  const env = await environment();
  let size = 0;
  const result = await env.exec(
    ["node", "-e", 'process.stdout.write("x".repeat(20*1024*1024))'],
    {
      onOutput(text) {
        size += text.length;
        expect(text.length).toBeLessThanOrEqual(16384);
      },
    },
    context,
  );
  expect(result.ok).toBe(false);
  expect(size).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(getOrThrow(await env.exec("true", undefined, context)).exitCode).toBe(
    0,
  );
  await env.cleanup(context);
});
test("missing supervisor receipt permanently fences and destroys the container", async () => {
  const isolated = new DockerTransport();
  const env = createNativeExecutionEnv(isolated.native(), "uncertain-room");
  const result = await env.exec("kill -KILL $PPID", undefined, context);
  expect(result.ok).toBe(false);
  expect(isolated.destroyed).toBe(true);
  expect((await env.exec("true", undefined, context)).ok).toBe(false);
  expect((await env.writeFile("should-not-run", "x", context)).ok).toBe(false);
});
test("filesystem append/truncate/flush/temp and text-line APIs use Linux files", async () => {
  const env = await environment();
  getOrThrow(await env.appendFile("nested/file", "first\nsecond\n", context));
  getOrThrow(await env.flushFile("nested/file", context));
  expect(
    getOrThrow(
      await env.readTextLines("nested/file", { maxLines: 1 }, context),
    ),
  ).toEqual(["first"]);
  const reader = getOrThrow(
    await env.openTextLineReader("nested/file", context),
  );
  expect(getOrThrow(await reader.readLine(context))).toEqual({
    text: "first",
    terminated: true,
  });
  expect(getOrThrow(await reader.readLine(context))).toEqual({
    text: "second",
    terminated: true,
  });
  expect(getOrThrow(await reader.readLine(context))).toBeUndefined();
  await reader.close(context);
  getOrThrow(await env.truncateFile("nested/file", 5, context));
  expect(getOrThrow(await env.readTextFile("nested/file", context))).toBe(
    "first",
  );
  const temp = getOrThrow(
    await env.createTempFile({ prefix: "focused-", suffix: ".txt" }, context),
  );
  expect(temp.endsWith(".txt")).toBe(true);
  expect(getOrThrow(await env.fileInfo(".", context)).name).toBe(
    env.cwd.split("/").at(-1),
  );
  await env.cleanup(context);
});
test("shell preserves UTF-8 split across native chunks and has no implicit secret env", async () => {
  const env = await environment();
  let out = "";
  const result = await env.exec(
    [
      "node",
      "-e",
      "process.stdout.write(Buffer.from([0xf0,0x9f])); setTimeout(()=>process.stdout.write(Buffer.from([0x98,0x80])), 30)",
    ],
    {
      onOutput(text) {
        out += text;
      },
    },
    context,
  );
  expect(getOrThrow(result).exitCode).toBe(0);
  expect(out).toBe("😀");
  out = "";
  getOrThrow(
    await env.exec(
      ["/usr/bin/env"],
      {
        inheritEnv: false,
        env: { ONLY: "value" },
        onOutput(text) {
          out += text;
        },
      },
      context,
    ),
  );
  expect(out).toBe("ONLY=value\n");
  await env.cleanup(context);
});
