import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition did not hold");
}
async function connect(name: string) {
  const response = await env.SPIKE.getByName(name).fetch(
    new Request("https://room.test/", { headers: { Upgrade: "websocket" } }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const batches: Array<Array<{ type: string }>> = [];
  socket.addEventListener("message", (event) => {
    batches.push(JSON.parse(String(event.data)));
  });
  await until(() => batches.some((batch) => batch[0]?.type === "snapshot"));
  return { socket, batches };
}

describe("published PiHarness + real Durable Object spike", () => {
  it("deduplicates durable admission across an eviction", async () => {
    const room = env.SPIKE.getByName(crypto.randomUUID());
    expect((await room.submit("hello", "stable-id")).accepted).toBe(true);
    expect((await room.wait("stable-id")).text).toBe("echo: hello");
    await evictDurableObject(room);
    expect((await room.submit("hello", "stable-id")).accepted).toBe(false);
    expect((await room.wait("stable-id")).text).toBe("echo: hello");
  });
  it("shares in-flight tools, accepts followups and survives every browser leaving", async () => {
    const name = crypto.randomUUID();
    const room = env.SPIKE.getByName(name);
    const a = await connect(name);
    await room.submit("gate", "first");
    await until(async () => (await room.runs()) === 1);
    const b = await connect(name);
    expect(JSON.stringify(b.batches)).toContain("waiting");
    await room.submit("next", "second");
    expect((await room.pending()).map((item) => item.operationId)).toEqual([
      "first",
      "second",
    ]);
    a.socket.close();
    b.socket.close();
    await room.release();
    expect((await room.wait("first")).text).toBe("released");
    expect((await room.wait("second")).text).toBe("echo: next");
  });
  it("recovers an unsafe interrupted tool without executing it twice", async () => {
    const name = crypto.randomUUID();
    let room = env.SPIKE.getByName(name);
    await room.submit("gate", "crash");
    await until(async () => (await room.runs()) === 1);
    await abortAllDurableObjects();
    room = env.SPIKE.getByName(name);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    const result = await room.wait("crash");
    expect(result.text).toBe("interrupted");
    expect(await room.runs()).toBe(1);
  });
  it("reattaches a surviving socket after hibernation", async () => {
    const name = crypto.randomUUID();
    const room = env.SPIKE.getByName(name);
    const client = await connect(name);
    await evictDurableObject(room);
    await room.submit("after", "after");
    await room.wait("after");
    await until(
      () =>
        client.batches.filter((batch) => batch[0]?.type === "snapshot")
          .length === 2,
    );
    client.socket.close();
  });
});
