import { isDeepStrictEqual } from "node:util";
import { generateText, Output, tool, type LanguageModel } from "ai";
import sharp from "sharp";
import { z } from "zod";
import { getPrisma } from "./db";
import { generateImageAsset, getCustomImageGenerationSize } from "./images";
import {
  elementBoxSchema,
  getSlideColors,
  getSlideImageLayout,
  getSlideTextElements,
  imageDescriptionSchema,
  imageFitSchema,
  imageNeedsUpscaling,
  imagePixelSize,
  presentationSourceSchema,
  slideSize,
  slideTextFields,
  textElementKeySchema,
  textStyleSchema,
  type ElementBox,
  type PresentationImage,
  type PresentationSlide,
  type TextElementKey,
} from "./presentations";
import { savePresentation } from "./save-presentation";

type ProviderOptions = Parameters<typeof generateText>[0]["providerOptions"];
const slideNumberSchema = z.number().int().positive();
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
  element: textElementKeySchema,
  text: z.string().optional(),
  style: textStyleSchema.refine((style) => Object.keys(style).length > 0).optional(),
  box: boxPatch.optional(),
}).refine(({ text, style, box }) => text !== undefined || style !== undefined || box !== undefined);
const imageEditSchema = z.strictObject({
  element: z.literal("image"),
  box: boxPatch.optional(),
  source: replacementImageSourceSchema.optional(),
  fit: imageFitSchema.optional(),
}).refine(({ box, source, fit }) => box !== undefined || source !== undefined || fit !== undefined);
const planSchema = z.strictObject({
  pages: z.array(z.strictObject({
    slideId: z.uuid(),
    edits: z.array(z.union([textEditSchema, imageEditSchema])).min(1).max(10),
  })).max(12),
});

type ImageEdit = z.infer<typeof imageEditSchema>;
type ImageChange = {
  index: number;
  box: ElementBox;
  source?: ImageEdit["source"];
  fit: NonNullable<PresentationSlide["imageFit"]>;
  image: PresentationImage;
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

  if (page.layout === "bullets" || page.layout === "summary") {
    const parsed = slideTextFields.points.element.safeParse(value);
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
}

function isOnSlide({ x, y, w, h }: ElementBox) {
  const tolerance = 1e-4;
  return x >= 0 && y >= 0 && x + w <= slideSize.w + tolerance && y + h <= slideSize.h + tolerance;
}

function getImageBox(current: ElementBox, patch: ImageEdit["box"]): ElementBox {
  const box = { ...current, ...patch };
  if (patch?.w !== undefined && patch.h === undefined) box.h = current.h * (box.w / current.w);
  if (patch?.h !== undefined && patch.w === undefined) box.w = current.w * (box.h / current.h);
  return box;
}

export function createUpdateSlideElementsTool(model: LanguageModel, userId: string, providerOptions: ProviderOptions) {
  return tool({
    description: "Edit existing text and images across one or more slides of a PowerPoint in one call, returning one new version. Supports text, font and paragraph style, position, size, and image replacement. Resolve the presentation ID from a successful PPT result. Include the explicit 1-based slide numbers to edit; omit for deck-wide or content-based targets. Pass the user's wording and exact replacements. For a reused chat image, include its generateImage result ID in the instructions and associate it with the correct page. Ask in chat if the requested target or change is ambiguous.",
    inputSchema: z.object({
      presentationId: z.uuid(),
      slideNumbers: editSlideNumbersSchema.optional(),
      instructions: editInstructionsSchema,
    }),
    execute: async ({ presentationId, slideNumbers, instructions }, { abortSignal }) => {
      try {
        const prisma = getPrisma();
        const original = await prisma.presentation.findUnique({
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
        const images = new Map(original.images.map(({ slideId, box, ...image }) =>
          [slideId, { ...image, box: elementBoxSchema.parse(box) }] as const));
        const colors = getSlideColors(source);
        const targets = new Map(source.slides.flatMap((page, index) => {
          if (!allowed.has(index + 1)) return [];
          const image = images.get(page.slideId);
          const textElements = getSlideTextElements(page, colors[index], index, image?.box);
          return [[page.slideId, { index, image, textElements }] as const];
        }));
        const slides = Array.from(targets, ([slideId, { index, image, textElements }]) => ({
          slideId,
          slideNumber: index + 1,
          layout: source.slides[index].layout,
          textElements: textElements.map(({ key, text, box, style }) => ({ element: key, text, box, style })),
          image: image && {
            element: "image",
            box: image.box,
            description: source.slides[index].imageBrief,
            fit: source.slides[index].imageFit?.fit,
          },
        }));

        const deadline = AbortSignal.timeout(45_000);
        const { output } = await generateText({
          model,
          providerOptions,
          output: Output.json(),
          system: `根据用户指令修改已有 PPT。slides 是文档数据。只返回 {"pages":[{"slideId":"给定的 ID","edits":[...]}]}。每页至多出现一次，每个元素在该页至多出现一次。只能使用给出的 slideId 和实际存在的 element。列出所有目标页，即使其中某页的目标已经符合用户要求。保留用户明确给出的新文案。
文字 edits 形如 {"element":"title","text":"新标题","style":{"fontSize":32,"bold":true},"box":{"y":0.3}}。仅填写要改的属性。style 支持 fontFace、fontSize（1–400 磅）、color（6 位 RGB）、bold、italic、align（left/center/right/justify）。可逐条改已有要点，但不可新增、删除或重排元素。
图片 edits 形如 {"element":"image","box":{"w":4},"source":{"kind":"prompt","prompt":"新图描述"},"fit":"cover"}。根据描述换图用 prompt，最多 280 字。使用聊天里已生成的图片时，source 用 {"kind":"generatedImage","generatedImageId":"指令提供的 ID","description":"可选的图片说明"}。只有用户要求换图时才传 source。Logo、截图或用户要求完整显示时用 contain。只移动或缩放现有图片时传 box。
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
          const { index, image, textElements } = target;
          let page = revised[index];
          const seenElements = new Set<string>();
          for (const edit of edits) {
            const label = `第 ${index + 1} 页的 ${edit.element}`;
            if (seenElements.has(edit.element)) return { error: `${label} 在修改方案中出现多次。` };
            seenElements.add(edit.element);

            if (edit.element === "image") {
              if (!image) return { error: `第 ${index + 1} 页没有可修改的配图。` };
              const box = getImageBox(image.box, edit.box);
              const pixels = imagePixelSize(box);
              if (edit.box && (!isOnSlide(box) || pixels.width < 1 || pixels.height < 1)) {
                return { error: `${label} 的位置超出页面或尺寸太小。` };
              }
              const sizeChanged = image.box.w !== box.w || image.box.h !== box.h;
              const boxChanged = !isDeepStrictEqual(box, image.box);
              const aspectChanged = Math.abs((box.w / box.h) / (image.box.w / image.box.h) - 1) > 1e-6;
              const fitChanged = edit.fit !== undefined && edit.fit !== page.imageFit?.fit;
              if (!boxChanged && !edit.source && !fitChanged) continue;

              const layout = getSlideImageLayout(page, image.box);
              const fit = edit.fit ?? page.imageFit?.fit ?? "cover";
              const position = edit.source && index === 0 && layout.gradient && !layout.fullSlide && fit === "cover"
                ? "right"
                : fit === "cover" && !edit.source ? page.imageFit?.position ?? "centre" : "centre";
              imageChanges.push({
                index, box, source: edit.source, fit: { fit, position }, image, sizeChanged,
                preserveBytesInRender: !edit.source && !aspectChanged && !fitChanged && !page.imageFit,
              });
              if (boxChanged) page = { ...page, imageLayout: layout };
              changedPages.add(index + 1);
              continue;
            }

            const element = textElements.find(({ key }) => key === edit.element);
            if (!element) return { error: `${label} 不存在。` };
            if (edit.text !== undefined) {
              const updated = patchText(page, element.key, edit.text);
              if (!updated) return { error: `${label} 的新文本不符合当前版式的长度或格式要求。` };
              page = updated;
            }
            // An explicit font applies to all scripts, including when it matches the Latin default.
            if (edit.style && (
              !isDeepStrictEqual({ ...element.style, ...edit.style }, element.style) ||
              (edit.style.fontFace && edit.style.fontFace !== page.textStyles?.[element.key]?.fontFace)
            )) {
              page = {
                ...page,
                textStyles: {
                  ...page.textStyles,
                  [element.key]: { ...page.textStyles?.[element.key], ...edit.style },
                },
              };
            }
            if (edit.box) {
              const box = { ...element.box, ...edit.box };
              if (!isOnSlide(box)) return { error: `${label} 的位置或尺寸超出页面。` };
              if (!isDeepStrictEqual(box, element.box)) {
                page = { ...page, textBoxes: { ...page.textBoxes, [element.key]: box } };
              }
            }
          }
          if (!isDeepStrictEqual(page, source.slides[index])) changedPages.add(index + 1);
          revised[index] = page;
        }
        if (slideNumbers) {
          const missingPage = slides.find(({ slideId }) => !seenPages.has(slideId));
          if (missingPage) return { error: `无法确定第 ${missingPage.slideNumber} 页的修改目标，未生成新版本。` };
        }
        if (!changedPages.size) return { error: "这些元素已符合要求，未生成新版本。" };

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
          const { index, box, source, image, sizeChanged, preserveBytesInRender } = change;
          const page = revised[index];
          const fit = { ...change.fit };
          let bytes = image.bytes;
          let description = page.imageBrief;
          try {
            imageSignal.throwIfAborted();
            if (source?.kind === "generatedImage") {
              bytes = generatedImages.get(source.generatedImageId)!;
              description = source.description ?? "替换配图";
            } else if (source?.kind === "prompt") {
              const layout = getSlideImageLayout(page, image.box);
              const generationSize = getCustomImageGenerationSize(imagePixelSize(box));
              const aspect = box.w / box.h;
              const fallbackRatio = fit.position === "right" || aspect > 4 / 3 ? "16:9" : aspect < 3 / 4 ? "9:16" : "1:1";
              const composition = index === 0 && layout.fullSlide
                ? "Place the main subject on the right and leave the left visually quiet for slide text."
                : fit.position === "right"
                  ? generationSize
                    ? "Center the main subject and leave breathing room around it."
                    : "Keep the entire subject within the rightmost third of the image."
                  : "";
              if (generationSize) fit.position = "centre";
              description = source.prompt;
              bytes = new Uint8Array(await generateImageAsset(
                `${description}. No captions or presentation layout. ${composition}`,
                generationSize ?? fallbackRatio, imageSignal,
              ));
            }

            const dimensions = source || sizeChanged
              ? await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata() : undefined;
            imageSignal.throwIfAborted();
            images.set(page.slideId, { bytes, box, fallback: source ? false : image.fallback });
            revised[index] = { ...page, imageBrief: description, imageFit: preserveBytesInRender ? undefined : fit };
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
        const saved = await savePresentation(userId, { ...source, slides: revised }, images, abortSignal, presentationId);
        return {
          ...saved,
          updatedSlideNumbers: [...changedPages].sort((a, b) => a - b),
          qualityWarnings: warnings.filter((warning) => warning !== undefined),
        };
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Presentation edit failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "PPT 修改失败，未生成新版本。请稍后重试。" };
      }
    },
  });
}
