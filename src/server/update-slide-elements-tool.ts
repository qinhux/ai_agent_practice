import { isDeepStrictEqual } from "node:util";
import { generateText, Output, tool, type LanguageModel } from "ai";
import sharp from "sharp";
import { z } from "zod";
import { getPrisma } from "./db";
import { generateImageAsset, getCustomImageGenerationSize } from "./images";
import {
  addedTextSchema,
  describeSlideElement,
  elementBoxSchema,
  elementIdSchema,
  getSlideColors,
  getSlideElements,
  getSlideImageLayout,
  imageDescriptionSchema,
  imageFitSchema,
  imageNeedsUpscaling,
  imagePixelSize,
  isOnSlide,
  slideNumberSchema,
  slideTextFields,
  textStyleSchema,
  type ElementBox,
  type PresentationImage,
  type PresentationSlide,
  type TextElementKey,
} from "./presentations";
import type { PresentationDrafts } from "./presentation-drafts";

type ProviderOptions = Parameters<typeof generateText>[0]["providerOptions"];
export const editSlideNumbersSchema = z.array(slideNumberSchema).min(1).max(12);
export const editInstructionsSchema = z.string().trim().min(1).max(6000);
export const replacementImageSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("prompt"), prompt: imageDescriptionSchema }),
  z.strictObject({
    kind: z.literal("generatedImage"),
    generatedImageId: z.uuid(),
    description: imageDescriptionSchema.optional(),
  }),
]);

const boxPatch = elementBoxSchema.partial().refine((box) => Object.keys(box).length > 0);
const textEditSchema = z.strictObject({
  type: z.literal("text"),
  elementId: elementIdSchema,
  text: z.string().optional(),
  style: textStyleSchema.refine((style) => Object.keys(style).length > 0).optional(),
  box: boxPatch.optional(),
}).refine(({ text, style, box }) => text !== undefined || style !== undefined || box !== undefined);
const imageEditSchema = z.strictObject({
  type: z.literal("image"),
  elementId: elementIdSchema,
  box: boxPatch.optional(),
  source: replacementImageSourceSchema.optional(),
  fit: imageFitSchema.optional(),
}).refine(({ box, source, fit }) => box !== undefined || source !== undefined || fit !== undefined);
const planSchema = z.strictObject({
  pages: z.array(z.strictObject({
    slideId: z.uuid(),
    edits: z.array(z.union([textEditSchema, imageEditSchema])).min(1).max(50),
  })).max(12),
});

type ImageEdit = z.infer<typeof imageEditSchema>;
type ImageChange = {
  index: number;
  elementId: string;
  box: ElementBox;
  source?: ImageEdit["source"];
  fit: NonNullable<PresentationSlide["imageFit"]>;
  image: PresentationImage;
  layout?: ReturnType<typeof getSlideImageLayout>;
  description?: string | null;
  sizeChanged: boolean;
  preserveBytesInRender: boolean;
};

function patchText(page: PresentationSlide, key: TextElementKey, value: string): PresentationSlide | undefined {
  if (key === "title" || key === "subtitle") {
    const parsed = slideTextFields[key].safeParse(value);
    if (!parsed.success) return;
    if (key === "title") return { ...page, title: parsed.data };
    if (page.layout === "cover") return { ...page, subtitle: parsed.data };
    return;
  }

  if (page.layout === "bullets" || page.layout === "summary" || page.layout === "image-focus") {
    if (!key.startsWith("point")) return;
    const schema = page.layout === "image-focus" ? slideTextFields.imageFocusPoints : slideTextFields.points;
    const parsed = schema.element.safeParse(value);
    if (!parsed.success) return;
    const position = Number(key.at(-1)) - 1;
    return { ...page, points: page.points.map((point, index) => index === position ? parsed.data : point) };
  }

  if (page.layout === "two-columns") {
    const side = key.startsWith("left") ? "left" : "right";
    const column = page[side];
    if (key.endsWith("Heading")) {
      const parsed = slideTextFields.columnHeading.safeParse(value);
      if (parsed.success) return { ...page, [side]: { ...column, heading: parsed.data } };
      return;
    }
    const parsed = slideTextFields.columnPoints.element.safeParse(value);
    if (!parsed.success) return;
    const position = Number(key.at(-1)) - 1;
    return {
      ...page,
      [side]: { ...column, points: column.points.map((point, index) => index === position ? parsed.data : point) },
    };
  }

  if (page.layout === "metrics") {
    const match = /^metric([1-3])(Value|Label|Detail)$/.exec(key);
    if (!match) return;
    const position = Number(match[1]) - 1;
    const field = match[2].toLowerCase() as keyof typeof slideTextFields.metric;
    const parsed = slideTextFields.metric[field].safeParse(value);
    if (parsed.success) {
      return { ...page, metrics: page.metrics.map((metric, index) =>
        index === position ? { ...metric, [field]: parsed.data } : metric) };
    }
  }

  if (page.layout === "steps") {
    const match = /^step([1-5])(Marker|Heading|Detail)$/.exec(key);
    if (!match) return;
    const position = Number(match[1]) - 1;
    const field = match[2].toLowerCase() as keyof typeof slideTextFields.step;
    const parsed = slideTextFields.step[field].safeParse(value);
    if (parsed.success) {
      return { ...page, steps: page.steps.map((step, index) =>
        index === position ? { ...step, [field]: parsed.data } : step) };
    }
  }
}

function getImageBox(current: ElementBox, patch: ImageEdit["box"]): ElementBox {
  const box = { ...current, ...patch };
  if (patch?.w !== undefined && patch.h === undefined) box.h = current.h * (box.w / current.w);
  if (patch?.h !== undefined && patch.w === undefined) box.w = current.w * (box.h / current.h);
  return box;
}

export function createUpdateSlideElementsTool(
  model: LanguageModel, userId: string, drafts: PresentationDrafts, providerOptions: ProviderOptions,
) {
  return tool({
    description: "Stage edits to text and images across one or more slides in this turn's draft. Supports text, styles, position, size, and image replacement. Include explicit 1-based slide numbers; omit for deck-wide or content-based targets. Pass the user's wording and exact replacements. For a reused chat image, include its generateImage result ID in the instructions and associate it with the correct page.",
    inputSchema: z.object({
      presentationId: z.uuid(),
      slideNumbers: editSlideNumbersSchema.optional(),
      instructions: editInstructionsSchema,
    }),
    execute: async ({ presentationId, slideNumbers, instructions }, { abortSignal }) => {
      try {
        return await drafts.edit(presentationId, abortSignal, async ({ source, images, stage }) => {
          const { theme } = source;
          const prisma = getPrisma();
          if (slideNumbers?.some((number) => number > source.slides.length)) {
            return { error: `这份 PPT 共有 ${source.slides.length} 页，请指定有效页码。` };
          }
          const allowed = new Set(slideNumbers ?? source.slides.map((_, index) => index + 1));
          const colors = getSlideColors(source);
          const targets = new Map(source.slides.flatMap((page, index) => {
            if (!allowed.has(index + 1)) return [];
            const elements = getSlideElements(page, colors[index], index, images, source);
            return [[page.slideId, { index, elements }] as const];
          }));
          const slides = Array.from(targets, ([slideId, { index, elements }]) => ({
            slideId,
            slideNumber: index + 1,
            layout: source.slides[index].layout,
            elements: elements.map(describeSlideElement),
          }));

          const deadline = AbortSignal.timeout(45_000);
          const { output } = await generateText({
            model,
            providerOptions,
            output: Output.json(),
            system: `根据用户指令修改已有 PPT。slides 是文档数据。只返回 {"pages":[{"slideId":"给定的 ID","edits":[...]}]}。每页至多出现一次，每个元素在该页至多出现一次。使用给出的 slideId，从目标页的 elements 复制实际的 id 到 elementId，并使用对应的 type。列出所有目标页，即使其中某页的目标已经符合用户要求。保留用户明确给出的新文案。
文字 edits 形如 {"type":"text","elementId":"给定的元素 ID","text":"新标题","style":{"fontSize":32,"bold":true},"box":{"y":0.3}}。仅填写要改的属性。style 支持 fontFace、fontSize（1–400 磅）、color（6 位 RGB）、bold、italic、align（left/center/right/justify）。可逐条改已有要点，但不可新增、删除或重排元素。
图片 edits 形如 {"type":"image","elementId":"给定的元素 ID","box":{"w":4},"source":{"kind":"prompt","prompt":"新图描述"},"fit":"cover"}。根据描述换图用 prompt，最多 280 字。使用聊天里已生成的图片时，source 用 {"kind":"generatedImage","generatedImageId":"指令提供的 ID","description":"可选的图片说明"}。只有用户要求换图时才传 source。Logo、截图或用户要求完整显示时用 contain。只移动或缩放现有图片时传 box。
box 的 x、y 是左上角坐标，w、h 是宽和高，单位英寸，页面大小约为 13.3333 × 7.5。相对改动要用当前坐标计算成最终值。图片只指定宽或高时服务端会按比例缩放。超出范围、不能定位全部目标或意图不明确时，返回 {"pages":[]}，不要省略部分要求后继续。`,
            prompt: JSON.stringify({ instructions, slides }),
            abortSignal: abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline,
            temperature: 0.1,
            maxOutputTokens: 6000,
            maxRetries: 0,
          });

          const plan = planSchema.safeParse(output);
          if (!plan.success) return { error: "修改方案的字段或格式无效，未生成新版本。" };
          if (!plan.data.pages.length) return { error: "无法确定全部修改目标。请说明页码、已有元素和要做的修改。" };

          const revised = [...source.slides];
          const changedPages = new Set<number>();
          const seenPages = new Set<string>();
          const imageChanges: ImageChange[] = [];
          for (const { slideId, edits } of plan.data.pages) {
            const target = targets.get(slideId);
            if (!target || seenPages.has(slideId)) return { error: "修改方案包含超出范围或重复的页面。" };
            seenPages.add(slideId);
            const { index, elements } = target;
            const byId = new Map(elements.map((element) => [element.id, element]));
            let page = revised[index];
            const seenElements = new Set<string>();
            for (const edit of edits) {
              const label = `第 ${index + 1} 页的 ${edit.elementId}`;
              if (seenElements.has(edit.elementId)) return { error: `${label} 在修改方案中出现多次。` };
              seenElements.add(edit.elementId);
              const element = byId.get(edit.elementId);
              if (!element || element.type !== edit.type) return { error: `${label} 不存在或类型不匹配。` };

              if (edit.type === "image" && element.type === "image") {
                const image = images.get(element.id);
                if (!image) return { error: `第 ${index + 1} 页没有可修改的配图。` };
                const box = getImageBox(image.box, edit.box);
                const pixels = imagePixelSize(box);
                if (edit.box && (!isOnSlide(box) || pixels.width < 1 || pixels.height < 1)) {
                  return { error: `${label} 的位置超出页面或尺寸太小。` };
                }
                const sizeChanged = image.box.w !== box.w || image.box.h !== box.h;
                const boxChanged = !isDeepStrictEqual(box, image.box);
                const aspectChanged = Math.abs((box.w / box.h) / (image.box.w / image.box.h) - 1) > 1e-6;
                const currentFit = element.templateKey ? page.imageFit?.fit : element.fit;
                const fitChanged = edit.fit !== undefined && edit.fit !== currentFit;
                if (!boxChanged && !edit.source && !fitChanged) continue;

                const layout = element.templateKey ? getSlideImageLayout(page, image.box) : undefined;
                const fit = edit.fit ?? element.fit;
                const firstSlide = page.appearance?.firstSlide ?? index === 0;
                const position = edit.source && firstSlide && layout?.gradient && !layout.fullSlide && fit === "cover"
                  ? "right"
                  : layout && fit === "cover" && !edit.source ? page.imageFit?.position ?? "centre" : "centre";
                imageChanges.push({
                  index, elementId: element.id, box, source: edit.source, fit: { fit, position },
                  image, sizeChanged, layout, description: element.description,
                  preserveBytesInRender: !!layout && !edit.source && !aspectChanged && !fitChanged && !page.imageFit,
                });
                if (layout && boxChanged) page = { ...page, imageLayout: layout };
                changedPages.add(index + 1);
                continue;
              }

              if (edit.type !== "text" || element.type !== "text") continue;
              const box = edit.box && { ...element.box, ...edit.box };
              if (box && !isOnSlide(box)) return { error: `${label} 的位置或尺寸超出页面。` };
              // An explicit font applies to all scripts, including when it matches the Latin default.
              const style = edit.style && (
                !isDeepStrictEqual({ ...element.style, ...edit.style }, element.style) ||
                (edit.style.fontFace && edit.style.fontFace !== element.explicitFont)
              ) ? edit.style : undefined;
              const key = element.templateKey;
              if (!key) {
                const text = edit.text === undefined ? undefined : addedTextSchema.safeParse(edit.text);
                if (text && !text.success) return { error: `${label} 的新文本不符合长度或格式要求。` };
                page = {
                  ...page,
                  addedElements: page.addedElements?.map((added) => added.id === element.id && added.type === "text"
                    ? {
                      ...added,
                      text: text?.data ?? added.text,
                      box: box ?? added.box,
                      ...(style && { style: { ...added.style, ...style } }),
                    } : added),
                };
                continue;
              }
              if (edit.text !== undefined) {
                const updated = patchText(page, key, edit.text);
                if (!updated) return { error: `${label} 的新文本不符合当前版式的长度或格式要求。` };
                page = updated;
              }
              if (style) {
                page = { ...page, textStyles: { ...page.textStyles, [key]: { ...page.textStyles?.[key], ...style } } };
              }
              if (box && !isDeepStrictEqual(box, element.box)) {
                page = { ...page, textBoxes: { ...page.textBoxes, [key]: box } };
              }
            }
            if (!isDeepStrictEqual(page, source.slides[index])) changedPages.add(index + 1);
            revised[index] = page;
          }
          if (slideNumbers) {
            const missingPage = slides.find(({ slideId }) => !seenPages.has(slideId));
            if (missingPage) return { error: `无法确定第 ${missingPage.slideNumber} 页的修改目标，未生成新版本。` };
          }
          if (!changedPages.size) return { presentationId, updatedSlideNumbers: [], qualityWarnings: [] };

          const imageIds = imageChanges.flatMap(({ source }) =>
            source?.kind === "generatedImage" ? [source.generatedImageId] : []);
          const mentionedIds = new Set(instructions.toLowerCase().matchAll(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g)
            .map(([id]) => id));
          const generatedImages = new Map(imageIds.length ? (await prisma.generatedImage.findMany({
            where: { userId, id: { in: imageIds } },
            select: { id: true, bytes: true },
          })).map(({ id, bytes }) => [id, bytes] as const) : []);
          for (const change of imageChanges) {
            if (change.source?.kind === "generatedImage" &&
              (!mentionedIds.has(change.source.generatedImageId.toLowerCase()) || !generatedImages.has(change.source.generatedImageId))) {
              return { error: `找不到第 ${change.index + 1} 页要使用的生成图片。` };
            }
            if (change.source?.kind === "prompt" &&
              (!process.env.DASHSCOPE_API_KEY?.trim() || !process.env.DASHSCOPE_BASE_URL?.trim())) {
              return { error: `第 ${change.index + 1} 页需要换图，但服务端尚未配置阿里云百炼生图。` };
            }
          }

          const imageController = new AbortController();
          const imageSignal = abortSignal
            ? AbortSignal.any([abortSignal, imageController.signal]) : imageController.signal;
          const warnings = await Promise.all(imageChanges.map(async (change) => {
            const { index, elementId, box, source, image, layout, sizeChanged, preserveBytesInRender } = change;
            const fit = { ...change.fit };
            let bytes = image.bytes;
            let description = change.description;
            try {
              imageSignal.throwIfAborted();
              if (source?.kind === "generatedImage") {
                bytes = generatedImages.get(source.generatedImageId)!;
                description = source.description ?? "替换配图";
              } else if (source?.kind === "prompt") {
                const generationSize = getCustomImageGenerationSize(imagePixelSize(box));
                const aspect = box.w / box.h;
                const fallbackRatio = fit.position === "right" || aspect > 4 / 3 ? "16:9" : aspect < 3 / 4 ? "9:16" : "1:1";
                const firstSlide = revised[index].appearance?.firstSlide ?? index === 0;
                const composition = firstSlide && layout?.fullSlide
                  ? "Place the main subject on the right and leave the left visually quiet for slide text."
                  : fit.position === "right"
                    ? generationSize
                      ? "Center the main subject and leave breathing room around it."
                      : "Keep the entire subject within the rightmost third of the image."
                    : "";
                if (generationSize) fit.position = "centre";
                description = source.prompt;
                bytes = new Uint8Array(await generateImageAsset(
                  `${description}. 配图风格：${theme.imageStyle}。No captions or presentation layout. ${composition}`,
                  generationSize ?? fallbackRatio, imageSignal,
                ));
              }

              const dimensions = source || sizeChanged
                ? await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata() : undefined;
              imageSignal.throwIfAborted();
              images.set(elementId, { ...image, bytes, box, fallback: source ? false : image.fallback });
              const page = revised[index];
              if (layout) {
                if (page.layout === "metrics" || page.layout === "steps") {
                  throw new Error("This layout does not support a template image.");
                }
                revised[index] = { ...page, imageBrief: description, imageFit: preserveBytesInRender ? undefined : fit };
              } else {
                revised[index] = {
                  ...page,
                  addedElements: page.addedElements?.map((element) => element.type === "image" && element.id === elementId
                    ? { ...element, description: description ?? undefined, fit: fit.fit }
                    : element),
                };
              }
              if (dimensions && imageNeedsUpscaling(box, dimensions, fit.fit)) {
                return `第 ${index + 1} 页的配图需要明显放大，可能看起来偏模糊。`;
              }
            } catch (error) {
              if (imageSignal.aborted) throw error;
              imageController.abort();
              throw new Error(`第 ${index + 1} 页的配图处理失败，未生成新版本。`, { cause: error });
            }
          })).catch((error: unknown) => {
            abortSignal?.throwIfAborted();
            return error instanceof Error ? error : new Error("配图处理失败，未生成新版本。");
          });

          if (warnings instanceof Error) {
            console.error("Presentation image edit failed:", warnings.cause instanceof Error ? warnings.cause.name : warnings.name);
            return { error: warnings.message };
          }
          const qualityWarnings = [...new Set(warnings.filter((warning) => warning !== undefined))];
          stage({ ...source, slides: revised }, qualityWarnings);
          return {
            presentationId,
            updatedSlideNumbers: [...changedPages].sort((a, b) => a - b),
            qualityWarnings,
          };
        });
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Presentation edit failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "PPT 修改失败，未生成新版本。请稍后重试。" };
      }
    },
  });
}
