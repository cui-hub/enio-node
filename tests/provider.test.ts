import { describe, expect, it, vi } from "vitest";
import { createAgent, createOpenAICompatibleModel, defineTool } from "../src/index.js";
import type { ModelRequest } from "../src/index.js";

/** 真实 SDK 读取这些 SSE 帧；替换 HTTP transport，无网络和模型费用。 */
const sse = (frames: unknown[]) =>
  new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
const frame = (delta: unknown, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const request: ModelRequest = { messages: [{ role: "user", content: "go" }], tools: [] };

describe("OpenAI-compatible adapter", () => {
  it("A04: assembles interleaved tool fragments by index and preserves ids", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      sse([
        frame({
          role: "assistant",
          tool_calls: [
            { index: 1, id: "b", type: "function", function: { name: "two", arguments: '{"b":' } },
            { index: 0, id: "a", type: "function", function: { name: "one", arguments: '{"a":' } },
          ],
        }),
        frame(
          {
            tool_calls: [
              { index: 0, function: { arguments: "1}" } },
              { index: 1, function: { arguments: "2}" } },
            ],
          },
          "tool_calls",
        ),
        { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } },
      ]),
    );
    const model = createOpenAICompatibleModel({ apiKey: "test", model: "test", fetch: transport });
    const chunks = [];
    for await (const chunk of model.stream!(request, AbortSignal.timeout(1000))) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({
      type: "response",
      response: {
        message: {
          toolCalls: [
            { id: "a", name: "one", arguments: '{"a":1}' },
            { id: "b", name: "two", arguments: '{"b":2}' },
          ],
        },
        usage: { inputTokens: 8, outputTokens: 3 },
      },
    });
  });

  it("A04: incomplete streams fail without executing a tool", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, content: "ok" }));
    const tool = defineTool({
      name: "work",
      description: "work",
      effect: "read" as const,
      inputSchema: { type: "object", properties: {} },
      execute,
    });
    const model = createOpenAICompatibleModel({
      apiKey: "test",
      model: "test",
      fetch: async () =>
        sse([
          frame({
            tool_calls: [
              { index: 0, id: "a", type: "function", function: { name: "work", arguments: "{" } },
            ],
          }),
        ]),
    });
    const result = await createAgent({ model, tools: [tool] }).run(
      { input: "go" },
      { context: {} },
    );
    expect(result.stopReason).toBe("incomplete_response");
    expect(execute).not.toHaveBeenCalled();
  });

  it("normalizes generate messages and submits the expected wire protocol", async () => {
    let submitted: Record<string, unknown> | undefined;
    const transport: typeof fetch = async (input, init) => {
      submitted = (await new Request(input, init).json()) as Record<string, unknown>;
      return Response.json({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      });
    };
    const result = await createOpenAICompatibleModel({
      apiKey: "test",
      model: "custom-model",
      baseURL: "https://example.test/v1",
      fetch: transport,
    }).generate(request, AbortSignal.timeout(1000));
    expect(result.message.content).toBe("ok");
    expect(submitted).toMatchObject({
      model: "custom-model",
      n: 1,
      stream: false,
      messages: [{ role: "user", content: "go" }],
    });
  });

  it("A06: one runtime retry means two HTTP calls, with no hidden SDK retries", async () => {
    let attempts = 0;
    const transport = vi.fn<typeof fetch>(async () =>
      ++attempts === 1
        ? Response.json({ error: { message: "busy" } }, { status: 429 })
        : sse([frame({ content: "ok" }), frame({}, "stop")]),
    );
    const model = createOpenAICompatibleModel({ apiKey: "test", model: "test", fetch: transport });
    const result = await createAgent({ model, limits: { retryDelayMs: 0 } }).run(
      { input: "go" },
      { context: {} },
    );
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("ok");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("bounds model streams and refuses data after finish_reason", async () => {
    for (const frames of [
      [frame({ content: "x".repeat(500) }), frame({}, "stop")],
      [frame({}, "stop"), frame({ content: "after" })],
    ]) {
      const model = createOpenAICompatibleModel({
        apiKey: "test",
        model: "test",
        maxResponseBytes: 256,
        fetch: async () => sse(frames),
      });
      const result = await createAgent({ model }).run({ input: "go" }, { context: {} });
      expect(result.status).toBe("failed");
    }
  });
});
