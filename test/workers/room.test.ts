import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import app from "../../src/worker/index";
import { RoomDocument, RoomStore } from "../../src/room/state";
import { FixtureRoom } from "./application";
import { Publication } from "../../src/room/room";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UsageDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
const owner = "alice@example.test";
const actor = (id: string) => ({
  id,
  subject: id,
  expiresAt: Date.now() + 60_000,
});
async function create() {
  const id = crypto.randomUUID();
  await env.ROOMS.getByName(id).initialize({
    id,
    title: "Task",
    repository: "org/repo",
    baseSha: "a".repeat(40),
    owner,
    createdAt: new Date().toISOString(),
  });
  await env.DIRECTORY.getByName("deployment").add(id);
  return id;
}
async function request(
  path: string,
  principal = owner,
  method = "GET",
  value?: unknown,
  origin = "http://localhost",
) {
  const response = await app.fetch(
    new Request(`http://localhost/api${path}`, {
      method,
      headers: {
        "x-multipi-dev-user": principal,
        Origin: origin,
        ...(value === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }),
    env,
  );
  // Drain the DO response even when a test only inspects status; open bodies prevent eviction.
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}
async function connect(id: string, principal = owner) {
  const response = await env.ROOMS.getByName(id).fetch(
    new Request("https://internal/socket", {
      headers: {
        Upgrade: "websocket",
        "x-multipi-identity": JSON.stringify(actor(principal)),
      },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const frames: Array<{ type: string; [key: string]: unknown }> = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)));
  });
  async function until(check: () => boolean) {
    for (let i = 0; i < 300; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Socket condition timed out");
  }
  await until(() => frames.some((frame) => frame.type === "pi"));
  return { socket, frames, until };
}
describe("application room authorization and durable multiplayer", () => {
  it("returns the persisted delivery on HTTP and socket snapshots after eviction without exposing its prepared payload", async () => {
    const id = await create();
    const stub = env.ROOMS.getByName(id);
    const reviewId = crypto.randomUUID();
    const delivery = {
      reviewId,
      pullRequestUrl: "https://github.com/org/repo/pull/1",
      headSha: "b".repeat(40),
    };
    await runInDurableObject(stub, async (room) => {
      await (
        await room.harness.pi()
      ).commit(async (tx) => {
        const p = await tx.doc(Publication);
        p.state = "done";
        p.reviewId = reviewId;
        p.payload = "PRIVATE_PREPARED_PAYLOAD";
        p.result = JSON.stringify({
          ...delivery,
          unexpected: "PRIVATE_UNUSED_RESULT_FIELD",
        });
        (await tx.doc(RoomDocument)).publishedHead = delivery.headSha;
      }, BACKGROUND_CONTEXT);
    });
    await evictDurableObject(stub);
    const response = await request(`/rooms/${id}`);
    const body = await response.json<{ publication: unknown }>();
    expect(body.publication).toEqual(delivery);
    expect(JSON.stringify(body)).not.toContain("PRIVATE_");
    const viewer = await connect(id);
    try {
      await viewer.until(() => viewer.frames.some((f) => f.type === "room"));
      expect(viewer.frames.find((f) => f.type === "room")).toMatchObject({
        publication: delivery,
      });
    } finally {
      viewer.socket.close();
    }
    expect(
      (await request(`/rooms/${id}`, "outsider@example.test")).status,
    ).toBe(403);
  });
  it("rejects a late automatic restore after Archive instead of reopening recovery", async () => {
    const id = await create();
    const stub = env.ROOMS.getByName(id);
    expect((await request(`/rooms/${id}/archive`, owner, "POST")).status).toBe(
      200,
    );
    const result = await runInDurableObject(stub, async (room) => {
      if (!(room instanceof FixtureRoom))
        throw Error("Unexpected fixture class");
      try {
        await room.transitionWorkspace("restoring");
        return "unexpected success";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(result).toBe("Restore was superseded by another control");
    expect(
      (await (await request(`/rooms/${id}`)).json<{ room: { mode: string } }>())
        .room.mode,
    ).toBe("archived");
  });
  it("keeps repeated Archive terminal across cleanup failure and actual eviction", async () => {
    const id = await create();
    expect(
      (await request(`/rooms/${id}/archive`, owner, "POST", {})).status,
    ).toBe(200);
    await runInDurableObject(env.ROOMS.getByName(id), (room) => {
      if (!(room instanceof FixtureRoom))
        throw new Error("Fixture room required");
      vi.spyOn(room.workspace(), "stop").mockRejectedValueOnce(
        new Error("cleanup must not run twice"),
      );
    });
    expect(
      (await request(`/rooms/${id}/archive`, owner, "POST", {})).status,
    ).toBe(200);
    await evictDurableObject(env.ROOMS.getByName(id));
    const viewer = await connect(id);
    try {
      const commandId = crypto.randomUUID();
      viewer.socket.send(JSON.stringify({ type: "resume", id: commandId }));
      await viewer.until(() =>
        viewer.frames.some((frame) => frame.id === commandId),
      );
      expect(
        viewer.frames.find((frame) => frame.id === commandId),
      ).toMatchObject({ type: "error", status: 409 });
      expect(
        (
          await (
            await request(`/rooms/${id}`)
          ).json<{ room: { mode: string } }>()
        ).room.mode,
      ).toBe("archived");
    } finally {
      viewer.socket.close();
      vi.restoreAllMocks();
    }
  });
  it("fences an incomplete old Stop after eviction and a new recovery cycle", async () => {
    const id = await create();
    let viewer = await connect(id);
    const oldStop = crypto.randomUUID();
    try {
      const receipt = vi
        .spyOn(RoomStore.prototype, "receipt")
        .mockRejectedValueOnce(new Error("fixture completion write failed"));
      viewer.socket.send(JSON.stringify({ type: "stop", id: oldStop }));
      await viewer.until(() =>
        viewer.frames.some((frame) => frame.id === oldStop),
      );
      expect(viewer.frames.find((frame) => frame.id === oldStop)).toMatchObject(
        { type: "error", status: 503 },
      );
      receipt.mockRestore();
      viewer.socket.close();
      await evictDurableObject(env.ROOMS.getByName(id));
      viewer = await connect(id);
      const resume = crypto.randomUUID();
      viewer.socket.send(JSON.stringify({ type: "resume", id: resume }));
      await viewer.until(() =>
        viewer.frames.some(
          (frame) => frame.id === resume && frame.type === "result",
        ),
      );
      const next = crypto.randomUUID();
      viewer.socket.send(
        JSON.stringify({
          type: "submit",
          id: next,
          text: "later " + "x".repeat(5000),
          mode: "followUp",
        }),
      );
      await viewer.until(() =>
        viewer.frames.some(
          (frame) => frame.id === next && frame.type === "result",
        ),
      );
      viewer.socket.send(JSON.stringify({ type: "stop", id: oldStop }));
      await viewer.until(() =>
        viewer.frames.some((frame) => frame.id === oldStop),
      );
      expect(viewer.frames.find((frame) => frame.id === oldStop)).toMatchObject(
        {
          type: "error",
          status: 409,
          message: expect.stringContaining("earlier recovery state"),
        },
      );
      expect(
        (
          await (
            await request(`/rooms/${id}`)
          ).json<{ room: { mode: string } }>()
        ).room.mode,
      ).toBe("ready");
    } finally {
      viewer.socket.close();
      vi.restoreAllMocks();
      await runInDurableObject(env.ROOMS.getByName(id), (room) =>
        room.harness.abort(),
      );
    }
  });
  it("reconciles committed queued withdrawal after lost reply, eviction and Resume without losing its draft", async () => {
    const id = await create();
    let viewer = await connect(id);
    const queuedId = crypto.randomUUID();
    const withdrawId = crypto.randomUUID();
    let operationId = "";
    try {
      const activeId = crypto.randomUUID();
      viewer.socket.send(
        JSON.stringify({
          type: "submit",
          id: activeId,
          text: "active " + "x".repeat(5000),
          mode: "followUp",
        }),
      );
      await viewer.until(() =>
        viewer.frames.some(
          (frame) => frame.id === activeId && frame.type === "result",
        ),
      );
      viewer.socket.send(
        JSON.stringify({
          type: "submit",
          id: queuedId,
          text: "recoverable queued draft",
          mode: "followUp",
        }),
      );
      await viewer.until(() =>
        viewer.frames.some(
          (frame) => frame.id === queuedId && frame.type === "result",
        ),
      );
      await runInDurableObject(env.ROOMS.getByName(id), async (room) => {
        const pi = await room.harness.pi();
        const queued = (await pi.inspect(BACKGROUND_CONTEXT)).submissions.find(
          (record) => record.status === "queued",
        );
        if (!queued?.requestId) throw new Error("Queued submission required");
        operationId = queued.requestId;
        const original = pi.abortSubmission.bind(pi);
        vi.spyOn(pi, "abortSubmission").mockImplementationOnce(
          async (...args) => {
            expect(await original(...args)).toBe("aborted");
            throw new Error("fixture reply lost after abort commit");
          },
        );
      });
      viewer.socket.send(
        JSON.stringify({ type: "withdraw", id: withdrawId, operationId }),
      );
      await viewer.until(() =>
        viewer.frames.some(
          (frame) => frame.id === withdrawId && frame.type === "error",
        ),
      );
      const stop = crypto.randomUUID();
      viewer.socket.send(JSON.stringify({ type: "stop", id: stop }));
      await viewer.until(() =>
        viewer.frames.some(
          (frame) => frame.id === stop && frame.type === "result",
        ),
      );
      viewer.socket.close();
      vi.restoreAllMocks();
      await evictDurableObject(env.ROOMS.getByName(id));
      viewer = await connect(id);
      const resume = crypto.randomUUID();
      viewer.socket.send(JSON.stringify({ type: "resume", id: resume }));
      await viewer.until(() =>
        viewer.frames.some(
          (frame) => frame.id === resume && frame.type === "result",
        ),
      );
      viewer.socket.send(
        JSON.stringify({ type: "withdraw", id: withdrawId, operationId }),
      );
      await viewer.until(() =>
        viewer.frames.some((frame) => frame.id === withdrawId),
      );
      expect(viewer.frames.find((frame) => frame.id === withdrawId)?.type).toBe(
        "result",
      );
      const data = await runInDurableObject(
        env.ROOMS.getByName(id),
        async (room) =>
          await (
            await room.harness.pi()
          ).snapshot(RoomDocument, BACKGROUND_CONTEXT),
      );
      expect(
        data?.withdrawn?.filter((item) => item.operationId === operationId),
      ).toEqual([
        {
          actor: owner,
          operationId,
          text: "recoverable queued draft",
          reason: "withdrawn",
        },
      ]);
    } finally {
      viewer.socket.close();
      vi.restoreAllMocks();
      await runInDurableObject(env.ROOMS.getByName(id), (room) =>
        room.harness.abort(),
      );
    }
  });
  it("hides rooms from outsiders and validates browser origins", async () => {
    const id = await create();
    const denied = await request(`/rooms/${id}`, "mallory@example.test");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(
      (
        await request(
          `/rooms/${id}/archive`,
          owner,
          "POST",
          {},
          "https://evil.test",
        )
      ).status,
    ).toBe(403);
    const list = await (
      await request("/rooms", "mallory@example.test")
    ).json<{ rooms: unknown[] }>();
    expect(list.rooms).toEqual([]);
  });
  it("shares attributed input, preserves it after reload and refuses observers", async () => {
    const id = await create();
    expect(
      (
        await request(`/rooms/${id}/members`, owner, "PUT", {
          email: "bob@example.test",
          role: "observer",
        })
      ).status,
    ).toBe(200);
    const alice = await connect(id);
    const bob = await connect(id, "bob@example.test");
    const commandId = crypto.randomUUID();
    bob.socket.send(JSON.stringify({ type: "stop", id: crypto.randomUUID() }));
    await bob.until(() => bob.frames.some((frame) => frame.type === "error"));
    alice.socket.send(
      JSON.stringify({
        type: "submit",
        id: commandId,
        text: "hello",
        mode: "followUp",
      }),
    );
    await alice.until(() =>
      alice.frames.some((frame) => frame.type === "result"),
    );
    await bob.until(() =>
      JSON.stringify(bob.frames).includes("Fixture model: hello"),
    );
    alice.socket.close();
    bob.socket.close();
    await expect
      .poll(
        async () =>
          (await (await request(`/rooms/${id}`)).json<{ pending: unknown[] }>())
            .pending,
      )
      .toEqual([]);
    await evictDurableObject(env.ROOMS.getByName(id));
    const resumed = await connect(id);
    expect(JSON.stringify(resumed.frames)).toContain("alice@example.test");
    resumed.socket.send(
      JSON.stringify({
        type: "submit",
        id: commandId,
        text: "changed",
        mode: "followUp",
      }),
    );
    await resumed.until(() =>
      resumed.frames.some(
        (frame) => frame.type === "error" && frame.status === 409,
      ),
    );
    resumed.socket.close();
  });
  it.each(["tokens", "cost"] as const)(
    "blocks model dispatch after the room %s budget is exhausted",
    async (limit) => {
      const id = await create();
      await runInDurableObject(env.ROOMS.getByName(id), async (room) => {
        const pi = await room.harness.pi();
        const root = await pi.root(BACKGROUND_CONTEXT);
        const usage = structuredClone(
          fauxAssistantMessage("budget fixture").usage,
        );
        if (limit === "tokens") usage.totalTokens = 200_000;
        else usage.cost.total = 5;
        await pi.commit(async (tx) => {
          (await tx.doc(UsageDoc, root.id)).models["fixture/budget"] = usage;
        }, BACKGROUND_CONTEXT);
      });
      const viewer = await connect(id);
      try {
        viewer.socket.send(
          JSON.stringify({
            type: "submit",
            id: crypto.randomUUID(),
            text: "budget-guard-probe",
            mode: "followUp",
          }),
        );
        await viewer.until(() => {
          const text = JSON.stringify(viewer.frames);
          return (
            text.includes("Room model budget reached") ||
            text.includes("Fixture model: budget-guard-probe")
          );
        });
        expect(
          JSON.stringify(viewer.frames).includes(
            "Fixture model: budget-guard-probe",
          ),
        ).toBe(false);
        expect(JSON.stringify(viewer.frames)).toContain(
          "Room model budget reached",
        );
      } finally {
        viewer.socket.close();
      }
    },
  );
  it("checks the updated token ledger before the next request, not just at startup", async () => {
    const id = await create();
    await runInDurableObject(env.ROOMS.getByName(id), async (room) => {
      const pi = await room.harness.pi();
      const root = await pi.root(BACKGROUND_CONTEXT);
      const usage = structuredClone(
        fauxAssistantMessage("budget fixture").usage,
      );
      usage.totalTokens = 199_999;
      await pi.commit(async (tx) => {
        (await tx.doc(UsageDoc, root.id)).models["fixture/budget"] = usage;
      }, BACKGROUND_CONTEXT);
    });
    const viewer = await connect(id);
    try {
      viewer.socket.send(
        JSON.stringify({
          type: "submit",
          id: crypto.randomUUID(),
          text: "budget-crossing-first",
          mode: "followUp",
        }),
      );
      await viewer.until(() =>
        JSON.stringify(viewer.frames).includes(
          "Fixture model: budget-crossing-first",
        ),
      );
      viewer.socket.send(
        JSON.stringify({
          type: "submit",
          id: crypto.randomUUID(),
          text: "budget-crossing-second",
          mode: "followUp",
        }),
      );
      await viewer.until(() =>
        JSON.stringify(viewer.frames).includes("Room model budget reached"),
      );
      expect(
        JSON.stringify(viewer.frames).includes(
          "Fixture model: budget-crossing-second",
        ),
      ).toBe(false);
    } finally {
      viewer.socket.close();
    }
  });
  it("does not request another model response after a tool requires recovery", async () => {
    const id = await create();
    const viewer = await connect(id);
    try {
      viewer.socket.send(
        JSON.stringify({
          type: "submit",
          id: crypto.randomUUID(),
          text: "!bash echo recovery-probe",
          mode: "followUp",
        }),
      );
      await viewer.until(() => {
        const text = JSON.stringify(viewer.frames);
        return (
          text.includes("Room execution is paused") ||
          text.includes("Tool failed; inspect the result.")
        );
      });
      expect(
        JSON.stringify(viewer.frames).includes(
          "Tool failed; inspect the result.",
        ),
      ).toBe(false);
      expect(JSON.stringify(viewer.frames)).toContain(
        "Room execution is paused",
      );
      expect(
        (
          await (
            await request(`/rooms/${id}`)
          ).json<{ room: { mode: string } }>()
        ).room.mode,
      ).toBe("recovery");
    } finally {
      viewer.socket.close();
    }
  });
  it("revalidates repository policy before publishing, even for an existing operator", async () => {
    const id = await create();
    await runInDurableObject(env.ROOMS.getByName(id), async (room) => {
      await (
        await room.harness.pi()
      ).commit(async (tx) => {
        (await tx.doc(RoomDocument)).members["removed@example.test"] =
          "operator";
      }, BACKGROUND_CONTEXT);
    });
    const response = await request(
      `/rooms/${id}/publish`,
      "removed@example.test",
      "POST",
      {
        id: crypto.randomUUID(),
        reviewId: crypto.randomUUID(),
        digest: "a".repeat(64),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Repository access not granted",
    });
  });
  it.each(["command", "delivery", "reattach"])(
    "rejects an expired socket authorization lease on %s",
    async (trigger) => {
      const id = await create();
      const viewer = await connect(id);
      let closeCode: number | undefined;
      viewer.socket.addEventListener("close", (event) => {
        closeCode = event.code;
      });
      const commandId = crypto.randomUUID();
      try {
        await runInDurableObject(env.ROOMS.getByName(id), (room) => {
          const socket = [...room.sockets.getConnections()][0]!;
          socket.setState({
            ...actor(owner),
            authorizedUntil: Date.now() - 1,
          });
        });
        if (trigger === "command")
          viewer.socket.send(JSON.stringify({ type: "retry", id: commandId }));
        else {
          if (trigger === "reattach")
            await runInDurableObject(env.ROOMS.getByName(id), (room) =>
              room.onStart(),
            );
          expect((await request(`/rooms/${id}`)).status).toBe(200);
        }
        await viewer.until(() => closeCode !== undefined);
        expect(closeCode).toBe(4002);
        expect(viewer.frames.some((frame) => frame.id === commandId)).toBe(
          false,
        );
      } finally {
        viewer.socket.close();
      }
    },
  );
  it("revokes existing viewers before any subsequent delivery", async () => {
    const id = await create();
    await request(`/rooms/${id}/members`, owner, "PUT", {
      email: "bob@example.test",
      role: "observer",
    });
    const viewer = await connect(id, "bob@example.test");
    const closed = new Promise<void>((resolve) =>
      viewer.socket.addEventListener("close", () => resolve(), { once: true }),
    );
    expect(
      (
        await request(`/rooms/${id}/members`, owner, "PUT", {
          email: "bob@example.test",
          role: null,
        })
      ).status,
    ).toBe(200);
    await closed;
    expect((await request(`/rooms/${id}`, "bob@example.test")).status).toBe(
      403,
    );
  });
});
