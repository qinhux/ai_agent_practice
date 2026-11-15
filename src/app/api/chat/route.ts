import { convertToModelMessages, safeValidateUIMessages } from "ai";
import { createAgent, legacyPresentationTools, type ChatMessage } from "@/server/agent";
import { getAuth } from "@/server/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = getAuth();
  if (request.headers.get("origin") !== new URL(auth.options.baseURL).origin) {
    return new Response("请求来源无效。", { status: 403 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("请先登录。", { status: 401 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response("请在服务端配置 DEEPSEEK_API_KEY。", { status: 503 });
  }

  const body = await request.text();
  if (Buffer.byteLength(body) > 256 * 1024) {
    return new Response("对话内容太长，请开始新对话。", { status: 413 });
  }

  let messages: unknown;
  try {
    messages = JSON.parse(body)?.messages;
  } catch {
    return new Response("请求必须包含有效的 JSON。", { status: 400 });
  }

  if (!Array.isArray(messages) || messages.length > 100) {
    return new Response("对话格式无效或消息过多。", { status: 400 });
  }

  const agent = createAgent(apiKey, session.user.id);
  const historyTools = { ...agent.tools, ...legacyPresentationTools };
  const result = await safeValidateUIMessages<ChatMessage>({ messages, tools: historyTools });
  const lastMessage = result.success ? result.data.at(-1) : undefined;
  if (!result.success || lastMessage?.role !== "user" || !lastMessage.parts.some(
    (part) => part.type === "text" && part.text.trim(),
  )) {
    return new Response("请提供有效的用户消息。", { status: 400 });
  }

  if (result.data.some((message) =>
    message.role === "system" || message.parts.some((part) => part.type === "file"),
  )) {
    return new Response("该接口仅支持文本对话。", { status: 400 });
  }

  const stream = await agent.stream({
    messages: await convertToModelMessages(result.data, {
      tools: historyTools,
      ignoreIncompleteToolCalls: true,
    }),
    abortSignal: request.signal,
    timeout: 270_000,
  });

  return stream.toUIMessageStreamResponse({
    headers: { "X-Accel-Buffering": "no" },
    onError(error) {
      console.error("Agent stream failed:", error);
      return "模型请求失败，请稍后重试。";
    },
  });
}
