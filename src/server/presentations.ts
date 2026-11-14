import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import sharp from "sharp";
import { z } from "zod";
import { generateImageAsset } from "./images";

// 去掉字符串首尾的空白，要求至少有一个字符，并限制长度。正则会拒绝换行、制表符等字符，让每个字段以单行文本传给排版代码。
function slideText(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).regex(/^[^\p{Cc}\p{Cs}\u2028\u2029\uFFFE\uFFFF]+$/u);
}

// 要求至少有一条要点，每条最多 90 字符，校验通过后只保留前 4 条。这里先校验每一条，再截取数组。如果模型输出了 5 条，第 5 条也要通过校验，之后才会被截掉。
function slidePoints(maxPoints: number, maxLength: number) {
  return z.array(slideText(maxLength)).min(1).transform((points) => points.slice(0, maxPoints));
}

// title、`points`、`column`、`slide` 都是定义的 Zod 校验规则
const title = slideText(50);
// 要点页或总结页的列表。至少 1 条，每条最多 90 个字符，校验后保留前 4 条。
const points = slidePoints(4, 90);
// 双栏页中的一栏，包含栏标题 heading 和该栏的 points。栏标题最多 26 个字符，每条要点最多 60 个字符，校验后保留前 3 条。
const column = z.object({ heading: slideText(26), points: slidePoints(3, 60) });
const imageBrief = slideText(280).nullish();
// 一整页幻灯片。根据 layout 决定这页需要哪些字段。
const slide = z.discriminatedUnion("layout", [
  z.object({ layout: z.literal("cover"), title, subtitle: slideText(90).optional(), imageBrief }),
  // 要点列表页。这一页有一个标题，正文在同一栏里逐条列出，每条前面有一个圆点 •
  z.object({ layout: z.literal("bullets"), title, points, imageBrief }),
  z.object({ layout: z.literal("two-columns"), title, left: column, right: column, imageBrief }),
  z.object({ layout: z.literal("summary"), title, points, closing: z.boolean().optional().catch(undefined), imageBrief }),
]);

function luminance(color: string) {
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: string, second: string) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const defaultPalette = { lightBackground: "F7F9FC", darkBackground: "142846", accent: "225AA5" };
const hexColor = z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/)
  .transform((color) => color.replace(/^#/, "").toUpperCase());
const paletteSchema = z.object({
  lightBackground: hexColor,
  darkBackground: hexColor,
  accent: hexColor,
}).refine(({ lightBackground, darkBackground }) =>
  luminance(lightBackground) >= 0.8 && luminance(darkBackground) <= 0.12,
).catch(defaultPalette);

export const presentationSchema = z.object({
  title: slideText(60),
  slides: z.array(slide),
  palette: paletteSchema,
});

type Presentation = z.infer<typeof presentationSchema>;
type SlideColors = { background: string; text: string; accent: string };

export function getSlideColors({ slides, palette }: Presentation): SlideColors[] {
  const { lightBackground, darkBackground, accent } = palette;
  return slides.map((page, index) => {
    const isCover = index === 0 && page.layout === "cover";
    const isClosing = index === slides.length - 1 && page.layout === "summary" &&
      page.closing && page.points.length === 1 && page.points[0].length <= 50;
    const useDarkBackground = slides.length > 1 && (isCover || isClosing);
    return {
      background: useDarkBackground ? darkBackground : lightBackground,
      text: useDarkBackground ? lightBackground : darkBackground,
      accent,
    };
  });
}

const imageBoxes = {
  cover: { x: 6.66, y: 0.6, w: 5.82, h: 6.3 },
  bullets: { x: 7.58, y: 1.94, w: 4.9, h: 4.9 },
  "two-columns": { x: 0.85, y: 1.73, w: 11.63, h: 2.22 },
  summary: { x: 7.58, y: 1.94, w: 4.9, h: 4.9 },
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
  { slides }: Pick<Presentation, "slides">,
  signal?: AbortSignal,
) {
  const images: ({ bytes: Buffer; fallback: boolean } | undefined)[] = new Array(slides.length);
  const configured = Boolean(process.env.DASHSCOPE_API_KEY?.trim() && process.env.DASHSCOPE_BASE_URL?.trim());
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < slides.length) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      const page = slides[index];
      if (!page.imageBrief) continue;

      const box = imageBoxes[page.layout];
      const width = Math.round(box.w * 135);
      const height = Math.round(box.h * 135);
      if (configured) {
        try {
          const aspectRatio = page.layout === "two-columns" ? "16:9" : "1:1";
          const composition = page.layout === "two-columns" ? "Keep the subject in the central horizontal band." : "";
          const prompt = `${page.imageBrief}. No text, captions, or presentation layout. ${composition}`;
          const image = await generateImageAsset(prompt, aspectRatio, signal);
          const bytes = await sharp(image).resize(width, height, { fit: "cover" }).jpeg({ quality: 87 }).toBuffer();
          images[index] = { bytes, fallback: false };
          continue;
        } catch (error) {
          signal?.throwIfAborted();
          console.warn("Presentation image unavailable:", error instanceof Error ? error.name : "UnknownError");
        }
      }
      images[index] = { bytes: await fallbackImage(width, height, index), fallback: true };
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, slides.length) }, worker));
  signal?.throwIfAborted();
  return images;
}

export async function renderPresentation(
  presentation: Presentation,
  slideColors: SlideColors[],
  images: Awaited<ReturnType<typeof preparePresentationImages>>,
) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = presentation.title;
  const textOptions = { fontFace: "Microsoft YaHei", margin: 0, valign: "middle", fit: "shrink" } as const;

  for (const [index, page] of presentation.slides.entries()) {
    const slide = pptx.addSlide();
    const colors = slideColors[index];
    slide.background = { color: colors.background };
    const image = images[index];
    if (image) {
      slide.addImage({
        data: `image/jpeg;base64,${image.bytes.toString("base64")}`,
        ...imageBoxes[page.layout],
        altText: image.fallback ? "装饰插图" : page.imageBrief ?? undefined,
      });
    }
    if (page.layout === "cover") {
      const width = image ? 5.4 : 11.6;
      slide.addText(page.title, {
        ...textOptions, x: 0.85, y: image || page.subtitle ? 1.52 : 2.48, w: width,
        h: 2.55, fontSize: 40, bold: true, color: colors.text,
      });
      if (page.subtitle) {
        slide.addText(page.subtitle, {
          ...textOptions, x: 0.85, y: 4.23, w: width, h: 1.45, fontSize: 20, color: colors.text,
        });
      }
      continue;
    }

    slide.addText(page.title, {
      ...textOptions, x: 0.85, y: 0.5, w: 11.6, h: 1.15, fontSize: 32, bold: true, color: colors.text,
    });

    if (page.layout === "two-columns") {
      const headingColor = contrastRatio(colors.accent, colors.background) >= 4.5 ? colors.accent : colors.text;
      const headingY = image ? 4.11 : 1.94;
      const pointSpacing = image ? 0.76 : 1.24;
      for (const [column, x] of [[page.left, 0.85], [page.right, 7.0]] as const) {
        slide.addText(column.heading, {
          ...textOptions, x, y: headingY, w: 5.4, h: 0.55, fontSize: 20, bold: true, color: headingColor,
        });
        column.points.forEach((point, index) => {
          slide.addText(point, {
            ...textOptions, x, y: headingY + 0.62 + pointSpacing * index, w: 5.4, h: pointSpacing - 0.02,
            fontSize: 17, color: colors.text, bullet: { indent: 17 },
          });
        });
      }
      continue;
    }

    page.points.forEach((point, index) => {
      slide.addText(point, {
        ...textOptions, x: 0.85, y: 1.94 + 1.24 * index, w: image ? 6.2 : 11.6, h: 1.17,
        fontSize: 20, color: colors.text, bullet: { indent: 19 },
      });
    });
  }

  const bytes = await pptx.write({ outputType: "nodebuffer" });
  if (!Buffer.isBuffer(bytes)) throw new TypeError("Expected PowerPoint output as a Node buffer.");

  // PptxGenJS 4.0.1 declares a slide master for each slide, but writes only one (issue #1444).
  const archive = await JSZip.loadAsync(bytes);
  const manifest = archive.file("[Content_Types].xml");
  if (!manifest) throw new Error("Missing PowerPoint content types.");
  const contentTypes = await manifest.async("string");
  archive.file("[Content_Types].xml", contentTypes.replace(
    /<Override PartName="\/(ppt\/slideMasters\/slideMaster\d+\.xml)"[^>]*\/>/g,
    (entry, masterPath: string) => archive.file(masterPath) ? entry : "",
  ));
  return new Uint8Array(await archive.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}
