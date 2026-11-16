import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import sharp, { type ResizeOptions, type Sharp } from "sharp";
import { z } from "zod";
import {
  hexColor, luminance, savedPaletteSchema, themeFont, themeStyleSchema, type FontPair, type ThemeStyle,
} from "./theme-generator";

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
export const imageDescriptionSchema = slideText(280);
const imageBrief = imageDescriptionSchema.nullish();
const metricSchema = z.object({ value: slideText(14), label: slideText(20), detail: slideText(60) });
const stepSchema = z.object({ marker: slideText(12).optional(), heading: slideText(14), detail: slideText(42) });
const imageFocusPoints = z.array(slideText(72)).min(1).max(2);
export const slideTextFields = {
  title,
  subtitle: slideText(90),
  points: z.array(slideText(90)).min(1).max(4),
  columnHeading: column.shape.heading,
  columnPoints: z.array(slideText(60)).min(1).max(3),
  metric: metricSchema.shape,
  step: stepSchema.shape,
  imageFocusPoints,
};
// 一整页幻灯片。根据 layout 决定这页需要哪些字段。
export const slideContentSchema = z.discriminatedUnion("layout", [
  z.object({ layout: z.literal("cover"), title, subtitle: slideText(90).optional(), imageBrief }),
  // 要点列表页。这一页有一个标题，正文在同一栏里逐条列出，每条前面有一个圆点 •
  z.object({ layout: z.literal("bullets"), title, points, imageBrief }),
  z.object({ layout: z.literal("two-columns"), title, left: column, right: column, imageBrief }),
  z.object({ layout: z.literal("summary"), title, points, closing: z.boolean().optional().catch(undefined), imageBrief }),
  z.object({ layout: z.literal("metrics"), title, metrics: z.array(metricSchema).min(1).max(3), imageBrief: z.null().optional() }),
  z.object({ layout: z.literal("steps"), title, steps: z.array(stepSchema).min(3).max(5), imageBrief: z.null().optional() }),
  z.object({ layout: z.literal("image-focus"), title, points: imageFocusPoints, imageBrief }),
]);

function contrastRatio(first: string, second: string) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export const textStyleSchema = z.strictObject({
  fontFace: slideText(100).optional(),
  fontSize: z.number().min(1).max(400).optional(),
  color: hexColor.optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(["left", "center", "right", "justify"]).optional(),
});
export const textElementKeySchema = z.enum([
  "title", "subtitle", "point1", "point2", "point3", "point4",
  "leftHeading", "leftPoint1", "leftPoint2", "leftPoint3",
  "rightHeading", "rightPoint1", "rightPoint2", "rightPoint3",
  ...([1, 2, 3] as const).flatMap((slot) => [`metric${slot}Value`, `metric${slot}Label`, `metric${slot}Detail`] as const),
  ...([1, 2, 3, 4, 5] as const).flatMap((slot) => [`step${slot}Marker`, `step${slot}Heading`, `step${slot}Detail`] as const),
]);
export type TextElementKey = z.infer<typeof textElementKeySchema>;
export const elementBoxSchema = z.strictObject({
  x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(),
});
export const imageFitSchema = z.enum(["cover", "contain"]);
const imagePositionSchema = z.enum(["centre", "right"]);
const imageLayoutSchema = z.object({ fullSlide: z.boolean(), gradient: z.boolean() });
export const slideNumberSchema = z.number().int().positive();
export const elementIdSchema = z.string().min(1).max(64);
export const addedTextSchema = slideText(500);
const addedTextDefinition = z.strictObject({
  type: z.literal("text"),
  text: addedTextSchema,
  box: elementBoxSchema,
  style: textStyleSchema.optional(),
});
const addedImageDefinition = z.strictObject({
  type: z.literal("image"),
  generatedImageId: z.uuid(),
  box: elementBoxSchema,
  description: imageDescriptionSchema.optional(),
  fit: imageFitSchema.optional(),
});
export const slideElementDefinitionSchema = z.discriminatedUnion("type", [
  addedTextDefinition, addedImageDefinition,
]);
const addedElementSchema = z.discriminatedUnion("type", [
  addedTextDefinition.extend({ id: z.uuid() }),
  addedImageDefinition.omit({ generatedImageId: true, box: true }).extend({ id: z.uuid() }),
]);
export type AddedSlideElement = z.infer<typeof addedElementSchema>;
export const presentationSchema = z.object({
  title: slideText(60),
  slides: z.array(slideContentSchema),
  palette: savedPaletteSchema,
  theme: themeStyleSchema.optional(),
});

export const maxSlideCount = 12;

export const presentationSourceSchema = presentationSchema.extend({
  slides: z.array(slideContentSchema.and(z.object({
    slideId: z.uuid(),
    // Preserve the original position-dependent styling when an existing slide is reordered.
    appearance: z.object({ firstSlide: z.boolean(), darkBackground: z.boolean() }).optional(),
    textStyles: z.partialRecord(textElementKeySchema, textStyleSchema).optional(),
    textBoxes: z.partialRecord(textElementKeySchema, elementBoxSchema).optional(),
    imageLayout: imageLayoutSchema.optional(),
    imageFit: z.object({ fit: imageFitSchema, position: imagePositionSchema }).optional(),
    addedElements: z.array(addedElementSchema).optional(),
    removedElementIds: z.array(elementIdSchema).optional(),
  }))).min(1).refine(
    (slides) => new Set(slides.map((page) => page.slideId)).size === slides.length,
  ),
});
export type PresentationSource = z.infer<typeof presentationSourceSchema>;
export type PresentationSlide = PresentationSource["slides"][number];
type SlideColors = { background: string; text: string; accent: string };

export function getSlideAppearance(page: PresentationSlide, index: number, slideCount: number) {
  const firstSlide = index === 0;
  const isCover = firstSlide && page.layout === "cover";
  const isClosing = index === slideCount - 1 && page.layout === "summary" &&
    page.closing === true && page.points.length === 1 && page.points[0].length <= 50;
  return page.appearance ?? { firstSlide, darkBackground: slideCount > 1 && (isCover || isClosing) };
}

export function getSlideColors({ slides, palette }: PresentationSource): SlideColors[] {
  const { lightBackground, darkBackground, accent } = palette;
  return slides.map((page, index) => {
    const { darkBackground: useDarkBackground } = getSlideAppearance(page, index, slides.length);
    return {
      background: useDarkBackground ? darkBackground : lightBackground,
      text: useDarkBackground ? lightBackground : darkBackground,
      accent,
    };
  });
}

// LAYOUT_WIDE measures 13⅓ × 7½ inches.
export const slideSize = { w: 40 / 3, h: 7.5 };
export function isOnSlide({ x, y, w, h }: ElementBox) {
  const tolerance = 1e-4;
  return x >= 0 && y >= 0 && x + w <= slideSize.w + tolerance && y + h <= slideSize.h + tolerance;
}
const firstSlideTextWidth = 6.2;
const pageNumberBox = { x: slideSize.w - 1.2, y: 7.05, w: 0.85, h: 0.27 };

export type ElementBox = z.infer<typeof elementBoxSchema>;
export type PresentationImage = { slideId: string; bytes: Uint8Array<ArrayBuffer>; box: ElementBox; fallback: boolean };

export function templateElementId(slideId: string, key: TextElementKey | "image") {
  return `${slideId}:${key}`;
}

export function getSlideImageLayout(page: PresentationSlide, box?: ElementBox) {
  return page.imageLayout ?? {
    fullSlide: box?.w === slideSize.w && box.h === slideSize.h,
    gradient: box?.y === 0 && box.h === slideSize.h,
  };
}

export function imagePixelSize({ w, h }: PresentationImage["box"]) {
  return { width: Math.round(w * 135), height: Math.round(h * 135) };
}

export async function fitPresentationImage(
  image: Sharp,
  box: PresentationImage["box"],
  options: Pick<ResizeOptions, "fit" | "position" | "background">,
) {
  const { width, height } = imagePixelSize(box);
  return new Uint8Array(await image.resize({ width, height, ...options }).jpeg({ quality: 87 }).toBuffer());
}

export function imageNeedsUpscaling(
  box: PresentationImage["box"],
  dimensions: { width: number; height: number },
  fit: "cover" | "contain",
) {
  const { width, height } = imagePixelSize(box);
  const scales = [width / dimensions.width, height / dimensions.height];
  const scale = fit === "contain" ? Math.min(...scales) : Math.max(...scales);
  return scale > 1.5;
}

type SlideTextElement = {
  key: TextElementKey;
  text: string;
  box: ElementBox;
  style: z.infer<typeof textStyleSchema>;
  font?: FontPair;
  explicitFont?: string;
  bullet?: { indent: number };
};

function getSlideTextElements(
  page: PresentationSlide,
  colors: SlideColors,
  index: number,
  imageBox?: ElementBox,
  theme?: ThemeStyle,
): SlideTextElement[] {
  const elements: SlideTextElement[] = [];
  const hasFirstSlideImage = (page.appearance?.firstSlide ?? index === 0) && Boolean(imageBox);
  function add(
    key: TextElementKey,
    text: string,
    box: ElementBox,
    style: SlideTextElement["style"],
    bullet?: SlideTextElement["bullet"],
  ) {
    if (page.removedElementIds?.includes(templateElementId(page.slideId, key))) return;
    const override = page.textStyles?.[key];
    const font = resolveFont(override?.fontFace, theme, key === "title" ? "title" : "body");
    elements.push({
      key, text, box: page.textBoxes?.[key] ?? box,
      style: { fontFace: "Arial", color: colors.text, ...style, ...override, ...(font && { fontFace: font.latin }) },
      font,
      explicitFont: override?.fontFace,
      bullet,
    });
  }

  if (page.layout === "cover") {
    const width = hasFirstSlideImage ? firstSlideTextWidth : imageBox ? 5.4 : 11.6;
    add("title", page.title,
      { x: 0.85, y: imageBox || page.subtitle ? 1.52 : 2.48, w: width, h: 2.55 },
      { fontFace: "Georgia", bold: true, fontSize: 40 });
    if (page.subtitle) {
      add("subtitle", page.subtitle,
        { x: 0.85, y: 4.23, w: width, h: 1.45 }, { fontSize: 20 });
    }
    return elements;
  }

  add("title", page.title,
    { x: 0.85, y: 0.5, w: hasFirstSlideImage && page.layout !== "image-focus" ? firstSlideTextWidth : 11.6, h: 1.15 },
    { fontFace: "Georgia", bold: true, fontSize: 32 });
  const accentText = contrastRatio(colors.accent, colors.background) >= 4.5 ? colors.accent : colors.text;
  if (page.layout === "metrics") {
    const count = page.metrics.length;
    const gap = 0.5;
    const width = (11.6 - gap * (count - 1)) / count;
    page.metrics.forEach(({ value, label, detail }, index) => {
      const slot = (index + 1) as 1 | 2 | 3;
      const x = 0.85 + index * (width + gap);
      add(`metric${slot}Value`, value, { x, y: 2.1, w: width, h: 1.25 },
        { fontSize: count === 1 ? 64 : 46, bold: true, color: accentText, align: "center" });
      add(`metric${slot}Label`, label, { x, y: 3.5, w: width, h: 0.8 },
        { fontSize: 22, bold: true, align: "center" });
      add(`metric${slot}Detail`, detail, { x, y: 4.45, w: width, h: 1.55 },
        { fontSize: 17, align: "center" });
    });
  } else if (page.layout === "steps") {
    const gap = 0.35;
    const width = (11.6 - gap * (page.steps.length - 1)) / page.steps.length;
    const markerWidth = 1.55;
    page.steps.forEach(({ marker, heading, detail }, index) => {
      const slot = (index + 1) as 1 | 2 | 3 | 4 | 5;
      const x = 0.85 + index * (width + gap);
      add(`step${slot}Marker`, marker ?? String(slot), { x: x + (width - markerWidth) / 2, y: 2.04, w: markerWidth, h: 0.65 },
        { fontSize: 20, bold: true, color: accentText, align: "center" });
      add(`step${slot}Heading`, heading, { x, y: 2.91, w: width, h: 0.88 },
        { fontSize: 20, bold: true, align: "center" });
      add(`step${slot}Detail`, detail, { x, y: 3.95, w: width, h: 1.75 }, { fontSize: 17, align: "center" });
    });
  } else if (page.layout === "image-focus") {
    page.points.forEach((point, index) => {
      add(`point${(index + 1) as 1 | 2}`, point,
        imageBox
          ? { x: 9, y: 2.12 + 1.9 * index, w: 3.45, h: 1.75 }
          : { x: 0.85, y: 1.94 + 1.4 * index, w: 11.6, h: 1.27 },
        { fontSize: 20 }, { indent: 19 });
    });
  } else if (page.layout === "two-columns") {
    const { fullSlide } = getSlideImageLayout(page, imageBox);
    const headingColor = fullSlide ? colors.text : accentText;
    const hasImageAboveColumns = imageBox && !hasFirstSlideImage;
    const headingY = hasImageAboveColumns ? 4.11 : 1.94;
    const pointSpacing = hasImageAboveColumns ? 0.76 : 1.24;
    const columnGap = 0.4;
    const columnWidth = hasFirstSlideImage ? (firstSlideTextWidth - columnGap) / 2 : 5.4;
    const rightColumnX = hasFirstSlideImage ? 0.85 + columnWidth + columnGap : 7.0;
    for (const [side, x] of [["left", 0.85], ["right", rightColumnX]] as const) {
      const column = page[side];
      add(`${side}Heading`, column.heading,
        { x, y: headingY, w: columnWidth, h: 0.55 },
        { fontSize: 20, bold: true, color: headingColor });
      column.points.forEach((point, index) => {
        add(`${side}Point${index + 1}` as TextElementKey, point,
          { x, y: headingY + 0.62 + pointSpacing * index, w: columnWidth, h: pointSpacing - 0.02 },
          { fontSize: 17 }, { indent: 17 });
      });
    }
  } else {
    page.points.forEach((point, index) => {
      add(`point${index + 1}` as TextElementKey, point,
        { x: 0.85, y: 1.94 + 1.24 * index, w: imageBox ? firstSlideTextWidth : 11.6, h: 1.17 },
        { fontSize: 20 }, { indent: 19 });
    });
  }
  return elements;
}

function resolveFont(explicit: string | undefined, theme: ThemeStyle | undefined, role: "title" | "body") {
  if (explicit) return { latin: explicit, eastAsian: explicit };
  return theme ? themeFont(theme, role) : undefined;
}

type SlideElement =
  | ({ type: "text"; id: string; templateKey?: TextElementKey }
    & Omit<SlideTextElement, "key">)
  | { type: "image"; id: string; templateKey?: "image"; box: ElementBox; description?: string; fit: "cover" | "contain" };

export function getSlideElements(
  page: PresentationSlide,
  colors: SlideColors,
  index: number,
  images: ReadonlyMap<string, Pick<PresentationImage, "box">>,
  theme?: ThemeStyle,
): SlideElement[] {
  const imageId = templateElementId(page.slideId, "image");
  const image = page.removedElementIds?.includes(imageId) ? undefined : images.get(imageId);
  const elements: SlideElement[] = getSlideTextElements(page, colors, index, image?.box, theme)
    .map(({ key, ...element }) => ({
      ...element, type: "text", id: templateElementId(page.slideId, key), templateKey: key,
    }));
  if (image) {
    elements.unshift({
      type: "image", id: imageId, templateKey: "image", box: image.box,
      description: page.imageBrief ?? undefined, fit: page.imageFit?.fit ?? (page.layout === "image-focus" ? "contain" : "cover"),
    });
  }
  for (const element of page.addedElements ?? []) {
    if (element.type === "text") {
      const font = resolveFont(element.style?.fontFace, theme, "body");
      elements.push({
        ...element, font, explicitFont: element.style?.fontFace,
        style: { fontFace: font?.latin ?? "Arial", color: colors.text, fontSize: 20, ...element.style },
      });
    } else {
      const asset = images.get(element.id);
      if (asset) elements.push({ ...element, box: asset.box, fit: element.fit ?? "cover" });
    }
  }
  return elements;
}

export function describeSlideElement(element: SlideElement) {
  if (element.type === "image") {
    const { id, type, box, description, fit } = element;
    return { id, type, box, description, fit };
  }
  const { id, type, box, text, style } = element;
  return { id, type, box, text, style };
}

// DrawingML alpha represents opacity in thousandths of a percent.
const imageGradientFill = '<a:gradFill rotWithShape="1"><a:gsLst>' +
  '<a:gs pos="0"><a:srgbClr val="000000"><a:alpha val="70000"/></a:srgbClr></a:gs>' +
  '<a:gs pos="100000"><a:srgbClr val="000000"><a:alpha val="0"/></a:srgbClr></a:gs>' +
  '</a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>';

export async function renderPresentation(
  presentation: PresentationSource,
  slideColors: SlideColors[],
  images: ReadonlyMap<string, PresentationImage>,
) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = presentation.title;
  const textOptions = { fontFace: "Arial", margin: 0, valign: "middle", fit: "shrink" } as const;
  const slidesWithGradient = new Set<string>();
  const customFonts = new Map<string, FontPair>();

  function customFontFace(font: FontPair) {
    // PptxGenJS inserts font names into XML attributes without escaping them.
    const token = `PptxCustomFont${customFonts.size}`;
    const escape = (name: string) => name.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    customFonts.set(token, { latin: escape(font.latin), eastAsian: escape(font.eastAsian) });
    return token;
  }

  for (const [index, page] of presentation.slides.entries()) {
    const slide = pptx.addSlide();
    const colors = slideColors[index];
    slide.background = { color: colors.background };
    const elements = getSlideElements(page, colors, index, images, presentation.theme);
    const imageElements = elements.filter((element) => element.type === "image");
    for (const element of imageElements) {
      const image = images.get(element.id)!;
      const fit = element.templateKey ? page.imageFit : { fit: element.fit, position: "centre" as const };
      const bytes = fit
        ? await fitPresentationImage(sharp(image.bytes, { limitInputPixels: 16_000_000 }), image.box, {
          ...fit,
          background: `#${presentation.palette.lightBackground}`,
        })
        : image.bytes;
      slide.addImage({
        data: `image/jpeg;base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`,
        objectName: element.templateKey ?? element.id,
        ...image.box,
        altText: image.fallback ? "装饰插图" : element.description,
      });
      if (element.templateKey && getSlideImageLayout(page, image.box).gradient) {
        slide.addShape(pptx.ShapeType.rect, {
          ...image.box,
          objectName: "渐变遮罩",
          line: { transparency: 100 },
        });
        slidesWithGradient.add(`ppt/slides/slide${index + 1}.xml`);
      }
    }
    if (page.layout === "steps") {
      const markers = elements.filter((element) => element.type === "text" && /^step\dMarker$/.test(element.templateKey ?? ""));
      const color = contrastRatio(colors.accent, colors.background) >= 3 ? colors.accent : colors.text;
      for (const [index, marker] of markers.slice(1).entries()) {
        const from = markers[index].box;
        const to = marker.box;
        const x = from.x + from.w + 0.08;
        const y = from.y + from.h / 2;
        const w = to.x - x - 0.08;
        if (w <= 0 || Math.abs(y - to.y - to.h / 2) > 0.02) continue;
        slide.addShape(pptx.ShapeType.line, { x, y, w, h: 0, line: { color, width: 1 } });
      }
    }
    const imageOverlapsPageNumber = imageElements.some(({ box }) =>
      box.x < pageNumberBox.x + pageNumberBox.w && box.x + box.w > pageNumberBox.x &&
      box.y < pageNumberBox.y + pageNumberBox.h && box.y + box.h > pageNumberBox.y);
    slide.addText(`${index + 1} / ${presentation.slides.length}`, {
      ...textOptions, ...pageNumberBox, objectName: "页码", align: "right", fontSize: 10, margin: [0, 5, 0, 5],
      color: imageOverlapsPageNumber ? presentation.palette.lightBackground : colors.text,
      fill: imageOverlapsPageNumber ? { color: presentation.palette.darkBackground } : undefined,
      ...(presentation.theme && { fontFace: customFontFace(themeFont(presentation.theme, "body")) }),
    });

    for (const element of elements) {
      if (element.type !== "text") continue;
      const { text, box, style, bullet, font, templateKey, id } = element;
      slide.addText(text, {
        ...textOptions, ...box, ...style,
        fontFace: font ? customFontFace(font) : style.fontFace,
        objectName: templateKey ?? id, bullet,
      });
    }
  }

  const bytes = await pptx.write({ outputType: "nodebuffer" });
  if (!Buffer.isBuffer(bytes)) throw new TypeError("Expected PowerPoint output as a Node buffer.");

  const archive = await JSZip.loadAsync(bytes);
  await Promise.all(archive.file(/^ppt\/slides\/slide\d+\.xml$/).map(async (part) => {
    // Keep legacy East Asian defaults and resolve per-script fonts for themed and edited text.
    let xml = (await part.async("string"))
      .replaceAll('<a:ea typeface="Georgia"', '<a:ea typeface="Songti SC"')
      .replaceAll('<a:ea typeface="Arial"', '<a:ea typeface="Microsoft YaHei"')
      .replace(/<a:(latin|ea|cs) typeface="(PptxCustomFont\d+)"/g, (match, script: string, token: string) => {
        const font = customFonts.get(token);
        return font ? `<a:${script} typeface="${script === "ea" ? font.eastAsian : font.latin}"` : match;
      });
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
