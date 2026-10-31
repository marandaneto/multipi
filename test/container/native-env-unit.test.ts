import { afterEach, expect, test, vi } from "vitest";
import {
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createNativeExecutionEnv } from "../../src/workspace/native-env";

afterEach(() => vi.useRealTimers());
test("unresponsive supervisor gets a six-second cancellation watchdog, not the ten-minute command deadline", async () => {
  vi.useFakeTimers();
  const destroy = vi.fn(async () => {});
  const native = {
    exec: vi.fn(() => new Promise<ExecProcess>(() => {})),
    destroy,
  } as unknown as Container;
  const env = createNativeExecutionEnv(native, "watchdog-room");
  const abort = new AbortController();
  const running = env.exec(
    "sleep 100",
    undefined,
    withAbortSignal(abort.signal, context),
  );
  abort.abort();
  await vi.advanceTimersByTimeAsync(5999);
  expect(destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  const result = await running;
  expect(result.ok ? "" : result.error.code).toBe("unknown");
  expect(destroy).toHaveBeenCalledExactlyOnceWith();
  expect((await env.exec("true", undefined, context)).ok).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
test("destroy failure still permanently fences all subsequent filesystem and shell use", async () => {
  const native = {
    exec: vi.fn(async () => {
      throw new Error("transport");
    }),
    destroy: vi.fn(async () => {
      throw new Error("destroy unavailable");
    }),
  } as unknown as Container;
  const env = createNativeExecutionEnv(native, "fenced-room");
  expect((await env.exec("true", undefined, context)).ok).toBe(false);
  expect((await env.writeFile("blocked", "x", context)).ok).toBe(false);
  expect((await env.exec("true", undefined, context)).ok).toBe(false);
  expect(native.exec).toHaveBeenCalledTimes(1);
});
