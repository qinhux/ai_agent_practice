import { getPrisma } from "./db";
import type { Prisma } from "@/generated/prisma/client";
import type { FileDeliveryData } from "@/lib/file-delivery";
import {
  elementBoxSchema,
  getSlideColors,
  presentationSourceSchema,
  renderPresentation,
  templateElementId,
  type PresentationImage,
  type PresentationSource,
} from "./presentations";

export function readPresentationSource(record: { source: unknown } | null): { source: PresentationSource } | { error: string } {
  if (!record) return { error: "找不到这份 PPT。请指定当前对话中的 PPT。" };
  const parsed = presentationSourceSchema.safeParse(record.source);
  if (!parsed.success) return { error: "这份 PPT 没有可编辑的逐页数据。请选用近期生成的 PPT。" };
  return { source: parsed.data };
}

export async function loadPresentationForEdit(userId: string, presentationId: string) {
  const original = await getPrisma().presentation.findUnique({
    where: { id: presentationId, userId },
    select: {
      source: true,
      images: { select: { elementId: true, slideId: true, bytes: true, box: true, fallback: true } },
    },
  });
  const result = readPresentationSource(original);
  if ("error" in result) return result;
  const images = new Map((original?.images ?? []).map(({ elementId, box, ...image }) =>
    [elementId, { ...image, box: elementBoxSchema.parse(box) }] as const));
  return { source: result.source, images };
}

export type PresentationDraft = {
  source: PresentationSource;
  images: ReadonlyMap<string, PresentationImage>;
  parentId?: string;
  warnings: readonly string[];
};

export async function preparePresentationDrafts(
  userId: string,
  drafts: Iterable<PresentationDraft>,
  abortSignal: AbortSignal,
) {
  const prepared: {
    data: Prisma.PresentationUncheckedCreateInput;
    slideCount: number;
    fallbackImageCount: number;
    warnings: readonly string[];
  }[] = [];
  for (const { source, images, parentId, warnings } of drafts) {
    abortSignal.throwIfAborted();
    const bytes = await renderPresentation(source, getSlideColors(source), images);
    const missingImagePages = source.slides.flatMap((page, index) =>
      page.layout === "image-focus" && page.imageBrief && !images.has(templateElementId(page.slideId, "image"))
        ? [index + 1] : []);
    prepared.push({
      data: {
        userId, parentId, title: source.title, bytes, source,
        images: { create: Array.from(images, ([elementId, image]) => ({ elementId, ...image })) },
      },
      slideCount: source.slides.length,
      fallbackImageCount: new Set([...images.values()].filter((image) => image.fallback).map((image) => image.slideId)).size,
      warnings: missingImagePages.length
        ? [`第 ${missingImagePages.join("、")} 页的配图未能生成，已使用纯文字布局`, ...warnings]
        : warnings,
    });
  }
  return async (transaction: Prisma.TransactionClient) => {
    const files: FileDeliveryData["files"] = [];
    for (const { data, slideCount, fallbackImageCount, warnings } of prepared) {
      abortSignal.throwIfAborted();
      const { id, title } = await transaction.presentation.create({ data, select: { id: true, title: true } });
      files.push({
        id,
        kind: "presentation",
        name: `${title}.pptx`,
        downloadUrl: `/api/presentations/${encodeURIComponent(id)}`,
        details: `${slideCount} 页`,
        warnings: fallbackImageCount ? [`${fallbackImageCount} 页使用了备用配图`, ...warnings] : [...warnings],
      });
    }
    return files;
  };
}
