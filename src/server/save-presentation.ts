import { getPrisma } from "./db";
import type { Prisma } from "@/generated/prisma/client";
import type { FileDeliveryData } from "@/lib/file-delivery";
import { validatePresentationCitations } from "./presentation-research";
import {
  elementBoxSchema,
  getSlideColors,
  getSlideImageBrief,
  getSlideImageSlots,
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
    validatePresentationCitations(source);
    const bytes = await renderPresentation(source, getSlideColors(source), images);
    const missingImageWarnings = source.slides.flatMap((page, index) => {
      const missingSlots = getSlideImageSlots(page.layout).filter(({ id }) => {
        const elementId = templateElementId(page.slideId, id);
        return getSlideImageBrief(page, id) && !page.removedElementIds?.includes(elementId) && !images.has(elementId);
      });
      if (!missingSlots.length) return [];
      if (page.layout === "image-focus") return [`第 ${index + 1} 页的配图未能生成，已使用纯文字布局`];
      const slotLabels = { image: "主图", leftImage: "左图", rightImage: "右图" };
      return [`第 ${index + 1} 页的${missingSlots.map(({ id }) => slotLabels[id]).join("、")}未能生成`];
    });
    prepared.push({
      data: {
        userId, parentId, title: source.title, bytes, source,
        images: { create: Array.from(images, ([elementId, image]) => ({ elementId, ...image })) },
      },
      slideCount: source.slides.length,
      fallbackImageCount: new Set([...images.values()].filter((image) => image.fallback).map((image) => image.slideId)).size,
      warnings: [...new Set([...missingImageWarnings, ...warnings, ...(source.research?.warnings ?? [])])],
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
