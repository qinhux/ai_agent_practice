import { tool } from "ai";
import sharp from "sharp";
import { z } from "zod";
import { getPrisma } from "./db";
import { generateImageAsset, getCustomImageGenerationSize } from "./images";
import {
  fitPresentationImage,
  imageBoxSchema,
  imageDescriptionSchema,
  imageNeedsUpscaling,
  imagePixelSize,
  presentationSourceSchema,
} from "./presentations";
import { savePresentation } from "./save-presentation";

export function createReplaceImageElementTool(userId: string) {
  return tool({
    description: "Replace the existing image on one slide of a PowerPoint from this chat and deliver a new version. Resolve the presentation ID from a successful PPT tool result and use 1-based slide numbers. Generate a replacement from a prompt, or reuse a successful generateImage result by ID. Use contain for logos, screenshots, or when the user asks to show the entire image. Ask in chat when the target, page, or image source is ambiguous.",
    inputSchema: z.object({
      presentationId: z.uuid(),
      slideNumber: z.number().int().positive(),
      source: z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("prompt"),
          prompt: imageDescriptionSchema.describe("Describe the desired subject and style in one line, at most 280 characters."),
        }),
        z.strictObject({
          kind: z.literal("generatedImage"),
          generatedImageId: z.uuid(),
          description: imageDescriptionSchema.optional().describe("Short alternative text based on the original image prompt."),
        }),
      ]),
      fit: z.enum(["cover", "contain"]).optional(),
    }),
    execute: async ({ presentationId, slideNumber, source, fit = "cover" }, { abortSignal }) => {
      try {
        const prisma = getPrisma();
        const original = await prisma.presentation.findUnique({
          where: { id: presentationId, userId },
          select: { source: true, images: { select: { slideId: true, bytes: true, box: true, fallback: true } } },
        });
        if (!original) return { error: "找不到这份 PPT。请指定当前对话中的 PPT。" };
        const parsed = presentationSourceSchema.safeParse(original.source);
        if (!parsed.success) return { error: "这份 PPT 没有可编辑的逐页数据。请选用近期生成的 PPT。" };

        const slides = parsed.data.slides;
        const index = slideNumber - 1;
        const page = slides[index];
        if (!page) return { error: `这份 PPT 共有 ${slides.length} 页，请指定有效页码。` };
        const images = new Map(original.images.map(({ slideId, box, ...image }) =>
          [slideId, { ...image, box: imageBoxSchema.parse(box) }] as const));
        const originalImage = images.get(page.slideId);
        if (!originalImage) return { error: `第 ${slideNumber} 页没有可替换的配图。` };

        const { box } = originalImage;
        const firstSlideSideImage = index === 0 && box.x > 0;
        let position = firstSlideSideImage && fit === "cover" ? "right" : "centre";
        let imageBytes: Uint8Array;
        let description: string;
        abortSignal?.throwIfAborted();
        if (source.kind === "generatedImage") {
          const image = await prisma.generatedImage.findUnique({
            where: { id: source.generatedImageId, userId },
            select: { bytes: true },
          });
          if (!image) return { error: "找不到要使用的图片。请指定当前对话中生成的图片。" };
          imageBytes = image.bytes;
          description = source.description ?? "替换配图";
        } else {
          if (!process.env.DASHSCOPE_API_KEY?.trim() || !process.env.DASHSCOPE_BASE_URL?.trim()) {
            return { error: "服务端尚未配置阿里云百炼生图。" };
          }
          const generationSize = getCustomImageGenerationSize(imagePixelSize(box));
          const aspect = box.w / box.h;
          const fallbackAspectRatio = position === "right" || aspect > 4 / 3 ? "16:9" : aspect < 3 / 4 ? "9:16" : "1:1";
          const composition = firstSlideSideImage && generationSize
            ? "Use a portrait composition. Center the main subject and leave breathing room around it."
            : index === 0 && box.x === 0
              ? "Place the main subject on the right and leave the left visually quiet for slide text."
              : position === "right"
                ? "Keep the entire subject within the rightmost third of the image."
                : fit === "cover" && page.layout === "two-columns"
                  ? "Keep the subject in the central horizontal band so a wide crop preserves it."
                  : "";
          if (generationSize) position = "centre";
          description = source.prompt;
          imageBytes = await generateImageAsset(
            `${description}. No captions or presentation layout. ${composition}`,
            generationSize ?? fallbackAspectRatio,
            abortSignal,
          );
        }

        abortSignal?.throwIfAborted();
        const image = sharp(imageBytes, { limitInputPixels: 16_000_000 });
        const dimensions = await image.metadata();
        const qualityWarning = imageNeedsUpscaling(box, dimensions, fit)
          ? `第 ${slideNumber} 页的新图需要明显放大，可能看起来偏模糊。`
          : undefined;
        const bytes = await fitPresentationImage(image, box, {
          fit,
          position,
          background: `#${parsed.data.palette.lightBackground}`,
        });
        images.set(page.slideId, { bytes, box, fallback: false });
        slides[index] = { ...page, imageBrief: description };

        const saved = await savePresentation(userId, parsed.data, images, abortSignal, presentationId);
        return { ...saved, slideNumber, qualityWarning };
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Presentation image replacement failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "PPT 配图替换失败，请稍后重试。" };
      }
    },
  });
}
