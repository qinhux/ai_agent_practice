import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generatePresentationJson, type PresentationModelOptions } from "./presentation-json";
import { presentationTitleSchema, slideContentSchema } from "./presentations";
import { backgroundModeSchema, themeInstructions, themeSpecSchema } from "./theme-generator";

const slideLayoutIds = slideContentSchema.options.map(({ shape }) => shape.layout.value);
const slideLayoutCatalog = {
  cover: {
    role: "封面",
    suitableFor: "介绍整份演示文稿的主题",
    content: "仅可用于首页，放主标题和可选副标题",
    image: "optional",
  },
  bullets: {
    role: "正文",
    suitableFor: "围绕同一主题展开多条要点",
    content: "1–4 条单栏要点",
    image: "optional",
  },
  "two-columns": {
    role: "正文",
    suitableFor: "有两组可分别命名的内容，如现状与目标、方案 A 与 B",
    content: "两栏各有一个小标题和 1–3 条要点",
    image: "optional",
  },
  summary: {
    role: "总结或收尾",
    suitableFor: "归纳前文，或用一句核心结论收尾",
    content: "1–4 条要点。仅末页只有一条不超过 50 字的结论时，可作一句话收尾",
    image: "optional",
  },
  metrics: {
    role: "正文",
    suitableFor: "素材明确给出了值得突出的数值",
    content: "1–3 项指标，每项含数值、名称和口径说明，keyPoints 保留准确数值、单位和口径",
    image: "none",
  },
  steps: {
    role: "正文",
    suitableFor: "有明确先后顺序的流程或里程碑",
    content: "3–5 个节点，keyPoints 按顺序一项对应一个节点",
    image: "none",
  },
  "image-focus": {
    role: "正文",
    suitableFor: "图片承担主要叙事，且适合使用 AI 示意图",
    content: "一张主图配 1–2 条解读，不能用生成图替代真实截图、照片证据或数据图",
    image: "illustration",
  },
} satisfies Record<(typeof slideLayoutIds)[number], {
  role: string;
  suitableFor: string;
  content: string;
  image: "optional" | "none" | "illustration";
}>;

const imageIntentLabels = {
  optional: "配图可选",
  none: "imageIntent 必须为 none",
  illustration: "imageIntent 必须为 illustration",
};
const layoutInstructions = [
  "| layout | 适用页面角色 | 适合什么内容 | 内容与配图约束 |",
  "| --- | --- | --- | --- |",
  ...slideLayoutIds.map((layout) => {
    const { role, suitableFor, content, image } = slideLayoutCatalog[layout];
    return `| \`${layout}\` | ${role} | ${suitableFor} | ${content}。${imageIntentLabels[image]} |`;
  }),
].join("\n");

const plannedSlideSchema = z.object({
  layout: z.literal(slideLayoutIds),
  goal: z.string().trim().min(1).max(120),
  keyPoints: z.array(z.string().trim().min(1).max(160)).min(1).max(5),
  imageIntent: z.enum(["none", "illustration"]),
  backgroundMode: backgroundModeSchema.optional(),
}).refine(({ layout, imageIntent }) => {
  const { image } = slideLayoutCatalog[layout];
  return image === "optional" || imageIntent === image;
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
layout 从下表选择。根据内容选版式，避免重复。单页直接呈现核心内容。goal 描述本页叙事作用，keyPoints 概括要覆盖的材料。

${layoutInstructions}

imageIntent 使用 none（无图）或 illustration（AI 生成配图）。图片能帮助理解或用户要求配图时用 illustration，可按主题规划写实或插画风格，包括以真实地点、人物或产品为主题的配图。
按指定语言规划，未指定时根据主题推断。忠实使用提供的材料，避免编造统计数据、引文或来源。`,
    JSON.stringify(brief), signal);
  return { theme, plan: { ...plan, slides: plan.slides.map((page) => ({ ...page, slideId: randomUUID() })) } };
}
