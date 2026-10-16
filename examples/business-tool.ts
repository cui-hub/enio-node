import { createAgent, createScriptedModel, defineTool } from "../src/index.js";

/** 身份来自宿主 context；真实接入时将 mock 服务替换为已鉴权的业务客户端。 */
interface BusinessContext {
  userId: string;
  orders: {
    get(orderId: string, userId: string, signal: AbortSignal): Promise<{ status: string }>;
  };
}

const lookupOrder = defineTool<{ orderId: string }, BusinessContext>({
  name: "lookup_order",
  description: "查询当前用户可访问的订单状态",
  effect: "read",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string", minLength: 1, maxLength: 64 } },
    required: ["orderId"],
    additionalProperties: false,
  },
  async execute({ orderId }, { context, signal }) {
    const order = await context.orders.get(orderId, context.userId, signal);
    return { ok: true, content: JSON.stringify(order) };
  },
});

const agent = createAgent<BusinessContext>({
  tools: [lookupOrder],
  model: createScriptedModel(({ messages }) => {
    const result = messages.find((message) => message.role === "tool");
    if (result)
      return {
        message: { role: "assistant", content: `订单查询完成：${result.content}` },
        finishReason: "stop",
      };
    return {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "lookup-1",
            name: "lookup_order",
            arguments: JSON.stringify({ orderId: "order-001" }),
          },
        ],
      },
      finishReason: "tool_calls",
    };
  }),
});

const result = await agent.run(
  { input: "查询我的订单 order-001" },
  {
    context: {
      userId: "demo-user",
      orders: {
        async get(orderId, userId, signal) {
          signal.throwIfAborted();
          if (orderId !== "order-001" || userId !== "demo-user")
            throw new Error("Order is not accessible");
          return { status: "paid" };
        },
      },
    },
  },
);
if (result.status !== "completed") throw new Error(result.stopReason);
process.stdout.write(`${result.finalText}\n`);
