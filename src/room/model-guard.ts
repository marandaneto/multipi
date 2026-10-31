import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { AppError } from "../shared/protocol";

export const MODEL_REQUEST_TIMEOUT_MS = 120_000;

async function interruptible<T>(
  pending: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const interrupted = Promise.withResolvers<never>();
  const abort = () => interrupted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([pending, interrupted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function guardProvider(
  provider: Provider,
  check: () => Promise<void>,
): Provider {
  function stream(
    model: Model<Api>,
    start: (signal: AbortSignal) => AssistantMessageEventStream,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        ...(options?.signal ? [options.signal] : []),
      ]);
      const duration = Math.max(
        1,
        Math.min(
          options?.timeoutMs ?? MODEL_REQUEST_TIMEOUT_MS,
          MODEL_REQUEST_TIMEOUT_MS,
        ),
      );
      const deadline = Date.now() + duration;
      const expire = () =>
        controller.abort(new AppError(408, "Model request timed out"));
      const checkDeadline = () => {
        if (Date.now() >= deadline) expire();
        signal.throwIfAborted();
      };
      const timeout = setTimeout(expire, duration);
      let source: AssistantMessageEventStream | undefined;
      let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
      let latest: AssistantMessage | undefined;
      let terminal = false;
      try {
        checkDeadline();
        await interruptible(check(), signal);
        checkDeadline();
        source = start(signal);
        iterator = source[Symbol.asyncIterator]();
        while (true) {
          const next = await interruptible(iterator.next(), signal);
          checkDeadline();
          if (next.done)
            throw new AppError(502, "Model response ended without a result");
          const event = next.value;
          if ("partial" in event) latest = event.partial;
          output.push(event);
          if (event.type === "done" || event.type === "error") {
            terminal = true;
            break;
          }
        }
      } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        const message: AssistantMessage = {
          role: "assistant",
          content: latest ? structuredClone(latest.content) : [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: latest
            ? structuredClone(latest.usage)
            : {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
          stopReason: reason,
          errorMessage:
            error instanceof AppError
              ? error.message
              : "Model request blocked; check room diagnostics",
          timestamp: Date.now(),
        };
        output.push({
          type: "error",
          reason,
          error: message,
        });
      } finally {
        clearTimeout(timeout);
        if (!terminal) {
          controller.abort();
          source?.end();
        }
        void iterator?.return?.().catch(() => {});
        output.end();
      }
    })();
    return output;
  }
  const deferred = provider.fetchDeferred;
  return {
    ...provider,
    stream: (model, context, options) =>
      stream(
        model,
        (signal) =>
          provider.stream(
            model,
            context,
            Object.assign({}, options, { signal }),
          ),
        options,
      ),
    streamSimple: (model, context, options) =>
      stream(
        model,
        (signal) =>
          provider.streamSimple(model, context, { ...options, signal }),
        options,
      ),
    ...(deferred
      ? ({
          fetchDeferred: (model, handle, options) =>
            stream(
              model,
              (signal) =>
                deferred.call(provider, model, handle, { ...options, signal }),
              options,
            ),
        } satisfies Pick<Provider, "fetchDeferred">)
      : {}),
  };
}
