import sharp from "sharp";
import { generateImageAsset } from "./images";
import {
  fitPresentationImage, getComparisonImageBox, getSlideColors, getSlideContentTop, getSlideGrid, getSlideImageBrief,
  getSlideImageSlots, imagePixelSize, slideSize, templateElementId,
  type ElementBox, type PresentationImage, type PresentationSlide, type PresentationSource,
} from "./presentations";

const fullSlideImageBox = { x: 0, y: 0, ...slideSize };
const firstSlideSideImageBox = { x: 7.5, y: 0, w: slideSize.w - 7.5, h: slideSize.h };
const imageBoxes: Partial<Record<PresentationSlide["layout"], ElementBox>> = {
  cover: { x: 6.66, y: 0.6, w: 5.82, h: 6.3 },
  bullets: { x: 7.58, y: 1.94, w: 4.9, h: 4.9 },
  "two-columns": { x: 0.85, y: 1.73, w: 11.63, h: 2.22 },
  summary: { x: 7.58, y: 1.94, w: 4.9, h: 4.9 },
  "image-focus": { x: 0.85, y: 1.84, w: 7.72, h: 4.62 },
};

function themedImageBox(
  layout: PresentationSlide["layout"],
  isFirstSlide: boolean,
  theme: PresentationSource["theme"],
): ElementBox {
  const grid = getSlideGrid(theme.grid);
  const y = getSlideContentTop(theme);
  if (isFirstSlide) {
    const { x } = grid.column(6, 6);
    return { x, y: 0, w: slideSize.w - x, h: slideSize.h };
  }
  if (layout === "cover") return { ...grid.column(6, 6), y: 0.6, h: 6.3 };
  if (layout === "two-columns") return { ...grid.column(0, 12), y, h: 2.22 };
  if (layout === "image-focus") return { ...grid.column(0, 8), y, h: 4.62 };
  const column = grid.column(7, 5);
  return { ...column, y, h: Math.min(column.w, 4.9) };
}

async function fallbackImage(width: number, height: number, index: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 1000" preserveAspectRatio="none">
    <rect width="1000" height="1000" fill="#F4F4F5"/>
    <circle cx="${260 + (index % 4) * 135}" cy="425" r="158" fill="#D4D4D8"/>
    <path d="M0 690 Q250 320 540 645 T1000 584 V1000 H0 Z" fill="#A1A1AA"/>
    <path d="M0 825 Q300 585 670 804 T1000 758 V1000 H0 Z" fill="#71717A"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 86 }).toBuffer();
}

export async function preparePresentationImages(
  presentation: PresentationSource,
  signal?: AbortSignal,
  slideIds?: ReadonlySet<string>,
) {
  const { slides, theme, legacyLayout } = presentation;
  const slideColors = getSlideColors(presentation);
  const images = new Map<string, PresentationImage>();
  const jobs = slides.flatMap((page, index) => {
    if (slideIds && !slideIds.has(page.slideId)) return [];
    return getSlideImageSlots(page.layout).flatMap((slot) => {
      const brief = getSlideImageBrief(page, slot.id);
      const elementId = templateElementId(page.slideId, slot.id);
      return brief && !page.removedElementIds?.includes(elementId) ? [{ page, index, slot, brief, elementId }] : [];
    });
  });
  const configured = Boolean(process.env.DASHSCOPE_API_KEY?.trim() && process.env.DASHSCOPE_BASE_URL?.trim());
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < jobs.length) {
      signal?.throwIfAborted();
      const { page, index, slot, brief, elementId } = jobs[nextIndex++];

      const imageFocus = page.layout === "image-focus";
      const isComparison = slot.id !== "image";
      const isFirstSlide = !isComparison && !imageFocus && (page.appearance?.firstSlide ?? index === 0);
      const coverStyle = page.layout === "cover" ? page.coverStyle : undefined;
      const useCoverBox = isFirstSlide || Boolean(coverStyle);
      const legacyBox = legacyLayout ? (useCoverBox ? firstSlideSideImageBox : imageBoxes[page.layout]) : undefined;
      const plannedBox = coverStyle === "full-bleed" ? fullSlideImageBox
        : slot.id === "image" ? legacyBox ?? themedImageBox(page.layout, useCoverBox, theme)
        : getComparisonImageBox(theme, slot.id);
      if (configured) {
        try {
          const wideCover = useCoverBox && coverStyle !== "split-right";
          const wideImage = wideCover || imageFocus || isComparison || page.layout === "two-columns";
          const aspectRatio = wideImage ? "16:9" : "1:1";
          const composition = coverStyle === "split-right"
            ? "Center the subject in the image with room for a slightly portrait crop."
            : wideCover
              ? "Use a wide landscape composition. Place the main subject on the right and keep the left visually quiet."
              : page.layout === "two-columns" ? "Keep the subject in the central horizontal band." : "";
          const prompt = `${brief}. 配图风格：${theme.imageStyle}。No text, captions, or presentation layout. ${composition}`;
          const image = await generateImageAsset(prompt, aspectRatio, signal);
          const source = sharp(image);
          let box = plannedBox;
          if (isFirstSlide && !coverStyle) {
            const { width, height } = await source.metadata();
            const slideAspect = fullSlideImageBox.w / fullSlideImageBox.h;
            // Allow minor provider rounding (e.g. 1696 × 960 for a 16:9 request).
            if (Math.abs(width / height / slideAspect - 1) <= 0.02) box = fullSlideImageBox;
          }
          const bytes = await fitPresentationImage(source, box, {
            fit: slot.fit,
            position: isFirstSlide && !coverStyle && box === plannedBox ? "right" : "centre",
            ...(imageFocus && { background: `#${legacyLayout ? theme.colors.modes.light.background : slideColors[index].background}` }),
          });
          images.set(elementId, { slideId: page.slideId, bytes, box, fallback: false });
          continue;
        } catch (error) {
          signal?.throwIfAborted();
          console.warn("Presentation image unavailable:", error instanceof Error ? error.name : "UnknownError");
        }
      }
      if (slot.required && page.layout !== "cover") continue;
      const { width, height } = imagePixelSize(plannedBox);
      const bytes = await fallbackImage(width, height, index);
      images.set(elementId, {
        slideId: page.slideId, bytes: new Uint8Array(bytes), box: plannedBox, fallback: true,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
  signal?.throwIfAborted();
  return images;
}
