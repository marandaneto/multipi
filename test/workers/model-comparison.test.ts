import { createAI } from "agents/models/pi-ai";
import { expect, it, vi } from "vitest";

it("sends low reasoning and accounts GLM-5.3 with the pinned official adapter", async () => {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    if (
      input !==
      "https://api.cloudflare.com/client/v4/accounts/fixture/ai/run/@cf/zai-org/glm-5.3"
    )
      throw Error("Unexpected local fixture request");
    calls.push({ url: input, body: JSON.parse(String(init.body)) });
    const frames = [
      {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "LOW_OK" },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      {
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ];
    return new Response(
      frames
        .map((frame) => "data: " + JSON.stringify(frame) + "\n\n")
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const ai = createAI({
      accountId: "fixture",
      apiToken: "fixture-not-a-credential",
    });
    const model = ai("@cf/zai-org/glm-5.3");
    expect(model.cost).toEqual({
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
      cacheWrite: 0,
    });
    expect(model.contextWindow).toBe(1048576);
    const result = await ai.completeSimple(
      model,
      {
        messages: [{ role: "user", content: "Say LOW_OK", timestamp: 0 }],
      },
      { reasoning: "low", maxTokens: 64 },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual(
      expect.objectContaining({ reasoning_effort: "low" }),
    );
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "LOW_OK" }]);
    expect(result.usage.cost.total).toBeCloseTo(0.000013, 10);
  } finally {
    vi.unstubAllGlobals();
  }
});
