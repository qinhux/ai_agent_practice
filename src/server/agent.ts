import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs, tool, ToolLoopAgent, type InferAgentUIMessage } from "ai";
import { z } from "zod";

const getCurrentTime = tool({
  description: "Look up the current time in an IANA time zone such as Asia/Shanghai.",
  inputSchema: z.object({
    timeZone: z.string().min(1).max(100).describe("IANA time zone"),
  }),
  execute: async ({ timeZone }) => {
    try {
      const now = new Date();
      const localTime = new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone,
      }).format(now);

      return { timeZone, localTime, utcTime: now.toISOString() };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return { error: "Invalid IANA time zone.", timeZone };
    }
  },
});

export function createAgent(apiKey: string) {
  const openai = createOpenAI({ apiKey });

  return new ToolLoopAgent({
    model: openai(process.env.OPENAI_MODEL || "gpt-4.1-mini"),
    instructions: "You are a helpful assistant. Reply in the user's language. Use getCurrentTime for questions about the current time.",
    tools: { getCurrentTime },
    providerOptions: { openai: { store: false } },
    maxOutputTokens: 2048,
    stopWhen: stepCountIs(5),
  });
}

export type AgentMessage = InferAgentUIMessage<ReturnType<typeof createAgent>>;
