import { WorkerEntrypoint } from "cloudflare:workers";
import { GitHubService } from "../github";
import { AppError, createRoom } from "../shared/protocol";
import { allowedRepository, authenticate, requireSameOrigin } from "./auth";
import type { AppEnv } from "./env";
import { body, errorResponse } from "./http";
export { RoomDO } from "../room/room";
export { DirectoryDO } from "./directory";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";

export function github(env: AppEnv) {
  if (
    !env.GITHUB_APP_ID ||
    !env.GITHUB_INSTALLATION_ID ||
    !env.GITHUB_PRIVATE_KEY
  )
    throw new AppError(503, "GitHub App is not configured");
  return new GitHubService(
    {
      appId: env.GITHUB_APP_ID,
      installationId: env.GITHUB_INSTALLATION_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
    },
    fetch,
  );
}

export class GitReadGateway extends WorkerEntrypoint<
  AppEnv,
  { repository: string }
> {
  async fetch(request: Request) {
    try {
      return await github(this.env).brokerRead(
        this.ctx.props.repository,
        request,
      );
    } catch {
      return new Response("Repository read denied", { status: 403 });
    }
  }
}
export class DependencyGateway extends WorkerEntrypoint {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (
      url.hostname !== "registry.npmjs.org" ||
      url.protocol !== "https:" ||
      request.method !== "GET" ||
      url.port
    )
      return new Response("Denied", { status: 403 });
    const response = await fetch(url, {
      headers: { Accept: request.headers.get("Accept") ?? "*/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      return new Response("Registry fetch failed", { status: 502 });
    return new Response(response.body, {
      headers: {
        "Content-Type":
          response.headers.get("Content-Type") ?? "application/octet-stream",
      },
    });
  }
}

const routes = {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    let phase = "authentication";
    try {
      const identity = await authenticate(request, env);
      if (
        request.method !== "GET" ||
        request.headers.get("Upgrade")?.toLowerCase() === "websocket"
      )
        requireSameOrigin(request, env);
      if (url.pathname === "/api/me" && request.method === "GET")
        return Response.json({ identity, localDev: env.LOCAL_DEV === "true" });
      const directory = env.DIRECTORY.getByName("deployment");
      if (url.pathname === "/api/rooms") {
        if (request.method === "GET") {
          const rooms = [];
          for (const id of await directory.list()) {
            const response = await env.ROOMS.getByName(id).fetch(
              new Request("https://internal/", {
                headers: { "x-multipi-identity": JSON.stringify(identity) },
              }),
            );
            if (response.ok) {
              const value = await response.json<{
                room: { metadata: unknown };
              }>();
              rooms.push(value.room.metadata);
            }
          }
          return Response.json({ rooms });
        }
        if (request.method !== "POST")
          throw new AppError(405, "Method not allowed");
        const input = createRoom.parse(await body(request));
        allowedRepository(
          input.repository,
          identity.id,
          env.ALLOWED_REPOSITORIES,
        );
        phase = "repository_resolution";
        const selected = await github(env).resolveRepository(
          input.repository,
          input.baseSha,
        );
        if (selected.baseSha !== input.baseSha)
          throw new AppError(409, "Expected an exact base commit");
        const id = crypto.randomUUID();
        phase = "room_registration";
        await directory.add(id);
        phase = "workspace_initialization";
        const room = env.ROOMS.getByName(id);
        const metadata = {
          id,
          title: input.title,
          repository: input.repository,
          baseSha: input.baseSha,
          owner: identity.id,
          createdAt: new Date().toISOString(),
        };
        try {
          await room.initialize(metadata);
        } catch {
          let diagnosticsAvailable = false;
          try {
            // Initialization may have completed; reconcile without replaying its effects.
            const ready = await room.reconcilePreparation(metadata);
            const diagnostic = await room.fetch(
              new Request("https://internal/", {
                headers: { "x-multipi-identity": JSON.stringify(identity) },
              }),
            );
            await diagnostic.arrayBuffer();
            diagnosticsAvailable = diagnostic.ok;
            if (ready && diagnosticsAvailable)
              return Response.json({ id }, { status: 201 });
          } catch {}
          throw new AppError(
            503,
            diagnosticsAvailable
              ? `Workspace preparation needs attention; open #/rooms/${id} for diagnostics`
              : `Workspace preparation could not be confirmed; reference ${id}. Check the room directory before creating another room.`,
          );
        }
        return Response.json({ id }, { status: 201 });
      }
      const match = /^\/api\/rooms\/([a-f0-9-]{36})(\/.*)?$/.exec(url.pathname);
      if (!match) throw new AppError(404, "Not found");
      const internal = new URL(request.url);
      internal.pathname = match[2] ?? "/";
      const headers = new Headers(request.headers);
      headers.set("x-multipi-identity", JSON.stringify(identity));
      return await env.ROOMS.getByName(match[1]).fetch(
        new Request(internal, new Request(request, { headers })),
      );
    } catch (error) {
      const response = errorResponse(error);
      if (response.status === 500)
        console.error(
          JSON.stringify({
            component: "worker",
            phase,
            category:
              error instanceof TypeError ? "type_error" : "server_error",
            sites:
              error instanceof Error
                ? [
                    ...(error.stack ?? "").matchAll(
                      /(?:index|worker|service|directory)\.(?:js|ts):(\d+):(\d+)/g,
                    ),
                  ]
                    .slice(0, 5)
                    .map((match) => [Number(match[1]), Number(match[2])])
                : [],
          }),
        );
      return response;
    }
  },
} satisfies ExportedHandler<AppEnv>;

export default {
  async fetch(request: Request, env: AppEnv) {
    const response = await routes.fetch(request, env);
    if (
      response.status === 101 ||
      !new URL(request.url).pathname.startsWith("/api/")
    )
      return response;
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<AppEnv>;
