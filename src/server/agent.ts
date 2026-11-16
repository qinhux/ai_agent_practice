import { createDeepSeek, type DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";
import { stepCountIs, tool, ToolLoopAgent, type InferUITools, type LanguageModel, type UIMessage } from "ai";
import { z } from "zod";
import type { FileDeliveryData } from "@/lib/file-delivery";
import { imageFitSchema } from "./presentations";
import type { ToolDomain, ToolRegistry } from "./tool-registry";
import {
  editInstructionsSchema,
  editSlideNumbersSchema,
  replacementImageSourceSchema,
} from "./update-slide-elements-tool";

export const providerOptions = {
  deepseek: { thinking: { type: "disabled" } } satisfies DeepSeekLanguageModelOptions,
};

export function createAgentModel(apiKey: string) {
  const deepseek = createDeepSeek({ apiKey });
  return deepseek(process.env.DEEPSEEK_MODEL || "deepseek-flash");
}

const instructions = `你是一个乐于助人的助手。使用用户所用的语言回复。对于需要当前环境未提供的能力，请如实说明。如果用户只想要建议或文案草稿，直接回复。
文档创建和修改工具在本轮内写入草稿。对同一份文档串行调用工具，始终用同一文件 ID 继续操作，查看内容时读取该草稿的最新状态。
只有本轮有文件需要交付，且所有文件操作和用户要求都完成后，才单独调用一次 completeFileWork。它通知服务端在本轮结束时保存并交付文件。调用后简要说明准备好的文件和修改，下载链接由界面提供。用户要求尚未完成、需要澄清或工具出错时，停止写入并说明原因，省略 completeFileWork。仅聊天、查询或 PPT 已经符合要求而没有修改时无需调用。`;

export function createAgent(
  model: LanguageModel, registry: ToolRegistry, initialDomains: readonly ToolDomain[],
) {
  return new ToolLoopAgent({
    model,
    instructions,
    tools: registry.tools,
    providerOptions,
    maxOutputTokens: 2048,
    prepareStep: ({ steps }) => {
      if (steps.some((step) => step.toolCalls.some((call) => call.toolName === "completeFileWork"))) {
        return { activeTools: [], toolChoice: "none" };
      }

      const activeDomains = new Set(initialDomains);
      for (const step of steps) {
        for (const result of step.toolResults) {
          if (!result.dynamic && result.toolName === "requestToolDomains") {
            for (const domain of result.output.domains) activeDomains.add(domain);
          }
        }
      }

      const inactiveDomains = registry.catalog.filter(({ id }) => !activeDomains.has(id));
      const stepInstructions = [instructions, ...registry.instructionsFor(activeDomains)];
      if (inactiveDomains.length) {
        stepInstructions.push(
          `仅当完成本轮任务还需要以下能力时，调用 requestToolDomains 启用相应能力域，再于下一步使用对应工具。日常对话直接回复。可追加的能力域：${JSON.stringify(inactiveDomains)}`,
        );
      }
      return {
        activeTools: registry.toolNamesFor(activeDomains),
        system: stepInstructions.join("\n"),
      };
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

type ChatTools = ToolRegistry["tools"] & typeof legacyPresentationTools;
export type ChatMessage = UIMessage<unknown, FileDeliveryData, InferUITools<ChatTools>>;
