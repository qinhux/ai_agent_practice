import { generateText, NoObjectGeneratedError, Output, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { getPrisma } from "./db";
import { preparePresentationImages, presentationSchema, presentationStyles, renderPresentation } from "./presentations";

type ProviderOptions = Parameters<typeof generateText>[0]["providerOptions"];

const defaultSlideCount = 8;
const maxSlideCount = 12;

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
        system: `Write an audience-appropriate PowerPoint in the language specified in the brief, or infer it from the topic. Return only a JSON object with a title (up to 60 characters) and a slides array with exactly ${slideCount} entries. Use these slide structures:
{"layout":"cover","title":"...","subtitle":"...","imageBrief":"..."}
{"layout":"bullets","title":"...","points":["..."],"imageBrief":"..."}
{"layout":"two-columns","title":"...","left":{"heading":"...","points":["..."]},"right":{"heading":"...","points":["..."]},"imageBrief":"..."}
{"layout":"summary","title":"...","points":["..."],"imageBrief":"..."}
Slide titles are limited to 50 characters, the optional subtitle to 90, and column headings to 26. A bullets or summary slide has 1–4 points of at most 90 characters each. Each column has 1–3 points of at most 60 characters each. Keep each point concise so it fits alongside an image. Every slide must have a distinct imageBrief (up to 280 characters) describing an illustration that supports the slide, including a concrete subject and composition. Ask for a standalone illustration without lettering, slide text, charts, or invented evidence. Use plain single-line text. A one-slide deck should present the main content. For larger decks use a cover when appropriate, and place it first. Use supplied material faithfully and avoid inventing statistics, quotes, or sources.${correction}`,
        prompt: brief,
        temperature: 0.3,
        maxOutputTokens: 6000,
        abortSignal: signal,
        maxRetries: 0,
      });
      const parsed = schema.safeParse(output);
      if (parsed.success) return parsed.data;

      correction = " The previous response failed validation at " + parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join(".") || "root"} (${issue.code})`)
        .join(", ") + ". Return a fresh JSON object that meets all limits.";
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error) || signal.aborted) throw error;
      correction = " The previous response was not valid JSON. Return a complete JSON object.";
    }
  }

  console.error("Presentation content did not meet the required format." + correction);
  throw new Error("Invalid presentation content.");
}

export function createPresentationTool(model: LanguageModel, userId: string, providerOptions: ProviderOptions) {
  return tool({
    description: `Create and deliver an editable PowerPoint (.pptx) file. Use this when the user asks to make, export, or revise a presentation file, including from earlier messages. For brainstorming, outlines, titles, or wording alone, answer in chat. Use the conversation to fill in the brief. Ask for the topic or essential source material only if it is missing. The supported range is 1–${maxSlideCount} slides. If the requested count is outside that range, explain the range and ask for a supported count.`,
    inputSchema: z.object({
      topic: z.string().trim().min(1).max(240).describe("Presentation topic or working title"),
      audience: z.string().trim().min(1).max(160).optional(),
      slideCount: z.number().int().min(1).max(maxSlideCount).optional()
        .describe(`The page count specified by the user. Omit this field when the user has not specified a page count. The server then uses ${defaultSlideCount}.`),
      style: presentationStyles.optional().describe("Visual theme. Defaults to professional."),
      language: z.string().trim().min(1).max(60).optional().describe("Requested language or the user's language"),
      context: z.string().trim().min(1).max(6000).optional().describe("Brief summary of relevant source material from the conversation and the user's requirements. Leave slide writing to the tool."),
    }),
    execute: async ({ slideCount = defaultSlideCount, style = "professional", ...brief }, { abortSignal }) => {
      try {
        const output = await writePresentation(
          model,
          providerOptions,
          JSON.stringify({ ...brief, slideCount, style }),
          slideCount,
          abortSignal,
        );
        const images = await preparePresentationImages(output, style, abortSignal);
        const bytes = await renderPresentation(output, style, images);
        abortSignal?.throwIfAborted();
        const presentation = await getPrisma().presentation.create({
          data: { userId, title: output.title, bytes },
          select: { id: true, title: true },
        });

        return {
          ...presentation,
          slideCount: output.slides.length,
          fallbackImageCount: images.filter((image) => image.fallback).length,
        };
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Presentation generation failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "PPT 生成失败，请稍后重试。" };
      }
    },
  });
}
