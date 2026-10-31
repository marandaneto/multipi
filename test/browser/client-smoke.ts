// Optional local Brave smoke: pnpm test:ui
// Uses mocked HTTP/socket APIs, but real React, WebSocket plumbing, and browser IndexedDB.
import assert from "node:assert/strict";
import { chromium, expect, type WebSocketRoute } from "@playwright/test";
import { createServer } from "vite";
import { z } from "zod";
import { braveExecutable } from "./brave.ts";

const roomId = "00000000-0000-4000-8000-000000000010";
const alice = {
  id: "alice@example.test",
  subject: "alice-subject",
  expiresAt: Date.now() + 3600000,
};
let identity = alice;
let role: "owner" | "operator" | "observer" = "operator";
let mode: "ready" | "review" | "recovery" | "provisioning" = "ready";
let digest = "digest-one";
let reviewId = "review-one";
let publication: {
  reviewId: string;
  pullRequestUrl: string;
  headSha: string;
} | null = null;
const review = () => ({
  id: reviewId,
  revision: 1,
  digest,
  patch: "+<img src=x onerror=alert(1)>\n",
  files: [{ path: "test.ts", status: "M" }],
});
const envelope = () => ({
  room: {
    metadata: {
      id: roomId,
      title: "Browser demo",
      repository: "org/repo",
      baseSha: "a".repeat(40),
      owner: "owner@example.test",
      createdAt: "2026-01-01",
    },
    members: { [identity.id]: role },
    mode,
    checkpoint: { revision: 1, backupKey: "test", digest: "checkpoint" },
    execution: null,
    diagnostic: null,
    review: mode === "review" ? { id: reviewId, revision: 1, digest } : null,
    publishedHead: publication?.headSha ?? null,
  },
  publication,
  role,
  identity,
  pending: [],
});
const snapshot = {
  type: "pi",
  events: [
    {
      type: "snapshot",
      entries: [
        {
          id: 2,
          kind: "multipi.execution",
          data: {
            callId: "stopped-call",
            command: "<img src=x onerror=alert(1)>",
            startedAt: 100,
            observedAt: 200,
            workspaceRevision: 1,
            outcome: "interrupted",
            exitCode: null,
            reason: "stop",
          },
        },
        {
          id: 1,
          kind: "multipi.input",
          model: [
            {
              role: "user",
              content: "[alice@example.test] hi",
              timestamp: 123,
            },
          ],
          data: {
            actor: alice.id,
            text: "hi",
            mode: "followUp",
            commandId: crypto.randomUUID(),
          },
        },
      ],
      tools: [],
      nestedTools: [],
      inbox: [],
      agent: { model: { provider: "example", modelId: "model" } },
      usage: { models: {}, tools: {} },
    },
  ],
};
const commands: { type: string; id?: string; text?: string }[] = [];
const publications: unknown[] = [];
const creations: unknown[] = [];
const memberships: unknown[] = [];
let archives = 0;
let latestSocket: WebSocketRoute | undefined;
const server = await createServer({
  configFile: false,
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("No browser-check Vite URL");
const browser = await chromium.launch({
  headless: true,
  executablePath: braveExecutable,
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown;
    if (path === "/api/me") body = { identity, localDev: false };
    else if (path === "/api/rooms") {
      if (request.method() === "POST") {
        const value: unknown = request.postDataJSON();
        creations.push(value);
        if (creations.length === 1) {
          mode = "recovery";
          await route.fulfill({
            status: 503,
            json: {
              error: `Workspace preparation needs attention; open #/rooms/${roomId} for diagnostics`,
            },
          });
          return;
        }
        body = { id: roomId };
      } else body = { rooms: [envelope().room.metadata] };
    } else if (path.endsWith("/review")) {
      if (["POST", "DELETE"].includes(request.method())) {
        mode = request.method() === "POST" ? "review" : "ready";
        latestSocket?.send(
          JSON.stringify({
            type: "room",
            ...envelope(),
            presence: [identity.id],
          }),
        );
      }
      body = review();
    } else if (path.endsWith("/publish")) {
      const value: unknown = request.postDataJSON();
      publications.push(value);
      body = {
        pullRequestUrl: "https://github.com/org/repo/pull/1",
        headSha: "b".repeat(40),
      };
      publication = {
        reviewId: review().id,
        pullRequestUrl: "https://github.com/org/repo/pull/1",
        headSha: "b".repeat(40),
      };
      latestSocket?.send(
        JSON.stringify({
          type: "room",
          ...envelope(),
          presence: [identity.id],
        }),
      );
    } else if (path.endsWith("/members")) {
      const value: unknown = request.postDataJSON();
      memberships.push(value);
      body = { ok: true };
    } else if (path.endsWith("/archive")) {
      archives++;
      body = { ok: true };
    } else if (path === `/api/rooms/${roomId}`) body = envelope();
    else {
      await route.fulfill({
        status: 404,
        json: { error: "Unknown smoke API" },
      });
      return;
    }
    await route.fulfill({ status: 200, json: body });
  });
  await context.routeWebSocket("**/api/rooms/*/socket", (socket) => {
    latestSocket = socket;
    socket.onMessage((raw) => {
      const value: unknown = JSON.parse(String(raw));
      const command = z
        .object({
          type: z.string(),
          id: z.string().optional(),
          text: z.string().optional(),
        })
        .parse(value);
      commands.push(command);
    });
    socket.send(
      JSON.stringify({ type: "room", ...envelope(), presence: [identity.id] }),
    );
    socket.send(JSON.stringify(snapshot));
  });
  await page.goto(url);
  await page.getByLabel("Title", { exact: true }).fill("Browser demo");
  await page.getByLabel("Repository", { exact: true }).fill("org/repo");
  await page.getByLabel("Base commit SHA").fill("a".repeat(40));
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  const diagnostics = page.getByRole("link", {
    name: "Open room diagnostics",
    exact: true,
  });
  await expect(diagnostics).toHaveAttribute("href", `#/rooms/${roomId}`);
  await diagnostics.click();
  await expect(
    page.getByRole("region", { name: "Room and agent state" }),
  ).toContainText("Room: recovery");
  await expect(page.getByLabel("Message to Pi")).toBeDisabled();
  await page.getByRole("link", { name: "← Rooms", exact: true }).click();
  mode = "ready";
  await page.getByLabel("Title", { exact: true }).fill("Browser demo");
  await page.getByLabel("Repository", { exact: true }).fill("org/repo");
  await page.getByLabel("Base commit SHA").fill("a".repeat(40));
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/rooms/${roomId}$`));
  await expect(
    page.getByText("Connected · synchronized", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(creations, [
    { title: "Browser demo", repository: "org/repo", baseSha: "a".repeat(40) },
    { title: "Browser demo", repository: "org/repo", baseSha: "a".repeat(40) },
  ]);
  await expect(
    page.getByRole("button", { name: "Send follow-up" }),
  ).toBeDisabled();
  const record = page.locator(".message.execution");
  await expect(record).toContainText("Host execution record · stop");
  await expect(record).toContainText("exit not reported");
  await expect(record).toContainText("<img src=x onerror=alert(1)>");
  await expect(record.locator("img")).toHaveCount(0);
  const download = page.getByRole("link", {
    name: "Download patch",
    exact: true,
  });
  await expect(download).toHaveCount(0);
  await page.getByLabel("Message to Pi").fill("durable prompt");
  await expect(
    page.getByRole("button", { name: "Send follow-up" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Send follow-up" }).click();
  await expect(
    page.getByRole("heading", { name: "Browser outbox" }),
  ).toBeVisible();
  await expect
    .poll(() => commands.filter((command) => command.type === "submit").length)
    .toBe(1);
  const originalId = commands.find((command) => command.type === "submit")?.id;
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect
    .poll(() => commands.filter((command) => command.type === "stop").length)
    .toBe(1);
  await page.reload();
  await expect
    .poll(() => commands.filter((command) => command.type === "submit").length)
    .toBe(2);
  assert.equal(
    commands.filter((command) => command.type === "submit")[1]?.id,
    originalId,
  );
  assert.equal(commands.filter((command) => command.type === "stop").length, 1);
  identity = { ...alice, id: "bob@example.test", subject: "bob-subject" };
  await page.reload();
  await expect(
    page.getByText("Connected · synchronized", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Browser outbox" }),
  ).toHaveCount(0);
  assert.equal(
    commands.filter((command) => command.type === "submit").length,
    2,
  );
  identity = alice;
  await page.reload();
  await expect
    .poll(() => commands.filter((command) => command.type === "submit").length)
    .toBe(3);
  latestSocket?.send(
    JSON.stringify({
      type: "result",
      id: originalId,
      result: { accepted: true },
    }),
  );
  await expect(
    page.getByRole("heading", { name: "Browser outbox" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Freeze patch for review" }).click();
  await expect(download).toBeVisible();
  await page.getByRole("button", { name: "Exit review", exact: true }).click();
  await expect(download).toHaveCount(0);
  await page.getByRole("button", { name: "Freeze patch for review" }).click();
  const publish = page.getByRole("button", { name: "Create draft PR" });
  await expect(publish).toBeDisabled();
  await expect(page.locator("pre.diff")).toContainText("<img");
  await expect(page.locator("pre.diff img")).toHaveCount(0);
  await page.getByRole("checkbox").check();
  digest = "digest-two";
  latestSocket?.send(
    JSON.stringify({ type: "room", ...envelope(), presence: [identity.id] }),
  );
  await expect(publish).toBeDisabled();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("checkbox").check();
  await publish.click();
  await expect(
    page.getByRole("link", { name: "Open pull request" }),
  ).toHaveAttribute("href", "https://github.com/org/repo/pull/1");
  assert.equal(publications.length, 1);
  await page.reload();
  await expect(
    page.getByText("Connected · synchronized", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open pull request", exact: true }),
  ).toHaveAttribute("href", "https://github.com/org/repo/pull/1");
  await expect(
    page.getByRole("button", { name: "Create draft PR", exact: true }),
  ).toBeDisabled();
  assert.equal(publications.length, 1);
  reviewId = "review-two";
  digest = "digest-three";
  latestSocket?.send(
    JSON.stringify({ type: "room", ...envelope(), presence: [identity.id] }),
  );
  await expect(page.getByRole("checkbox")).toBeEnabled();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(
    page.getByRole("link", { name: "Open pull request", exact: true }),
  ).toBeVisible();
  assert.equal(publications.length, 1);
  z.object({
    id: z.uuid(),
    reviewId: z.literal("review-one"),
    digest: z.literal("digest-two"),
  })
    .strict()
    .parse(publications[0]);
  role = "observer";
  mode = "ready";
  await page.reload();
  await expect(page.getByText("Observer: read-only access.")).toBeVisible();
  await expect(page.getByLabel("Message to Pi")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Manage membership" }),
  ).toHaveCount(0);
  role = "owner";
  await page.reload();
  await page.getByLabel("Existing user's email").fill("bob@example.test");
  await page.getByRole("combobox").selectOption("observer");
  await page.getByRole("button", { name: "Update membership" }).click();
  await expect.poll(() => memberships.length).toBe(1);
  assert.deepEqual(memberships, [
    { email: "bob@example.test", role: "observer" },
  ]);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Archive room", exact: true }).click();
  await expect.poll(() => archives).toBe(1);
  const stopsBeforeLoss = commands.filter(
    (command) => command.type === "stop",
  ).length;
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect
    .poll(() => commands.filter((command) => command.type === "stop").length)
    .toBe(stopsBeforeLoss + 1);
  await latestSocket?.close({
    code: 4002,
    reason: "Simulated lost confirmation",
  });
  await expect(page.getByRole("alert")).toContainText(
    "Stop outcome unconfirmed; check room state before trying again",
  );
  await expect(
    page.getByText("Connected · synchronized", { exact: true }),
  ).toBeVisible();
  assert.equal(
    commands.filter((command) => command.type === "stop").length,
    stopsBeforeLoss + 1,
  );
  mode = "provisioning";
  latestSocket?.send(
    JSON.stringify({ type: "room", ...envelope(), presence: [identity.id] }),
  );
  await expect(page.getByLabel("Message to Pi")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Archive room", exact: true }),
  ).toBeEnabled();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Archive room", exact: true }).click();
  await expect.poll(() => archives).toBe(2);
  assert.deepEqual(pageErrors, []);
  console.log(
    "PASS browser smoke: room creation, real IndexedDB reload/replay and principal isolation, one-shot stop, digest-bound publication, literal diff, observer controls, owner membership/archive; zero browser errors",
  );
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
