import sharp from "sharp";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export const imageAspectRatios = z.enum(["1:1", "16:9", "9:16"]);
type ImageAspectRatio = z.infer<typeof imageAspectRatios>;
type ImageDimensions = { width: number; height: number };

const imageSizes: Record<ImageAspectRatio, string> = {
  "1:1": "1280*1280",
  "16:9": "1696*960",
  "9:16": "960*1696",
};
const imageResponse = z.object({
  output: z.object({
    choices: z.array(z.object({
      message: z.object({ content: z.array(z.object({ image: z.url().optional() })) }),
    })),
  }),
});
const maxImageBytes = 12 * 1024 * 1024;
let nextRequestAt = 0;

function getImageModel() {
  return process.env.DASHSCOPE_IMAGE_MODEL?.trim() || "wan2.6-t2i";
}

export function getCustomImageGenerationSize({ width, height }: ImageDimensions): ImageDimensions | undefined {
  if (getImageModel() !== "wan2.6-t2i") return;

  // Wan 2.6 accepts custom dimensions within these pixel-area and aspect-ratio limits.
  const minPixels = 1280 ** 2;
  const maxPixels = 1440 ** 2;
  const maxAspect = 4;
  const pixels = width * height;
  const landscape = width >= height;
  const aspect = landscape ? width / height : height / width;
  if (pixels >= minPixels && pixels <= maxPixels && aspect <= maxAspect) return { width, height };

  const targetPixels = Math.min(maxPixels, Math.max(minPixels, pixels));
  const targetAspect = Math.min(maxAspect, aspect);
  const shortEdge = Math.round(Math.sqrt(targetPixels / targetAspect));
  const longEdge = Math.min(
    Math.floor(maxPixels / shortEdge),
    maxAspect * shortEdge,
    Math.max(Math.ceil(minPixels / shortEdge), Math.round(shortEdge * targetAspect)),
  );
  return landscape ? { width: longEdge, height: shortEdge } : { width: shortEdge, height: longEdge };
}

export async function generateImageAsset(
  prompt: string,
  size: ImageAspectRatio | ImageDimensions,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  const baseUrl = process.env.DASHSCOPE_BASE_URL?.trim().replace(/\/+$/, "");
  if (!apiKey || !baseUrl) throw new Error("DashScope is not configured.");
  const endpoint = new URL(baseUrl + "/services/aigc/multimodal-generation/generation");
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".aliyuncs.com")) {
    throw new Error("Invalid DashScope endpoint.");
  }
  // The Beijing wan2.6-t2i endpoint allows one request start per second.
  const now = performance.now();
  const requestAt = Math.max(now, nextRequestAt);
  nextRequestAt = requestAt + 1_100;
  if (requestAt > now) await delay(requestAt - now, undefined, { signal: abortSignal });

  const deadline = AbortSignal.timeout(45_000);
  const signal = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: getImageModel(),
      input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
      parameters: { n: 1, size: typeof size === "string" ? imageSizes[size] : `${size.width}*${size.height}`, prompt_extend: false },
    }),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`DashScope image request failed (HTTP ${response.status}).`);
  }
  const result = imageResponse.parse(await response.json());
  const imageUrl = result.output.choices.flatMap(({ message }) => message.content).find(({ image }) => image)?.image;
  if (!imageUrl) throw new Error("DashScope returned no image.");
  const url = new URL(imageUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".aliyuncs.com")) {
    throw new Error("Invalid DashScope image URL.");
  }

  const download = await fetch(url, { redirect: "error", signal });
  if (!download.ok || !download.body || Number(download.headers.get("content-length")) > maxImageBytes) {
    await download.body?.cancel();
    throw new Error("DashScope image download failed.");
  }
  const reader = download.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxImageBytes) {
        await reader.cancel();
        throw new Error("DashScope image exceeds the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Decode and normalize provider output before serving or embedding it.
  const image = sharp(Buffer.concat(chunks), { limitInputPixels: 16_000_000 });
  const { format } = await image.metadata();
  if (format !== "png" && format !== "jpeg" && format !== "webp") {
    throw new Error("Unsupported DashScope image format.");
  }
  image.rotate();
  if (typeof size === "string") image.resize(1696, 1696, { fit: "inside", withoutEnlargement: true });
  const normalized = await image.flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
  signal.throwIfAborted();
  return normalized;
}
