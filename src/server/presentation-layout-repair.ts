import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { generatePresentationJson, type PresentationModelOptions } from "./presentation-json";
import {
  elementBoxSchema, elementIdSchema, getCitationBand, getComparisonImageBox, getImageBox, getSlideColors,
  getSlideElements, getSlideImageFit, getSlideImageLayout, isOnSlide, maxSlideCount, patchTextLayout, slideSize,
  type PresentationImage, type PresentationSource, type SlideElement,
} from "./presentations";

const boxPatch = elementBoxSchema.partial().refine((value) => Object.keys(value).length > 0);
const repairPlan = z.strictObject({
  pages: z.array(z.strictObject({
    slideId: z.uuid(),
    edits: z.array(z.strictObject({
      elementId: elementIdSchema,
      box: boxPatch.optional(),
      fontSize: z.number().min(14).max(400).optional(),
    }).refine(({ box, fontSize }) => box !== undefined || fontSize !== undefined)).max(12),
  })).max(maxSlideCount),
});

export type LayoutIssue = {
  page: number;
  kind: "text-missing" | "text-off-slide" | "text-overlap" | "image-overlap" | "image-in-sources";
  elementIds: string[];
};

export async function planLayoutRepair(
  source: PresentationSource, images: ReadonlyMap<string, PresentationImage>,
  elements: SlideElement[][], issues: LayoutIssue[], options: PresentationModelOptions, signal: AbortSignal,
) {
  const affected = new Map<number, LayoutIssue[]>();
  for (const issue of issues) {
    const index = issue.page - 1;
    const existing = affected.get(index);
    if (existing) existing.push(issue);
    else affected.set(index, [issue]);
  }
  const targets = new Map(Array.from(affected, ([index, problems]) => {
    const page = source.slides[index];
    const band = getCitationBand(page, source);
    const byId = new Map(elements[index].map((element) => {
      const permissions = element.type === "text" ? {
        box: Boolean(element.templateKey && !page.textBoxes?.[element.templateKey]),
        fontSize: Boolean(element.templateKey && !page.textStyles?.[element.templateKey]?.fontSize),
      } : {
        box: Boolean(element.templateKey && !getSlideImageFit(page, element.templateKey) &&
          (element.templateKey === "image"
            ? !page.imageLayout && !getSlideImageLayout(page, element.box).gradient
            : isDeepStrictEqual(element.box, getComparisonImageBox(source.theme, element.templateKey)))),
        fontSize: false,
      };
      return [element.id, { element, permissions }] as const;
    }));
    return [page.slideId, { index, band, byId, problems }] as const;
  }));
  if (![...targets.values()].some(({ byId }) =>
    [...byId.values()].some(({ permissions }) => permissions.box || permissions.fontSize))) return;

  const { pages } = await generatePresentationJson(options, "layout repair", repairPlan,
    "你负责修复 PPT 排版。阅读逐页的版面数据和检测问题，返回 JSON " +
    '{"pages":[{"slideId":"给定ID","edits":[{"elementId":"给定ID","box":{"w":7.2},"fontSize":24}]}]}。' +
    "每个问题页可列出多项具体调整，每个元素至多出现一次，无安全调整时用空 edits 或省略该页。" +
    "只修改 permissions 允许的字段。box 给出最终值，左上角为原点，坐标、宽高均为英寸；字号单位为磅，只能调小。" +
    "图片不改变宽高比，缩放时只给 w 或 h。避开页面边界和来源区，尽量保留现有视觉层级，优先给文本更多空间。" +
    "text-missing 表示渲染结果缺少文字，text-off-slide 表示越界，text-overlap 和 image-overlap 表示文字重叠，" +
    "image-in-sources 表示配图侵入来源区。页内其他元素允许作必要的配合调整。不得修改文案、图片内容或引用。",
    JSON.stringify({ slideSize, pages: Array.from(targets, ([slideId, { index, band, byId, problems }]) => ({
      slideId, page: index + 1, layout: source.slides[index].layout,
      sourcesBand: band.rows ? { y: band.y, h: band.h } : undefined,
      issues: problems.map(({ kind, elementIds }) => ({ kind, elementIds })),
      elements: Array.from(byId, ([id, { element, permissions }]) => ({
        id, type: element.type, role: element.templateKey, box: element.box, permissions,
        ...(element.type === "text" && {
          textLength: Array.from(element.text).length,
          wideCharacters: Array.from(element.text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)).length,
          fontSize: element.style.fontSize,
        }),
      })),
    })) }), AbortSignal.any([signal, AbortSignal.timeout(12_000)]));

  const slides = [...source.slides];
  const revisedImages = new Map(images);
  const seenPages = new Set<string>();
  const changedPages: number[] = [];
  for (const { slideId, edits } of pages) {
    const target = targets.get(slideId);
    if (!target || seenPages.has(slideId)) return;
    seenPages.add(slideId);
    const { index, byId, band } = target;
    let page = slides[index];
    let movedImage = false;
    const seenElements = new Set<string>();
    for (const edit of edits) {
      const item = byId.get(edit.elementId);
      if (!item || seenElements.has(edit.elementId)) return;
      seenElements.add(edit.elementId);
      const { element, permissions } = item;
      if ((edit.box && !permissions.box) || (edit.fontSize !== undefined && !permissions.fontSize)) return;
      const box = edit.box && (element.type === "image" ? getImageBox(element.box, edit.box) : { ...element.box, ...edit.box });
      if (box && (!isOnSlide(box) || box.w < 0.1 || box.h < 0.1 ||
          (band.rows && box.y < band.y + band.h && box.y + box.h > band.y - 0.12))) return;
      const changedBox = box && !isDeepStrictEqual(box, element.box) ? box : undefined;
      if (element.type === "text") {
        const fontSize = edit.fontSize;
        const currentSize = element.style.fontSize ?? source.theme.typography.bodySize;
        if (fontSize !== undefined && fontSize > currentSize) return;
        const style = fontSize !== undefined && fontSize < currentSize ? { fontSize } : undefined;
        if (changedBox || style) page = patchTextLayout(page, element, changedBox, style);
      } else if (changedBox) {
        if (edit.box?.w !== undefined && edit.box.h !== undefined) return;
        const image = images.get(element.id);
        if (!image) return;
        revisedImages.set(element.id, { ...image, box: changedBox });
        if (element.templateKey === "image") page = { ...page, imageLayout: getSlideImageLayout(page, element.box) };
        movedImage = true;
      }
    }
    if (movedImage || page !== slides[index]) {
      slides[index] = page;
      changedPages.push(index + 1);
    }
  }
  if (!changedPages.length) return;
  const candidate = { ...source, slides };
  // Check layout constraints with the actual renderer's element calculation before exporting.
  const colors = getSlideColors(candidate);
  for (const page of changedPages) {
    const index = page - 1;
    getSlideElements(slides[index], colors[index], index, revisedImages, candidate);
  }
  return { source: candidate, images: revisedImages, changedPages: changedPages.sort((a, b) => a - b) };
}
