import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import sharp, { type ResizeOptions, type Sharp } from "sharp";
import { z } from "zod";
import {
  backgroundModeSchema, contrastRatio, hexColor, legacyPaletteSchema, legacyStyleSchema, luminance,
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
export const coverTextFields = {
  subtitle: slideText(90),
  eyebrow: slideText(26),
  tagline: slideText(48),
  description: slideText(80),
  author: slideText(36),
  date: slideText(28),
  extraInfo: slideText(48),
  footer: slideText(42),
};
export const coverMetricSchema = metricSchema.extend({ detail: slideText(32).optional() });
export const coverKeywordSchema = slideText(12);
export const coverCopySchema = z.object({
  subtitle: coverTextFields.subtitle.optional(),
  eyebrow: coverTextFields.eyebrow.optional(),
  tagline: coverTextFields.tagline.optional(),
  description: coverTextFields.description.optional(),
  keywords: z.array(coverKeywordSchema).min(1).max(4).optional(),
});
export const coverDetailsSchema = z.object({
  author: coverTextFields.author.optional(),
  date: coverTextFields.date.optional(),
  extraInfo: coverTextFields.extraInfo.optional(),
  footer: coverTextFields.footer.optional(),
  metrics: z.array(coverMetricSchema).min(1).max(3).optional(),
});
export const coverFieldSchema = z.enum([...coverCopySchema.keyof().options, ...coverDetailsSchema.keyof().options, "logo"]);
export type CoverField = z.infer<typeof coverFieldSchema>;
export const slideTextFields = {
  title,
  points: z.array(slideText(90)).min(1).max(4),
  columnHeading: column.shape.heading,
  columnPoints: z.array(slideText(60)).min(1).max(3),
  metric: metricSchema.shape,
  step: stepSchema.shape,
  imageFocusPoints,
  imageCaption,
};
const keywordElementKeys = ["keyword1", "keyword2", "keyword3", "keyword4"] as const;
export const textElementKeySchema = z.enum([
  "title", ...z.object(coverTextFields).keyof().options, "point1", "point2", "point3", "point4",
  ...keywordElementKeys,
  "leftHeading", "leftPoint1", "leftPoint2", "leftPoint3",
  "rightHeading", "rightPoint1", "rightPoint2", "rightPoint3",
  "leftCaption", "rightCaption",
  ...([1, 2, 3] as const).flatMap((slot) => [`metric${slot}Value`, `metric${slot}Label`, `metric${slot}Detail`] as const),
  ...([1, 2, 3, 4, 5] as const).flatMap((slot) => [`step${slot}Marker`, `step${slot}Heading`, `step${slot}Detail`] as const),
]);
export type TextElementKey = z.infer<typeof textElementKeySchema>;
export const highlightPhrasesSchema = z.array(slideText(50)).max(8).refine(
  (phrases) => new Set(phrases).size === phrases.length, "强调短语不得重复。",
);
export const textHighlightsSchema = z.partialRecord(textElementKeySchema, highlightPhrasesSchema);

// 一整页幻灯片。根据 layout 决定这页需要哪些字段。
const slideFields = { title, backgroundMode: backgroundModeSchema.optional(), imageBriefs,
  textHighlights: textHighlightsSchema.optional() };
export const coverStyleSchema = z.enum(["full-bleed", "split-right"]);
const slideLayoutSchema = z.discriminatedUnion("layout", [
  z.object({ layout: z.literal("cover"), ...slideFields, ...coverCopySchema.shape, ...coverDetailsSchema.shape,
    coverStyle: coverStyleSchema.optional(), imageBrief }),
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
  cover: [{ id: "image", required: true, fit: "cover" }],
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
).superRefine((page, context) => {
  for (const [key, phrases] of Object.entries(page.textHighlights ?? {})) {
    const text = getTemplateText(page, key as TextElementKey);
    if (phrases?.some((phrase) => !text?.includes(phrase))) {
      context.addIssue({ code: "custom", path: ["textHighlights", key],
        message: "强调短语必须逐字出现在对应的文本字段中。" });
    }
  }
});

export function getTemplateText(page: z.infer<typeof slideLayoutSchema>, key: TextElementKey): string | undefined {
  if (key === "title") return page.title;
  if (page.layout === "cover") {
    if (Object.hasOwn(coverTextFields, key)) return page[key as keyof typeof coverTextFields];
    const keyword = /^keyword([1-4])$/.exec(key);
    if (keyword) return page.keywords?.[Number(keyword[1]) - 1];
  }
  const point = /^point([1-4])$/.exec(key);
  if (point && "points" in page) return page.points[Number(point[1]) - 1];
  if (page.layout === "two-columns") {
    const column = /^(left|right)(Heading|Point([1-3]))$/.exec(key);
    if (column) {
      const side = page[column[1] as "left" | "right"];
      return column[2] === "Heading" ? side.heading : side.points[Number(column[3]) - 1];
    }
  }
  if (page.layout === "image-comparison" && (key === "leftCaption" || key === "rightCaption")) return page[key];
  const metric = /^metric([1-3])(Value|Label|Detail)$/.exec(key);
  if (metric && "metrics" in page) {
    return page.metrics?.[Number(metric[1]) - 1]?.[metric[2].toLowerCase() as "value" | "label" | "detail"];
  }
  const step = /^step([1-5])(Marker|Heading|Detail)$/.exec(key);
  if (step && page.layout === "steps") {
    const item = page.steps[Number(step[1]) - 1];
    return item?.[step[2].toLowerCase() as "marker" | "heading" | "detail"] ??
      (item && step[2] === "Marker" ? step[1] : undefined);
  }
}

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
  addedImageDefinition.omit({ generatedImageId: true, box: true }).extend({ id: z.uuid(), role: z.literal("logo").optional() }),
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
type SlideColors = { background: string; text: string; accentText: string };

export function getSlideAppearance(
  page: PresentationSlide, index: number, slideCount: number,
  defaultBackgroundMode: ThemeSpec["defaultBackgroundMode"],
) {
  const firstSlide = index === 0;
  const isCover = firstSlide && page.layout === "cover";
  const isClosing = index === slideCount - 1 && page.layout === "summary" &&
    page.closing === true && page.points.length === 1 && page.points[0].length <= 50;
  const defaultDarkBackground = defaultBackgroundMode === undefined
    ? slideCount > 1 && (isCover || isClosing)
    : defaultBackgroundMode === "dark";
  return {
    firstSlide: page.appearance?.firstSlide ?? firstSlide,
    darkBackground: page.backgroundMode === undefined
      ? page.appearance?.darkBackground ?? defaultDarkBackground
      : page.backgroundMode === "dark",
  };
}

export function getSlideColors({ slides, theme }: PresentationSource): SlideColors[] {
  const { modes, accent } = theme.colors;
  return slides.map((page, index) => {
    const { darkBackground: useDarkBackground } = getSlideAppearance(page, index, slides.length, theme.defaultBackgroundMode);
    const { background, text, accentText } = modes[useDarkBackground ? "dark" : "light"];
    return { background, text, accentText: accentText ?? (contrastRatio(accent, background) >= 4.5 ? accent : text) };
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
export const coverLogoSize = { y: 0.43, w: 1.45, h: 0.58 };

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
    gradient: box?.y === 0 && box.h === slideSize.h && !(page.layout === "cover" && page.coverStyle === "split-right"),
  };
}

export function imagePixelSize({ w, h }: PresentationImage["box"]) {
  return { width: Math.round(w * 135), height: Math.round(h * 135) };
}

export async function fitPresentationImage(
  image: Sharp,
  box: PresentationImage["box"],
  options: Pick<ResizeOptions, "fit" | "position" | "background">,
  format: "jpeg" | "png" = "jpeg",
) {
  const { width, height } = imagePixelSize(box);
  const resized = image.resize({ width, height, ...options });
  return new Uint8Array(await (format === "png" ? resized.png() : resized.jpeg({ quality: 87 })).toBuffer());
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
  highlights?: string[];
  bullet?: { indent: number };
};

function getSlideTextElements(
  page: PresentationSlide,
  colors: SlideColors,
  index: number,
  imageBox: ElementBox | undefined,
  { theme, legacyLayout }: PresentationLayout,
  hasComparisonImage: boolean,
  hasCoverLogo: boolean,
): SlideTextElement[] {
  const elements: SlideTextElement[] = [];
  const hasFirstSlideImage = (page.appearance?.firstSlide ?? index === 0) && Boolean(imageBox);
  const grid = getSlideGrid(theme.grid);
  const { coverTitleSize, titleSize, subtitleSize, bodySize } = theme.typography;
  const margin = legacyLayout ? 0.85 : grid.margin;
  const width = legacyLayout ? 11.6 : grid.width;
  const firstTextWidth = legacyLayout ? firstSlideTextWidth : grid.column(0, 6).w;
  const contentTop = legacyLayout ? 1.94 : getSlideContentTop(theme);
  const isVisible = (key: TextElementKey) => !page.removedElementIds?.includes(templateElementId(page.slideId, key));
  function add(
    key: TextElementKey,
    text: string,
    box: ElementBox,
    style: SlideTextElement["style"],
    bullet?: SlideTextElement["bullet"],
  ) {
    if (!isVisible(key)) return;
    const override = page.textStyles?.[key];
    const font = resolveFont(override?.fontFace, theme, key === "title" ? "title" : "body");
    elements.push({
      key, text, box: page.textBoxes?.[key] ?? box,
      style: { color: colors.text, ...style,
        ...(page.textHighlights !== undefined && { color: colors.text }),
        ...override, fontFace: font.latin },
      font,
      explicitFont: override?.fontFace,
      highlights: override?.color ? undefined : page.textHighlights?.[key],
      bullet,
    });
  }

  if (page.layout === "cover") {
    const textWidth = hasFirstSlideImage ? firstTextWidth : imageBox ? (legacyLayout ? 5.4 : firstTextWidth) : width;
    const supportingCopy = [
      { key: "subtitle", h: 0.64, fontSize: subtitleSize },
      { key: "tagline", h: 0.48, fontSize: Math.min(20, subtitleSize), bold: true, color: colors.accentText },
      { key: "description", h: 0.62, fontSize: Math.min(17, bodySize) },
    ] as const;
    if (page.eyebrow || page.tagline || page.description || page.author || page.date || page.extraInfo ||
      page.footer || page.metrics || page.keywords || hasCoverLogo) {
      const visibleCopy = supportingCopy.filter(({ key }) => page[key] && isVisible(key));
      const metrics = (page.metrics ?? []).map((metric, index) => ({ ...metric, slot: (index + 1) as 1 | 2 | 3 }))
        .filter(({ slot, detail }) => isVisible(`metric${slot}Value`) || isVisible(`metric${slot}Label`) ||
          (detail && isVisible(`metric${slot}Detail`)));
      const keywords = (page.keywords ?? []).map((text, index) => ({ text, key: keywordElementKeys[index] }))
        .filter(({ key }) => isVisible(key));
      const metricsHeight = metrics.length ? 0.98 : 0;
      const keywordsHeight = keywords.length ? 0.32 : 0;
      const gap = 0.1;
      const copyHeight = visibleCopy.reduce((height, copy) => height + copy.h + gap, 0);
      const supportingHeight = copyHeight + (metricsHeight && metricsHeight + gap) + (keywordsHeight && keywordsHeight + gap);
      const titleHeight = isVisible("title") ? Math.min(2.25, 4.95 - supportingHeight) : 0;
      const content = { x: margin, w: textWidth };
      let y = 1.12 + (4.95 - supportingHeight - titleHeight) / 2;
      if (page.eyebrow) {
        const inset = hasCoverLogo ? coverLogoSize.w + 0.23 : 0;
        add("eyebrow", page.eyebrow, { x: margin + inset, y: 0.52, w: textWidth - inset, h: 0.4 },
          { fontSize: 13, bold: true, color: colors.accentText });
      }
      if (titleHeight) {
        add("title", page.title, { ...content, y, h: titleHeight }, { bold: true, fontSize: coverTitleSize });
        y += titleHeight;
      }
      for (const { key, h, ...style } of visibleCopy) {
        y += gap;
        add(key, page[key]!, { ...content, y, h }, style);
        y += h;
      }
      if (metrics.length) {
        y += gap;
        const trackWidth = textWidth / metrics.length;
        metrics.forEach(({ value, label, detail, slot }, index) => {
          const track = { x: margin + index * trackWidth, w: trackWidth - 0.16 };
          add(`metric${slot}Value`, value, { ...track, y, h: 0.38 }, { fontSize: 23, bold: true, color: colors.accentText });
          add(`metric${slot}Label`, label, { ...track, y: y + 0.39, h: 0.22 }, { fontSize: 12, bold: true });
          if (detail) add(`metric${slot}Detail`, detail, { ...track, y: y + 0.62, h: 0.36 }, { fontSize: 10 });
        });
        y += metricsHeight;
      }
      if (keywords.length) {
        const trackWidth = Math.min(1.5, textWidth / keywords.length);
        keywords.forEach(({ text, key }, index) => {
          add(key, text, { x: margin + index * trackWidth, y: y + gap, w: trackWidth - 0.12, h: keywordsHeight },
            { fontSize: 12, bold: true, color: colors.accentText });
        });
      }
      const hasAuthor = page.author && isVisible("author");
      const hasDate = page.date && isVisible("date");
      if (hasAuthor) add("author", page.author!, { ...content, y: 6.23, w: hasDate ? textWidth * 0.56 : textWidth, h: 0.3 }, { fontSize: 13 });
      if (hasDate) {
        const inset = hasAuthor ? textWidth * 0.6 : 0;
        add("date", page.date!, { x: margin + inset, y: 6.23, w: textWidth - inset, h: 0.3 }, { fontSize: 13 });
      }
      if (page.extraInfo) add("extraInfo", page.extraInfo, { ...content, y: hasAuthor || hasDate ? 6.61 : 6.23, h: 0.3 }, { fontSize: 12 });
      if (page.footer) add("footer", page.footer, { ...content, y: pageNumberBox.y,
        w: Math.min(textWidth, pageNumberBox.x - margin - 0.2), h: pageNumberBox.h }, { fontSize: 10 });
      return elements;
    }
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
  const { accentText } = colors;
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
  const hasCoverLogo = page.layout === "cover" && Boolean(page.addedElements?.some(
    (element) => element.type === "image" && element.role === "logo" && images.has(element.id),
  ));
  for (const { key, ...element } of getSlideTextElements(page, colors, index, primaryImageBox, layout, hasComparisonImage, hasCoverLogo)) {
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
  const { id, type, box, text, style, highlights } = element;
  return { id, type, box, text, style, highlights };
}

// Keep the original text box, bullet, and paragraph style; color only selected runs.
function highlightedText(text: string, phrases: string[] | undefined, color: string): string | pptxgen.TextProps[] {
  if (!phrases?.length) return text;
  const spans = phrases.flatMap((phrase) => {
    const matches: { start: number; end: number }[] = [];
    for (let start = text.indexOf(phrase); start !== -1; start = text.indexOf(phrase, start + phrase.length)) {
      matches.push({ start, end: start + phrase.length });
    }
    return matches;
  }).sort((a, b) => a.start - b.start);
  if (!spans.length) return text;
  const merged: typeof spans = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  const runs: pptxgen.TextProps[] = [];
  let position = 0;
  for (const { start, end } of merged) {
    if (start > position) runs.push({ text: text.slice(position, start) });
    runs.push({ text: text.slice(start, end), options: { color } });
    position = end;
  }
  if (position < text.length) runs.push({ text: text.slice(position) });
  return runs;
}

type HeaderDecoration = { type: "rect" | "line"; name: string; box: ElementBox; color: string };

function getSlideHeaderDecorations(
  page: PresentationSlide, colors: SlideColors, elements: SlideElement[],
  { theme, legacyLayout }: PresentationLayout,
): HeaderDecoration[] {
  if (legacyLayout || theme.headerStyle === "none") return [];
  const title = elements.find((element) => element.type === "text" && element.templateKey === "title");
  if (!title) return [];
  const grid = getSlideGrid(theme.grid);
  const isCover = page.layout === "cover";
  const isClosing = page.layout === "summary" && page.closing === true &&
    page.points.length === 1 && page.points[0].length <= 50;
  const prominent = isCover || isClosing;
  const color = [theme.colors.primary, theme.colors.accent, colors.accentText]
    .find((candidate) => contrastRatio(candidate, colors.background) >= 3) ?? colors.text;
  const neutral = luminance(colors.background) > 0.5 ? "D8DDE3" : "59616C";
  const x = title.box.x;
  const width = Math.min(title.box.w, slideSize.w - grid.margin - x);
  const barWidth = isCover ? 1.15 : isClosing ? 0.95 : 0.65;
  const decorations: HeaderDecoration[] = [{
    type: "rect", name: "页眉主题色条", color,
    box: { x, y: 0.27, w: Math.min(barWidth, width), h: prominent ? 0.1 : 0.07 },
  }];
  const fullSlideImage = elements.some((element) => element.type === "image" &&
    element.templateKey === "image" && getSlideImageLayout(page, element.box).fullSlide);
  if (prominent) {
    decorations.push({
      type: "line", name: "页眉短灰线", color: neutral,
      box: { x: x + barWidth + 0.2, y: 0.32, w: Math.min(2.2, width - barWidth - 0.2), h: 0 },
    });
  } else if (!fullSlideImage) {
    decorations.push({
      type: "line", name: "标题内容分隔线", color: neutral,
      box: { x, y: 1.65 + theme.spacing.elementGap / 144, w: width, h: 0 },
    });
  }
  // An edited title, logo, or added object can occupy the otherwise reserved header band.
  // Omit decorations in that case; background images are deliberately allowed underneath.
  return decorations.filter(({ box }) => isOnSlide(box) && box.w > 0 && !elements.some((element) => {
    if (element.type === "image" && element.templateKey === "image" &&
      getSlideImageLayout(page, element.box).fullSlide) return false;
    const other = element.box;
    const clearance = 0.04;
    return box.x < other.x + other.w + clearance && box.x + box.w > other.x - clearance &&
      box.y < other.y + other.h + clearance && box.y + box.h > other.y - clearance;
  }));
}

// DrawingML alpha represents opacity in thousandths of a percent.
function imageGradientFill(color: string) {
  return '<a:gradFill rotWithShape="1"><a:gsLst>' +
    `<a:gs pos="0"><a:srgbClr val="${color}"><a:alpha val="60000"/></a:srgbClr></a:gs>` +
    `<a:gs pos="100000"><a:srgbClr val="${color}"><a:alpha val="0"/></a:srgbClr></a:gs>` +
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
  const gradientColors = new Map<string, string>();
  const customFonts = new Map<string, FontPair>();
  const requiredColors = [...new Set((theme.colorRequirements?.roles ?? []).map((role) => theme.colors[role]))];

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
      const format = image.bytes[0] === 0x89 ? "png" : "jpeg";
      const fit = element.templateKey ? getSlideImageFit(page, element.templateKey) : { fit: element.fit, position: "centre" as const };
      const bytes = fit
        ? await fitPresentationImage(sharp(image.bytes, { limitInputPixels: 16_000_000 }), image.box, {
          ...fit,
          background: format === "png" ? "#00000000" : `#${imageBackground}`,
        }, format)
        : image.bytes;
      slide.addImage({
        data: `image/${format};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`,
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
        // Themes saved before deck-wide backgrounds used a black overlay.
        gradientColors.set(`ppt/slides/slide${index + 1}.xml`, theme.defaultBackgroundMode ? colors.background : "000000");
      }
    }
    for (const { type, name, box, color } of getSlideHeaderDecorations(page, colors, elements, presentation)) {
      slide.addShape(type === "rect" ? pptx.ShapeType.rect : pptx.ShapeType.line, {
        ...box, objectName: name,
        fill: type === "rect" ? { color } : undefined,
        line: type === "rect" ? { transparency: 100 } : { color, width: 0.75 },
      });
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
      const { text, box, style, bullet, font, templateKey, id, highlights } = element;
      slide.addText(highlightedText(text, highlights, colors.accentText), {
        ...textOptions, ...box, ...style,
        fontFace: font ? customFontFace(font) : style.fontFace,
        objectName: templateKey ?? id, bullet,
      });
    }
    if (requiredColors.length) {
      const bestContrastColor = requiredColors.reduce((best, color) =>
        contrastRatio(color, colors.background) > contrastRatio(best, colors.background) ? color : best);
      const footerColors = theme.colorRequirements?.perSlide === "all" ? requiredColors : [bestContrastColor];
      // Draw last so full-slide images and edited elements cannot cover the required colors.
      for (const [colorIndex, color] of footerColors.entries()) {
        const outline = contrastRatio(color, "FFFFFF") >= contrastRatio(color, "000000") ? "FFFFFF" : "000000";
        slide.addShape(pptx.ShapeType.rect, {
          x: theme.grid.pageMargin / 72 + colorIndex * 0.85, y: 7.12, w: 0.75, h: 0.1,
          objectName: `主题必用色-${color}`,
          fill: { color }, line: { color: outline, width: 0.5 },
        });
      }
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
      })
      .replace(/<a:p>[\s\S]*?<\/a:p>/g, (paragraph) => {
        // PptxGenJS emits a pPr per rich-text run. DrawingML permits only one;
        // later buNone entries otherwise erase bullets when opened in Office/Impress.
        let hasProperties = false;
        return paragraph.replace(/<a:pPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:pPr>)/g, (properties) => {
          if (hasProperties) return "";
          hasProperties = true;
          return properties;
        });
      });
    const gradientColor = gradientColors.get(part.name);
    if (gradientColor) {
      // PptxGenJS cannot set a gradient fill on a shape through its public API.
      const maskFill = /(<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="渐变遮罩">[\s\S]*?<\/a:prstGeom>)<a:noFill\/>/;
      if (!maskFill.test(xml)) throw new Error("Missing PowerPoint gradient mask shape.");
      xml = xml.replace(maskFill, (_, shape: string) => shape + imageGradientFill(gradientColor));
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
