import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import type { z } from "zod";

export type PresentationModelOptions = {
  model: LanguageModel;
  providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
};

export async function generatePresentationJson<T>(
  options: PresentationModelOptions,
  stage: string,
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  const deadline = AbortSignal.timeout(45_000);
  const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let correction = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { output } = await generateText({
        ...options, system: system + correction, prompt, abortSignal,
        output: Output.json(), temperature: 0.3, maxOutputTokens: 6000, maxRetries: 0,
      });
      const parsed = schema.safeParse(output);
      if (parsed.success) return parsed.data;
      correction = "\n上次输出未通过校验：" + parsed.error.issues.slice(0, 6)
        .map(({ path, message }) => `${path.join(".") || "根对象"}（${message}）`).join("、")
        + "。请返回修正后的完整 JSON 对象。";
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error) || abortSignal.aborted) throw error;
      correction = "\n上次输出的 JSON 格式无效。请返回一个完整、有效的 JSON 对象。";
    }
  }

  console.error(`Presentation ${stage} did not meet the required format.${correction}`);
  throw new Error(`Invalid presentation ${stage}.`);
}
