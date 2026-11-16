import sharp from "sharp";
import { generateImageAsset } from "./images";
import {
  fitPresentationImage, imagePixelSize, slideSize, templateElementId,
  type PresentationImage, type PresentationSource,
} from "./presentations";

const fullSlideImageBox = { x: 0, y: 0, ...slideSize };
const firstSlideSideImageBox = { x: 7.5, y: 0, w: slideSize.w - 7.5, h: slideSize.h };
const imageBoxes = {
  cover: { x: 6.66, y: 0.6, w: 5.82, h: 6.3 },
  bullets: { x: 7.58, y: 1.94, w: 4.9, h: 4.9 },
  "two-columns": { x: 0.85, y: 1.73, w: 11.63, h: 2.22 },
  summary: { x: 7.58, y: 1.94, w: 4.9, h: 4.9 },
  "image-focus": { x: 0.85, y: 1.84, w: 7.72, h: 4.62 },
} as const;

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
  { slides, theme, palette }: Pick<PresentationSource, "slides" | "theme" | "palette">,
  signal?: AbortSignal,
  slideIds?: ReadonlySet<string>,
) {
  const images = new Map<string, PresentationImage>();
  const configured = Boolean(process.env.DASHSCOPE_API_KEY?.trim() && process.env.DASHSCOPE_BASE_URL?.trim());
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < slides.length) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      const page = slides[index];
      if (!page.imageBrief || (slideIds && !slideIds.has(page.slideId))) continue;

      const imageFocus = page.layout === "image-focus";
      const isFirstSlide = !imageFocus && (page.appearance?.firstSlide ?? index === 0);
      const sideOrContentBox = isFirstSlide ? firstSlideSideImageBox : imageBoxes[page.layout];
      if (configured) {
        try {
          const aspectRatio = isFirstSlide || imageFocus || page.layout === "two-columns" ? "16:9" : "1:1";
          const composition = isFirstSlide
            ? "Use a wide landscape composition. Place the main subject on the right and keep the left visually quiet."
            : page.layout === "two-columns" ? "Keep the subject in the central horizontal band." : "";
          const style = theme ? `配图风格：${theme.imageStyle}。` : "";
          const prompt = `${page.imageBrief}. ${style}No text, captions, or presentation layout. ${composition}`;
          const image = await generateImageAsset(prompt, aspectRatio, signal);
          const source = sharp(image);
          let box = sideOrContentBox;
          if (isFirstSlide) {
            const { width, height } = await source.metadata();
            const slideAspect = fullSlideImageBox.w / fullSlideImageBox.h;
            // Allow minor provider rounding (e.g. 1696 × 960 for a 16:9 request).
            if (Math.abs(width / height / slideAspect - 1) <= 0.02) box = fullSlideImageBox;
          }
          const bytes = await fitPresentationImage(source, box, {
            fit: imageFocus ? "contain" : "cover",
            position: isFirstSlide && box === firstSlideSideImageBox ? "right" : "centre",
            ...(imageFocus && { background: `#${palette.lightBackground}` }),
          });
          images.set(templateElementId(page.slideId, "image"), { slideId: page.slideId, bytes, box, fallback: false });
          continue;
        } catch (error) {
          signal?.throwIfAborted();
          console.warn("Presentation image unavailable:", error instanceof Error ? error.name : "UnknownError");
        }
      }
      if (imageFocus) continue;
      const { width, height } = imagePixelSize(sideOrContentBox);
      const bytes = await fallbackImage(width, height, index);
      images.set(templateElementId(page.slideId, "image"), {
        slideId: page.slideId, bytes: new Uint8Array(bytes), box: sideOrContentBox, fallback: true,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, slides.length) }, worker));
  signal?.throwIfAborted();
  return images;
}
