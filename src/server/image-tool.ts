import { tool } from "ai";
import { z } from "zod";
import { getPrisma } from "./db";
import { generateImageAsset, imageAspectRatios } from "./images";

export function createImageTool(userId: string) {
  return tool({
    description: "Generate one image from text and deliver it in chat. Use for standalone image requests. For slides or PowerPoint files, use generatePresentation.",
    inputSchema: z.object({
      prompt: z.string().trim().min(1).max(2000).describe("Subject, composition and visual style requested by the user."),
      aspectRatio: imageAspectRatios.optional().describe("Square, landscape or portrait. Defaults to square."),
    }),
    execute: async ({ prompt, aspectRatio = "1:1" }, { abortSignal }) => {
      if (!process.env.DASHSCOPE_API_KEY?.trim() || !process.env.DASHSCOPE_BASE_URL?.trim()) {
        return { error: "服务端尚未配置阿里云百炼生图。" };
      }
      try {
        const bytes = await generateImageAsset(prompt, aspectRatio, abortSignal);
        abortSignal?.throwIfAborted();
        return await getPrisma().generatedImage.create({
          data: { userId, bytes: new Uint8Array(bytes) },
          select: { id: true },
        });
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Image generation failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "图片生成失败，请稍后重试。" };
      }
    },
  });
}
