import { z } from "zod";

export function luminance(color: string) {
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(first: string, second: string) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export const hexColor = z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/)
  .transform((color) => color.replace(/^#/, "").toUpperCase());

export const backgroundModeSchema = z.enum(["light", "dark"]);
const colorRoleSchema = z.enum(["primary", "secondary", "accent"]);
const modeColorsSchema = z.object({ background: hexColor, text: hexColor, accentText: hexColor.optional() }).refine(
  ({ background, text }) => contrastRatio(background, text) >= 4.5,
  { path: ["text"], message: "背景和文字的对比度必须至少为 4.5:1。" },
).refine(
  ({ background, accentText }) => accentText === undefined || contrastRatio(background, accentText) >= 4.5,
  { path: ["accentText"], message: "背景和强调文字的对比度必须至少为 4.5:1。" },
);
const modesSchema = z.object({ light: modeColorsSchema, dark: modeColorsSchema }).refine(
  ({ light, dark }) => luminance(light.background) >= 0.65 && luminance(dark.background) <= 0.18,
  "light.background 必须为浅色，dark.background 必须为深色。",
);
const fontName = z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cs}\u2028\u2029\uFFFE\uFFFF]+$/u);
const fontFamilySchema = z.object({ latin: fontName, eastAsian: fontName });
export type FontPair = z.infer<typeof fontFamilySchema>;
const bodyFont: FontPair = { latin: "Arial", eastAsian: "Microsoft YaHei" };
const classicTitleFont: FontPair = { latin: "Georgia", eastAsian: "Songti SC" };

const typographySchema = z.object({
  fontFamily: fontFamilySchema.default(bodyFont),
  titleFontFamily: fontFamilySchema.optional(),
  coverTitleSize: z.number().min(32).max(48).default(40),
  titleSize: z.number().min(26).max(36).default(32),
  subtitleSize: z.number().min(16).max(26).default(22),
  bodySize: z.number().min(16).max(22).default(18),
});
const gridSchema = z.object({
  columns: z.literal(12).default(12),
  pageMargin: z.number().min(32).max(64).default(40),
  columnGap: z.number().min(12).max(28).default(20),
});
const spacingSchema = z.object({ elementGap: z.number().min(12).max(24).default(20) });
const shapeSchema = z.object({
  borderRadius: z.number().min(0).max(12).default(8),
  strokeWidth: z.number().min(0.5).max(3).default(1),
  strokeColorRole: colorRoleSchema.default("secondary"),
});
const visualDescription = z.string().trim().min(1).max(120);

export const themeSpecSchema = z.object({
  themeId: z.string().trim().max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  aspectRatio: z.literal("16:9").default("16:9"),
  colors: z.object({ primary: hexColor, secondary: hexColor, accent: hexColor, modes: modesSchema }),
  typography: typographySchema.prefault({}),
  grid: gridSchema.prefault({}),
  spacing: spacingSchema.prefault({}),
  shape: shapeSchema.prefault({}),
  visualStyle: visualDescription,
  imageStyle: visualDescription,
});
export type ThemeSpec = z.infer<typeof themeSpecSchema>;

export const generatedThemeSpecSchema = themeSpecSchema.refine(
  ({ colors: { modes } }) => modes.light.accentText !== undefined && modes.dark.accentText !== undefined,
  { path: ["colors", "modes"], message: "浅色和深色模式都必须提供 accentText。" },
);

export function themeFont(theme: ThemeSpec, role: "title" | "body"): FontPair {
  const { fontFamily, titleFontFamily } = theme.typography;
  return role === "title" ? titleFontFamily ?? fontFamily : fontFamily;
}

export const legacyPaletteSchema = z.object({
  lightBackground: hexColor,
  darkBackground: hexColor,
  accent: hexColor,
}).refine(
  ({ lightBackground, darkBackground }) => luminance(lightBackground) >= 0.8 && luminance(darkBackground) <= 0.12,
).catch({ lightBackground: "F7F9FC", darkBackground: "142846", accent: "225AA5" });

export const legacyStyleSchema = z.object({
  fontPreset: z.enum(["classic", "modern"]),
  visualStyle: visualDescription,
  imageStyle: visualDescription,
}).optional();

export function upgradeLegacyTheme(
  { lightBackground, darkBackground, accent }: z.infer<typeof legacyPaletteSchema>,
  style: z.infer<typeof legacyStyleSchema>,
) {
  return themeSpecSchema.parse({
    themeId: "legacy",
    colors: {
      primary: darkBackground,
      secondary: accent,
      accent,
      modes: {
        light: { background: lightBackground, text: darkBackground },
        dark: { background: darkBackground, text: lightBackground },
      },
    },
    typography: {
      titleFontFamily: style?.fontPreset === "modern" ? undefined : classicTitleFont,
      subtitleSize: 20,
      bodySize: 20,
    },
    grid: { pageMargin: 61.2 },
    shape: { borderRadius: 0, strokeColorRole: "accent" },
    visualStyle: style?.visualStyle ?? "简洁商务",
    imageStyle: style?.imageStyle ?? "自然光、写实摄影",
  });
}

export const themeInstructions = `整份演示文稿使用同一个 theme。结构示例：
{"themeId":"modern-city","aspectRatio":"16:9","colors":{"primary":"#17324D","secondary":"#277DA8","accent":"#E5A64B","modes":{"light":{"background":"#F3F6F8","text":"#17324D","accentText":"#8A5314"},"dark":{"background":"#17324D","text":"#F3F6F8","accentText":"#E5A64B"}}},"typography":{"fontFamily":{"latin":"Arial","eastAsian":"Microsoft YaHei"},"coverTitleSize":40,"titleSize":32,"subtitleSize":22,"bodySize":18},"grid":{"columns":12,"pageMargin":40,"columnGap":20},"spacing":{"elementGap":20},"shape":{"borderRadius":8,"strokeWidth":1,"strokeColorRole":"secondary"},"visualStyle":"现代城市风格","imageStyle":"自然光、写实摄影"}
根据主题和受众选择品牌色，优先尊重用户指定的颜色。colors 使用六位 RGB，light 使用浅色背景，dark 使用深色背景。两种模式都要填写 accentText，用于强调文字。从品牌强调色 accent 选取适合该背景的色调，浅底可用较深色调，深底可用较亮色调，并与普通文字色有明显区别。每种模式的 text 和 accentText 与各自背景的对比度都至少为 4.5:1。themeId 使用小写字母、数字和连字符。
页面比例固定 16:9，网格固定为 12 列，pageMargin 是左右页边距。除非需求明确需要调整，沿用示例中的字号和尺寸，单位为 pt。字体默认 Arial / Microsoft YaHei；经典风格可增加 titleFontFamily，使用 Georgia / Songti SC。shape.strokeColorRole 可用 primary、secondary 或 accent。
visualStyle 和 imageStyle 各最多 120 字。未指定配图风格时优先自然光、真实质感的写实摄影风格。`;
