import { z } from "zod";
import { generatePresentationJson, type PresentationModelOptions } from "./presentation-json";
import type { PresentationBrief, PresentationPlan } from "./presentation-planner";
import { slideContentSchema, slideTextFields } from "./presentations";
import type { ThemeSpec } from "./theme-generator";

// Keep legacy slide parsing intact and enforce the renderer's limits on newly generated content.
const generatedContentSchema = z.looseObject({
  points: slideTextFields.points.optional(),
  left: z.looseObject({ points: slideTextFields.columnPoints }).optional(),
  right: z.looseObject({ points: slideTextFields.columnPoints }).optional(),
}).refine((content) => content.imageBrief === undefined, {
  path: ["imageBrief"], message: "新页面请使用 imageBriefs。",
}).pipe(slideContentSchema);

export async function generateSlides(
  options: PresentationModelOptions,
  brief: PresentationBrief,
  plan: PresentationPlan,
  theme: ThemeSpec,
  signal: AbortSignal | undefined,
) {
  const schema = z.object({
    slides: z.array(z.object({ slideNumber: z.number().int(), content: generatedContentSchema }))
      .length(plan.slides.length).superRefine((slides, context) => {
        for (const [index, { slideNumber, content }] of slides.entries()) {
          const planned = plan.slides[index];
          if (!planned || slideNumber !== index + 1 || content.layout !== planned.layout) {
            context.addIssue({ code: "custom", path: [index], message: "页码、顺序和布局必须与大纲一致。" });
            continue;
          }
          const slots = Object.keys(content.imageBriefs ?? {});
          if (slots.length !== planned.imageSlots.length ||
            planned.imageSlots.some((id) => !content.imageBriefs?.[id])) {
            context.addIssue({ code: "custom", path: [index, "content", "imageBriefs"],
              message: "imageBriefs 的键必须与本页大纲中的 imageSlots 一致。" });
          }
          if (content.layout === "summary" && content.closing &&
            (index !== plan.slides.length - 1 || content.points.length !== 1 || content.points[0].length > 50)) {
            context.addIssue({ code: "custom", path: [index], message: "只有末页且只有一条不超过 50 字的结论时可设置 closing。" });
          }
        }
      }),
  });
  const pages = plan.slides.map(({ layout, goal, keyPoints, imageSlots, backgroundMode }, index) =>
    ({ slideNumber: index + 1, layout, goal, keyPoints, imageSlots, backgroundMode }));
  const { slides } = await generatePresentationJson(options, "slide content", schema,
    `按照给定的 PowerPoint 大纲写出逐页内容。只返回 {"slides":[{"slideNumber":1,"content":{...}},...]}。按原顺序返回所有页，保留原页码和布局。
content 使用以下结构：
{"layout":"cover","title":"...","subtitle":"..."}
{"layout":"bullets","title":"...","points":["..."]}
{"layout":"two-columns","title":"...","left":{"heading":"...","points":["..."]},"right":{"heading":"...","points":["..."]}}
{"layout":"summary","title":"...","points":["..."]}
{"layout":"metrics","title":"...","metrics":[{"value":"...","label":"...","detail":"..."}]}
{"layout":"steps","title":"...","steps":[{"marker":"...","heading":"...","detail":"..."}]}
{"layout":"image-focus","title":"...","points":["..."],"imageBriefs":{"image":"..."}}
{"layout":"image-comparison","title":"...","leftCaption":"...","rightCaption":"...","imageBriefs":{"leftImage":"...","rightImage":"..."}}
标题最多 50 字，副标题可选、最多 90 字，双栏小标题最多 26 字。bullets 或 summary 页包含 1–4 条要点，每条最多 90 字。双栏每栏 1–3 条要点，每条最多 60 字。
metrics 写 1–3 项，value 最多 14 字并含必要单位，label 最多 20 字，detail 最多 60 字，用于解释口径或含义。忠实保留材料里的数值。
steps 写 3–5 个有序节点，marker 用于日期或阶段标记，最多 12 字；省略时自动编号。heading 最多 14 字，detail 最多 42 字。
image-focus 写 1–2 条解读，每条最多 72 字，围绕图中可示意的主体或结构。
image-comparison 左右图注各最多 80 字，分别描述对应图的含义，配图描述的风格和视角应便于对照。
仅当最后一页是收尾用的 summary，且只有一条不超过 50 字的简短结论时，才添加 "closing":true。
为大纲 imageSlots 中的每个槽位填写 imageBriefs，键用槽位 ID，值是对应独立配图的主体和构图描述，每条最多 280 字。imageSlots 为空时省略 imageBriefs。配图避免出现文字、幻灯片文案或图表，避免把生成的场景描述为实拍证据。
所有文本使用单行纯文本。按需求指定的语言和主题风格写作，忠实使用提供的材料，保留用户指定的精确文案，避免编造统计数据、引文或来源。`,
    JSON.stringify({ brief, title: plan.title, pages, theme }), signal);
  return slides.map(({ content }, index) => {
    const { slideId, backgroundMode } = plan.slides[index];
    return { ...content, slideId, backgroundMode };
  });
}
