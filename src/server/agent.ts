import { createDeepSeek, type DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";
import { stepCountIs, tool, ToolLoopAgent, type InferUITools, type UIDataTypes, type UIMessage } from "ai";
import { z } from "zod";
import { createImageTool } from "./image-tool";
import { createPresentationTool } from "./presentation-tool";
import { imageFitSchema } from "./presentations";
import { getCurrentTime } from "./time-tool";
import {
  createUpdateSlideElementsTool,
  editInstructionsSchema,
  editSlideNumbersSchema,
  replacementImageSourceSchema,
} from "./update-slide-elements-tool";

const providerOptions = {
  deepseek: { thinking: { type: "disabled" } } satisfies DeepSeekLanguageModelOptions,
};

export function createAgent(apiKey: string, userId: string) {
  const deepseek = createDeepSeek({ apiKey });
  const model = deepseek(process.env.DEEPSEEK_MODEL || "deepseek-flash");

  return new ToolLoopAgent({
    model,
    instructions: `你是一个乐于助人的助手。使用用户所用的语言回复。用户询问当前时间时，调用 getCurrentTime。用户单独请求生成图片时，调用 generateImage，成功后提示用户查看聊天中的图片预览。
创建新的 PowerPoint 时，调用 generatePresentation，并传入相关的对话上下文。该工具会自行生成插图。只有在用户指定页数时才传入 slideCount。
修改已有 PPT 时，调用 updateSlideElements。一次提交同一份 PPT 的所有修改，支持同页或跨页修改已有文字和配图的内容、样式、位置及尺寸，也适用于「第二页再简洁一点」。用户给出页码时传入从 1 开始的 slideNumbers；按内容定位或全稿修改时省略。用 instructions 保留用户的全部要求和精确文案。需要复用聊天中的图片时，从 generateImage 的成功结果取图片 ID，附在 instructions 里并注明对应页面。目标版、元素或图片来源不明确时先确认。
从 PPT 工具的成功结果中取出用户所指版本的 ID。继续修改同一份 PPT 时，优先使用最近一次成功生成或修改的版本。如果用户指定了较早的版本，则使用指定版本。如果用户指的是哪份 PPT 不明确，或当前对话中没有可用的 PPT，请向用户确认要修改哪一份。如果用户只想要建议或文案草稿，直接在聊天中回复。
针对同一份 PPT 的单次请求，最多调用一次 PPT 工具。成功后简要说明结果，并提示用户使用聊天中的下载按钮。如果工具返回错误，告知用户错误信息，然后等待用户的下一条消息。`,
    tools: {
      getCurrentTime,
      generateImage: createImageTool(userId),
      generatePresentation: createPresentationTool(model, userId, providerOptions),
      updateSlideElements: createUpdateSlideElementsTool(model, userId, providerOptions),
    },
    providerOptions,
    maxOutputTokens: 2048,
    stopWhen: stepCountIs(5),
  });
}

// History schemas keep old results available to the chat and model without registering executable tools.
const legacyEditResult = z.union([
  z.object({ error: z.string() }),
  z.object({
    id: z.uuid(),
    title: z.string(),
    slideCount: z.number(),
    fallbackImageCount: z.number(),
    slideNumber: z.number().optional(),
    qualityWarning: z.string().optional(),
  }),
]);
const legacyTextEdit = tool({
  inputSchema: z.object({
    presentationId: z.uuid(),
    slideNumbers: editSlideNumbersSchema.optional(),
    instructions: editInstructionsSchema,
  }),
  outputSchema: legacyEditResult,
});
export const legacyPresentationTools = {
  editPresentation: legacyTextEdit,
  updateTextElement: legacyTextEdit,
  replaceImageElement: tool({
    inputSchema: z.object({
      presentationId: z.uuid(),
      slideNumber: z.number().int().positive(),
      source: replacementImageSourceSchema,
      fit: imageFitSchema.optional(),
    }),
    outputSchema: legacyEditResult,
  }),
};

type ChatTools = ReturnType<typeof createAgent>["tools"] & typeof legacyPresentationTools;
export type ChatMessage = UIMessage<unknown, UIDataTypes, InferUITools<ChatTools>>;
