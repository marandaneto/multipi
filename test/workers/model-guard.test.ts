import { expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { guardProvider } from "../../src/room/model-guard";

it("enforces a real workerd timer and preserves partial usage across native abort", async () => {
  const faux = fauxProvider();
  const source = createAssistantMessageEventStream();
  const dispatch = vi
    .spyOn(faux.provider, "streamSimple")
    .mockReturnValue(source);
  const partial = fauxAssistantMessage("unfinished response");
  partial.usage.totalTokens = 17;
  source.push({
    type: "text_delta",
    contentIndex: 0,
    delta: "unfinished response",
    partial,
  });
  const result = await guardProvider(faux.provider, async () => {})
    .streamSimple(faux.getModel(), normalizeContext({ messages: [] }), {
      timeoutMs: 50,
    })
    .result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toBe("Model request timed out");
  expect(result.content).toEqual([
    { type: "text", text: "unfinished response" },
  ]);
  expect(result.usage.totalTokens).toBe(17);
  expect(dispatch.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
});
