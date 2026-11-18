import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { preparePresentationImages } from "./asset-manager";
import type { PresentationDrafts } from "./presentation-drafts";
import type { PresentationModelOptions } from "./presentation-json";
import { availableCoverFields, planPresentation } from "./presentation-planner";
import { coverDetailsSchema, coverFieldSchema, coverLogoSize, getSlideGrid, maxSlideCount, type PresentationSource } from "./presentations";
import { generateSlides } from "./slide-generator";

const defaultSlideCount = 8;

export type PresentationResources = { logo?: Uint8Array<ArrayBuffer>; userText: string };

export function createPresentationTool(
  model: PresentationModelOptions["model"], drafts: PresentationDrafts,
  providerOptions: PresentationModelOptions["providerOptions"],
  { logo, userText }: PresentationResources,
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
      coverDetails: coverDetailsSchema.optional().describe("Verbatim cover facts from the user's source: presenter/team, date, metrics (value with units, label, optional detail), extra information such as location, and a series/copyright footer. Omit unavailable facts."),
      requiredCoverFields: z.array(coverFieldSchema).max(coverFieldSchema.options.length).optional()
        .describe("Only optional cover fields the user explicitly requires on the cover. An attached cover Logo is handled automatically."),
    }),
    execute: async ({ slideCount = defaultSlideCount, ...brief }, { abortSignal }) => {
      try {
        const options = { model, providerOptions };
        const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
        const sourceText = normalize(userText);
        const inSource = (value?: string) => value !== undefined && sourceText.includes(normalize(value));
        const { coverDetails } = brief;
        const metrics = coverDetails?.metrics?.filter(({ value, label, detail }) =>
          inSource(value) && inSource(label) && (detail === undefined || inSource(detail)));
        const request = {
          ...brief, slideCount, hasLogo: Boolean(logo),
          coverDetails: coverDetails && {
            author: inSource(coverDetails.author) ? coverDetails.author : undefined,
            date: inSource(coverDetails.date) ? coverDetails.date : undefined,
            extraInfo: inSource(coverDetails.extraInfo) ? coverDetails.extraInfo : undefined,
            footer: inSource(coverDetails.footer) ? coverDetails.footer : undefined,
            metrics: metrics?.length ? metrics : undefined,
          },
        };
        const available = availableCoverFields(request);
        const missing = brief.requiredCoverFields?.filter((key) => !available.has(key));
        if (missing?.length) {
          const labels = { author: "汇报人或团队", date: "日期", extraInfo: "辅助信息", footer: "页脚文案", metrics: "关键数据", logo: "Logo 图片" };
          return { error: `请提供封面所需的${missing.map((key) => labels[key as keyof typeof labels] ?? key).join("、")}。` };
        }
        const { theme, plan } = await planPresentation(options, request, abortSignal);
        const slides: PresentationSource["slides"] = await generateSlides(options, request, plan, theme, abortSignal);
        const source: PresentationSource = { title: plan.title, theme, slides };
        const images = await preparePresentationImages(source, abortSignal);
        const cover = slides[0];
        if (logo && cover.layout === "cover" && plan.slides[0].coverFields?.includes("logo")) {
          const id = randomUUID();
          const box = { x: getSlideGrid(theme.grid).margin, ...coverLogoSize };
          slides[0] = { ...cover, addedElements: [{ type: "image", id, fit: "contain", description: "封面 Logo", role: "logo" }] };
          images.set(id, { slideId: cover.slideId, bytes: logo, box, fallback: false });
        }
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
