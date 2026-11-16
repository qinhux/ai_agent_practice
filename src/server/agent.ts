import { createDeepSeek, type DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";
import { stepCountIs, tool, ToolLoopAgent, type InferUITools, type UIMessage } from "ai";
import { z } from "zod";
import type { FileDeliveryData } from "@/lib/file-delivery";
import { createAddRemoveOrMoveSlidesTool } from "./add-remove-or-move-slides-tool";
import type { FileDrafts } from "./file-drafts";
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

export function createAgent(apiKey: string, userId: string, drafts: FileDrafts) {
  const deepseek = createDeepSeek({ apiKey });
  const model = deepseek(process.env.DEEPSEEK_MODEL || "deepseek-flash");
  const presentationDrafts = drafts.get("presentation");

  return new ToolLoopAgent({
    model,
    instructions: `你是一个乐于助人的助手。使用用户所用的语言回复。用户询问当前时间时，调用 getCurrentTime。用户单独请求生成图片时，调用 generateImage，成功后提示用户查看聊天中的图片预览。
创建新的 PowerPoint 时，调用 generatePresentation，并传入相关的对话上下文。该工具会自行生成插图。只有在用户指定页数时才传入 slideCount。
查询、新增、删除或移动整页时，调用 addRemoveOrMoveSlides。先用 mode: "list" 读取当前 PPT 的页面目录，再用 mode: "edit" 一次提交同一份 PPT 的全部整页操作，按用户要求的顺序排列。默认把本轮用户提到的页码绑定到修改前目录的 slideId。例如「删除第 2 页，把第 5 页移到最前面」使用原第 2 页和原第 5 页的 ID。仅当用户明确指的是前面操作后的新页码时，才用 currentSlideNumber，例如「删掉第 2 页后，把新的第 5 页移到最前面」。如果用户说「把第 2 页移到第 5 页」，第 5 页是移动完成后的最终页码，据此用 before 或 after 选锚点。未指定插入位置时新增到末尾。新增页面使用简明的结构化文案，保留用户给出的精确文案，只有需要新配图时才填写 imageBrief。页面目标不明确时先确认。同一轮还需修改页内元素时，改页序前先记下原页码对应的 ID，改页序后用返回的新目录确定页内工具所需的当前页码。
修改已有文字或配图的内容、样式、位置、尺寸，或在原位置替换配图时，调用 updateSlideElements。一次提交同一份 PPT 中所有此类修改，也适用于「第二页再简洁一点」。用户给出页码时传入从 1 开始的 slideNumbers；按内容定位或全稿修改时省略。用 instructions 保留用户的全部要求和精确文案。需要复用聊天中的图片时，从 generateImage 的成功结果取图片 ID，附在 instructions 里并注明对应页面。
指定页新增文本框、添加图片或删除元素时，调用 addOrRemoveSlideElements。同一页的新增和删除合并到一次调用。删除前调用只读的 listSlideElements，使用它针对同一 PPT 版本和页码返回的实际元素 ID。需要了解页面布局时也可调用它。新增时提交类型、内容和以英寸为单位的完整位置尺寸，由服务端分配元素 ID。新增图片使用已有 generateImage 成功结果中的图片 ID，需要新图时先调用 generateImage。看不出用户指的是哪个元素时先确认。
继续修改已有 PPT 时，从此前已交付文件中取出版本 ID，优先使用最近交付的版本，也尊重用户指定的旧版。如果版本不明确，请先确认。如果用户只想要建议或文案草稿，直接回复。
文档创建和修改工具在本轮内写入草稿。对同一份文档串行调用工具，始终用同一文件 ID 继续操作，查看内容时读取该草稿的最新状态。修改已有 PPT 时用原版本 ID，新创建的 PPT 用 generatePresentation 返回的草稿 presentationId。草稿 ID 只在本轮有效。
只有本轮有文件需要交付，且所有文件操作和用户要求都完成后，才单独调用一次 completeFileWork。它通知服务端在本轮结束时保存并交付文件。调用后简要说明准备好的文件和修改，下载链接由界面提供。用户要求尚未完成、需要澄清或工具出错时，停止写入并说明原因，省略 completeFileWork。仅聊天、查询或 PPT 已经符合要求而没有修改时无需调用。`,
    tools: {
      getCurrentTime,
      generateImage: createImageTool(userId),
      generatePresentation: createPresentationTool(model, presentationDrafts, providerOptions),
      addRemoveOrMoveSlides: createAddRemoveOrMoveSlidesTool(userId, presentationDrafts),
      updateSlideElements: createUpdateSlideElementsTool(model, userId, presentationDrafts, providerOptions),
      listSlideElements: createListSlideElementsTool(userId, presentationDrafts),
      addOrRemoveSlideElements: createAddOrRemoveSlideElementsTool(userId, presentationDrafts),
      completeFileWork: tool({
        description: "Confirm all requested document work for this turn is complete. Call by itself after all document operations succeed. The server saves and delivers the drafts when the turn finishes.",
        inputSchema: z.strictObject({}),
        execute: async () => drafts.hasChanges ? { ready: true } : { error: "本轮没有需要保存的文件。" },
      }),
    },
    providerOptions,
    maxOutputTokens: 2048,
    prepareStep: ({ steps }) => {
      if (steps.some((step) => step.toolCalls.some((call) => call.toolName === "completeFileWork"))) {
        return { activeTools: [], toolChoice: "none" };
      }
    },
    stopWhen: stepCountIs(12),
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
export type ChatMessage = UIMessage<unknown, FileDeliveryData, InferUITools<ChatTools>>;
