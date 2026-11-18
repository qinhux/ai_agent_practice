import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generatePresentationJson, type PresentationModelOptions } from "./presentation-json";
import {
  coverCopySchema, coverDetailsSchema, coverFieldSchema, coverStyleSchema, getSlideImageSlots,
  imageSlotSchema, presentationTitleSchema, slideContentSchema, type CoverField,
} from "./presentations";
import { backgroundModeSchema, generatedThemeSpecSchema, themeInstructions } from "./theme-generator";

const slideLayoutIds = slideContentSchema.options.map(({ shape }) => shape.layout.value);
const slideLayoutCatalog = {
  cover: {
    role: "封面",
    suitableFor: "介绍整份演示文稿的主题",
    content: "仅用于首页，主标题必填，其他内容按主题、受众和用户要求选择",
  },
  bullets: {
    role: "正文",
    suitableFor: "围绕同一主题展开多条要点",
    content: "1–4 条单栏要点",
  },
  "two-columns": {
    role: "正文",
    suitableFor: "有两组可分别命名的内容，如现状与目标、方案 A 与 B",
    content: "两栏各有一个小标题和 1–3 条要点",
  },
  summary: {
    role: "总结或收尾",
    suitableFor: "归纳前文，或用一句核心结论收尾",
    content: "1–4 条要点。仅末页只有一条不超过 50 字的结论时，可作一句话收尾",
  },
  metrics: {
    role: "正文",
    suitableFor: "素材明确给出了值得突出的数值",
    content: "1–3 项指标，每项含数值、名称和口径说明，keyPoints 保留准确数值、单位和口径",
  },
  steps: {
    role: "正文",
    suitableFor: "有明确先后顺序的流程或里程碑",
    content: "3–5 个节点，keyPoints 按顺序一项对应一个节点",
  },
  "image-focus": {
    role: "正文",
    suitableFor: "图片承担主要叙事，且适合使用 AI 示意图",
    content: "一张主图配 1–2 条解读，不能用生成图替代真实截图、照片证据或数据图",
  },
  "image-comparison": {
    role: "正文",
    suitableFor: "并排比较两种适合用 AI 图像示意的场景或方案",
    content: "左图和右图分别配一句简短图注，不能用生成图替代真实截图、照片证据或数据图",
  },
} satisfies Record<(typeof slideLayoutIds)[number], {
  role: string;
  suitableFor: string;
  content: string;
}>;

const layoutInstructions = [
  "| layout | 适用页面角色 | 适合什么内容 | 内容与配图约束 |",
  "| --- | --- | --- | --- |",
  ...slideLayoutIds.map((layout) => {
    const { role, suitableFor, content } = slideLayoutCatalog[layout];
    const slots = getSlideImageSlots(layout);
    const slotList = slots.map(({ id, required }) => `\`${id}\`（${required ? "必填" : "可选"}）`).join("、");
    return `| \`${layout}\` | ${role} | ${suitableFor} | ${content}。${slotList || "无配图槽位"} |`;
  }),
].join("\n");

const plannedSlideSchema = z.object({
  layout: z.literal(slideLayoutIds),
  goal: z.string().trim().min(1).max(120),
  keyPoints: z.array(z.string().trim().min(1).max(160)).min(1).max(5),
  coverStyle: coverStyleSchema.optional(),
  coverFields: z.array(coverFieldSchema).max(coverFieldSchema.options.length).optional(),
  imageSlots: z.array(imageSlotSchema),
  backgroundMode: backgroundModeSchema.optional(),
}).refine((page) => (page.layout === "cover") === (page.coverStyle !== undefined), {
  path: ["coverStyle"], message: "封面必须选择 full-bleed 或 split-right，其他版式省略 coverStyle。",
}).refine(({ layout, coverFields }) => (layout === "cover") === (coverFields !== undefined) &&
  (!coverFields || new Set(coverFields).size === coverFields.length), {
  path: ["coverFields"], message: "仅封面填写 coverFields，可填空数组，字段不得重复。",
}).refine(({ layout, imageSlots }) => {
  const slots = getSlideImageSlots(layout);
  const selected = new Set(imageSlots);
  return imageSlots.length === selected.size && imageSlots.every((id) => slots.some((slot) => slot.id === id)) &&
    slots.every(({ id, required }) => !required || selected.has(id));
}, { path: ["imageSlots"], message: "imageSlots 必须包含所选版式的所有必填槽位，只能使用该版式的槽位且不能重复。" });

export type PlannedSlide = z.infer<typeof plannedSlideSchema> & { slideId: string };
export type PresentationPlan = { title: string; slides: PlannedSlide[] };
export type PresentationBrief = {
  topic: string;
  slideCount: number;
  audience?: string;
  language?: string;
  context?: string;
  coverDetails?: z.infer<typeof coverDetailsSchema>;
  requiredCoverFields?: CoverField[];
  hasLogo?: boolean;
};

export function availableCoverFields({ coverDetails, hasLogo }: PresentationBrief): ReadonlySet<CoverField> {
  const available = new Set<CoverField>(coverCopySchema.keyof().options);
  for (const key of coverDetailsSchema.keyof().options) {
    if (coverDetails?.[key] !== undefined) available.add(key);
  }
  if (hasLogo) available.add("logo");
  return available;
}

export async function planPresentation(
  options: PresentationModelOptions,
  brief: PresentationBrief,
  signal: AbortSignal | undefined,
) {
  const available = availableCoverFields(brief);
  const required = new Set(brief.requiredCoverFields);
  if (brief.hasLogo) required.add("logo");
  const schema = z.object({
    theme: generatedThemeSpecSchema,
    plan: z.object({
      title: presentationTitleSchema,
      slides: z.array(plannedSlideSchema).length(brief.slideCount)
        .refine((slides) => slides.slice(1).every(({ layout }) => layout !== "cover"), "封面只能位于第一页。")
        .refine(([first]) => {
          const selected = first?.coverFields ?? [];
          return selected.every((field) => available.has(field)) && [...required].every((field) => selected.includes(field));
        }, "封面只能使用可用字段，且必须包含用户要求的字段。"),
    }),
  });
  const { theme, plan } = await generatePresentationJson(options, "plan", schema,
    `为目标受众策划 PowerPoint。只返回 {"theme":{...},"plan":{"title":"...","slides":[...]}}。
${themeInstructions}
plan.title 最多 60 字，slides 恰好有 ${brief.slideCount} 项，按放映顺序排列。每页包含 layout、goal（最多 120 字）、keyPoints（1–5 条，每条最多 160 字）和 imageSlots。
多页演示通常以 cover 开场。根据主题、受众和标题选择封面的 coverStyle，imageSlots 填 ["image"]。适合展现场景、氛围或全景时选 full-bleed，画面铺满全页，左侧预留标题区。适合突出单个产品、人物或需要独立文字区时选 split-right，左侧放文字，右侧为上下铺满的配图。其他版式省略 coverStyle。
每页默认继承 theme.defaultBackgroundMode。仅在用户指定某页的深浅模式，或长篇文稿需要突出章节过渡等少数页面时，才用 backgroundMode（light 或 dark）覆盖。用户要求全稿统一底色时，所有页面均沿用全稿模式。
layout 从下表选择。根据内容选版式，避免重复。单页直接呈现核心内容。goal 描述本页叙事作用，keyPoints 概括要覆盖的材料。
封面用 coverFields 数组列出本次要显示的可选字段，主标题必填，不列入数组。可用字段为 ${JSON.stringify([...available])}，必须使用的字段为 ${JSON.stringify([...required])}。有必用字段时，第一页必须采用封面版式。其余版式省略 coverFields。
根据用户需求、主题和受众选择：正式汇报可用 eyebrow（场合或栏目）、author、date；品牌发布可用 logo、tagline（一句话主张）；项目速览或城市名片可用 metrics、extraInfo（地点或编号）或 keywords。description 用于简短背景，footer 用于系列名或版权。副标题、核心文案和描述选能补充标题的内容，默认最多用两项。必要字段优先，避免自动填满。仅在 coverDetails 中有明确资料时才可选对应字段。Logo 只使用用户附上的素材。

${layoutInstructions}

imageSlots 是本页使用的配图槽位 ID 数组，包含该版式的所有必填槽位。无配图时填 []。图片能帮助理解或用户要求配图时可启用可选槽位。每个槽位使用一张独立的 AI 配图，可按主题规划写实或插画风格。
按指定语言规划，未指定时根据主题推断。忠实使用提供的材料，避免编造统计数据、引文或来源。`,
    JSON.stringify(brief), signal);
  return { theme, plan: { ...plan, slides: plan.slides.map((page) => ({ ...page, slideId: randomUUID() })) } };
}
