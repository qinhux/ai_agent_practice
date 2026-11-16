import { randomUUID } from "node:crypto";
import { generateText, NoObjectGeneratedError, Output, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { maxSlideCount, preparePresentationImages, presentationSchema } from "./presentations";
import type { PresentationDrafts } from "./presentation-drafts";

type ProviderOptions = Parameters<typeof generateText>[0]["providerOptions"];

const defaultSlideCount = 8;

// 把 PPT 制作需求变成经过校验的逐页数据
async function writePresentation(
  model: LanguageModel,
  providerOptions: ProviderOptions,
  brief: string,
  slideCount: number,
  abortSignal: AbortSignal | undefined,
) {
  const schema = presentationSchema.extend({ slides: presentationSchema.shape.slides.length(slideCount) });
  const deadline = AbortSignal.timeout(45_000);
  const signal = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
  let correction = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { output } = await generateText({
        model,
        providerOptions,
        output: Output.json(),
        system: `制作一份适合目标受众的 PowerPoint。正文使用需求指定的语言，未指定时根据主题推断。只返回一个 JSON 对象，包含 title（最多 60 字符）、palette，以及恰好有 ${slideCount} 项的 slides 数组。

根据主题、受众以及用户指定的风格或品牌色，为整份 PPT 设计一套配色。palette 包含三个六位十六进制色值：lightBackground 是内容页使用的白色或近白色，darkBackground 是封面背景及浅底页面文字使用的深色，accent 是用于页面重点的协调色。优先采用合适的品牌色，过亮的品牌色可以用作 accent。

每页使用以下一种结构：
{"layout":"cover","title":"...","subtitle":"..."}
{"layout":"bullets","title":"...","points":["..."]}
{"layout":"two-columns","title":"...","left":{"heading":"...","points":["..."]},"right":{"heading":"...","points":["..."]}}
{"layout":"summary","title":"...","points":["..."]}
仅当最后一页是收尾用的 summary，且只有一条不超过 50 字符的简短结论时，才添加 "closing":true。信息较多的总结页和行动项列表省略该字段。

每页标题最多 50 字符，可选副标题最多 90 字符，双栏的小标题最多 26 字符。bullets 或 summary 页包含 1–4 条要点，每条最多 90 字符。双栏页每栏包含 1–3 条要点，每条最多 60 字符。要点保持简洁。

逐页判断图片能否帮助受众理解内容。任何版式都可以配图。需要配图时，添加可选的 imageBrief（最多 280 字符），根据当页主题和用户明确提出的配图偏好，描述具体的主体和构图。默认明确要求写实摄影风格，采用自然光和真实质感。用户指定其他风格时，按指定风格描述。页面配色仅用于幻灯片，配图无需匹配 palette。描述一张独立图片，避免出现文字、幻灯片文案、图表或虚构的证据。文字足以说明内容时省略 imageBrief，例如许多议程页、对比页或总结页。整份 PPT 可以没有配图。

所有文本字段使用单行纯文本。单页 PPT 直接呈现核心内容。多页 PPT 可按需使用封面，并将封面放在首页。忠实使用提供的材料，避免编造统计数据、引文或来源。${correction}`,
        prompt: brief,
        temperature: 0.3,
        maxOutputTokens: 6000,
        abortSignal: signal,
        maxRetries: 0,
      });
      const parsed = schema.safeParse(output);
      if (parsed.success) return parsed.data;

      correction = "\n上次输出未通过校验，问题如下：" + parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join(".") || "根对象"}（${issue.code}）`)
        .join("、") + "。请重新返回一个符合所有限制的完整 JSON 对象。";
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error) || signal.aborted) throw error;
      correction = "\n上次输出的 JSON 格式无效。请返回一个完整、有效的 JSON 对象。";
    }
  }

  console.error("Presentation content did not meet the required format." + correction);
  throw new Error("Invalid presentation content.");
}

export function createPresentationTool(model: LanguageModel, drafts: PresentationDrafts, providerOptions: ProviderOptions) {
  return tool({
    description: `Create a new editable PowerPoint draft for this turn. For existing PPTs, use addRemoveOrMoveSlides for whole slides, or updateSlideElements and addOrRemoveSlideElements for individual elements. For brainstorming, outlines, titles, or wording alone, answer in chat. Use the conversation to fill in the brief. Ask for the topic or essential source material only if it is missing. The supported range is 1–${maxSlideCount} slides. If the requested count is outside that range, explain the range and ask for a supported count.`,
    inputSchema: z.object({
      topic: z.string().trim().min(1).max(240).describe("Presentation topic or working title"),
      audience: z.string().trim().min(1).max(160).optional(),
      slideCount: z.number().int().min(1).max(maxSlideCount).optional()
        .describe(`The page count specified by the user. Omit this field when the user has not specified a page count. The server then uses ${defaultSlideCount}.`),
      language: z.string().trim().min(1).max(60).optional().describe("Requested language or the user's language"),
      context: z.string().trim().min(1).max(6000).optional().describe("Brief summary of relevant source material and user requirements, including any requested visual style, brand colors, or image preferences. Leave slide writing and palette design to the tool."),
    }),
    execute: async ({ slideCount = defaultSlideCount, ...brief }, { abortSignal }) => {
      try {
        const content = await writePresentation(
          model,
          providerOptions,
          JSON.stringify({ ...brief, slideCount }),
          slideCount,
          abortSignal,
        );
        const source = {
          ...content,
          slides: content.slides.map((slide) => ({ ...slide, slideId: randomUUID() })),
        };
        const images = await preparePresentationImages(source, abortSignal);
        abortSignal?.throwIfAborted();
        return { presentationId: drafts.create(source, images), title: source.title, slideCount: source.slides.length };
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Presentation generation failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "PPT 生成失败，请稍后重试。" };
      }
    },
  });
}
