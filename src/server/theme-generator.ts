import { z } from "zod";

export function luminance(color: string) {
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export const hexColor = z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/)
  .transform((color) => color.replace(/^#/, "").toUpperCase());

const paletteSchema = z.object({
  lightBackground: hexColor,
  darkBackground: hexColor,
  accent: hexColor,
}).refine(
  ({ lightBackground, darkBackground }) => luminance(lightBackground) >= 0.8 && luminance(darkBackground) <= 0.12,
  "lightBackground 必须接近白色，darkBackground 必须为深色。",
);

export const savedPaletteSchema = paletteSchema.catch({
  lightBackground: "F7F9FC", darkBackground: "142846", accent: "225AA5",
});

export const themeStyleSchema = z.object({
  fontPreset: z.enum(["classic", "modern"]),
  visualStyle: z.string().trim().min(1).max(120),
  imageStyle: z.string().trim().min(1).max(120),
});
export type ThemeStyle = z.infer<typeof themeStyleSchema>;

export type FontPair = { latin: string; eastAsian: string };
const bodyFont: FontPair = { latin: "Arial", eastAsian: "Microsoft YaHei" };
const classicTitleFont: FontPair = { latin: "Georgia", eastAsian: "Songti SC" };

export function themeFont(theme: ThemeStyle, role: "title" | "body"): FontPair {
  return role === "title" && theme.fontPreset === "classic" ? classicTitleFont : bodyFont;
}

export const themeSpecSchema = z.object({ palette: paletteSchema, style: themeStyleSchema });
export type ThemeSpec = z.infer<typeof themeSpecSchema>;

// The planner requests both parts in one model call. This module defines the theme contract.
export const themeInstructions = `theme 形如 {"palette":{"lightBackground":"F7F9FC","darkBackground":"142846","accent":"225AA5"},"style":{"fontPreset":"modern","visualStyle":"简洁商务","imageStyle":"自然光、写实摄影"}}。
按需求和受众选择接近白色的 lightBackground、深色的 darkBackground 和协调的 accent，使用六位 RGB，优先采用合适的品牌色。
fontPreset 选 classic（标题 Georgia / Songti SC，正文 Arial / Microsoft YaHei）或 modern（标题和正文 Arial / Microsoft YaHei）。
visualStyle 描述整份稿件的视觉风格，imageStyle 描述配图的视觉风格，各最多 120 字。未指定配图风格时优先使用自然光、真实质感的写实摄影风格。`;
