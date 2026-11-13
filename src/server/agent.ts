import { createDeepSeek, type DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";
import { stepCountIs, ToolLoopAgent, type InferAgentUIMessage } from "ai";
import { createImageTool } from "./image-tool";
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
    instructions: "You are a helpful assistant. Reply in the user's language. Use getCurrentTime for questions about the current time. Use generateImage for standalone image requests and refer to the image preview in chat when it succeeds. When the user wants a PowerPoint file, use generatePresentation and pass the relevant conversation context. That tool generates slide illustrations itself. Leave slideCount unset unless the user specified it in the relevant conversation. After PowerPoint generation, briefly report the result and refer to the download button in the chat. If a generation tool fails, report its error and wait for the user to retry.",
    tools: {
      getCurrentTime,
      generateImage: createImageTool(userId),
      generatePresentation: createPresentationTool(model, userId, providerOptions),
    },
    providerOptions,
    maxOutputTokens: 2048,
    stopWhen: stepCountIs(5),
  });
}

export type AgentMessage = InferAgentUIMessage<ReturnType<typeof createAgent>>;
