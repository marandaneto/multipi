import { DurableObject } from "cloudflare:workers";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  type AgentEventStream,
} from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";

export class SpikeRoom extends DurableObject<Cloudflare.Env> {
  readonly faux = fauxProvider({ tokensPerSecond: 1000 });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      this.registry.install({
        name: "spike",
        tools: [
          {
            name: "gate",
            description: "Wait for release",
            parameters: Type.Object({}),
            replay: "unsafe",
            execute: async (_args, api, context) => {
              await this.ctx.storage.put(
                "runs",
                ((await this.ctx.storage.get<number>("runs")) ?? 0) + 1,
              );
              api.output("waiting");
              while (!(await this.ctx.storage.get("release"))) {
                context.abortSignal?.throwIfAborted();
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              return { output: [{ type: "text", text: "released" }] };
            },
          },
        ],
      });
      const models = createModels();
      models.setProvider(this.faux.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          settings: { retry: { enabled: false } },
        },
        context,
      );
    },
    defaults: { model: this.faux.getModel() },
  });
  readonly streams = new Map<WebSocket, AgentEventStream>();
  readonly sockets = new WebSockets({
    handlers: {
      onConnect: (connection) => this.watch(connection),
      onClose: async (connection) => {
        await this.streams.get(connection)?.stop();
        this.streams.delete(connection);
      },
    },
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.sockets)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const script = (context: TranscriptContext) => {
      const last = context.messages
        .filter((message) => message.role !== "system")
        .at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(last.isError ? "interrupted" : "released");
      const text = last?.role === "user" ? last.content : "";
      return text === "gate"
        ? fauxAssistantMessage([fauxToolCall("gate", {})], {
            stopReason: "toolUse",
          })
        : fauxAssistantMessage(
            `echo: ${typeof text === "string" ? text : JSON.stringify(text)}`,
          );
    };
    this.faux.setResponses(Array.from({ length: 100 }, () => script));
  }

  async onStart() {
    for (const socket of this.ctx.getWebSockets()) await this.watch(socket);
  }
  async watch(socket: WebSocket) {
    await this.streams.get(socket)?.stop();
    const stream = await this.harness.session().events();
    this.streams.set(socket, stream);
    socket.send(JSON.stringify([stream.snapshot]));
    stream.start(async (events) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(events));
    });
  }
  submit(input: string, operationId: string, steer = false) {
    return this.harness.submit(input, {
      operationId,
      ...(steer ? { whenBusy: "steer" as const } : {}),
    });
  }
  wait(operationId: string) {
    return this.harness.wait(operationId);
  }
  async release() {
    await this.ctx.storage.put("release", true);
  }
  async runs() {
    return (await this.ctx.storage.get<number>("runs")) ?? 0;
  }
  pending() {
    return this.harness.pending();
  }
  messages() {
    return this.harness.messages();
  }
}

export default { fetch: () => new Response("Spike only", { status: 404 }) };
