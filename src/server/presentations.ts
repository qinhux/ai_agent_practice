import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import sharp, { type ResizeOptions, type Sharp } from "sharp";
import { z } from "zod";
import {
  backgroundModeSchema, contrastRatio, hexColor, legacyPaletteSchema, legacyStyleSchema,
  themeFont, themeSpecSchema, upgradeLegacyTheme, type FontPair, type ThemeSpec,
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
export const imageSlotSchema = z.enum(["image", "leftImage", "rightImage"]);
export type ImageSlot = z.infer<typeof imageSlotSchema>;
const imageBriefs = z.partialRecord(imageSlotSchema, imageDescriptionSchema).optional();
const imageCaption = slideText(80);
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
  imageCaption,
};
// 一整页幻灯片。根据 layout 决定这页需要哪些字段。
const slideFields = { title, backgroundMode: backgroundModeSchema.optional(), imageBriefs };
const slideLayoutSchema = z.discriminatedUnion("layout", [
  z.object({ layout: z.literal("cover"), ...slideFields, subtitle: slideText(90).optional(), imageBrief }),
  // 要点列表页。这一页有一个标题，正文在同一栏里逐条列出，每条前面有一个圆点 •
  z.object({ layout: z.literal("bullets"), ...slideFields, points, imageBrief }),
  z.object({ layout: z.literal("two-columns"), ...slideFields, left: column, right: column, imageBrief }),
  z.object({ layout: z.literal("summary"), ...slideFields, points, closing: z.boolean().optional().catch(undefined), imageBrief }),
  z.object({ layout: z.literal("metrics"), ...slideFields, metrics: z.array(metricSchema).min(1).max(3), imageBrief: z.null().optional() }),
  z.object({ layout: z.literal("steps"), ...slideFields, steps: z.array(stepSchema).min(3).max(5), imageBrief: z.null().optional() }),
  z.object({ layout: z.literal("image-focus"), ...slideFields, points: imageFocusPoints, imageBrief }),
  z.object({ layout: z.literal("image-comparison"), ...slideFields, leftCaption: imageCaption, rightCaption: imageCaption }),
]);

type ImageSlotSpec = { id: ImageSlot; required: boolean; fit: "cover" | "contain" };
const optionalImage = [{ id: "image", required: false, fit: "cover" }] as const;
const slideImageSlots = {
  cover: optionalImage,
  bullets: optionalImage,
  "two-columns": optionalImage,
  summary: optionalImage,
  metrics: [],
  steps: [],
  "image-focus": [{ id: "image", required: true, fit: "contain" }],
  "image-comparison": [
    { id: "leftImage", required: true, fit: "cover" },
    { id: "rightImage", required: true, fit: "cover" },
  ],
} satisfies Record<z.infer<typeof slideLayoutSchema>["layout"], readonly ImageSlotSpec[]>;

export function getSlideImageSlots(layout: keyof typeof slideImageSlots): readonly ImageSlotSpec[] {
  return slideImageSlots[layout];
}

export const slideContentSchema = slideLayoutSchema.refine(
  (page) => Object.keys(page.imageBriefs ?? {}).every((id) => getSlideImageSlots(page.layout).some((slot) => slot.id === id)),
  { path: ["imageBriefs"], message: "配图描述包含该版式不支持的槽位。" },
);

export function getSlideImageBrief(page: z.infer<typeof slideContentSchema>, slot: ImageSlot) {
  return page.imageBriefs?.[slot] ?? (slot === "image" && "imageBrief" in page ? page.imageBrief : undefined);
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
  "leftCaption", "rightCaption",
  ...([1, 2, 3] as const).flatMap((slot) => [`metric${slot}Value`, `metric${slot}Label`, `metric${slot}Detail`] as const),
  ...([1, 2, 3, 4, 5] as const).flatMap((slot) => [`step${slot}Marker`, `step${slot}Heading`, `step${slot}Detail`] as const),
]);
export type TextElementKey = z.infer<typeof textElementKeySchema>;
export const elementBoxSchema = z.strictObject({
  x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(),
});
export const imageFitSchema = z.enum(["cover", "contain"]);
const imagePositionSchema = z.enum(["centre", "right"]);
const imageFitOverrideSchema = z.object({ fit: imageFitSchema, position: imagePositionSchema });
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
export const presentationTitleSchema = slideText(60);

export const maxSlideCount = 12;

const presentationPagesSchema = z.object({
  title: presentationTitleSchema,
  slides: z.array(slideContentSchema.and(z.object({
    slideId: z.uuid(),
    // Preserve the original position-dependent styling when an existing slide is reordered.
    appearance: z.object({ firstSlide: z.boolean(), darkBackground: z.boolean() }).optional(),
    textStyles: z.partialRecord(textElementKeySchema, textStyleSchema).optional(),
    textBoxes: z.partialRecord(textElementKeySchema, elementBoxSchema).optional(),
    imageLayout: imageLayoutSchema.optional(),
    imageFit: imageFitOverrideSchema.optional(),
    imageSlotFits: z.partialRecord(imageSlotSchema.exclude(["image"]), imageFitOverrideSchema).optional(),
    addedElements: z.array(addedElementSchema).optional(),
    removedElementIds: z.array(elementIdSchema).optional(),
  }))).min(1).refine(
    (slides) => new Set(slides.map((page) => page.slideId)).size === slides.length,
  ),
});
const themedPresentationSchema = presentationPagesSchema.extend({
  theme: themeSpecSchema,
  legacyLayout: z.literal(true).optional(),
});
export const presentationSourceSchema = z.union([
  themedPresentationSchema,
  presentationPagesSchema.extend({ palette: legacyPaletteSchema, theme: legacyStyleSchema })
    .transform(({ palette, theme, ...source }) => ({
      ...source, theme: upgradeLegacyTheme(palette, theme), legacyLayout: true as const,
    })),
]);
export type PresentationSource = z.infer<typeof presentationSourceSchema>;
export type PresentationSlide = PresentationSource["slides"][number];
type SlideColors = { background: string; text: string; accent: string };

export function getSlideAppearance(page: PresentationSlide, index: number, slideCount: number) {
  const firstSlide = index === 0;
  const isCover = firstSlide && page.layout === "cover";
  const isClosing = index === slideCount - 1 && page.layout === "summary" &&
    page.closing === true && page.points.length === 1 && page.points[0].length <= 50;
  return {
    firstSlide: page.appearance?.firstSlide ?? firstSlide,
    darkBackground: page.backgroundMode === undefined
      ? page.appearance?.darkBackground ?? (slideCount > 1 && (isCover || isClosing))
      : page.backgroundMode === "dark",
  };
}

export function getSlideColors({ slides, theme }: PresentationSource): SlideColors[] {
  const { modes, accent } = theme.colors;
  return slides.map((page, index) => {
    const { darkBackground: useDarkBackground } = getSlideAppearance(page, index, slides.length);
    return { ...modes[useDarkBackground ? "dark" : "light"], accent };
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

type PresentationLayout = Pick<PresentationSource, "theme" | "legacyLayout">;

export function getSlideGrid({ pageMargin, columnGap, columns }: ThemeSpec["grid"]) {
  const margin = pageMargin / 72;
  const gap = columnGap / 72;
  const width = slideSize.w - 2 * margin;
  const columnWidth = (width - (columns - 1) * gap) / columns;
  return {
    margin, gap, width,
    column: (start: number, span: number) => ({
      x: margin + start * (columnWidth + gap),
      w: span * columnWidth + (span - 1) * gap,
    }),
  };
}

export function getSlideContentTop(theme: ThemeSpec) {
  return 1.65 + theme.spacing.elementGap / 72;
}

export type ElementBox = z.infer<typeof elementBoxSchema>;
export type PresentationImage = { slideId: string; bytes: Uint8Array<ArrayBuffer>; box: ElementBox; fallback: boolean };

export function templateElementId(slideId: string, key: TextElementKey | ImageSlot) {
  return `${slideId}:${key}`;
}

export function getSlideImageFit(page: PresentationSlide, slot: ImageSlot) {
  return slot === "image" ? page.imageFit : page.imageSlotFits?.[slot];
}

export function setSlideImageBrief(page: PresentationSlide, slot: ImageSlot, description?: string): PresentationSlide {
  if (slot === "image" && !page.imageBriefs && "imageBrief" in page && page.layout !== "metrics" && page.layout !== "steps") {
    return { ...page, imageBrief: description };
  }
  const imageBriefs = { ...page.imageBriefs };
  if (description === undefined) delete imageBriefs[slot];
  else imageBriefs[slot] = description;
  const updated = { ...page, imageBriefs };
  if (slot === "image" && "imageBrief" in updated) delete updated.imageBrief;
  return updated;
}

export function getComparisonImageBox(theme: ThemeSpec, slot: Exclude<ImageSlot, "image">): ElementBox {
  return { ...getSlideGrid(theme.grid).column(slot === "leftImage" ? 0 : 6, 6), y: getSlideContentTop(theme), h: 3.4 };
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
  imageBox: ElementBox | undefined,
  { theme, legacyLayout }: PresentationLayout,
  hasComparisonImage: boolean,
): SlideTextElement[] {
  const elements: SlideTextElement[] = [];
  const hasFirstSlideImage = (page.appearance?.firstSlide ?? index === 0) && Boolean(imageBox);
  const grid = getSlideGrid(theme.grid);
  const { coverTitleSize, titleSize, subtitleSize, bodySize } = theme.typography;
  const margin = legacyLayout ? 0.85 : grid.margin;
  const width = legacyLayout ? 11.6 : grid.width;
  const firstTextWidth = legacyLayout ? firstSlideTextWidth : grid.column(0, 6).w;
  const contentTop = legacyLayout ? 1.94 : getSlideContentTop(theme);
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
      style: { color: colors.text, ...style, ...override, fontFace: font.latin },
      font,
      explicitFont: override?.fontFace,
      bullet,
    });
  }

  if (page.layout === "cover") {
    const textWidth = hasFirstSlideImage ? firstTextWidth : imageBox ? (legacyLayout ? 5.4 : firstTextWidth) : width;
    add("title", page.title,
      { x: margin, y: imageBox || page.subtitle ? 1.52 : 2.48, w: textWidth, h: 2.55 },
      { bold: true, fontSize: coverTitleSize });
    if (page.subtitle) {
      add("subtitle", page.subtitle,
        { x: margin, y: 4.23, w: textWidth, h: 1.45 }, { fontSize: subtitleSize });
    }
    return elements;
  }

  add("title", page.title,
    { x: margin, y: 0.5, w: hasFirstSlideImage && page.layout !== "image-focus" ? firstTextWidth : width, h: 1.15 },
    { bold: true, fontSize: titleSize });
  const accentText = contrastRatio(colors.accent, colors.background) >= 4.5 ? colors.accent : colors.text;
  if (page.layout === "image-comparison") {
    for (const [slot, key] of [["leftImage", "leftCaption"], ["rightImage", "rightCaption"]] as const) {
      const { x, y, w, h } = getComparisonImageBox(theme, slot);
      add(key, page[key], { x, y: hasComparisonImage ? y + h + theme.spacing.elementGap / 72 : y, w, h: 0.85 },
        { fontSize: subtitleSize, bold: true, align: "center" });
    }
  } else if (page.layout === "metrics") {
    const count = page.metrics.length;
    const gap = legacyLayout ? 0.5 : grid.gap;
    const metricWidth = (width - gap * (count - 1)) / count;
    page.metrics.forEach(({ value, label, detail }, index) => {
      const slot = (index + 1) as 1 | 2 | 3;
      const x = margin + index * (metricWidth + gap);
      add(`metric${slot}Value`, value, { x, y: contentTop + 0.16, w: metricWidth, h: 1.25 },
        { fontSize: titleSize + (count === 1 ? 32 : 14), bold: true, color: accentText, align: "center" });
      add(`metric${slot}Label`, label, { x, y: contentTop + 1.56, w: metricWidth, h: 0.8 },
        { fontSize: legacyLayout ? 22 : subtitleSize, bold: true, align: "center" });
      add(`metric${slot}Detail`, detail, { x, y: contentTop + 2.51, w: metricWidth, h: 1.55 },
        { fontSize: legacyLayout ? 17 : bodySize, align: "center" });
    });
  } else if (page.layout === "steps") {
    const gap = legacyLayout ? 0.35 : grid.gap;
    const stepWidth = (width - gap * (page.steps.length - 1)) / page.steps.length;
    const markerWidth = 1.55;
    page.steps.forEach(({ marker, heading, detail }, index) => {
      const slot = (index + 1) as 1 | 2 | 3 | 4 | 5;
      const x = margin + index * (stepWidth + gap);
      add(`step${slot}Marker`, marker ?? String(slot), { x: x + (stepWidth - markerWidth) / 2, y: contentTop + 0.1, w: markerWidth, h: 0.65 },
        { fontSize: bodySize, bold: true, color: accentText, align: "center" });
      add(`step${slot}Heading`, heading, { x, y: contentTop + 0.97, w: stepWidth, h: 0.88 },
        { fontSize: legacyLayout ? 20 : subtitleSize, bold: true, align: "center" });
      add(`step${slot}Detail`, detail, { x, y: contentTop + 2.01, w: stepWidth, h: 1.75 },
        { fontSize: legacyLayout ? 17 : bodySize, align: "center" });
    });
  } else if (page.layout === "image-focus") {
    const interpretation = legacyLayout ? { x: 9, w: 3.45 } : grid.column(8, 4);
    page.points.forEach((point, index) => {
      add(`point${(index + 1) as 1 | 2}`, point,
        imageBox
          ? { ...interpretation, y: contentTop + 0.18 + 1.9 * index, h: 1.75 }
          : { x: margin, y: contentTop + 1.4 * index, w: width, h: 1.27 },
        { fontSize: bodySize }, { indent: 19 });
    });
  } else if (page.layout === "two-columns") {
    const { fullSlide } = getSlideImageLayout(page, imageBox);
    const headingColor = fullSlide ? colors.text : accentText;
    const hasImageAboveColumns = imageBox && !hasFirstSlideImage;
    const headingY = hasImageAboveColumns ? (legacyLayout ? 4.11 : contentTop + 2.22 + theme.spacing.elementGap / 72) : contentTop;
    const pointSpacing = hasImageAboveColumns
      ? (legacyLayout ? 0.76 : Math.min(0.76, (pageNumberBox.y - 0.1 - headingY - 0.62) / 3))
      : 1.24;
    const span = hasFirstSlideImage ? 3 : 6;
    const legacyWidth = hasFirstSlideImage ? (firstSlideTextWidth - 0.4) / 2 : 5.4;
    const columns = legacyLayout
      ? [{ x: 0.85, w: legacyWidth }, { x: hasFirstSlideImage ? 0.85 + legacyWidth + 0.4 : 7, w: legacyWidth }]
      : [grid.column(0, span), grid.column(span, span)];
    for (const [columnIndex, side] of (["left", "right"] as const).entries()) {
      const column = page[side];
      const track = columns[columnIndex];
      add(`${side}Heading`, column.heading,
        { ...track, y: headingY, h: 0.55 },
        { fontSize: legacyLayout ? 20 : subtitleSize, bold: true, color: headingColor });
      column.points.forEach((point, index) => {
        add(`${side}Point${index + 1}` as TextElementKey, point,
          { ...track, y: headingY + 0.62 + pointSpacing * index, h: pointSpacing - 0.02 },
          { fontSize: legacyLayout ? 17 : bodySize }, { indent: 17 });
      });
    }
  } else {
    page.points.forEach((point, index) => {
      add(`point${index + 1}` as TextElementKey, point,
        { x: margin, y: contentTop + 1.24 * index,
          w: hasFirstSlideImage || (imageBox && legacyLayout) ? firstTextWidth : imageBox ? grid.column(0, 7).w : width, h: 1.17 },
        { fontSize: bodySize }, { indent: 19 });
    });
  }
  return elements;
}

function resolveFont(explicit: string | undefined, theme: ThemeSpec, role: "title" | "body") {
  if (explicit) return { latin: explicit, eastAsian: explicit };
  return themeFont(theme, role);
}

type SlideElement =
  | ({ type: "text"; id: string; templateKey?: TextElementKey }
    & Omit<SlideTextElement, "key">)
  | { type: "image"; id: string; templateKey?: ImageSlot; box: ElementBox; description?: string; fit: "cover" | "contain" };

export function getSlideElements(
  page: PresentationSlide,
  colors: SlideColors,
  index: number,
  images: ReadonlyMap<string, Pick<PresentationImage, "box">>,
  layout: PresentationLayout,
): SlideElement[] {
  const elements: SlideElement[] = [];
  let primaryImageBox: ElementBox | undefined;
  for (const slot of getSlideImageSlots(page.layout)) {
    const id = templateElementId(page.slideId, slot.id);
    const asset = page.removedElementIds?.includes(id) ? undefined : images.get(id);
    if (!asset) continue;
    if (slot.id === "image") primaryImageBox = asset.box;
    elements.push({
      type: "image", id, templateKey: slot.id, box: asset.box,
      description: getSlideImageBrief(page, slot.id) ?? undefined, fit: getSlideImageFit(page, slot.id)?.fit ?? slot.fit,
    });
  }
  const hasComparisonImage = page.layout === "image-comparison" && elements.length > 0;
  for (const { key, ...element } of getSlideTextElements(page, colors, index, primaryImageBox, layout, hasComparisonImage)) {
    elements.push({ ...element, type: "text", id: templateElementId(page.slideId, key), templateKey: key });
  }
  for (const element of page.addedElements ?? []) {
    if (element.type === "text") {
      const font = resolveFont(element.style?.fontFace, layout.theme, "body");
      elements.push({
        ...element, font, explicitFont: element.style?.fontFace,
        style: { fontFace: font.latin, color: colors.text, fontSize: layout.theme.typography.bodySize, ...element.style },
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
function imageGradientFill(background: string, legacyLayout?: true) {
  const color = legacyLayout ? "000000" : background;
  const stop = (position: number, opacity: number) =>
    `<a:gs pos="${position}"><a:srgbClr val="${color}"><a:alpha val="${opacity}"/></a:srgbClr></a:gs>`;
  const stops = legacyLayout ? stop(0, 70000) : stop(0, 97000) + stop(47000, 94000);
  return '<a:gradFill rotWithShape="1"><a:gsLst>' + stops + stop(100000, 0) +
    '</a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>';
}

const pptxLayouts = { "16:9": "LAYOUT_WIDE" } as const;

export async function renderPresentation(
  presentation: PresentationSource,
  slideColors: SlideColors[],
  images: ReadonlyMap<string, PresentationImage>,
) {
  const { theme, legacyLayout } = presentation;
  const pptx = new pptxgen();
  pptx.layout = pptxLayouts[theme.aspectRatio];
  pptx.title = presentation.title;
  const textOptions = { fontFace: "Arial", margin: 0, valign: "middle", fit: "shrink" } as const;
  const slidesWithGradient = new Map<string, string>();
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
    const imageBackground = legacyLayout ? theme.colors.modes.light.background : colors.background;
    slide.background = { color: colors.background };
    const elements = getSlideElements(page, colors, index, images, presentation);
    const imageElements = elements.filter((element) => element.type === "image");
    for (const element of imageElements) {
      const image = images.get(element.id)!;
      const fit = element.templateKey ? getSlideImageFit(page, element.templateKey) : { fit: element.fit, position: "centre" as const };
      const bytes = fit
        ? await fitPresentationImage(sharp(image.bytes, { limitInputPixels: 16_000_000 }), image.box, {
          ...fit,
          background: `#${imageBackground}`,
        })
        : image.bytes;
      slide.addImage({
        data: `image/jpeg;base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`,
        objectName: element.templateKey ?? element.id,
        ...image.box,
        altText: image.fallback ? "装饰插图" : element.description,
      });
      if (element.templateKey === "image" && getSlideImageLayout(page, image.box).gradient) {
        slide.addShape(pptx.ShapeType.rect, {
          ...image.box,
          objectName: "渐变遮罩",
          line: { transparency: 100 },
        });
        slidesWithGradient.set(`ppt/slides/slide${index + 1}.xml`, imageGradientFill(colors.background, legacyLayout));
      }
    }
    if (page.layout === "steps") {
      const markers = elements.filter((element) => element.type === "text" && /^step\dMarker$/.test(element.templateKey ?? ""));
      const { borderRadius, strokeWidth, strokeColorRole } = theme.shape;
      const strokeColor = theme.colors[strokeColorRole];
      const color = contrastRatio(strokeColor, colors.background) >= 3 ? strokeColor : colors.text;
      const line = { color, width: strokeWidth };
      if (!legacyLayout) {
        for (const { box } of markers) {
          slide.addShape(borderRadius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
            ...box, objectName: "步骤标记边框", rectRadius: Math.min(borderRadius / 72, box.h / 2, box.w / 2), line,
          });
        }
      }
      for (const [index, marker] of markers.slice(1).entries()) {
        const from = markers[index].box;
        const to = marker.box;
        const x = from.x + from.w + 0.08;
        const y = from.y + from.h / 2;
        const w = to.x - x - 0.08;
        if (w <= 0 || Math.abs(y - to.y - to.h / 2) > 0.02) continue;
        slide.addShape(pptx.ShapeType.line, { x, y, w, h: 0, line });
      }
    }
    const imageOverlapsPageNumber = imageElements.some(({ box }) =>
      box.x < pageNumberBox.x + pageNumberBox.w && box.x + box.w > pageNumberBox.x &&
      box.y < pageNumberBox.y + pageNumberBox.h && box.y + box.h > pageNumberBox.y);
    const pageNumberColors = imageOverlapsPageNumber && legacyLayout ? theme.colors.modes.dark : colors;
    slide.addText(`${index + 1} / ${presentation.slides.length}`, {
      ...textOptions, ...pageNumberBox, objectName: "页码", align: "right", fontSize: 10, margin: [0, 5, 0, 5],
      color: pageNumberColors.text,
      fill: imageOverlapsPageNumber ? { color: pageNumberColors.background } : undefined,
      fontFace: customFontFace(themeFont(theme, "body")),
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
    const gradient = slidesWithGradient.get(part.name);
    if (gradient) {
      // PptxGenJS cannot set a gradient fill on a shape through its public API.
      const maskFill = /(<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="渐变遮罩">[\s\S]*?<\/a:prstGeom>)<a:noFill\/>/;
      if (!maskFill.test(xml)) throw new Error("Missing PowerPoint gradient mask shape.");
      xml = xml.replace(maskFill, (_, shape: string) => shape + gradient);
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
