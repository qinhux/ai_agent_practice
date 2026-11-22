import {
  getCitationBand, getSlideColors, getSlideElements, getSlideImageLayout, isOnSlide, patchTextLayout,
  renderPresentation, slideSize, type ElementBox, type PresentationImage, type PresentationSource,
} from "./presentations";
import { readPresentationLayout, type RenderedWord } from "./presentation-layout";
import { planLayoutRepair, type LayoutIssue } from "./presentation-layout-repair";
import type { PresentationModelOptions } from "./presentation-json";

type TextElement = Extract<ReturnType<typeof getSlideElements>[number], { type: "text" }>;
type Issue = LayoutIssue & { key: string; message: string; repair?: TextElement };

function normalizeText(text: string) {
  // Wrapping, list marks, and font-dependent punctuation differ in PDF text extraction.
  return text.normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}\p{S}]/gu, "");
}

function indexWords(words: RenderedWord[]) {
  let content = "";
  const ranges = words.flatMap(({ text, box }) => {
    const normalized = normalizeText(text);
    if (!normalized) return [];
    const start = content.length;
    content += normalized;
    return [{ start, end: content.length, box }];
  });
  return { content, ranges };
}

function findRenderedWords(element: TextElement, { content, ranges }: ReturnType<typeof indexWords>) {
  const expected = normalizeText(element.text);
  if (!expected) return [];
  let best: ElementBox[] | undefined;
  let distance = Infinity;
  for (let start = content.indexOf(expected); start !== -1; start = content.indexOf(expected, start + 1)) {
    const boxes = ranges.filter((range) => range.end > start && range.start < start + expected.length)
      .map(({ box }) => box);
    const box = boxes[0];
    const x = box.x + box.w / 2;
    const y = box.y + box.h / 2;
    const gap = Math.hypot(
      Math.max(element.box.x - x, x - element.box.x - element.box.w, 0),
      Math.max(element.box.y - y, y - element.box.y - element.box.h, 0),
    );
    if (gap >= distance) continue;
    best = boxes;
    distance = gap;
    if (gap === 0) break;
  }
  // An identical phrase on the other side of the slide cannot verify this element.
  return distance <= 0.35 ? best : undefined;
}

function overlaps(first: ElementBox, second: ElementBox) {
  const width = Math.min(first.x + first.w, second.x + second.w) - Math.max(first.x, second.x);
  const height = Math.min(first.y + first.h, second.y + second.h) - Math.max(first.y, second.y);
  return width > 0.06 && height > 0.04 &&
    width * height > 0.16 * Math.min(first.w * first.h, second.w * second.h);
}

function label(element: TextElement) {
  const chars = Array.from(element.text);
  return "「" + chars.slice(0, 22).join("") + (chars.length > 22 ? "…" : "") + "」";
}

function slideElements(source: PresentationSource, images: ReadonlyMap<string, PresentationImage>) {
  return getSlideColors(source).map((colors, index) =>
    getSlideElements(source.slides[index], colors, index, images, source));
}

function inspectSlides(
  source: PresentationSource, images: ReadonlyMap<string, PresentationImage>, pages: RenderedWord[][],
) {
  const issues: Issue[] = [];
  for (const [index, elements] of slideElements(source, images).entries()) {
    const slide = source.slides[index];
    const page = index + 1;
    const words = indexWords(pages[index]);
    const pictures = elements.filter((item) => item.type === "image" &&
      !(item.templateKey === "image" && getSlideImageLayout(slide, item.box).gradient));
    const band = getCitationBand(slide, source);
    const rendered: { element: TextElement; boxes: ElementBox[] }[] = [];
    for (const element of elements) {
      if (element.type !== "text") continue;
      const boxes = findRenderedWords(element, words);
      if (!boxes) {
        issues.push({ page, kind: "text-missing", elementIds: [element.id], key: element.id + ":text", repair: element,
          message: label(element) + "在渲染结果中未完整匹配，可能有截断或字体显示问题。" });
        continue;
      }
      if (boxes.some((box) => box.x < -0.03 || box.y < -0.03 ||
          box.x + box.w > slideSize.w + 0.03 || box.y + box.h > slideSize.h + 0.03)) {
        issues.push({ page, kind: "text-off-slide", elementIds: [element.id], key: element.id + ":text", repair: element,
          message: label(element) + "的文字超出页面边界。" });
      }
      for (const prior of rendered) {
        if (boxes.some((box) => prior.boxes.some((other) => box !== other && overlaps(box, other)))) {
          issues.push({ page, kind: "text-overlap", elementIds: [element.id, prior.element.id],
            key: element.id + ":" + prior.element.id,
            message: label(element) + "与" + label(prior.element) + "可能重叠。" });
        }
      }
      for (const picture of pictures) {
        if (boxes.some((box) => overlaps(box, picture.box))) {
          issues.push({ page, kind: "image-overlap", elementIds: [element.id, picture.id],
            key: element.id + ":" + picture.id, message: label(element) + "与配图重叠，请检查可读性。" });
        }
      }
      rendered.push({ element, boxes });
    }
    for (const picture of pictures) {
      if (band.rows && picture.box.y < band.y + band.h && picture.box.y + picture.box.h > band.y) {
        issues.push({ page, kind: "image-in-sources", elementIds: [picture.id], key: picture.id + ":sources",
          message: "配图延伸到了页底来源区，请打开 PPT 核对。" });
      }
    }
  }
  return issues;
}

function proposeTextRepairs(
  source: PresentationSource, images: ReadonlyMap<string, PresentationImage>, issues: Issue[],
) {
  const elements = slideElements(source, images);
  return source.slides.map((slide, index) => {
    let updated = slide;
    for (const { page, repair } of issues) {
      const key = repair?.templateKey;
      if (page !== index + 1 || !repair || !key || slide.textBoxes?.[key] || slide.textStyles?.[key]?.fontSize) continue;
      const box = repair.box;
      const fontSize = repair.style.fontSize ?? source.theme.typography.bodySize;
      const band = getCitationBand(slide, source);
      const bottom = box.y + box.h;
      const limit = band.rows ? band.y - 0.13 : 6.92;
      const next = elements[index].filter((element) =>
        element.id !== repair.id && element.box.y >= bottom - 0.01 &&
        element.box.x < box.x + box.w && element.box.x + element.box.w > box.x);
      const space = Math.min(limit, ...next.map(({ box }) => box.y - 0.05)) - bottom;
      const height = box.h + Math.min(space, Math.max(0.45, fontSize / 54));
      if (space >= 0.18 && isOnSlide({ ...box, h: height })) {
        updated = patchTextLayout(updated, repair, { ...box, h: height });
      } else {
        const reduced = Math.max(14, Math.floor(fontSize * 0.85));
        if (reduced < fontSize) updated = patchTextLayout(updated, repair, undefined, { fontSize: reduced });
      }
    }
    return updated;
  });
}

export async function reviewPresentation(
  source: PresentationSource, images: ReadonlyMap<string, PresentationImage>, signal: AbortSignal,
  { readLayout = readPresentationLayout, model }: {
    readLayout?: typeof readPresentationLayout; model?: PresentationModelOptions;
  } = {},
) {
  const bytes = await renderPresentation(source, getSlideColors(source), images);
  const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);

  async function review(
    candidate: PresentationSource, candidateImages: ReadonlyMap<string, PresentationImage>, file: Uint8Array<ArrayBuffer>,
  ) {
    const pages = await readLayout(file, candidate.slides.length, reviewSignal);
    const issues = inspectSlides(candidate, candidateImages, pages);
    return { source: candidate, images: candidateImages, bytes: file, checked: true, issues, repairedPages: [] as number[] };
  }

  let original;
  try {
    original = await review(source, images, bytes);
  } catch (error) {
    signal.throwIfAborted();
    console.warn("Presentation layout review unavailable:", error instanceof Error ? error.name : "UnknownError");
    return { source, images, bytes, checked: false, issues: [], repairedPages: [] };
  }
  if (!original.issues.length) return original;

  let planned: { source: PresentationSource; images: ReadonlyMap<string, PresentationImage>; changedPages: number[] } | undefined;
  if (model && !reviewSignal.aborted) {
    try {
      planned = await planLayoutRepair(source, images, slideElements(source, images), original.issues, model, reviewSignal);
    } catch (error) {
      signal.throwIfAborted();
      console.warn("Presentation layout repair plan unavailable:", error instanceof Error ? error.name : "UnknownError");
    }
  }
  if (reviewSignal.aborted) return original;
  if (!planned) {
    const slides = proposeTextRepairs(source, images, original.issues);
    const changedPages = slides.flatMap((slide, index) => slide === source.slides[index] ? [] : [index + 1]);
    if (!changedPages.length) return original;
    planned = { source: { ...source, slides }, images, changedPages };
  }
  const { source: candidate, images: candidateImages, changedPages } = planned;
  try {
    const revisedBytes = await renderPresentation(candidate, getSlideColors(candidate), candidateImages);
    const revised = await review(candidate, candidateImages, revisedBytes);
    const remaining = new Set(revised.issues.map(({ key }) => key));
    const initial = new Set(original.issues.map(({ key }) => key));
    if (revised.issues.every(({ key }) => initial.has(key)) &&
        changedPages.every((page) => original.issues.some((issue) =>
          issue.page === page && !remaining.has(issue.key)))) {
      return { ...revised, repairedPages: changedPages };
    }
  } catch (error) {
    signal.throwIfAborted();
    console.warn("Presentation repair review unavailable:", error instanceof Error ? error.name : "UnknownError");
  }
  return original;
}
