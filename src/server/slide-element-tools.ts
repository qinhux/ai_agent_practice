import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { getPrisma } from "./db";
import {
  describeSlideElement,
  elementBoxSchema,
  elementIdSchema,
  getSlideColors,
  getSlideElements,
  imagePixelSize,
  isOnSlide,
  slideElementDefinitionSchema,
  slideNumberSchema,
  slideSize,
  type AddedSlideElement,
} from "./presentations";
import type { PresentationDrafts } from "./presentation-drafts";
import { readPresentationSource } from "./save-presentation";

const slideInputSchema = z.strictObject({
  presentationId: z.uuid(),
  slideNumber: slideNumberSchema.describe("1-based slide number"),
});

export function createListSlideElementsTool(userId: string, drafts: PresentationDrafts) {
  return tool({
    description: "List the editable elements on one slide of a specific PPT version, with their actual IDs, content, and boxes in inches. Use this to identify existing elements before removal or to plan placement. This is read-only.",
    inputSchema: slideInputSchema,
    execute: async ({ presentationId, slideNumber }, { abortSignal }) => {
      try {
        const draft = drafts.get(presentationId);
        const original = draft ? null : await getPrisma().presentation.findUnique({
          where: { id: presentationId, userId },
          select: { source: true, images: { select: { elementId: true, box: true } } },
        });
        abortSignal?.throwIfAborted();
        const result = draft ?? readPresentationSource(original);
        if ("error" in result) return result;
        const { source } = result;
        const index = slideNumber - 1;
        const page = source.slides[index];
        if (!page) return { error: `这份 PPT 共有 ${source.slides.length} 页，请指定有效页码。` };
        const images = draft?.images ?? new Map((original?.images ?? []).map(({ elementId, box }) =>
          [elementId, { box: elementBoxSchema.parse(box) }] as const));
        return {
          presentationId, slideNumber, slideSize,
          elements: getSlideElements(page, getSlideColors(source)[index], index, images, source).map(describeSlideElement),
        };
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Slide element lookup failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "读取 PPT 元素失败，请稍后重试。" };
      }
    },
  });
}

export function createAddOrRemoveSlideElementsTool(userId: string, drafts: PresentationDrafts) {
  return tool({
    description: "Stage additions and/or removals on one slide in this turn's draft. Specify each new element's type and x, y, w, h in inches on a 13⅓ by 7½ inch slide. The server assigns new IDs. For image additions use a generatedImageId from generateImage. For removal use actual element IDs from listSlideElements on the same PPT and slide.",
    inputSchema: slideInputSchema.extend({
      add: z.array(slideElementDefinitionSchema).max(20).optional(),
      remove: z.array(elementIdSchema).max(50).optional(),
    }).refine(({ add, remove }) => Boolean(add?.length || remove?.length), "Specify at least one addition or removal."),
    execute: async ({ presentationId, slideNumber, add = [], remove = [] }, { abortSignal }) => {
      try {
        return await drafts.edit(presentationId, abortSignal, async ({ source, images, stage }) => {
          const index = slideNumber - 1;
          const page = source.slides[index];
          if (!page) return { error: `这份 PPT 共有 ${source.slides.length} 页，请指定有效页码。` };

          const colors = getSlideColors(source)[index];
          const elements = getSlideElements(page, colors, index, images, source);
          const byId = new Map(elements.map((element) => [element.id, element]));
          const removals = new Set(remove);
          if (removals.size !== remove.length) return { error: "待删除的元素 ID 有重复。" };
          for (const id of removals) {
            if (!byId.has(id)) return { error: `第 ${slideNumber} 页不存在元素 ${id}，请重新查询该页。` };
          }

          const generatedImageIds = new Set<string>();
          for (const [position, definition] of add.entries()) {
            const label = `第 ${position + 1} 个新增元素`;
            if (!isOnSlide(definition.box)) return { error: `${label}的位置或尺寸超出页面。` };
            if (definition.type === "image") {
              const { width, height } = imagePixelSize(definition.box);
              if (width < 1 || height < 1) return { error: `${label}的图片尺寸太小。` };
              generatedImageIds.add(definition.generatedImageId);
            }
          }

          const generatedImages = new Map(generatedImageIds.size ? (await getPrisma().generatedImage.findMany({
            where: { userId, id: { in: [...generatedImageIds] } },
            select: { id: true, bytes: true },
          })).map(({ id, bytes }) => [id, bytes] as const) : []);
          if (generatedImages.size !== generatedImageIds.size) {
            return { error: "找不到要新增的图片，请使用当前用户已生成的图片。" };
          }
          abortSignal?.throwIfAborted();

          const revised = { ...page };
          const removedTemplateIds = [...(page.removedElementIds ?? [])];
          for (const id of removals) {
            const element = byId.get(id)!;
            if (element.templateKey) removedTemplateIds.push(id);
            if (element.type !== "image") continue;
            images.delete(id);
            if (element.templateKey) {
              delete revised.imageBrief;
              delete revised.imageLayout;
              delete revised.imageFit;
              // Keep the surviving template text in place when its layout image disappears.
              revised.textBoxes = { ...page.textBoxes };
              for (const text of elements) {
                if (text.type === "text" && text.templateKey && !removals.has(text.id)) {
                  revised.textBoxes[text.templateKey] = text.box;
                }
              }
            }
          }
          if (removedTemplateIds.length) revised.removedElementIds = removedTemplateIds;

          const added: AddedSlideElement[] = add.map((definition) => {
            const id = randomUUID();
            if (definition.type === "text") return { ...definition, id };
            const { generatedImageId, box, ...element } = definition;
            images.set(id, { slideId: page.slideId, bytes: generatedImages.get(generatedImageId)!, box, fallback: false });
            return { ...element, id };
          });
          revised.addedElements = [...(page.addedElements ?? []).filter(({ id }) => !removals.has(id)), ...added];
          const slides = [...source.slides];
          slides[index] = revised;
          stage({ ...source, slides });
          return {
            presentationId, slideNumber, addedElementIds: added.map(({ id }) => id), removedElementIds: remove,
          };
        });
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Slide element change failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "PPT 元素修改失败，未生成新版本。请稍后重试。" };
      }
    },
  });
}
