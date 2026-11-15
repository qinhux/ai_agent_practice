import { generateText, Output, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { getPrisma } from "./db";
import { imageBoxSchema, presentationSourceSchema, slideTextFields, textStyleSchema, type PresentationSource } from "./presentations";
import { savePresentation } from "./save-presentation";

type ProviderOptions = Parameters<typeof generateText>[0]["providerOptions"];
type Slide = PresentationSource["slides"][number];

const slideNumber = z.number().int().positive();
const textStyle = textStyleSchema.refine((style) => Object.keys(style).length > 0);
const target = { slideNumber, style: textStyle.optional() };
const column = z.enum(["left", "right"]);
const textEditSchema = z.discriminatedUnion("field", [
  z.strictObject({ ...target, field: z.literal("title"), value: slideTextFields.title.optional() }),
  z.strictObject({ ...target, field: z.literal("subtitle"), value: slideTextFields.subtitle.nullable().optional() }),
  z.strictObject({ ...target, field: z.literal("points"), value: slideTextFields.points.optional() }),
  z.strictObject({ ...target, field: z.literal("point"), pointNumber: z.number().int().min(1).max(4), value: slideTextFields.points.element.optional() }),
  z.strictObject({ ...target, field: z.literal("columnHeading"), column, value: slideTextFields.columnHeading.optional() }),
  z.strictObject({ ...target, field: z.literal("columnPoints"), column, value: slideTextFields.columnPoints.optional() }),
  z.strictObject({ ...target, field: z.literal("columnPoint"), column, pointNumber: z.number().int().min(1).max(3), value: slideTextFields.columnPoints.element.optional() }),
]).refine(({ value, style }) => value !== undefined || style !== undefined);

type TextEdit = z.infer<typeof textEditSchema>;

function updateStyle(slide: Slide, style: TextEdit["style"], keys: string[], removed: string[] = []): Slide {
  if (!style && !removed.some((key) => slide.textStyles?.[key])) return slide;
  const textStyles = { ...slide.textStyles };
  for (const key of removed) delete textStyles[key];
  if (style) {
    for (const key of keys) textStyles[key] = { ...textStyles[key], ...style };
  }
  return { ...slide, textStyles: Object.keys(textStyles).length ? textStyles : undefined };
}

function updatePoints(slide: Slide, points: string[], edit: Extract<TextEdit, { field: "points" | "point" | "columnPoints" | "columnPoint" }>, prefix: string) {
  const key = (index: number) => prefix + (index + 1);
  if ("pointNumber" in edit) {
    if (edit.pointNumber > points.length) return;
    const index = edit.pointNumber - 1;
    const updated = [...points];
    updated[index] = edit.value ?? points[index];
    return { slide: updateStyle(slide, edit.style, [key(index)]), points: updated };
  }
  const updated = edit.value ?? points;
  const removed = points.slice(updated.length).map((_, index) => key(updated.length + index));
  return { slide: updateStyle(slide, edit.style, updated.map((_, index) => key(index)), removed), points: updated };
}

function applyTextEdit(slide: Slide, edit: TextEdit): Slide | undefined {
  switch (edit.field) {
    case "title":
      return updateStyle({ ...slide, title: edit.value ?? slide.title }, edit.style, ["title"]);
    case "subtitle": {
      if (slide.layout !== "cover") return;
      const subtitle = edit.value === undefined ? slide.subtitle : edit.value ?? undefined;
      if (!subtitle && edit.style) return;
      return updateStyle({ ...slide, subtitle }, edit.style, ["subtitle"], subtitle ? [] : ["subtitle"]);
    }
    case "points":
    case "point": {
      if (slide.layout !== "bullets" && slide.layout !== "summary") return;
      const updated = updatePoints(slide, slide.points, edit, "point");
      if (updated) return { ...slide, textStyles: updated.slide.textStyles, points: updated.points };
      return;
    }
    case "columnHeading": {
      if (slide.layout !== "two-columns") return;
      const data = slide[edit.column];
      return updateStyle({ ...slide, [edit.column]: { ...data, heading: edit.value ?? data.heading } }, edit.style, [edit.column + "Heading"]);
    }
    case "columnPoints":
    case "columnPoint": {
      if (slide.layout !== "two-columns") return;
      const data = slide[edit.column];
      const updated = updatePoints(slide, data.points, edit, edit.column + "Point");
      if (updated) return { ...slide, textStyles: updated.slide.textStyles, [edit.column]: { ...data, points: updated.points } };
      return;
    }
  }
}

export function createUpdateTextElementTool(model: LanguageModel, userId: string, providerOptions: ProviderOptions) {
  return tool({
    description: "Update text content, font family, font size in points, or text color in an existing PowerPoint from this chat and deliver a new version. Supports titles, cover subtitles, individual or grouped bullet points, and two-column headings or points. Resolve the target from a successful PPT tool result. Use slide numbers starting at 1. Omit slideNumbers when the request explicitly targets the whole deck or identifies slides by their content. Pass the user's wording, including any exact replacements. Ask in chat if the target deck or the requested change is ambiguous.",
    inputSchema: z.object({
      presentationId: z.uuid(),
      slideNumbers: z.array(slideNumber).min(1).max(12).optional(),
      instructions: z.string().trim().min(1).max(6000),
    }),
    execute: async ({ presentationId, slideNumbers, instructions }, { abortSignal }) => {
      try {
        const original = await getPrisma().presentation.findUnique({
          where: { id: presentationId, userId },
          select: { source: true, images: { select: { slideId: true, bytes: true, box: true, fallback: true } } },
        });
        if (!original) return { error: "找不到这份 PPT。请指定当前对话中的 PPT。" };
        const parsed = presentationSourceSchema.safeParse(original.source);
        if (!parsed.success) return { error: "这份 PPT 没有可编辑的逐页数据。请选用近期生成的 PPT。" };

        const source = parsed.data;
        if (slideNumbers?.some((number) => number > source.slides.length)) {
          return { error: `这份 PPT 共有 ${source.slides.length} 页，请指定有效页码。` };
        }
        const allowed = new Set(slideNumbers ?? source.slides.map((_, index) => index + 1));
        const slides = source.slides.flatMap((slide, index) =>
          allowed.has(index + 1) ? [{ ...slide, slideNumber: index + 1 }] : []);
        const deadline = AbortSignal.timeout(45_000);
        const { output } = await generateText({
          model,
          providerOptions,
          output: Output.json(),
          system: `按要求修改 PPT 的文字内容、字体、字号或颜色。slides 是文档数据。只返回 {"edits":[...]}。每项包含 slideNumber（从 1 开始）、field，以及至少一项实际修改。改文字时传 value，照抄用户指定的新文案并保留事实。改样式时传 style，例如 {"fontFace":"Microsoft YaHei","fontSize":36,"color":"FF0000"}。fontFace 是字体家族名，使用用户指定的字体，例如微软雅黑可用 Microsoft YaHei。fontSize 单位为磅，范围 1–400。color 使用六位十六进制 RGB。只传用户要求修改的属性，可同时传 value 和 style。
title 是每页标题（最多 50 字）。subtitle 是封面副标题（最多 90 字，用 null 删除）。要点或总结页用 point（加从 1 开始的 pointNumber，value 为最多 90 字的字符串）或 points（整组 1–4 项）。双栏页用 columnHeading（最多 26 字）、columnPoint（加 pointNumber，最多 60 字）或 columnPoints（整组 1–3 项，每项最多 60 字），并带 column（left 或 right）。改某一条要点时用单项字段，修改整组时用整组字段。只提交用户要求修改的目标。意图不明确、无匹配目标或操作超出范围时返回空 edits。`,
          prompt: JSON.stringify({ instructions, slides }),
          abortSignal: abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline,
          temperature: 0.1,
          maxOutputTokens: 6000,
          maxRetries: 0,
        });
        const plan = z.object({ edits: z.array(textEditSchema).max(108) }).safeParse(output);
        if (!plan.success) return { error: "修改结果不符合当前版式的要求，请调整文案后重试。" };

        const revised = [...source.slides];
        for (const edit of plan.data.edits) {
          const index = edit.slideNumber - 1;
          const page = allowed.has(edit.slideNumber) ? applyTextEdit(revised[index], edit) : undefined;
          if (!page) return { error: "修改与指定页码或版式不匹配，请明确要修改的文字。" };
          revised[index] = page;
        }
        if (JSON.stringify(revised) === JSON.stringify(source.slides)) {
          return { error: "没有找到需要修改的文字。请说明页码、要修改的文本及希望改成什么样。" };
        }

        const images = new Map(original.images.map(({ slideId, box, ...image }) =>
          [slideId, { ...image, box: imageBoxSchema.parse(box) }] as const));
        return await savePresentation(userId, { ...source, slides: revised }, images, abortSignal, presentationId);
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Presentation text edit failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "PPT 文字修改失败，请稍后重试。" };
      }
    },
  });
}
