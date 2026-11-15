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
export const slideTextFields = {
  title,
  subtitle: slideText(90),
  points: z.array(slideText(90)).min(1).max(4),
  columnHeading: column.shape.heading,
  columnPoints: z.array(slideText(60)).min(1).max(3),
};
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
export const textStyleSchema = z.strictObject({
  fontFace: slideText(100).optional(),
  fontSize: z.number().min(1).max(400).optional(),
  color: hexColor.optional(),
});
const textStylesSchema = z.record(z.string().regex(/^(title|subtitle|point[1-4]|(left|right)(Heading|Point[1-3]))$/), textStyleSchema);
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
export const presentationSourceSchema = presentationSchema.extend({
  slides: z.array(slide.and(z.object({ slideId: z.uuid(), textStyles: textStylesSchema.optional() }))).min(1).refine(
    (slides) => new Set(slides.map((page) => page.slideId)).size === slides.length,
  ),
});
export type PresentationSource = z.infer<typeof presentationSourceSchema>;
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

// LAYOUT_WIDE measures 13⅓ × 7½ inches.
const fullSlideImageBox = { x: 0, y: 0, w: 40 / 3, h: 7.5 };
const firstSlideSideImageBox = { x: 7.5, y: 0, w: fullSlideImageBox.w - 7.5, h: fullSlideImageBox.h };
const firstSlideTextWidth = 6.2;
const pageNumberBox = { x: fullSlideImageBox.w - 1.2, y: 7.05, w: 0.85, h: 0.27 };

const imageBoxes = {
  cover: { x: 6.66, y: 0.6, w: 5.82, h: 6.3 },
  bullets: { x: 7.58, y: 1.94, w: 4.9, h: 4.9 },
  "two-columns": { x: 0.85, y: 1.73, w: 11.63, h: 2.22 },
  summary: { x: 7.58, y: 1.94, w: 4.9, h: 4.9 },
} as const;

export const imageBoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() });
export type PresentationImage = { bytes: Uint8Array<ArrayBuffer>; box: z.infer<typeof imageBoxSchema>; fallback: boolean };

async function fallbackImage(width: number, height: number, index: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 1000" preserveAspectRatio="none">
    <rect width="1000" height="1000" fill="#F4F4F5"/>
    <circle cx="${260 + (index % 4) * 135}" cy="425" r="158" fill="#D4D4D8"/>
    <path d="M0 690 Q250 320 540 645 T1000 584 V1000 H0 Z" fill="#A1A1AA"/>
    <path d="M0 825 Q300 585 670 804 T1000 758 V1000 H0 Z" fill="#71717A"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 86 }).toBuffer();
}

// DrawingML alpha represents opacity in thousandths of a percent.
const imageGradientFill = '<a:gradFill rotWithShape="1"><a:gsLst>' +
  '<a:gs pos="0"><a:srgbClr val="000000"><a:alpha val="70000"/></a:srgbClr></a:gs>' +
  '<a:gs pos="100000"><a:srgbClr val="000000"><a:alpha val="0"/></a:srgbClr></a:gs>' +
  '</a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>';

export async function preparePresentationImages(
  { slides }: Pick<PresentationSource, "slides">,
  signal?: AbortSignal,
) {
  const images = new Map<string, PresentationImage>();
  const configured = Boolean(process.env.DASHSCOPE_API_KEY?.trim() && process.env.DASHSCOPE_BASE_URL?.trim());
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < slides.length) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      const page = slides[index];
      if (!page.imageBrief) continue;

      const isFirstSlide = index === 0;
      const sideOrContentBox = isFirstSlide ? firstSlideSideImageBox : imageBoxes[page.layout];
      if (configured) {
        try {
          const aspectRatio = isFirstSlide || page.layout === "two-columns" ? "16:9" : "1:1";
          const composition = isFirstSlide
            ? "Use a wide landscape composition. Place the main subject on the right and keep the left visually quiet."
            : page.layout === "two-columns" ? "Keep the subject in the central horizontal band." : "";
          const prompt = `${page.imageBrief}. No text, captions, or presentation layout. ${composition}`;
          const image = await generateImageAsset(prompt, aspectRatio, signal);
          const source = sharp(image);
          let box = sideOrContentBox;
          if (isFirstSlide) {
            const { width, height } = await source.metadata();
            const slideAspect = fullSlideImageBox.w / fullSlideImageBox.h;
            // Allow minor provider rounding (e.g. 1696 × 960 for a 16:9 request).
            if (Math.abs(width / height / slideAspect - 1) <= 0.02) box = fullSlideImageBox;
          }
          const bytes = await source.resize(Math.round(box.w * 135), Math.round(box.h * 135), {
            fit: "cover",
            position: isFirstSlide && box === firstSlideSideImageBox ? "right" : "centre",
          }).jpeg({ quality: 87 }).toBuffer();
          images.set(page.slideId, { bytes: new Uint8Array(bytes), box, fallback: false });
          continue;
        } catch (error) {
          signal?.throwIfAborted();
          console.warn("Presentation image unavailable:", error instanceof Error ? error.name : "UnknownError");
        }
      }
      const { w, h } = sideOrContentBox;
      const bytes = await fallbackImage(Math.round(w * 135), Math.round(h * 135), index);
      images.set(page.slideId, { bytes: new Uint8Array(bytes), box: sideOrContentBox, fallback: true });
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, slides.length) }, worker));
  signal?.throwIfAborted();
  return images;
}

export async function renderPresentation(
  presentation: PresentationSource,
  slideColors: SlideColors[],
  images: ReadonlyMap<string, PresentationImage>,
) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = presentation.title;
  const textOptions = { fontFace: "Arial", margin: 0, valign: "middle", fit: "shrink" } as const;
  const titleOptions = { ...textOptions, fontFace: "Georgia", bold: true } as const;
  const slidesWithGradient = new Set<string>();
  const customFonts = new Map<string, string>();

  function textStyle(style: z.infer<typeof textStyleSchema> | undefined) {
    if (!style?.fontFace) return style;
    // PptxGenJS inserts font names into XML attributes without escaping them.
    const { fontFace, ...options } = style;
    const token = `PptxCustomFont${customFonts.size}`;
    customFonts.set(token, fontFace.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    return { ...options, fontFace: token };
  }

  for (const [index, page] of presentation.slides.entries()) {
    const slide = pptx.addSlide();
    const colors = slideColors[index];
    slide.background = { color: colors.background };
    const image = images.get(page.slideId);
    const hasFirstSlideImage = index === 0 && Boolean(image);
    const hasFullSlideImage = image?.box.w === fullSlideImageBox.w && image.box.h === fullSlideImageBox.h;
    if (image) {
      slide.addImage({
        data: `image/jpeg;base64,${Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString("base64")}`,
        ...image.box,
        altText: image.fallback ? "装饰插图" : page.imageBrief ?? undefined,
      });
      if (image.box.y === 0 && image.box.h === fullSlideImageBox.h) {
        slide.addShape(pptx.ShapeType.rect, {
          ...image.box,
          objectName: "渐变遮罩",
          line: { transparency: 100 },
        });
        slidesWithGradient.add(`ppt/slides/slide${index + 1}.xml`);
      }
    }
    const imageOverlapsPageNumber = image &&
      image.box.x < pageNumberBox.x + pageNumberBox.w && image.box.x + image.box.w > pageNumberBox.x &&
      image.box.y < pageNumberBox.y + pageNumberBox.h && image.box.y + image.box.h > pageNumberBox.y;
    slide.addText(`${index + 1} / ${presentation.slides.length}`, {
      ...textOptions, ...pageNumberBox, objectName: "页码", align: "right", fontSize: 10, margin: [0, 5, 0, 5],
      color: imageOverlapsPageNumber ? presentation.palette.lightBackground : colors.text,
      fill: imageOverlapsPageNumber ? { color: presentation.palette.darkBackground } : undefined,
    });

    if (page.layout === "cover") {
      const width = hasFirstSlideImage ? firstSlideTextWidth : image ? 5.4 : 11.6;
      slide.addText(page.title, {
        ...titleOptions, x: 0.85, y: image || page.subtitle ? 1.52 : 2.48, w: width,
        h: 2.55, fontSize: 40, color: colors.text, ...textStyle(page.textStyles?.title),
      });
      if (page.subtitle) {
        slide.addText(page.subtitle, {
          ...textOptions, x: 0.85, y: 4.23, w: width, h: 1.45, fontSize: 20, color: colors.text,
          ...textStyle(page.textStyles?.subtitle),
        });
      }
      continue;
    }

    slide.addText(page.title, {
      ...titleOptions, x: 0.85, y: 0.5, w: hasFirstSlideImage ? firstSlideTextWidth : 11.6,
      h: 1.15, fontSize: 32, color: colors.text, ...textStyle(page.textStyles?.title),
    });

    if (page.layout === "two-columns") {
      const headingColor = !hasFullSlideImage && contrastRatio(colors.accent, colors.background) >= 4.5
        ? colors.accent : colors.text;
      const hasImageAboveColumns = image && !hasFirstSlideImage;
      const headingY = hasImageAboveColumns ? 4.11 : 1.94;
      const pointSpacing = hasImageAboveColumns ? 0.76 : 1.24;
      const columnGap = 0.4;
      const columnWidth = hasFirstSlideImage ? (firstSlideTextWidth - columnGap) / 2 : 5.4;
      const rightColumnX = hasFirstSlideImage ? 0.85 + columnWidth + columnGap : 7.0;
      for (const [side, x] of [["left", 0.85], ["right", rightColumnX]] as const) {
        const column = page[side];
        slide.addText(column.heading, {
          ...textOptions, x, y: headingY, w: columnWidth, h: 0.55, fontSize: 20, bold: true, color: headingColor,
          ...textStyle(page.textStyles?.[`${side}Heading`]),
        });
        column.points.forEach((point, index) => {
          slide.addText(point, {
            ...textOptions, x, y: headingY + 0.62 + pointSpacing * index, w: columnWidth, h: pointSpacing - 0.02,
            fontSize: 17, color: colors.text, bullet: { indent: 17 },
            ...textStyle(page.textStyles?.[`${side}Point${index + 1}`]),
          });
        });
      }
      continue;
    }

    page.points.forEach((point, index) => {
      slide.addText(point, {
        ...textOptions, x: 0.85, y: 1.94 + 1.24 * index, w: image ? firstSlideTextWidth : 11.6, h: 1.17,
        fontSize: 20, color: colors.text, bullet: { indent: 19 }, ...textStyle(page.textStyles?.[`point${index + 1}`]),
      });
    });
  }

  const bytes = await pptx.write({ outputType: "nodebuffer" });
  if (!Buffer.isBuffer(bytes)) throw new TypeError("Expected PowerPoint output as a Node buffer.");

  const archive = await JSZip.loadAsync(bytes);
  await Promise.all(archive.file(/^ppt\/slides\/slide\d+\.xml$/).map(async (part) => {
    // Keep the template's East Asian defaults and apply explicit fonts to all scripts.
    let xml = (await part.async("string"))
      .replaceAll('<a:ea typeface="Georgia"', '<a:ea typeface="Songti SC"')
      .replaceAll('<a:ea typeface="Arial"', '<a:ea typeface="Microsoft YaHei"')
      .replace(/(<a:(?:latin|ea|cs) typeface=")(PptxCustomFont\d+)"/g,
        (match, prefix: string, token: string) => customFonts.has(token) ? `${prefix}${customFonts.get(token)}"` : match);
    if (slidesWithGradient.has(part.name)) {
      // PptxGenJS cannot set a gradient fill on a shape through its public API.
      const maskFill = /(<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="渐变遮罩">[\s\S]*?<\/a:prstGeom>)<a:noFill\/>/;
      if (!maskFill.test(xml)) throw new Error("Missing PowerPoint gradient mask shape.");
      xml = xml.replace(maskFill, (_, shape: string) => shape + imageGradientFill);
    }
    archive.file(part.name, xml);
  }));

  // PptxGenJS 4.0.1 declares a slide master for each slide, but writes only one (issue #1444).
  const manifest = archive.file("[Content_Types].xml");
  if (!manifest) throw new Error("Missing PowerPoint content types.");
  const contentTypes = await manifest.async("string");
  archive.file("[Content_Types].xml", contentTypes.replace(
    /<Override PartName="\/(ppt\/slideMasters\/slideMaster\d+\.xml)"[^>]*\/>/g,
    (entry, masterPath: string) => archive.file(masterPath) ? entry : "",
  ));
  return new Uint8Array(await archive.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}
