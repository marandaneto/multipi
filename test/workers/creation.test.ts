import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import app from "../../src/worker/index";
import { GitHubService } from "../../src/github";
import { FixtureRoom } from "./application";
import { RoomStore, type RoomMetadata } from "../../src/room/state";
import { AppError } from "../../src/shared/protocol";

const owner = "alice@example.test";
beforeEach(() => {
  vi.spyOn(GitHubService.prototype, "resolveRepository").mockResolvedValue({
    id: 1,
    repository: "org/repo",
    defaultBranch: "main",
    baseSha: "a".repeat(40),
  });
});
afterEach(() => vi.restoreAllMocks());
async function request(path: string, principal = owner, value?: unknown) {
  const response = await app.fetch(
    new Request(`http://localhost/api${path}`, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        Origin: "http://localhost",
        "x-multipi-dev-user": principal,
        "Content-Type": "application/json",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }),
    {
      ...env,
      GITHUB_APP_ID: "1",
      GITHUB_INSTALLATION_ID: "1",
      GITHUB_PRIVATE_KEY: "fixture key, not a credential",
    },
  );
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}
async function create() {
  return request("/rooms", owner, {
    title: "Failed admission",
    repository: "org/repo",
    baseSha: "a".repeat(40),
  });
}
it.each(["success", "failure"] as const)(
  "keeps provisioning cancellation archived through a late initialization %s and eviction",
  async (outcome) => {
    const id = crypto.randomUUID();
    const stub = env.ROOMS.getByName(id);
    const metadata = {
      id,
      title: "Cancelled preparation",
      repository: "org/repo",
      baseSha: "a".repeat(40),
      owner,
      createdAt: new Date().toISOString(),
    };
    const prepared = Promise.withResolvers<{
      revision: number;
      backupKey: string;
      digest: string;
    }>();
    await runInDurableObject(stub, (room) => {
      if (!(room instanceof FixtureRoom)) throw new Error("Fixture required");
      vi.spyOn(room.workspace(), "initialize").mockReturnValueOnce(
        prepared.promise,
      );
    });
    const initializing = stub.initialize(metadata).catch(() => {});
    try {
      await expect
        .poll(
          async () =>
            (
              await (
                await request(`/rooms/${id}`)
              ).json<{ room: { mode: string } }>()
            ).room.mode,
        )
        .toBe("provisioning");
      expect((await request(`/rooms/${id}/archive`, owner, {})).status).toBe(
        200,
      );
      if (outcome === "success")
        prepared.resolve({
          revision: 1,
          backupKey: "unacknowledged",
          digest: "unacknowledged",
        });
      else prepared.reject(new Error("fixture late preparation error"));
      await initializing;
      await evictDurableObject(stub);
      expect(await (await request(`/rooms/${id}`)).json()).toMatchObject({
        room: { mode: "archived", checkpoint: null },
      });
    } finally {
      prepared.reject(new Error("fixture cleanup"));
      await initializing;
    }
  },
);
it("retains private owner diagnostics when initialization fails before metadata", async () => {
  const initialize = vi
    .spyOn(FixtureRoom.prototype, "initialize")
    .mockRejectedValueOnce(new Error("private initialization failure"));
  const response = await create();
  expect(response.status).toBe(503);
  const body = await response.json<{ error: string }>();
  expect(body.error).not.toContain("private initialization failure");
  const id = body.error.match(/#\/rooms\/([a-f0-9-]{36})/)?.[1];
  expect(id).toBeTruthy();
  expect(initialize).toHaveBeenCalledTimes(1);
  const state = await request(`/rooms/${id}`);
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({
    role: "owner",
    room: { mode: "recovery", metadata: { id, owner }, checkpoint: null },
  });
  expect((await request(`/rooms/${id}`, "bob@example.test")).status).toBe(403);
  const listed = await (
    await request("/rooms")
  ).json<{ rooms: { id: string }[] }>();
  expect(listed.rooms.some((room) => room.id === id)).toBe(true);
  await evictDurableObject(env.ROOMS.getByName(id!));
  expect((await request(`/rooms/${id}`)).status).toBe(200);
  expect((await request(`/rooms/${id}/archive`, owner, {})).status).toBe(200);
});

it("keeps uncheckpointed diagnostics readable after restart while the workspace cannot be constructed", async () => {
  const workspace = vi
    .spyOn(FixtureRoom.prototype, "workspace")
    .mockImplementation(() => {
      throw new Error("Fixture workspace configuration unavailable");
    });
  const response = await create();
  expect(response.status).toBe(503);
  const body = await response.json<{ error: string }>();
  const id = body.error.match(/#\/rooms\/([a-f0-9-]{36})/)?.[1];
  expect(id).toBeTruthy();
  expect(workspace).toHaveBeenCalledTimes(1);
  await evictDurableObject(env.ROOMS.getByName(id!));
  const state = await request(`/rooms/${id}`);
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({
    room: { mode: "recovery", checkpoint: null },
  });
  expect(workspace).toHaveBeenCalledTimes(1);
  workspace.mockRestore();
  expect((await request(`/rooms/${id}/archive`, owner, {})).status).toBe(200);
});

it("does not reconcile or replay successful initialization", async () => {
  const initialize = vi.spyOn(FixtureRoom.prototype, "initialize");
  const reconcile = vi.spyOn(FixtureRoom.prototype, "reconcilePreparation");
  const response = await create();
  expect(response.status).toBe(201);
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(reconcile).not.toHaveBeenCalled();
});

it("reconciles a lost initialization reply without repeating checkout", async () => {
  const original = FixtureRoom.prototype.initialize;
  const initialize = vi
    .spyOn(FixtureRoom.prototype, "initialize")
    .mockImplementationOnce(async function (this: FixtureRoom, metadata) {
      await original.call(this, metadata);
      throw new Error("Fixture reply lost after commit");
    });
  const response = await create();
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: string }>();
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(await (await request(`/rooms/${id}`)).json()).toMatchObject({
    room: { mode: "ready", checkpoint: { revision: 1 } },
  });
});

it("does not promise diagnostics when reconciliation is unavailable", async () => {
  vi.spyOn(FixtureRoom.prototype, "initialize").mockRejectedValueOnce(
    new Error("Fixture transport unavailable"),
  );
  const reconcile = vi
    .spyOn(FixtureRoom.prototype, "reconcilePreparation")
    .mockRejectedValueOnce(new Error("Fixture reconciliation unavailable"));
  const response = await create();
  expect(response.status).toBe(503);
  const body = await response.json<{ error: string }>();
  expect(body.error).toContain("Check the room directory");
  expect(body.error).not.toContain("#/rooms/");
  expect(body.error).not.toContain("Fixture");
  expect(reconcile).toHaveBeenCalledTimes(1);
});

it("only offers a diagnostic link after verifying owner access", async () => {
  vi.spyOn(FixtureRoom.prototype, "initialize").mockRejectedValueOnce(
    new Error("Fixture early failure"),
  );
  vi.spyOn(FixtureRoom.prototype, "fetch").mockImplementationOnce(
    async () => new Response("Fixture unavailable", { status: 503 }),
  );
  const response = await create();
  const body = await response.json<{ error: string }>();
  expect(response.status).toBe(503);
  expect(body.error).not.toContain("#/rooms/");
  const id = body.error.match(/reference ([a-f0-9-]{36})/)?.[1];
  expect(id).toBeTruthy();
  expect((await request(`/rooms/${id}`)).status).toBe(200);
});

function metadata(): RoomMetadata {
  return {
    id: crypto.randomUUID(),
    title: "Original admission",
    repository: "org/repo",
    baseSha: "a".repeat(40),
    owner,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

it.each([
  { owner: "bob@example.test" },
  { repository: "other/repo" },
  { baseSha: "b".repeat(40) },
  { title: "Different title" },
  { createdAt: "2026-01-02T00:00:00.000Z" },
  { id: "00000000-0000-4000-8000-000000000001" },
])("does not replace a different admission: %j", async (patch) => {
  const original = metadata();
  const room = env.ROOMS.getByName(original.id);
  await room.initialize(original);
  const failure = await runInDurableObject(room, async (instance) => {
    try {
      await instance.reconcilePreparation({ ...original, ...patch });
      return null;
    } catch (error) {
      if (error instanceof AppError)
        return { status: error.status, message: error.message };
      throw error;
    }
  });
  expect(failure).toMatchObject({ status: "id" in patch ? 400 : 409 });
  expect(await (await request(`/rooms/${original.id}`)).json()).toMatchObject({
    role: "owner",
    room: { metadata: original, mode: "ready", checkpoint: { revision: 1 } },
  });
});

it("preserves an initialization still in progress rather than replaying or declaring it ready", async () => {
  const original = metadata();
  const room = env.ROOMS.getByName(original.id);
  await runInDurableObject(room, async (instance) => {
    await new RoomStore(await instance.harness.pi()).initialize(original);
  });
  expect(await room.reconcilePreparation(original)).toBe(false);
  expect(await (await request(`/rooms/${original.id}`)).json()).toMatchObject({
    room: {
      mode: "provisioning",
      checkpoint: null,
      diagnostic: "Workspace preparation outcome is not yet confirmed",
    },
  });
});

it("does not resurrect an archived room during reconciliation", async () => {
  const original = metadata();
  const room = env.ROOMS.getByName(original.id);
  await room.initialize(original);
  expect(
    (await request(`/rooms/${original.id}/archive`, owner, {})).status,
  ).toBe(200);
  expect(await room.reconcilePreparation(original)).toBe(false);
  expect(await (await request(`/rooms/${original.id}`)).json()).toMatchObject({
    room: { mode: "archived" },
  });
});
