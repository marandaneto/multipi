import assert from "node:assert/strict";
import fs from "node:fs";
const base = process.env.PROBE_URL ?? "http://localhost:8792";
async function get(path, method = "GET") {
  const response = await fetch(base + path, { method });
  const text = await response.text();
  assert.ok(response.ok, text);
  return JSON.parse(text);
}
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("Probe condition timed out");
}
await get("/setup", "POST");
const frames = [];
let socket = new WebSocket(base.replace("http", "ws") + "/socket");
socket.addEventListener("message", (event) =>
  frames.push(JSON.parse(event.data)),
);
await until(() => frames.some((frame) => frame.type === "pi"));
const parkedInput = crypto.randomUUID();
socket.send(
  JSON.stringify({
    type: "submit",
    id: parkedInput,
    text: "PARKED_LOCAL_FIXTURE " + "x".repeat(12000),
    mode: "followUp",
  }),
);
let connectionStart = 0;
let crashes = 0;
for (; crashes < 5; crashes++) {
  await until(async () => {
    const state = await get("/");
    const streamed = frames
      .slice(connectionStart)
      .some(
        (frame) =>
          frame.type === "pi" &&
          frame.events.some((event) => event.type === "message_update"),
      );
    return state.room.mode === "ready" && !state.room.execution && streamed;
  });
  await get("/crash", "POST");
  socket.close();
  connectionStart = frames.length;
  socket = new WebSocket(base.replace("http", "ws") + "/socket");
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data));
  });
  await until(() =>
    frames.slice(connectionStart).some((frame) => frame.type === "pi"),
  );
}
await until(async () =>
  (await get("/")).pending.some((input) => input.status === "parked"),
);
assert.equal((await get("/")).room.mode, "ready");
const parkedState = await get("/");
assert.equal(parkedState.pending.length, 1);
const retryId = crypto.randomUUID();
socket.send(JSON.stringify({ type: "retry", id: retryId }));
await until(() =>
  frames.some((frame) => frame.type === "result" && frame.id === retryId),
);
await until(async () => (await get("/")).pending.length === 0);
assert.equal((await get("/")).room.checkpoint.revision, 1);
socket.send(JSON.stringify({ type: "retry", id: retryId }));
await until(
  () =>
    frames.filter((frame) => frame.type === "result" && frame.id === retryId)
      .length === 2,
);
assert.equal((await get("/")).pending.length, 0);
const parkedInputs = new Map(
  frames
    .flatMap((frame) => (frame.type === "pi" ? frame.events : []))
    .flatMap((event) =>
      event.type === "snapshot"
        ? event.entries
        : event.entry
          ? [event.entry]
          : [],
    )
    .filter(
      (entry) =>
        entry.kind === "multipi.input" && entry.data.commandId === parkedInput,
    )
    .map((entry) => [entry.id, entry]),
);
assert.equal(parkedInputs.size, 1);
const parkedEvidence = {
  crashes,
  defaultRestartLimit: 5,
  pendingBeforeRetry: parkedState.pending,
  completedAfterRetry: true,
  replayedRetryReturnedCachedResult: true,
  retainedInputEntries: parkedInputs.size,
};
console.log(
  "Actual local actor aborts at default restart limit 5 parked model work; official Retry resumed it to completion without replaying the input.",
);
const executionRecords = (source) =>
  source
    .flatMap((frame) => (frame.type === "pi" ? frame.events : []))
    .flatMap((event) =>
      event.type === "snapshot"
        ? event.entries
        : event.entry
          ? [event.entry]
          : [],
    )
    .filter((entry) => entry.kind === "multipi.execution")
    .map((entry) => entry.data);
const send = (text) =>
  socket.send(
    JSON.stringify({
      type: "submit",
      id: crypto.randomUUID(),
      text,
      mode: "followUp",
    }),
  );
for (const kind of ["identical", "missing"]) {
  const start = frames.length;
  send(
    "!edit " +
      JSON.stringify({
        path: "index.js",
        edits: [
          {
            oldText:
              kind === "identical"
                ? "export const value = 1;"
                : "MISSING_EDIT_TARGET",
            newText:
              kind === "identical" ? "export const value = 1;" : "changed",
          },
        ],
      }),
  );
  await until(async () => {
    const text = JSON.stringify(frames.slice(start));
    const expected =
      kind === "identical"
        ? text.includes("No changes made")
        : text.includes("Could not find the exact text");
    return expected && (await get("/")).pending.length === 0;
  });
  const unchanged = await get("/");
  assert.equal(unchanged.room.mode, "ready");
  assert.equal(unchanged.room.execution, null);
  assert.equal(unchanged.room.checkpoint.revision, 1);
}
console.log(
  "Actual native edit validation errors preserved ready/checkpoint 1 without a write or recovery.",
);
send("!bash printf changed > index.js; printf added > new.txt; rm old.txt");
await until(async () => {
  const state = await get("/");
  return (
    state.room.checkpoint.revision === 2 &&
    !state.room.execution &&
    state.pending.length === 0
  );
});
await until(() => executionRecords(frames).length === 1);
assert.equal(executionRecords(frames)[0].outcome, "completed");
assert.equal(executionRecords(frames)[0].exitCode, 0);
assert.equal(executionRecords(frames)[0].workspaceRevision, 2);
const review = await get("/review", "POST");
assert.equal(review.files.length, 3);
assert.ok(review.patch.includes("new.txt") && review.patch.includes("old.txt"));
assert.equal((await get("/")).room.mode, "review");
const exit = await fetch(base + "/review", { method: "DELETE" });
assert.equal(exit.status, 200);
const stoppedCommand = "printf stop-running > stop-pending.txt; sleep 60";
send("!bash " + stoppedCommand);
await until(async () => Boolean((await get("/")).room.execution));
await until(async () => (await get("/has?path=stop-pending.txt")).exists);
socket.send(JSON.stringify({ type: "stop", id: crypto.randomUUID() }));
await until(async () => (await get("/")).room.mode === "stopped");
await until(() =>
  executionRecords(frames).some((record) => record.command === stoppedCommand),
);
const stoppedRecords = executionRecords(frames).filter(
  (record) => record.command === stoppedCommand,
);
assert.equal(stoppedRecords.length, 1);
assert.equal(stoppedRecords[0].outcome, "interrupted");
assert.equal(stoppedRecords[0].exitCode, null);
assert.equal(stoppedRecords[0].workspaceRevision, 2);
assert.ok(stoppedRecords[0].observedAt >= stoppedRecords[0].startedAt);
socket.send(JSON.stringify({ type: "resume", id: crypto.randomUUID() }));
await until(async () => (await get("/")).room.mode === "ready");
assert.equal((await get("/has?path=stop-pending.txt")).exists, false);
send("!bash printf uncertain > uncertain.txt; sleep 60");
await until(async () => Boolean((await get("/")).room.execution));
await until(async () => (await get("/has?path=uncertain.txt")).exists);
await get("/crash", "POST");
socket.close();
await until(async () => (await get("/")).room.mode === "recovery");
const recovered = new WebSocket(base.replace("http", "ws") + "/socket");
let synced = false;
const recoveredFrames = [];
recovered.addEventListener("message", (event) => {
  const frame = JSON.parse(event.data);
  recoveredFrames.push(frame);
  if (frame.type === "pi") synced = true;
});
await until(() => synced);
assert.equal(
  executionRecords(recoveredFrames).filter(
    (record) => record.command === stoppedCommand,
  ).length,
  1,
);
const crashedRecord = executionRecords(recoveredFrames).find(
  (record) => record.command === "printf uncertain > uncertain.txt; sleep 60",
);
assert.ok(crashedRecord);
assert.equal(crashedRecord.outcome, "interrupted");
assert.equal(crashedRecord.exitCode, null);
assert.equal(crashedRecord.workspaceRevision, 2);
recovered.send(JSON.stringify({ type: "resume", id: crypto.randomUUID() }));
await until(async () => {
  const error = recoveredFrames.find((frame) => frame.type === "error");
  if (error)
    throw Error(JSON.stringify({ frame: error, room: await get("/") }));
  return (await get("/")).room.mode === "ready";
});
assert.equal((await get("/has?path=uncertain.txt")).exists, false);
assert.equal((await get("/has?path=new.txt")).exists, true);
assert.equal((await get("/has?path=old.txt")).exists, false);
await get("/fail-restore", "POST");
recovered.send(
  JSON.stringify({
    type: "submit",
    id: crypto.randomUUID(),
    text: "!bash printf forbidden > partial.txt",
    mode: "followUp",
  }),
);
await until(async () => (await get("/")).room.mode === "recovery");
assert.equal((await get("/")).room.execution.callId, "workspace.restore");
await get("/allow-restore", "POST");
recovered.send(JSON.stringify({ type: "resume", id: crypto.randomUUID() }));
await until(async () => (await get("/")).room.mode === "ready");
assert.equal((await get("/has?path=partial.txt")).exists, false);
await get("/hold-backup", "POST");
const acknowledged = (await get("/")).room.checkpoint.revision;
recovered.send(
  JSON.stringify({
    type: "submit",
    id: crypto.randomUUID(),
    text: "!bash printf unacknowledged > pending.txt",
    mode: "followUp",
  }),
);
await until(async () => (await get("/backup-held")).held);
assert.equal((await get("/")).room.checkpoint.revision, acknowledged);
await get("/crash", "POST");
recovered.close();
await until(async () => (await get("/")).room.mode === "recovery");
const finalSocket = new WebSocket(base.replace("http", "ws") + "/socket");
let finalSynced = false;
const finalFrames = [];
finalSocket.addEventListener("message", (event) => {
  const frame = JSON.parse(event.data);
  finalFrames.push(frame);
  if (frame.type === "pi") finalSynced = true;
});
await until(() => finalSynced);
finalSocket.send(JSON.stringify({ type: "resume", id: crypto.randomUUID() }));
await until(async () => (await get("/")).room.mode === "ready");
assert.equal((await get("/has?path=pending.txt")).exists, false);
assert.equal((await get("/has?path=new.txt")).exists, true);
const archiveCommand = "printf archive-running > archive-pending.txt; sleep 60";
finalSocket.send(
  JSON.stringify({
    type: "submit",
    id: crypto.randomUUID(),
    text: "!bash " + archiveCommand,
    mode: "followUp",
  }),
);
await until(async () => Boolean((await get("/")).room.execution));
await until(async () => (await get("/has?path=archive-pending.txt")).exists);
await get("/archive", "POST");
await until(async () => (await get("/")).room.mode === "archived");
await until(() =>
  executionRecords(finalFrames).some(
    (record) => record.command === archiveCommand,
  ),
);
const archiveRecords = executionRecords(finalFrames).filter(
  (record) => record.command === archiveCommand,
);
assert.equal(archiveRecords.length, 1);
assert.equal(archiveRecords[0].outcome, "interrupted");
assert.equal(archiveRecords[0].exitCode, null);
finalSocket.close();
if (process.env.OUT)
  fs.writeFileSync(
    `${process.env.OUT}/summary.json`,
    JSON.stringify(
      {
        parkedRetry: parkedEvidence,
        archivedMode: (await get("/")).room.mode,
        interruptedArchiveRecords: archiveRecords.length,
      },
      null,
      2,
    ) + "\n",
  );
console.log(
  "Combined native RoomDO + PiHarness passed: durable Stop/Archive execution records, restart persistence, edit/review, unsafe-command crash, failed automatic restore, crash after backup before pointer commit, and explicit recovery preserving only acknowledged changes.",
);
