import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { z } from "zod";
import type { Identity } from "../shared/protocol";
import type { RoomMetadata } from "../room/state";
import { RoomConnection, canOperate, canArchive } from "./connection";
import { IndexedOutbox } from "./outbox";
import {
  createdResponse,
  errorText,
  ignoredResponse,
  meResponse,
  publishedResponse,
  request,
  reviewResponse,
  roomsResponse,
  safeLink,
  type Review,
} from "./wire";
import type { TranscriptItem } from "./projection";

const store = new IndexedOutbox();
function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const change = () => setHash(location.hash);
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  return hash;
}
export function App() {
  const [me, setMe] = useState<z.infer<typeof meResponse> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hash = useHash();
  useEffect(() => {
    const controller = new AbortController();
    void request("/api/me", meResponse, "GET", undefined, controller.signal)
      .then(setMe)
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });
    return () => controller.abort();
  }, []);
  const candidate = hash.startsWith("#/rooms/")
    ? z.uuid().safeParse(hash.slice(8))
    : null;
  return (
    <>
      <header className="topbar">
        <a href="#/">multipi</a>
        <span>One room. One shared agent.</span>
        {me && (
          <span className="identity">
            {me.identity.id}
            {me.localDev ? " · local development" : ""}
          </span>
        )}
      </header>
      <main>
        {error && (
          <p className="error" role="alert">
            {error}{" "}
            <button onClick={() => location.reload()}>Reload sign-in</button>
          </p>
        )}
        {!me && !error && <p role="status">Checking sign-in…</p>}
        {me &&
          (candidate?.success ? (
            <Room
              key={candidate.data}
              id={candidate.data}
              identity={me.identity}
            />
          ) : hash.startsWith("#/rooms/") ? (
            <p>
              Invalid room address. <a href="#/">Back to rooms</a>
            </p>
          ) : (
            <Rooms identity={me.identity} />
          ))}
      </main>
    </>
  );
}
function Rooms({ identity }: { identity: Identity }) {
  const [rooms, setRooms] = useState<RoomMetadata[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const diagnostics = z
    .uuid()
    .safeParse(error?.match(/#\/rooms\/([a-f0-9-]{36})\b/)?.[1]);
  useEffect(() => {
    const controller = new AbortController();
    void request(
      "/api/rooms",
      roomsResponse,
      "GET",
      undefined,
      controller.signal,
    )
      .then((value) => setRooms(value.rooms))
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const result = await request("/api/rooms", createdResponse, "POST", {
        title: form.get("title"),
        repository: form.get("repository"),
        baseSha: form.get("baseSha"),
      });
      location.hash = `/rooms/${result.id}`;
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="room-list">
      <section>
        <h1>Your rooms</h1>
        {loading && <p>Loading rooms…</p>}
        {!loading && !rooms.length && <p>No rooms yet.</p>}
        <ul className="cards">
          {rooms.map((room) => (
            <li key={room.id}>
              <a href={`#/rooms/${room.id}`}>{room.title}</a>
              <p>{room.repository}</p>
              <small>
                Base {room.baseSha} · owner {room.owner}
              </small>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Create a room</h2>
        <form onSubmit={(event) => void create(event)}>
          <fieldset disabled={busy || identity.expiresAt <= Date.now()}>
            <label>
              Title
              <input name="title" required maxLength={100} />
            </label>
            <label>
              Repository
              <input
                name="repository"
                placeholder="owner/repository"
                required
                pattern={
                  "[A-Za-z0-9][A-Za-z0-9_.\\-]{0,99}\\/[A-Za-z0-9][A-Za-z0-9_.\\-]{0,99}"
                }
              />
            </label>
            <label>
              Base commit SHA
              <input
                name="baseSha"
                required
                pattern="[a-f0-9]{40}"
                minLength={40}
                maxLength={40}
                spellCheck={false}
              />
            </label>
            <button type="submit">{busy ? "Creating…" : "Create room"}</button>
          </fieldset>
        </form>
      </section>
      {error && (
        <p role="alert" className="error">
          {error}
          {diagnostics.success && (
            <>
              {" "}
              <a href={`#/rooms/${diagnostics.data}`}>Open room diagnostics</a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
function Room({ id, identity }: { id: string; identity: Identity }) {
  const [connection, setConnection] = useState<RoomConnection | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const next = new RoomConnection(id, identity, store);
    setConnection(next);
    void next.start();
    return () => next.stop();
  }, [id, identity, attempt]);
  return (
    connection && (
      <RoomView
        key={attempt}
        connection={connection}
        reconnect={() => setAttempt((value) => value + 1)}
      />
    )
  );
}
function Transcript({
  item,
  names,
  live = false,
  revision,
}: {
  item: TranscriptItem;
  names: Record<string, string>;
  live?: boolean;
  revision?: number;
}) {
  return (
    <article className={`message ${item.role}`}>
      <div className="message-heading">
        <strong>
          {item.author
            ? (names[item.author] ?? item.author)
            : item.role === "assistant"
              ? "Pi"
              : item.role === "toolResult"
                ? "Tool"
                : item.role === "execution"
                  ? "Host"
                  : item.role === "user"
                    ? "User (unattributed legacy input)"
                    : "Room"}
        </strong>
        {live && <span>streaming</span>}
        {item.timestamp > 0 && (
          <time dateTime={new Date(item.timestamp).toISOString()}>
            {new Date(item.timestamp).toLocaleString()}
          </time>
        )}
      </div>
      <pre>{item.text}</pre>
      {item.execution && (
        <p>
          Execution: {item.execution.outcome} · exit{" "}
          {item.execution.exitCode ?? "not reported"} · checkpoint{" "}
          {item.execution.workspaceRevision}
          {revision !== undefined &&
          revision !== item.execution.workspaceRevision
            ? " · STALE for the current workspace"
            : ""}
        </p>
      )}
      {item.error && <p className="error">{item.error}</p>}
    </article>
  );
}
function RoomView({
  connection,
  reconnect,
}: {
  connection: RoomConnection;
  reconnect: () => void;
}) {
  const state = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
  );
  const envelope = state.room;
  const room = envelope?.room;
  const role = envelope?.role;
  const writable = canOperate(state);
  const ready = writable && room?.mode === "ready";
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const publishResult = envelope?.publication ?? null;
  const publishedThisReview =
    !!publishResult && publishResult.reviewId === room?.review?.id;
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const reviewKey =
    room?.mode === "review" && room.review
      ? `${room.review.id}:${room.review.digest}`
      : null;
  const names: Record<string, string> = {};
  if (envelope) {
    for (const id of Object.keys(envelope.room.members)) names[id] = id;
    names[envelope.identity.id] = `${envelope.identity.id} (you)`;
  }
  useEffect(() => {
    setReview(null);
    setConfirmation(null);
    if (!reviewKey) return;
    const controller = new AbortController();
    void request(
      `/api/rooms/${connection.roomId}/review`,
      reviewResponse,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setReview)
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });
    return () => controller.abort();
  }, [reviewKey, connection.roomId]);
  const frozen =
    review &&
    room?.review &&
    room.mode === "review" &&
    review.id === room.review.id &&
    review.digest === room.review.digest &&
    review.revision === room.review.revision
      ? review
      : null;
  async function action(work: () => Promise<unknown>, allowed = canOperate) {
    if (busy || !allowed(connection.getSnapshot())) {
      setError("Wait for a writable, synchronized room");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  function command(type: "stop" | "resume" | "retry") {
    try {
      setError(null);
      void connection
        .send({ type, id: crypto.randomUUID() })
        .catch((error) => setError(errorText(error)));
    } catch (error) {
      setError(errorText(error));
    }
  }
  async function submit(mode: "followUp" | "steer") {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await connection.submit(text, mode);
      setText("");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSending(false);
    }
  }
  async function membership(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsedRole = z
      .enum(["operator", "observer", "remove"])
      .parse(data.get("role"));
    await action(() =>
      request(
        `/api/rooms/${connection.roomId}/members`,
        ignoredResponse,
        "PUT",
        {
          email: data.get("email"),
          role: parsedRole === "remove" ? null : parsedRole,
        },
      ),
    );
  }
  async function publish() {
    const current = connection.getSnapshot();
    if (
      !frozen ||
      !current.synced ||
      current.room?.room.mode !== "review" ||
      current.room.room.review?.id !== frozen.id ||
      current.room.room.review.digest !== frozen.digest ||
      confirmation !== reviewKey
    )
      return;
    const selected = frozen;
    await action(async () => {
      setConfirmation(null); // Each attempt needs fresh human confirmation; never automatically retry publication.
      const result = await request(
        `/api/rooms/${connection.roomId}/publish`,
        publishedResponse,
        "POST",
        {
          id: crypto.randomUUID(),
          reviewId: selected.id,
          digest: selected.digest,
        },
      );
      const url = safeLink(result.pullRequestUrl);
      if (!url) throw new Error("Server returned a non-HTTPS pull request URL");
    });
  }
  return (
    <>
      <div className="room-title">
        <div>
          <a href="#/">← Rooms</a>
          <h1>{room?.metadata?.title ?? "Shared room"}</h1>
          <p>
            {room?.metadata?.repository} <code>{room?.metadata?.baseSha}</code>
          </p>
        </div>
        <span className={state.synced ? "badge connected" : "badge"}>
          {state.status}
        </span>
      </div>
      <div className="toolbar">
        <button onClick={reconnect} disabled={state.synced}>
          Reconnect
        </button>
        <button
          onClick={() =>
            navigator.clipboard
              .writeText(location.href)
              .catch((error) => setError(errorText(error)))
          }
        >
          Copy room link
        </button>
        <span>Link does not grant access.</span>
      </div>
      {(state.error || error) && (
        <div className="error" role="alert">
          {error ?? state.error}
        </div>
      )}
      <section className="status" aria-label="Room and agent state">
        <span>Role: {role ?? "unknown"}</span>
        <span>Room: {room?.mode ?? "unknown"}</span>
        <span>
          Run:{" "}
          {envelope?.pending.some((item) => item.status === "parked")
            ? "parked · explicit retry required"
            : state.view.running
              ? "running"
              : "idle"}
        </span>
        <span>
          Model:{" "}
          {state.view.model
            ? `${state.view.model.provider}/${state.view.model.modelId}`
            : "not reported"}
        </span>
        <span>{state.view.queued} queued</span>
        <span>
          {state.view.usage.tokens.toLocaleString()} tokens · $
          {state.view.usage.cost.toFixed(4)} estimated cost (pricing may be
          unavailable)
        </span>
        <span>Checkpoint: {room?.checkpoint?.revision ?? "none"}</span>
      </section>
      {room?.diagnostic && <p className="error">{room.diagnostic}</p>}
      {state.view.error && <p className="error">{state.view.error}</p>}
      {state.view.retry && (
        <p role="status">
          Agent retry backoff until{" "}
          {new Date(state.view.retry.at).toLocaleTimeString()}:{" "}
          {state.view.retry.error}
        </p>
      )}
      <div className="layout">
        <div>
          <section aria-label="Shared transcript">
            <h2>Shared transcript</h2>
            <p className="muted">
              Tool output and host records are execution evidence; assistant
              prose is not proof that tests passed.
            </p>
            {!state.view.messages.length && <p>No committed messages yet.</p>}
            {state.view.messages.map((item) => (
              <Transcript
                key={item.id}
                item={item}
                names={names}
                revision={room?.checkpoint?.revision}
              />
            ))}
            {state.view.live && (
              <Transcript item={state.view.live} names={names} live />
            )}
            {state.view.tools.map((tool) => (
              <article className="message" key={tool.callId}>
                <strong>{tool.name} · running</strong>
                <pre>{tool.output || "Waiting for output…"}</pre>
              </article>
            ))}
          </section>
          <section>
            <h2>Continue together</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit("followUp");
              }}
            >
              <label htmlFor="prompt">Message to Pi</label>
              <textarea
                id="prompt"
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={16384}
                rows={5}
                disabled={!ready || sending}
                placeholder="What should Pi do next?"
              />
              <div className="toolbar">
                <button
                  type="submit"
                  disabled={!ready || sending || !text.trim()}
                >
                  Send follow-up
                </button>
                <button
                  type="button"
                  disabled={!ready || sending || !text.trim()}
                  onClick={() => void submit("steer")}
                >
                  Steer at next tool boundary
                </button>
              </div>
              <p className="muted">
                Follow-up is FIFO after the current run. Steer does not cancel
                work or undo edits.
              </p>
            </form>
            <div className="toolbar">
              <button
                className="danger"
                disabled={
                  !writable ||
                  busy ||
                  !["ready", "stopping"].includes(room?.mode ?? "")
                }
                onClick={() => command("stop")}
              >
                Stop
              </button>
              <button
                disabled={
                  !writable ||
                  busy ||
                  !room?.checkpoint ||
                  !["stopped", "recovery"].includes(room.mode)
                }
                onClick={() => command("resume")}
              >
                Restore checkpoint & resume
              </button>
              <button
                disabled={!ready || busy}
                onClick={() => command("retry")}
              >
                Retry parked work
              </button>
            </div>
            <p className="muted">
              Stop remains “stopping” until the server confirms tools have
              stopped. Closing this page does not stop Pi.
            </p>
          </section>
          <section>
            <h2>Review & delivery</h2>
            <div className="toolbar">
              <button
                disabled={
                  !ready ||
                  busy ||
                  state.view.running ||
                  !!envelope?.pending.length
                }
                onClick={() =>
                  void action(() =>
                    request(
                      `/api/rooms/${connection.roomId}/review`,
                      reviewResponse,
                      "POST",
                      {},
                    ).then(setReview),
                  )
                }
              >
                Freeze patch for review
              </button>
              <button
                disabled={!writable || busy || room?.mode !== "review"}
                onClick={() =>
                  void action(() =>
                    request(
                      `/api/rooms/${connection.roomId}/review`,
                      ignoredResponse,
                      "DELETE",
                      {},
                    ),
                  )
                }
              >
                Exit review
              </button>
              {state.synced && room?.review && (
                <a
                  href={`/api/rooms/${connection.roomId}/patch`}
                  download="multipi.patch"
                >
                  Download patch
                </a>
              )}
            </div>
            {room?.mode === "review" && !frozen && (
              <p>Waiting for the frozen review…</p>
            )}
            {frozen && (
              <>
                <p>
                  Revision {frozen.revision} · review <code>{frozen.id}</code>
                </p>
                <p>
                  Digest <code>{frozen.digest}</code>
                </p>
                <ul>
                  {frozen.files.map((file) => (
                    <li key={file.path}>
                      <code>
                        {file.status} {file.path}
                      </code>
                    </li>
                  ))}
                </ul>
                <pre className="diff">
                  {frozen.patch ||
                    "No textual changes. See file status for binary or omitted changes."}
                </pre>
                <label className="confirm">
                  <input
                    type="checkbox"
                    checked={confirmation === reviewKey}
                    disabled={!writable || busy || publishedThisReview}
                    onChange={(event) =>
                      setConfirmation(event.target.checked ? reviewKey : null)
                    }
                  />
                  I reviewed this exact patch ({frozen.digest}) and want to
                  create a draft PR against base {room?.metadata?.baseSha}.
                </label>
                <button
                  disabled={
                    !writable ||
                    busy ||
                    confirmation !== reviewKey ||
                    publishedThisReview
                  }
                  onClick={() => void publish()}
                >
                  {busy ? "Working…" : "Create draft PR"}
                </button>
                <p className="muted">
                  Draft commits are unsigned; repository signing rules may
                  require patch export or additional signing. No automatic
                  publish or automatic retry. If the outcome is uncertain,
                  inspect GitHub before confirming again.
                </p>
              </>
            )}
            {publishResult && (
              <p>
                Draft PR:{" "}
                <a
                  href={publishResult.pullRequestUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open pull request
                </a>{" "}
                · head <code>{publishResult.headSha}</code>
              </p>
            )}
          </section>
        </div>
        <aside>
          <section>
            <h2>People</h2>
            <p>
              {state.synced
                ? `${state.presence.length} connected`
                : "Presence unavailable while disconnected"}
            </p>
            <ul>
              {Object.entries(room?.members ?? {}).map(([id, memberRole]) => (
                <li key={id}>
                  {names[id] ?? id} · {memberRole}
                  {state.synced && state.presence.includes(id)
                    ? " · online"
                    : ""}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Pending inputs</h2>
            {!envelope?.pending.length && <p>No pending operations.</p>}
            <ol>
              {envelope?.pending.map((item) => (
                <li key={item.operationId}>
                  <strong>{names[item.actor] ?? item.actor}</strong>
                  <p>{item.status}</p>
                  <code>{item.operationId}</code>
                  {item.status === "queued" &&
                    (role === "owner" ||
                      item.actor === envelope.identity.id) && (
                      <button
                        disabled={!writable || busy}
                        onClick={() => {
                          try {
                            setError(null);
                            void connection
                              .send({
                                type: "withdraw",
                                id: crypto.randomUUID(),
                                operationId: item.operationId,
                              })
                              .catch((error) => setError(errorText(error)));
                          } catch (error) {
                            setError(errorText(error));
                          }
                        }}
                      >
                        Withdraw
                      </button>
                    )}
                </li>
              ))}
            </ol>
          </section>
          {!!room?.withdrawn?.length && (
            <section>
              <h2>Stopped or withdrawn inputs</h2>
              <p>
                Not automatically retried. Choose a draft to resubmit
                deliberately.
              </p>
              {room.withdrawn.map((item, index) => (
                <article key={`${item.operationId}:${index}`}>
                  <strong>
                    {item.actor} · {item.reason}
                  </strong>
                  <pre>{item.text}</pre>
                  <button disabled={!ready} onClick={() => setText(item.text)}>
                    Use as draft
                  </button>
                </article>
              ))}
            </section>
          )}
          {!!state.outbox.length && (
            <section>
              <h2>Browser outbox</h2>
              <p>
                Awaiting server acknowledgment. Only these submits replay after
                synchronized reconnect. Paused while not ready or read-only.
              </p>
              <ul>
                {state.outbox.map((item) => (
                  <li key={item.command.id}>
                    <strong>{item.command.mode}</strong>
                    <pre>{item.command.text}</pre>
                    <button
                      disabled={!state.synced}
                      onClick={() => {
                        if (
                          confirm(
                            "Forget this browser retry? It may already have reached the server; use Withdraw for queued inputs.",
                          )
                        )
                          void connection
                            .discard(item.command.id)
                            .catch((error) => setError(errorText(error)));
                      }}
                    >
                      Forget local retry
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {role === "owner" && (
            <section>
              <h2>Manage membership</h2>
              <form onSubmit={(event) => void membership(event)}>
                <fieldset disabled={!writable || busy}>
                  <label>
                    Existing user's email
                    <input type="email" name="email" required maxLength={254} />
                  </label>
                  <label>
                    Role
                    <select name="role" defaultValue="operator">
                      <option value="operator">Operator</option>
                      <option value="observer">Observer</option>
                      <option value="remove">Remove access</option>
                    </select>
                  </label>
                  <button>Update membership</button>
                </fieldset>
              </form>
              <p className="muted">
                Share this room’s link after adding the member. No invite email
                is sent.
              </p>
              <button
                className="danger"
                disabled={busy || !canArchive(state)}
                onClick={() => {
                  if (confirm("Archive this room and stop its work?"))
                    void action(
                      () =>
                        request(
                          `/api/rooms/${connection.roomId}/archive`,
                          ignoredResponse,
                          "POST",
                          {},
                        ),
                      canArchive,
                    );
                }}
              >
                Archive room
              </button>
            </section>
          )}
          {role === "observer" && (
            <p className="muted">Observer: read-only access.</p>
          )}
        </aside>
      </div>
    </>
  );
}
