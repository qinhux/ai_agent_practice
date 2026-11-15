import { createDeepSeek, type DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";
import { stepCountIs, tool, ToolLoopAgent, type InferUITools, type UIDataTypes, type UIMessage } from "ai";
import { z } from "zod";
import { createImageTool } from "./image-tool";
import { createPresentationTool } from "./presentation-tool";
import { imageFitSchema } from "./presentations";
import { createAddOrRemoveSlideElementsTool, createListSlideElementsTool } from "./slide-element-tools";
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
修改已有文字或配图的内容、样式、位置、尺寸，或在原位置替换配图时，调用 updateSlideElements。一次提交同一份 PPT 中所有此类修改，也适用于「第二页再简洁一点」。用户给出页码时传入从 1 开始的 slideNumbers；按内容定位或全稿修改时省略。用 instructions 保留用户的全部要求和精确文案。需要复用聊天中的图片时，从 generateImage 的成功结果取图片 ID，附在 instructions 里并注明对应页面。
指定页新增文本框、添加图片或删除元素时，调用 addOrRemoveSlideElements。同一页的新增和删除合并到一次调用。删除前调用只读的 listSlideElements，使用它针对同一 PPT 版本和页码返回的实际元素 ID。需要了解页面布局时也可调用它。新增时提交类型、内容和以英寸为单位的完整位置尺寸，由服务端分配元素 ID。新增图片使用已有 generateImage 成功结果中的图片 ID，需要新图时先调用 generateImage。看不出用户指的是哪个元素时先确认。
从 PPT 工具的成功结果中取出用户所指版本的 ID。继续修改同一份 PPT 时，优先使用最近一次成功生成或修改的版本。如果用户指定了较早的版本，则使用指定版本。如果用户指的是哪份 PPT 不明确，或当前对话中没有可用的 PPT，请向用户确认要修改哪一份。如果用户只想要建议或文案草稿，直接在聊天中回复。
针对同一份 PPT，优先一次完成所有能一起提交的写入。需要分步写入时，串行调用并用上一步成功返回的新版本 ID 继续。只读的 listSlideElements 可在写入前调用。成功后简要说明结果，并提示用户下载最后一个成功版本。如果工具返回错误，停止后续写入，并说明失败和已完成的修改。`,
    tools: {
      getCurrentTime,
      generateImage: createImageTool(userId),
      generatePresentation: createPresentationTool(model, userId, providerOptions),
      updateSlideElements: createUpdateSlideElementsTool(model, userId, providerOptions),
      listSlideElements: createListSlideElementsTool(userId),
      addOrRemoveSlideElements: createAddOrRemoveSlideElementsTool(userId),
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
