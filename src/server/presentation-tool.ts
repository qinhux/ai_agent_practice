import { tool } from "ai";
import { z } from "zod";
import { preparePresentationImages } from "./asset-manager";
import type { PresentationDrafts } from "./presentation-drafts";
import type { PresentationModelOptions } from "./presentation-json";
import { planPresentation } from "./presentation-planner";
import { maxSlideCount, type PresentationSource } from "./presentations";
import { generateSlides } from "./slide-generator";

const defaultSlideCount = 8;

export function createPresentationTool(
  model: PresentationModelOptions["model"], drafts: PresentationDrafts,
  providerOptions: PresentationModelOptions["providerOptions"],
) {
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
        const options = { model, providerOptions };
        const request = { ...brief, slideCount };
        const { theme, plan } = await planPresentation(options, request, abortSignal);
        const slides = await generateSlides(options, request, plan, theme, abortSignal);
        const source: PresentationSource = { title: plan.title, theme, slides };
        const images = await preparePresentationImages(source, abortSignal);
        abortSignal?.throwIfAborted();
        return {
          presentationId: drafts.create(source, images),
          title: source.title, slideCount: slides.length,
        };
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Presentation generation failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "PPT 生成失败，请稍后重试。" };
      }
    },
  });
}
