import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import * as modelFactory from "@earendil-works/pi-ai/models";
import { ok } from "@earendil-works/pi-durable/env";
import { expect, it, vi } from "vitest";
import { RoomDocument } from "../../src/room/state";
import { createNativeExecutionEnv } from "../../src/workspace/native-env";
import { FixtureRoom } from "./application";

it.each(["identical", "missing", "changed", "mixed", "replaced"])(
  "guards edit validation without weakening mutation failure fencing: %s",
  async (kind) => {
    let models: ReturnType<typeof modelFactory.createModels> | undefined;
    const original = modelFactory.createModels;
    vi.spyOn(modelFactory, "createModels").mockImplementation(
      () => (models = original()),
    );
    const id = crypto.randomUUID(),
      owner = "alice@example.test";
    const stub = env.ROOMS.getByName(id);
    let socket: WebSocket | undefined;
    let writes = 0,
      checkpoints = 0;
    let replacedBeforeWrite = false;
    try {
      await stub.initialize({
        id,
        title: "No-op edit",
        repository: "org/repo",
        baseSha: "a".repeat(40),
        owner,
        createdAt: new Date().toISOString(),
      });
      await runInDurableObject(stub, async (room) => {
        if (!(room instanceof FixtureRoom)) throw Error("Unexpected fixture");
        const pi = await room.harness.pi(),
          agent = await (
            await pi.root(BACKGROUND_CONTEXT)
          ).agent(BACKGROUND_CONTEXT);
        const provider =
          agent.model && models?.getProvider(agent.model.provider);
        if (!provider) throw Error("Provider missing");
        const unused = () => {
          throw Error("Unexpected container operation");
        };
        const container: Container = {
          running: false,
          images: { workspace: "fixture" },
          start: unused,
          destroy: unused,
          monitor: unused,
          signal: unused,
          getTcpPort: unused,
          setInactivityTimeout: unused,
          interceptOutboundHttp: unused,
          interceptAllOutboundHttp: unused,
          interceptOutboundHttps: unused,
          snapshotContainer: unused,
          exec: unused,
          inspect: unused,
        };
        const native = createNativeExecutionEnv(container, id);
        vi.spyOn(native, "canonicalPath").mockResolvedValue(
          ok("/workspace/repo/file.txt"),
        );
        vi.spyOn(native, "fileInfo").mockResolvedValue(
          ok({
            name: "file.txt",
            path: "/workspace/repo/file.txt",
            kind: "file",
            size: 12,
            mtimeMs: 0,
          }),
        );
        vi.spyOn(native, "readTextFile").mockResolvedValue(ok("stable\nother"));
        const originalWrite = native.writeFile.bind(native);
        vi.spyOn(native, "writeFile").mockImplementation(async (...args) => {
          writes++;
          if (kind === "replaced")
            replacedBeforeWrite = room.workspace().env !== native;
          return originalWrite(...args);
        });
        Object.defineProperty(room.workspace(), "env", {
          value: native,
          configurable: true,
        });
        vi.spyOn(room.workspace(), "checkpoint").mockImplementation(
          async () => {
            checkpoints++;
            throw Error("Unexpected checkpoint");
          },
        );
        if (kind === "replaced") {
          const replacement = createNativeExecutionEnv(
            container,
            id + "-replacement",
          );
          vi.spyOn(replacement, "readTextFile").mockResolvedValue(
            ok("stable\nother"),
          );
          let ensures = 0;
          vi.spyOn(room.workspace(), "ensure").mockImplementation(async () => {
            ensures++;
            if (ensures === 3)
              Object.defineProperty(room.workspace(), "env", {
                value: replacement,
                configurable: true,
              });
          });
        }
        const stream = provider.streamSimple.bind(provider);
        vi.spyOn(provider, "streamSimple")
          .mockImplementationOnce((model) => {
            const result = createAssistantMessageEventStream();
            const message = {
              ...fauxAssistantMessage(
                [
                  fauxToolCall("edit", {
                    path: "file.txt",
                    edits:
                      kind === "mixed"
                        ? [
                            { oldText: "stable", newText: "stable" },
                            { oldText: "other", newText: "changed" },
                          ]
                        : [
                            {
                              oldText:
                                kind === "missing" ? "missing" : "stable",
                              newText:
                                kind === "identical" ? "stable" : "changed",
                            },
                          ],
                  }),
                ],
                { stopReason: "toolUse" },
              ),
              api: model.api,
              provider: model.provider,
              model: model.id,
            };
            queueMicrotask(() => {
              result.push({ type: "done", reason: "toolUse", message });
              result.end(message);
            });
            return result;
          })
          .mockImplementation(stream);
      });
      const response = await stub.fetch(
        new Request("https://internal/socket", {
          headers: {
            Upgrade: "websocket",
            "x-multipi-identity": JSON.stringify({
              id: owner,
              subject: owner,
              expiresAt: Date.now() + 60000,
            }),
          },
        }),
      );
      expect(response.status).toBe(101);
      socket = response.webSocket!;
      socket.accept();
      const frames: unknown[] = [];
      socket.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)));
      });
      socket.send(
        JSON.stringify({
          type: "submit",
          id: crypto.randomUUID(),
          text: "Try the identical edit",
          mode: "followUp",
        }),
      );
      await expect
        .poll(
          () =>
            (kind === "identical"
              ? /No changes|no changes/
              : kind === "missing"
                ? /Could not find the exact text/
                : /Could not edit file/
            ).test(JSON.stringify(frames)),
          { timeout: 5000, interval: 10 },
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            runInDurableObject(
              stub,
              async (room) => (await room.harness.pending()).length,
            ),
          { timeout: 5000, interval: 10 },
        )
        .toBe(0);
      expect(writes).toBe(kind === "identical" || kind === "missing" ? 0 : 1);
      expect(checkpoints).toBe(0);
      if (kind === "replaced") expect(replacedBeforeWrite).toBe(true);
      await runInDurableObject(stub, async (room) => {
        const data = await (
          await room.harness.pi()
        ).snapshot(RoomDocument, BACKGROUND_CONTEXT);
        expect(data?.mode).toBe(
          kind === "identical" || kind === "missing" ? "ready" : "recovery",
        );
        if (kind === "identical" || kind === "missing")
          expect(data?.execution).toBeNull();
        else expect(data?.execution).not.toBeNull();
        expect(data?.checkpoint?.revision).toBe(1);
      });
    } finally {
      socket?.close();
      vi.restoreAllMocks();
    }
  },
);
