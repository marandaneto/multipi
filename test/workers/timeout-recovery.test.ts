import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, it, vi } from "vitest";
import * as modelFactory from "@earendil-works/pi-ai/models";
import { FixtureRoom } from "./application";

it.each([false, true])(
  "omits cancelled goals after timeout and Stop/Restore (cleanup failure: %s) while preserving history and completed work",
  async (cleanupFailure) => {
    let openedModels: ReturnType<typeof modelFactory.createModels> | undefined;
    const originalModels = modelFactory.createModels;
    vi.spyOn(modelFactory, "createModels").mockImplementation(() => {
      openedModels = originalModels();
      return openedModels;
    });
    const getOpenedModels = () => openedModels;
    const id = crypto.randomUUID();
    const stub = env.ROOMS.getByName(id);
    const owner = "alice@example.test";
    await stub.initialize({
      id,
      title: "Timeout recovery",
      repository: "org/repo",
      baseSha: "a".repeat(40),
      owner,
      createdAt: new Date().toISOString(),
    });
    const requests: {
      latestUser: string;
      hasAbandonedGoal: boolean;
      hasCompletedGoal: boolean;
    }[] = [];
    await runInDurableObject(stub, async (room) => {
      const pi = await room.harness.pi();
      const root = await pi.root(BACKGROUND_CONTEXT);
      const agent = await root.agent(BACKGROUND_CONTEXT);
      const provider =
        agent.model && getOpenedModels()?.getProvider(agent.model.provider);
      if (!provider) throw new Error("Fixture provider missing");
      const original = provider.streamSimple.bind(provider);
      vi.spyOn(provider, "streamSimple").mockImplementation(
        (model, context, options) => {
          const last = context.messages
            .filter((message) => message.role === "user")
            .at(-1);
          requests.push({
            hasCompletedGoal: context.messages.some(
              (message) =>
                message.role === "user" &&
                typeof message.content === "string" &&
                message.content.includes("PRIOR_COMPLETED"),
            ),
            hasAbandonedGoal: context.messages.some(
              (message) =>
                message.role === "user" &&
                typeof message.content === "string" &&
                message.content.includes("ABANDONED_GOAL"),
            ),
            latestUser: last
              ? typeof last.content === "string"
                ? last.content
                : last.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("")
              : "",
          });
          return original(model, context, { ...options, timeoutMs: 100 });
        },
      );
    });
    const response = await stub.fetch(
      new Request("https://internal/socket", {
        headers: {
          Upgrade: "websocket",
          "x-multipi-identity": JSON.stringify({
            id: owner,
            subject: owner,
            expiresAt: Date.now() + 60_000,
          }),
        },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const frames: {
      type: string;
      id?: string;
      events?: unknown[];
      [key: string]: unknown;
    }[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)));
    });
    const until = async (predicate: () => boolean) => {
      await expect.poll(predicate, { timeout: 5000, interval: 10 }).toBe(true);
    };
    async function command(
      value: { type: string; [key: string]: unknown },
      expected = "result",
    ) {
      const commandId = crypto.randomUUID();
      socket.send(JSON.stringify({ ...value, id: commandId }));
      await until(() => frames.some((frame) => frame.id === commandId));
      expect(frames.find((frame) => frame.id === commandId)?.type).toBe(
        expected,
      );
    }
    try {
      await until(() => frames.some((frame) => frame.type === "pi"));
      await command({
        type: "submit",
        text: "PRIOR_COMPLETED",
        mode: "followUp",
      });
      await until(() =>
        JSON.stringify(frames).includes("Fixture model: PRIOR_COMPLETED"),
      );
      await command({
        type: "submit",
        text: "ABANDONED_GOAL " + "x".repeat(5000),
        mode: "followUp",
      });
      await until(() =>
        JSON.stringify(frames).includes("Model request timed out"),
      );
      if (cleanupFailure)
        await runInDurableObject(stub, (room) => {
          if (!(room instanceof FixtureRoom))
            throw new Error("Fixture room required");
          vi.spyOn(room.workspace(), "stop").mockRejectedValueOnce(
            new Error("Fixture cleanup failed"),
          );
        });
      await command({ type: "stop" }, cleanupFailure ? "error" : "result");
      await command({ type: "resume" });
      await runInDurableObject(stub, async (room) => {
        expect(await room.harness.pending()).toEqual([]);
        expect(await room.harness.session().busy()).toBe(false);
      });
      const requestsBeforeFollowUp = requests.length;
      await command({
        type: "submit",
        text: "NEXT_SHORT_INPUT",
        mode: "followUp",
      });
      await until(() =>
        JSON.stringify(frames).includes("Fixture model: NEXT_SHORT_INPUT"),
      );
      await expect
        .poll(
          () =>
            runInDurableObject(stub, async (room) => ({
              pending: await room.harness.pending(),
              busy: await room.harness.session().busy(),
            })),
          { timeout: 5000 },
        )
        .toEqual({ pending: [], busy: false });
      expect(requests).toHaveLength(requestsBeforeFollowUp + 1);
      expect(requests.at(-1)?.latestUser).toBe(`[${owner}] NEXT_SHORT_INPUT`);
      expect(requests.at(-1)?.hasAbandonedGoal).toBe(false);
      expect(requests.at(-1)?.hasCompletedGoal).toBe(true);
      socket.close();
      await evictDurableObject(stub);
      await runInDurableObject(stub, async (room) => {
        const root = await (await room.harness.pi()).root(BACKGROUND_CONTEXT);
        const context = await root.context(BACKGROUND_CONTEXT);
        const entries = context.entries;
        expect(
          context.messages.some(
            (message) =>
              message.role === "user" &&
              typeof message.content === "string" &&
              message.content.includes("ABANDONED_GOAL"),
          ),
        ).toBe(false);
        expect(
          context.messages.some(
            (message) =>
              message.role === "user" &&
              typeof message.content === "string" &&
              message.content.includes("PRIOR_COMPLETED"),
          ),
        ).toBe(true);
        expect(
          entries.filter((entry) => entry.kind === "multipi.control"),
        ).toHaveLength(1);
        expect(
          entries.filter((entry) => entry.kind === "multipi.input"),
        ).toHaveLength(3);
        expect(
          entries.filter((entry) => entry.kind === "multipi.context"),
        ).toHaveLength(1);
        expect(
          entries.some(
            (entry) =>
              entry.kind === "multipi.input" &&
              JSON.stringify(entry.data).includes("ABANDONED_GOAL"),
          ),
        ).toBe(true);
        expect(await room.harness.pending()).toEqual([]);
      });
    } finally {
      socket.close();
      await runInDurableObject(stub, (room) => room.harness.abort());
      vi.restoreAllMocks();
    }
  },
);
