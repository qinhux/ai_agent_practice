import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  safeValidateUIMessages,
  type InferUIMessageChunk,
} from "ai";
import sharp from "sharp";
import { z } from "zod";
import { fileDeliverySchemas } from "@/lib/file-delivery";
import { maxCoverLogoBytes } from "@/lib/presentation-logo";
import { createAgent, createAgentModel, legacyPresentationTools, providerOptions, type ChatMessage } from "@/server/agent";
import { getAuth } from "@/server/auth";
import { FileDrafts } from "@/server/file-drafts";
import { createToolRegistry } from "@/server/tool-registry";
import { routeToolDomains } from "@/server/tool-router";
import { ResearchError, researchModeSchema } from "@/server/research-schema";
import { WebResearch } from "@/server/web-research";

export const runtime = "nodejs";
const maxChatBytes = 256 * 1024;
const maxEncodedLogoLength = 4 * Math.ceil(maxCoverLogoBytes / 3);
const coverLogoSchema = z.base64().min(1).max(maxEncodedLogoLength);
const userMessageTextSchema = z.object({
  role: z.literal("user"),
  parts: z.array(z.unknown()),
});
const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });

export async function POST(request: Request) {
  const auth = getAuth();
  if (request.headers.get("origin") !== new URL(auth.options.baseURL).origin) {
    return new Response("请求来源无效。", { status: 403 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("请先登录。", { status: 401 });
  }
  if (!session.user.emailVerified) {
    return new Response("请先验证邮箱。", { status: 403 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response("请在服务端配置 DEEPSEEK_API_KEY。", { status: 503 });
  }

  const body = await request.text();
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > maxChatBytes + maxEncodedLogoLength + 16) {
    return new Response("对话内容太长，请开始新对话。", { status: 413 });
  }

  let messages: unknown;
  let logoInput: unknown;
  let researchInput: unknown;
  try {
    const input = JSON.parse(body);
    messages = input?.messages;
    logoInput = input?.coverLogo;
    researchInput = input?.researchMode;
  } catch {
    return new Response("请求必须包含有效的 JSON。", { status: 400 });
  }

  if (!Array.isArray(messages) || messages.length > 100) {
    return new Response("对话格式无效或消息过多。", { status: 400 });
  }
  const encodedLogo = coverLogoSchema.optional().safeParse(logoInput);
  const researchMode = researchModeSchema.default("auto").safeParse(researchInput);
  if (!researchMode.success) return new Response("搜索模式无效。", { status: 400 });
  if (!encodedLogo.success) return new Response("封面 Logo 格式无效或超过 1 MB。", { status: 400 });
  if (bodyBytes - (encodedLogo.data?.length ?? 0) > maxChatBytes) {
    return new Response("对话内容太长，请开始新对话。", { status: 413 });
  }

  let logo: Uint8Array<ArrayBuffer> | undefined;
  if (encodedLogo.data) {
    try {
      const bytes = Buffer.from(encodedLogo.data, "base64");
      if (bytes.length > maxCoverLogoBytes) throw new Error("Cover logo exceeds the size limit.");
      const image = sharp(bytes, { limitInputPixels: 16_000_000 });
      const { format } = await image.metadata();
      if (format !== "png" && format !== "jpeg" && format !== "webp") throw new Error("Unsupported cover logo format.");
      logo = new Uint8Array(await image.rotate().resize(512, 256, { fit: "inside", withoutEnlargement: true }).png().toBuffer());
    } catch {
      return new Response("请提供不超过 1 MB 的 PNG、JPEG 或 WebP 封面 Logo。", { status: 400 });
    }
  }
  const userText = messages.flatMap((message) => {
    const parsed = userMessageTextSchema.safeParse(message);
    return parsed.success ? parsed.data.parts.flatMap((part) => {
      const text = textPartSchema.safeParse(part);
      return text.success ? [text.data.text] : [];
    }) : [];
  }).join("\n");

  const model = createAgentModel(apiKey);
  const drafts = new FileDrafts(session.user.id);
  const registry = createToolRegistry(model, session.user.id, drafts, providerOptions,
    { logo, userText, webResearch: new WebResearch(researchMode.data) });
  const historyTools = { ...registry.tools, ...legacyPresentationTools };
  const result = await safeValidateUIMessages<ChatMessage>({
    messages, tools: historyTools, dataSchemas: fileDeliverySchemas,
  });
  const lastMessage = result.success ? result.data.at(-1) : undefined;
  if (!result.success || lastMessage?.role !== "user" || !lastMessage.parts.some(
    (part) => part.type === "text" && part.text.trim(),
  )) {
    return new Response("请提供有效的用户消息。", { status: 400 });
  }

  if (result.data.some((message) =>
    message.role === "system" || message.parts.some((part) =>
      part.type === "file" || (message.role === "user" && part.type.startsWith("data-"))),
  )) {
    return new Response("该接口仅支持文本对话。", { status: 400 });
  }

  const modelMessages = await convertToModelMessages<ChatMessage>(result.data, {
    tools: historyTools,
    ignoreIncompleteToolCalls: true,
    convertDataPart(part) {
      if (part.type === "data-files") {
        const files = part.data.map(({ id, kind, name }) => ({ id, kind, name }));
        return { type: "text", text: `本轮已保存并交付的文件：${JSON.stringify(files)}` };
      }
      if (part.type === "data-file-error") return { type: "text", text: part.data };
    },
  });

  function onError(error: unknown) {
    console.error("Agent stream failed:", error);
    return "模型请求失败，请稍后重试。";
  }

  const disconnect = new AbortController();
  const signal = AbortSignal.any([request.signal, disconnect.signal, AbortSignal.timeout(270_000)]);
  const uiStream = createUIMessageStream<ChatMessage>({
    onError,
    async execute({ writer }) {
      const domains = await routeToolDomains(result.data, registry, model, providerOptions, signal);
      const agent = createAgent(model, registry, domains);
      const stream = await agent.stream({ messages: modelMessages, abortSignal: signal });
      let finish: Extract<InferUIMessageChunk<ChatMessage>, { type: "finish" }> | undefined;
      let streamFailed = false;
      let toolFailed = false;

      for await (const chunk of stream.toUIMessageStream<ChatMessage>({ onError })) {
        if (chunk.type === "finish") {
          finish = chunk;
          continue;
        }
        if (chunk.type === "error" || chunk.type === "abort") streamFailed = true;
        if (chunk.type === "tool-output-error" || chunk.type === "tool-output-denied" ||
            (chunk.type === "tool-output-available" && typeof chunk.output === "object" &&
              chunk.output !== null && "error" in chunk.output)) {
          toolFailed = true;
        }
        writer.write(chunk);
      }

      if (drafts.hasChanges && !streamFailed && !signal.aborted) {
        const steps = await stream.steps;
        const confirmation = steps.at(-2);
        const confirmed = confirmation?.toolCalls.length === 1 &&
          confirmation.toolResults.some((result) =>
            result.toolName === "completeFileWork" && typeof result.output === "object" && result.output !== null &&
            "ready" in result.output && result.output.ready === true) &&
          steps.at(-1)?.toolCalls.length === 0 && finish?.finishReason === "stop";

        if (confirmed && !toolFailed) {
          try {
            const files = await drafts.save(signal);
            writer.write({ type: "data-files", data: files });
          } catch (error) {
            if (!signal.aborted) {
              console.error("File save failed:", error instanceof Error ? error.name : "UnknownError");
              writer.write({ type: "data-file-error", data: error instanceof ResearchError ? error.message : "文件保存失败，本轮未生成新版本。请稍后重试。" });
            }
          }
        } else {
          writer.write({ type: "data-file-error", data: "本轮文件操作未全部完成，草稿未保存。" });
        }
      }
      if (finish) writer.write(finish);
    },
  });
  const reader = uiStream.getReader();
  const responseStream = new ReadableStream<InferUIMessageChunk<ChatMessage>>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    cancel(reason) {
      disconnect.abort(reason);
      return reader.cancel(reason);
    },
  });
  return createUIMessageStreamResponse({ stream: responseStream, headers: { "X-Accel-Buffering": "no" } });
}
