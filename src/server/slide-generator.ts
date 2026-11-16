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
          if (Boolean(content.imageBrief) !== (planned.imageIntent === "illustration")) {
            context.addIssue({ code: "custom", path: [index], message: "只有 illustration 页面需要 imageBrief。" });
          }
          if (content.layout === "summary" && content.closing &&
            (index !== plan.slides.length - 1 || content.points.length !== 1 || content.points[0].length > 50)) {
            context.addIssue({ code: "custom", path: [index], message: "只有末页且只有一条不超过 50 字的结论时可设置 closing。" });
          }
        }
      }),
  });
  const pages = plan.slides.map(({ layout, goal, keyPoints, imageIntent }, index) =>
    ({ slideNumber: index + 1, layout, goal, keyPoints, imageIntent }));
  const { slides } = await generatePresentationJson(options, "slide content", schema,
    `按照给定的 PowerPoint 大纲写出逐页内容。只返回 {"slides":[{"slideNumber":1,"content":{...}},...]}。按原顺序返回所有页，保留原页码和布局。
content 使用以下结构：
{"layout":"cover","title":"...","subtitle":"..."}
{"layout":"bullets","title":"...","points":["..."]}
{"layout":"two-columns","title":"...","left":{"heading":"...","points":["..."]},"right":{"heading":"...","points":["..."]}}
{"layout":"summary","title":"...","points":["..."]}
标题最多 50 字，副标题可选、最多 90 字，双栏小标题最多 26 字。bullets 或 summary 页包含 1–4 条要点，每条最多 90 字。双栏每栏 1–3 条要点，每条最多 60 字。
仅当最后一页是收尾用的 summary，且只有一条不超过 50 字的简短结论时，才添加 "closing":true。
imageIntent 为 illustration 时，在 content 中用 imageBrief（最多 280 字）描述一张独立配图的主体和构图，可采用写实或插画风格。imageIntent 为 none 时省略 imageBrief。配图避免出现文字、幻灯片文案或图表，避免把生成的场景描述为实拍证据。
所有文本使用单行纯文本。按需求指定的语言和主题风格写作，忠实使用提供的材料，保留用户指定的精确文案，避免编造统计数据、引文或来源。`,
    JSON.stringify({ brief, title: plan.title, pages, theme }), signal);
  return slides.map(({ content }, index) => ({ ...content, slideId: plan.slides[index].slideId }));
}
