import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineDoc,
  GenerationTask,
  Harness,
  hook,
  type AgentEventStream,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type Connection } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { z } from "zod";
import { preparePublish, type PreparedPublish } from "../github";
import {
  AppError,
  command,
  digest,
  membershipChange,
  publishedDelivery,
  type Identity,
} from "../shared/protocol";
import { allowedRepository } from "../worker/auth";
import type { AppEnv } from "../worker/env";
import { github } from "../worker/index";
import { body, errorResponse } from "../worker/http";
import { reviewSchema, WorkspaceService } from "../workspace/service";
import { NativeExecutionEnv } from "../workspace/native-env";
import { RoomControl, type WorkspacePort } from "./control";
import { guardProvider, MODEL_REQUEST_TIMEOUT_MS } from "./model-guard";
import { RoomDocument, RoomStore, type RoomMetadata } from "./state";
import {
  identitySchema,
  SOCKET_AUTHORIZATION_MS,
  SocketAuthorization,
} from "./socket-auth";
const publishSchema = z
  .object({
    id: z.uuid(),
    reviewId: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const Publication = defineDoc<{
  payload: string | null;
  reviewId: string | null;
  state: "none" | "approved" | "done";
  result: string | null;
}>({
  kind: "multipi.publication",
  version: 1,
  scope: "session",
  initial: () => ({
    payload: null,
    reviewId: null,
    state: "none",
    result: null,
  }),
  checkpointWhen: () => true,
});
export interface RoomWorkspace extends WorkspacePort {
  readonly env: ExecutionEnv | undefined;
  attach(metadata: RoomMetadata): void;
  ensure(): Promise<void>;
}

export class RoomDO extends DurableObject<AppEnv> {
  private readonly registry = createRegistry();
  private readonly faux = fauxProvider({ tokensPerSecond: 500 });
  private readonly ai = this.env.AI ? createAI({ binding: this.env.AI }) : null;
  private readonly fixture =
    this.env.LOCAL_DEV === "true" && this.env.MODEL_ID === "fixture";
  private workspaceValue?: RoomWorkspace;
  private controlValue?: RoomControl;
  private readonly streams = new Map<WebSocket, AgentEventStream>();
  private readonly socketAuthorization = new SocketAuthorization();
  private releaseStartup!: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.releaseStartup = resolve;
  });
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      const models = createModels();
      const provider = this.fixture ? this.faux.provider : this.ai?.provider;
      // Pi Durable's environment errors are advisory, so enforce policy before provider dispatch.
      if (provider)
        models.setProvider(
          guardProvider(provider, () => this.assertModelRequestAllowed()),
        );
      const baseTools: readonly ToolRegistration[] = CodingTools.tools ?? [];
      const tools: ToolRegistration[] = baseTools.map((tool) => ({
        ...tool,
        replay: tool.name === "read" ? "safe" : "unsafe",
        executionMode: "sequential",
        execute: async (args, api, toolContext) => {
          await this.started;
          const store = await this.store();
          const state = await store.read();
          if (state.mode !== "ready" || !state.checkpoint)
            throw new AppError(409, "Workspace execution is blocked");
          const workspace = this.workspace();
          await workspace.ensure();
          const mutates = tool.name !== "read";
          // The pinned edit tool only reads before writeFile; error text is not proof of safety.
          const editEnv =
            tool.name === "edit" &&
            workspace.env instanceof NativeExecutionEnv &&
            workspace.env === api.env
              ? workspace.env
              : null;
          const editWrites = editEnv?.writeAttempts;
          const startedAt = Date.now();
          const shell =
            tool.name === "bash"
              ? z.object({ command: z.string() }).parse(args)
              : null;
          if (shell)
            await api.details(
              {
                command: shell.command,
                startedAt,
                outcome: "running",
                workspaceRevision: state.checkpoint.revision,
              },
              toolContext,
            );
          if (mutates)
            await store.update((room) => {
              room.execution = {
                callId: api.callId,
                beforeRevision: state.checkpoint!.revision,
                ...(shell
                  ? { shell: { command: shell.command, startedAt } }
                  : {}),
              };
            });
          try {
            const result = await tool.execute(args, api, toolContext);
            let revision = state.checkpoint.revision;
            const execution = z
              .object({ exitCode: z.number().int() })
              .safeParse(result.structuredOutput);
            if (mutates) {
              const checkpoint = await workspace.checkpoint(api.callId);
              revision = checkpoint.revision;
              if (shell)
                await store.recordExecution(
                  api.callId,
                  {
                    outcome: result.isError ? "failed" : "completed",
                    exitCode: execution.success
                      ? execution.data.exitCode
                      : null,
                    reason: "result",
                  },
                  checkpoint,
                );
              else
                await store.update((room) => {
                  room.checkpoint = checkpoint;
                });
            }
            if (shell) {
              return {
                ...result,
                details: {
                  command: shell.command,
                  startedAt,
                  finishedAt: Date.now(),
                  exitCode: execution.success ? execution.data.exitCode : null,
                  outcome: result.isError ? "failed" : "completed",
                  workspaceRevision: revision,
                },
              };
            }
            return result;
          } catch (error) {
            if (shell)
              await store.recordExecution(api.callId, {
                outcome:
                  error instanceof Error &&
                  /timed out|deadline/i.test(error.message)
                    ? "timed_out"
                    : "interrupted",
                exitCode: null,
                reason: "error",
              });
            if (shell && !toolContext.abortSignal?.aborted)
              await api.details(
                {
                  command: shell.command,
                  startedAt,
                  finishedAt: Date.now(),
                  outcome:
                    error instanceof Error &&
                    /timed out|deadline/i.test(error.message)
                      ? "timed_out"
                      : "interrupted",
                  exitCode: null,
                  workspaceRevision: state.checkpoint.revision,
                },
                BACKGROUND_CONTEXT,
              );
            if (mutates)
              await store.update((room) => {
                if (room.execution?.callId !== api.callId) return;
                if (
                  room.mode === "ready" &&
                  !toolContext.abortSignal?.aborted &&
                  editEnv &&
                  workspace.env === editEnv &&
                  editEnv.writeAttempts === editWrites
                ) {
                  room.execution = null;
                  return;
                }
                if (room.mode === "ready") room.mode = "recovery";
                room.diagnostic = "Tool outcome requires workspace recovery";
              });
            throw error;
          }
        },
      }));
      this.registry.install({
        name: "multipi.coding",
        tools,
        sections: [
          {
            key: "preamble",
            tag: false,
            render: () =>
              "You are the shared coding agent for this room. Work only in /workspace/repo. Humans are named in their inputs. Use read, edit, write, and bash to inspect, change, and test the repository. Never claim tests passed without a command result. Dependency caches such as node_modules are not checkpointed and may be absent after restoration; reinstall from the repository lockfile when needed before running checks. No production credentials or publication tools are available. Do not run detached jobs.",
          },
          {
            key: "project_instructions",
            render: async (input, sectionContext) => {
              const result = await input.env?.readTextFile(
                "/workspace/repo/AGENTS.md",
                sectionContext,
              );
              return result?.ok ? result.value.slice(0, 65_536) : undefined;
            },
          },
          {
            key: "repository",
            render: async () => {
              const room = await (await this.store()).read();
              return room.metadata
                ? `${room.metadata.repository} at ${room.metadata.baseSha}. Task: ${room.metadata.title}`
                : undefined;
            },
          },
        ],
        hooks: [
          hook(GenerationTask, {
            afterTools: async () => {
              await (
                await this.store()
              ).update((room) => {
                if (room.mode === "ready") room.execution = null;
              });
            },
          }),
        ],
      });
      const pi = await Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          env: async (target, envContext) => {
            await this.started;
            const room = await target.read.snapshot(RoomDocument, envContext);
            if (room?.mode !== "ready")
              throw new AppError(409, "Room execution is paused");
            await this.workspace().ensure();
            return this.workspace().env;
          },
          settings: {
            compaction: { backgroundTokens: 0 },
            toolExecution: "sequential",
            retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
            stream: { timeoutMs: MODEL_REQUEST_TIMEOUT_MS },
            afterFailedRun: "keep",
          },
          onReport: (_error, info) =>
            console.warn(
              JSON.stringify({ component: "pi", category: info.type }),
            ),
        },
        context,
      );
      // Recover before PiHarness resumes: afterTools may otherwise erase an interrupted intent.
      const recovered = await pi.snapshot(RoomDocument, context);
      if (
        recovered?.metadata &&
        (recovered.execution || recovered.mode === "stopping")
      ) {
        await pi.commit(async (tx) => {
          const room = await tx.doc(RoomDocument);
          room.mode = "recovery";
          room.diagnostic = "Interrupted workspace; explicit recovery required";
        }, context);
        this.workspace().attach(recovered.metadata);
        await this.workspace().stop();
        await new RoomStore(pi).recordInterruption("restart");
      }
      return pi;
    },
    defaults: {
      model: this.fixture
        ? this.faux.getModel()
        : this.ai && this.env.MODEL_ID
          ? this.ai(this.env.MODEL_ID)
          : undefined,
    },
  });
  readonly sockets = new WebSockets({
    protocol: false,
    getConnectionTags: async (connection, context) => {
      const identity = this.identity(context.request);
      await (await this.store()).authorize(identity);
      if ([...this.sockets.getConnections()].length >= 10)
        throw new AppError(429, "Room has 10 connected clients");
      connection.setState({
        ...identity,
        authorizedUntil: Date.now() + SOCKET_AUTHORIZATION_MS,
      });
      return [`user:${identity.id}`];
    },
    handlers: {
      onConnect: (connection) => this.attachSocket(connection),
      onMessage: (connection, raw) => this.message(connection, raw),
      onClose: async (connection) => {
        this.socketAuthorization.forget(connection);
        await this.unwatch(connection);
        await this.broadcast();
      },
      onError: (connection) => {
        this.socketAuthorization.forget(connection);
        return this.unwatch(connection);
      },
    },
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.sockets)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.faux.setResponses(
      Array.from({ length: 1000 }, () => (context: TranscriptContext) => {
        const last = context.messages
          .filter((item) => item.role !== "system")
          .at(-1);
        if (last?.role === "toolResult")
          return fauxAssistantMessage(
            last.isError
              ? "Tool failed; inspect the result."
              : "Tool completed.",
          );
        const input =
          last?.role === "user" && typeof last.content === "string"
            ? last.content.replace(/^\[[^\]]+\] /, "")
            : "";
        if (input.startsWith("!edit "))
          return fauxAssistantMessage(
            [fauxToolCall("edit", JSON.parse(input.slice(6)))],
            { stopReason: "toolUse" },
          );
        if (input.startsWith("!bash "))
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: input.slice(6) })],
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage(`Fixture model: ${input}`);
      }),
    );
  }
  private async assertModelRequestAllowed() {
    await this.started;
    const pi = await this.harness.pi();
    const room = await pi.snapshot(RoomDocument, BACKGROUND_CONTEXT);
    if (room?.mode !== "ready")
      throw new AppError(409, "Room execution is paused");
    const usage = await pi.usage(BACKGROUND_CONTEXT);
    const buckets = [
      ...Object.values(usage.models),
      ...Object.values(usage.tools),
    ];
    const tokens = buckets.reduce((sum, item) => sum + item.totalTokens, 0);
    const cost = buckets.reduce((sum, item) => sum + item.cost.total, 0);
    const tokenLimit = z.coerce
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .parse(this.env.MAX_ROOM_TOKENS ?? 200_000);
    const costLimit = z.coerce
      .number()
      .positive()
      .max(1000)
      .parse(this.env.MAX_ROOM_COST_USD ?? 5);
    if (tokens >= tokenLimit || cost >= costLimit)
      throw new AppError(429, "Room model budget reached; start a new room");
  }
  protected workspace(): RoomWorkspace {
    if (!this.workspaceValue) {
      if (!this.ctx.container)
        throw new AppError(503, "Linux container is not configured");
      const id = this.ctx.id.name;
      if (!id) throw new AppError(500, "Room must have a named Durable Object");
      this.workspaceValue = new WorkspaceService(
        this.ctx.container,
        id,
        this.ctx.exports.DirectoryBackupGateway,
        this.env.BACKUPS,
        async () => (await (await this.store()).read()).checkpoint,
        async (repository) => {
          await this.ctx.container!.interceptOutboundHttps(
            "github.com",
            this.ctx.exports.GitReadGateway({ props: { repository } }),
          );
          await this.ctx.container!.interceptOutboundHttps(
            "registry.npmjs.org",
            this.ctx.exports.DependencyGateway,
          );
        },
        (stage) => this.workspaceTransition(stage),
        this.env.WORKSPACE_INSTANCE_TYPE,
      );
    }
    return this.workspaceValue;
  }
  protected async workspaceTransition(stage: "restoring" | "ready" | "failed") {
    await (
      await this.store()
    ).update((room) => {
      if (stage === "restoring") {
        if (
          room.mode !== "ready" &&
          room.mode !== "review" &&
          room.mode !== "recovery"
        )
          throw new AppError(409, "Restore was superseded by another control");
        room.restoreMode = room.mode;
        room.mode = "recovery";
        room.execution = {
          callId: "workspace.restore",
          beforeRevision: room.checkpoint?.revision ?? 0,
        };
        room.diagnostic = "Restoring the acknowledged workspace checkpoint";
      } else if (stage === "ready") {
        if (
          room.mode !== "recovery" ||
          room.execution?.callId !== "workspace.restore"
        )
          throw new AppError(409, "Restore was superseded by another control");
        room.mode = room.restoreMode ?? "recovery";
        room.restoreMode = null;
        room.execution = null;
        room.diagnostic = null;
      } else if (room.mode === "recovery")
        room.diagnostic = "Restore failed; explicit recovery required";
    });
    await this.broadcast();
  }
  private async store() {
    return new RoomStore(await this.harness.pi());
  }
  private async control() {
    const store = await this.store();
    if (!this.controlValue || this.controlValue.store.pi !== store.pi)
      this.controlValue = new RoomControl(
        store,
        {
          submit: (input, options) => this.harness.submit(input, options),
          abort: (options) => this.harness.abort(options),
          retry: (options) => this.harness.retry(options),
          pending: (options) => this.harness.pending(options),
          busy: () => this.harness.session().busy(),
        },
        this.workspace(),
        () => this.broadcast(),
        async () => {
          if (
            (
              await (
                await this.harness.pi()
              ).snapshot(Publication, BACKGROUND_CONTEXT)
            )?.state === "approved"
          )
            throw new AppError(
              409,
              "Reconcile the pending publication before leaving review",
            );
        },
      );
    return this.controlValue;
  }
  async onStart() {
    const store = await this.store();
    const state = await store.read();
    if (
      state.metadata &&
      (state.checkpoint || state.execution || state.mode === "stopping")
    ) {
      this.workspace().attach(state.metadata);
      if (state.execution || state.mode === "stopping") {
        await store.update((room) => {
          room.mode = "recovery";
          room.diagnostic =
            "Interrupted workspace; restore the last checkpoint before continuing";
        });
        this.releaseStartup();
        await this.workspace().stop();
        await store.recordInterruption("restart");
        await this.harness.abort();
      }
    }
    this.releaseStartup();
    for (const socket of this.sockets.getConnections()) {
      try {
        await this.attachSocket(socket);
      } catch {
        if (socket.readyState === 1)
          socket.close(4001, "Reconnect to authenticate");
      }
    }
  }
  async initialize(metadata: RoomMetadata) {
    if (metadata.id !== this.ctx.id.name)
      throw new AppError(400, "Room ID mismatch");
    await (await this.control()).initialize(metadata);
  }
  async reconcilePreparation(metadata: RoomMetadata): Promise<boolean> {
    if (metadata.id !== this.ctx.id.name)
      throw new AppError(400, "Room ID mismatch");
    return (await this.store()).update((room) => {
      const existing = room.metadata;
      if (existing) {
        if (
          existing.id !== metadata.id ||
          existing.owner !== metadata.owner ||
          existing.repository !== metadata.repository ||
          existing.baseSha !== metadata.baseSha ||
          existing.title !== metadata.title ||
          existing.createdAt !== metadata.createdAt
        )
          throw new AppError(409, "Room admission does not match");
        if (room.mode === "provisioning")
          room.diagnostic =
            "Workspace preparation outcome is not yet confirmed";
        return room.mode === "ready" && room.checkpoint !== null;
      }
      room.metadata = metadata;
      room.members = { [metadata.owner]: "owner" };
      room.mode = "recovery";
      room.diagnostic = "Workspace preparation failed before initialization";
      return false;
    });
  }
  private identity(request: Request): Identity {
    try {
      return identitySchema.parse(
        JSON.parse(request.headers.get("x-multipi-identity") ?? ""),
      );
    } catch {
      throw new AppError(401, "Missing internal authenticated identity");
    }
  }
  private connectionIdentity(connection: Connection): Identity {
    return this.socketAuthorization.identity(connection);
  }
  private async envelope(identity: Identity) {
    const store = await this.store();
    const { data, role } = await store.authorize(identity);
    const publication = await store.pi.snapshot(
      Publication,
      BACKGROUND_CONTEXT,
    );
    const delivery =
      publication?.state === "done" &&
      publication.result &&
      publication.reviewId
        ? publishedDelivery.parse({
            ...JSON.parse(publication.result),
            reviewId: publication.reviewId,
          })
        : null;
    const pending = await Promise.all(
      (await this.harness.pending()).map(async (item) => ({
        ...item,
        actor: (await store.getReceipt(item.operationId))?.actor ?? "system",
      })),
    );
    const presence = new Set<string>();
    for (const socket of this.sockets.getConnections()) {
      try {
        const user = this.connectionIdentity(socket);
        if (user.expiresAt > Date.now() && Object.hasOwn(data.members, user.id))
          presence.add(user.id);
      } catch {
        if (socket.readyState === 1)
          socket.close(4001, "Reconnect to authenticate");
      }
    }
    return {
      type: "room" as const,
      room: data,
      publication: delivery,
      role,
      identity,
      presence: [...presence],
      pending,
    };
  }
  private async send(socket: Connection, value: unknown) {
    try {
      await (await this.store()).authorize(this.connectionIdentity(socket));
      if (socket.readyState !== 1) return;
      const encoded = JSON.stringify(value, (_key, field) => {
        if (
          field &&
          typeof field === "object" &&
          field.type === "thinking_delta"
        )
          return { ...field, delta: "" };
        if (field && typeof field === "object" && field.type === "thinking")
          return { type: "thinking", thinking: "" };
        return field;
      });
      if (encoded.length > 4 * 1024 * 1024) {
        socket.close(1009, "Room snapshot limit reached");
        return;
      }
      this.connectionIdentity(socket);
      socket.send(encoded);
    } catch {
      if (socket.readyState === 1)
        socket.close(4003, "Room access expired or revoked");
    }
  }
  private async attachSocket(socket: Connection) {
    this.socketAuthorization.watch(socket);
    await this.send(
      socket,
      await this.envelope(this.connectionIdentity(socket)),
    );
    if (socket.readyState !== 1) return;
    await this.unwatch(socket);
    const stream = await this.harness.session().events();
    if (socket.readyState !== 1) {
      await stream.stop();
      return;
    }
    this.streams.set(socket, stream);
    await this.send(socket, { type: "pi", events: [stream.snapshot] });
    if (socket.readyState !== 1) {
      await this.unwatch(socket);
      return;
    }
    stream.start(async (events) => {
      await this.send(socket, { type: "pi", events });
      if (
        events.some((event) =>
          [
            "inbox_update",
            "run_end",
            "submission",
            "tool_execution_end",
            "message_start",
          ].includes(event.type),
        )
      )
        await this.send(
          socket,
          await this.envelope(this.connectionIdentity(socket)),
        );
    });
    await this.broadcast();
  }
  private async unwatch(socket: WebSocket) {
    const stream = this.streams.get(socket);
    this.streams.delete(socket);
    await stream?.stop();
  }
  private async broadcast() {
    for (const socket of this.sockets.getConnections()) {
      try {
        await this.send(
          socket,
          await this.envelope(this.connectionIdentity(socket)),
        );
      } catch {
        socket.close(4003, "Room access expired or revoked");
      }
    }
  }
  private async message(
    connection: Connection,
    raw: string | ArrayBuffer | ArrayBufferView,
  ) {
    let id: string | undefined;
    try {
      if (typeof raw !== "string" || raw.length > 24 * 1024) {
        connection.close(1009, "Command too large");
        return;
      }
      const input = command.parse(JSON.parse(raw));
      if (input.type === "resync") {
        await this.attachSocket(connection);
        return;
      }
      id = input.id;
      const result = await (
        await this.control()
      ).dispatch(this.connectionIdentity(connection), input, () => {
        this.connectionIdentity(connection);
      });
      await this.send(connection, { type: "result", id, result });
    } catch (error) {
      const response = errorResponse(error);
      const value = await response.json<{ error: string }>();
      await this.send(connection, {
        type: "error",
        id,
        message: value.error,
        status: response.status,
      });
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await (await this.store()).authorize(this.identity(request));
      return await this.lifecycle.fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  }
  async onRequest(request: Request): Promise<Response> {
    try {
      const identity = this.identity(request);
      await (await this.store()).authorize(identity);
      const path = new URL(request.url).pathname;
      if (path === "/" && request.method === "GET")
        return Response.json(await this.envelope(identity));
      const control = await this.control();
      if (path === "/members" && request.method === "PUT") {
        const value = membershipChange.parse(await body(request));
        const repo = (await (await this.store()).read()).metadata!.repository;
        await control.membership(identity, value.email, value.role, () =>
          allowedRepository(repo, value.email, this.env.ALLOWED_REPOSITORIES),
        );
        return Response.json({ ok: true });
      }
      if (path === "/archive" && request.method === "POST") {
        await control.archive(identity);
        return Response.json({ ok: true });
      }
      if (path === "/review" && request.method === "POST")
        return Response.json(await control.prepareReview(identity));
      if (path === "/review" && request.method === "DELETE") {
        if (
          (
            await (
              await this.harness.pi()
            ).snapshot(Publication, BACKGROUND_CONTEXT)
          )?.state === "approved"
        )
          throw new AppError(
            409,
            "Reconcile the pending publication before exiting review",
          );
        await control.exitReview(identity);
        return Response.json({ ok: true });
      }
      if (
        (path === "/review" || path === "/patch") &&
        request.method === "GET"
      ) {
        const data = (await (await this.store()).authorize(identity)).data;
        if (!data.review) throw new AppError(404, "No prepared review");
        const object = await this.env.BACKUPS.get(
          `rooms/${data.metadata!.id}/reviews/${data.review.digest}.json`,
        );
        if (!object) throw new AppError(404, "Review artifact unavailable");
        const review = reviewSchema.parse(
          z
            .object({
              patch: reviewSchema.shape.patch,
              files: reviewSchema.shape.files,
            })
            .parse(await object.json()),
        );
        return path === "/patch"
          ? new Response(review.patch, {
              headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition": 'attachment; filename="multipi.patch"',
                "Cache-Control": "no-store",
              },
            })
          : Response.json({
              ...data.review,
              patch: review.patch,
              files: review.files.map((file) => ({
                path: file.path,
                status: file.content === null ? "deleted" : "changed",
              })),
            });
      }
      if (path === "/publish" && request.method === "POST") {
        const input = publishSchema.parse(await body(request));
        return Response.json(
          await control.serialize(async () => {
            const store = await this.store();
            const { data } = await store.authorize(identity, true);
            allowedRepository(
              data.metadata!.repository,
              identity.id,
              this.env.ALLOWED_REPOSITORIES,
            );
            const key = await digest(`${identity.id}:publish:${input.id}`);
            const receipt = await store.intent(
              key,
              identity.id,
              await digest(JSON.stringify(input)),
              key,
            );
            if (receipt.state === "done") return JSON.parse(receipt.result!);
            if (
              data.mode !== "review" ||
              !data.review ||
              data.review.id !== input.reviewId ||
              data.review.digest !== input.digest
            )
              throw new AppError(409, "Review approval is stale");
            const pi = await this.harness.pi();
            const existing = await pi.snapshot(Publication, BACKGROUND_CONTEXT);
            let prepared: PreparedPublish;
            if (existing?.reviewId === input.reviewId && existing.payload) {
              if (existing.state === "done")
                return JSON.parse(existing.result!);
              prepared = JSON.parse(existing.payload);
            } else {
              if (existing?.state === "approved")
                throw new AppError(
                  409,
                  "Another publication needs reconciliation",
                );
              const artifact = await this.env.BACKUPS.get(
                `rooms/${data.metadata!.id}/reviews/${input.digest}.json`,
              );
              if (!artifact)
                throw new AppError(404, "Review artifact unavailable");
              const parsed = z
                .object({
                  baseSha: z.string(),
                  files: reviewSchema.shape.files,
                })
                .parse(await artifact.json());
              if (
                (await digest(
                  JSON.stringify({
                    baseSha: parsed.baseSha,
                    files: parsed.files,
                  }),
                )) !== input.digest
              )
                throw new AppError(409, "Review integrity mismatch");
              prepared = await preparePublish(
                {
                  roomId: data.metadata!.id,
                  repository: data.metadata!.repository,
                  baseSha: data.metadata!.baseSha,
                  expectedHead: data.publishedHead,
                  title: data.metadata!.title,
                  body: "Human-reviewed multipi change. Commits are unsigned; repository rules may require additional signing or review.",
                  files: parsed.files,
                },
                { id: identity.id, name: identity.id, email: identity.id },
                new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
              );
              await pi.commit(async (tx) => {
                const publication = await tx.doc(Publication);
                publication.payload = JSON.stringify(prepared);
                publication.reviewId = input.reviewId;
                publication.state = "approved";
                publication.result = null;
              }, BACKGROUND_CONTEXT);
            }
            const result = await github(this.env).publish(prepared);
            await pi.commit(async (tx) => {
              const publication = await tx.doc(Publication);
              publication.state = "done";
              publication.result = JSON.stringify(result);
              (await tx.doc(RoomDocument)).publishedHead = result.headSha;
            }, BACKGROUND_CONTEXT);
            await store.receipt(key, { ...result }, "done");
            await this.broadcast();
            return result;
          }),
        );
      }
      throw new AppError(404, "Not found");
    } catch (error) {
      return errorResponse(error);
    }
  }
}
