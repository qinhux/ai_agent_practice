import { createDeepSeek, type DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";
import { stepCountIs, ToolLoopAgent, type InferAgentUIMessage } from "ai";
import { createImageTool } from "./image-tool";
import { createUpdateTextElementTool } from "./update-text-element-tool";
import { createPresentationTool } from "./presentation-tool";
import { getCurrentTime } from "./time-tool";

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
修改已有 PPT 的文字内容、字体、字号或文字颜色时，调用 updateTextElement。这也适用于「第二页再简洁一点」这样的后续请求。从 PPT 工具的成功结果中取出用户所指版本的 ID。继续修改同一份 PPT 时，优先使用最近一次成功生成或修改的版本。如果用户指定了较早的版本，则使用指定版本。如果用户指的是哪份 PPT 不明确，或当前对话中没有可用的 PPT，请向用户确认要修改哪一份。如果用户只想要建议或文案草稿，直接在聊天中回复。如果用户要求修改已有 PPT 的图片、其他样式、元素位置或页面顺序，请说明目前支持修改的范围是文字内容、字体、字号和文字颜色。
针对同一份 PPT 的单次请求，最多调用一次 PPT 工具。成功后简要说明结果，并提示用户使用聊天中的下载按钮。如果工具返回错误，告知用户错误信息，然后等待用户的下一条消息。`,
    tools: {
      getCurrentTime,
      generateImage: createImageTool(userId),
      generatePresentation: createPresentationTool(model, userId, providerOptions),
      updateTextElement: createUpdateTextElementTool(model, userId, providerOptions),
    },
    providerOptions,
    maxOutputTokens: 2048,
    stopWhen: stepCountIs(5),
  });
}

export type AgentMessage = InferAgentUIMessage<ReturnType<typeof createAgent>>;
type TextToolPart = Extract<AgentMessage["parts"][number], { type: "tool-updateTextElement" }>;
type LegacyTextToolPart<Part extends TextToolPart = TextToolPart> = Part extends TextToolPart
  ? Omit<Part, "type"> & { type: "tool-editPresentation" }
  : never;
export type ChatMessage = Omit<AgentMessage, "parts"> & {
  parts: (AgentMessage["parts"][number] | LegacyTextToolPart)[];
};
