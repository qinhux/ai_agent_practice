import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generatePresentationJson, type PresentationModelOptions } from "./presentation-json";
import { presentationTitleSchema, slideContentSchema } from "./presentations";
import { backgroundModeSchema, themeInstructions, themeSpecSchema } from "./theme-generator";

const plannedSlideSchema = z.object({
  layout: z.literal(slideContentSchema.options.map(({ shape }) => shape.layout.value)),
  goal: z.string().trim().min(1).max(120),
  keyPoints: z.array(z.string().trim().min(1).max(160)).min(1).max(5),
  imageIntent: z.enum(["none", "illustration"]),
  backgroundMode: backgroundModeSchema.optional(),
}).refine(({ layout, imageIntent }) => {
  if (layout === "image-focus") return imageIntent === "illustration";
  if (layout === "metrics" || layout === "steps") return imageIntent === "none";
  return true;
}, { path: ["imageIntent"], message: "image-focus 必须配图，metrics 和 steps 使用无图布局。" });

export type PlannedSlide = z.infer<typeof plannedSlideSchema> & { slideId: string };
export type PresentationPlan = { title: string; slides: PlannedSlide[] };
export type PresentationBrief = {
  topic: string;
  slideCount: number;
  audience?: string;
  language?: string;
  context?: string;
};

export async function planPresentation(
  options: PresentationModelOptions,
  brief: PresentationBrief,
  signal: AbortSignal | undefined,
) {
  const schema = z.object({
    theme: themeSpecSchema,
    plan: z.object({
      title: presentationTitleSchema,
      slides: z.array(plannedSlideSchema).length(brief.slideCount)
        .refine((slides) => slides.slice(1).every(({ layout }) => layout !== "cover"), "封面只能位于第一页。"),
    }),
  });
  const { theme, plan } = await generatePresentationJson(options, "plan", schema,
    `为目标受众策划 PowerPoint。只返回 {"theme":{...},"plan":{"title":"...","slides":[...]}}。
${themeInstructions}
plan.title 最多 60 字，slides 恰好有 ${brief.slideCount} 项，按放映顺序排列。每页包含 layout、goal（最多 120 字）、keyPoints（1–5 条，每条最多 160 字）和 imageIntent。
页面可通过 backgroundMode 指定 light 或 dark，用于响应用户的要求或有意突出某页。通常省略此字段，默认多页稿的封面和一句话收尾页用深色，其他页用浅色。
layout 使用 cover、bullets、two-columns、summary、metrics、steps 或 image-focus。封面只能出现在第一页。单页直接呈现核心内容。根据内容选版式，避免重复。goal 描述本页叙事作用，keyPoints 概括要覆盖的材料。
metrics 用于材料明确给出 1–3 项有意义的指标，keyPoints 保留准确数值、单位和口径。steps 用于 3–5 个有明确先后关系的步骤或里程碑，keyPoints 按顺序一项对应一个节点。两种版式的 imageIntent 均为 none。
image-focus 用于图片本身承担叙事、只需配 1–2 条解读的页面，imageIntent 必须为 illustration。仅在 AI 示意图适合时采用，不能用生成图替代真实截图、照片证据或数据图。
imageIntent 使用 none（无图）或 illustration（AI 生成配图）。图片能帮助理解或用户要求配图时用 illustration，可按主题规划写实或插画风格，包括以真实地点、人物或产品为主题的配图。
按指定语言规划，未指定时根据主题推断。忠实使用提供的材料，避免编造统计数据、引文或来源。`,
    JSON.stringify(brief), signal);
  return { theme, plan: { ...plan, slides: plan.slides.map((page) => ({ ...page, slideId: randomUUID() })) } };
}
