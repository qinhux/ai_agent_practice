import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { preparePresentationImages } from "./asset-manager";
import { getPrisma } from "./db";
import type { PresentationDrafts } from "./presentation-drafts";
import {
  getSlideAppearance,
  getSlideImageBrief,
  getSlideImageSlots,
  maxSlideCount,
  slideContentSchema,
  slideNumberSchema,
  type PresentationSlide,
} from "./presentations";
import { readPresentationSource } from "./save-presentation";

const slideReferenceSchema = z.union([
  z.strictObject({ slideId: z.uuid().describe("Stable ID from the slide directory") }),
  z.strictObject({
    currentSlideNumber: slideNumberSchema.describe("Use only for explicit references to page numbers after earlier operations"),
  }),
]);

const positionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("start") }),
  z.strictObject({ kind: z.literal("end") }),
  z.strictObject({ kind: z.literal("before"), target: slideReferenceSchema }),
  z.strictObject({ kind: z.literal("after"), target: slideReferenceSchema }),
]);

const operationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("add"),
    position: positionSchema,
    slides: z.array(slideContentSchema.refine(
      (page) => page.layout !== "cover" || Boolean(page.coverStyle),
      { path: ["coverStyle"], message: "按主题选择 full-bleed 或 split-right 封面。" },
    ).refine(
      (page) => getSlideImageSlots(page.layout).every(({ id, required }) => !required || Boolean(getSlideImageBrief(page, id))),
      { path: ["imageBriefs"], message: "为该版式的每个必填槽位提供配图描述。" },
    )).min(1).max(maxSlideCount),
  }),
  z.strictObject({ op: z.literal("remove"), targets: z.array(slideReferenceSchema).min(1).max(maxSlideCount) }),
  z.strictObject({ op: z.literal("move"), target: slideReferenceSchema, position: positionSchema }),
]);

const slideOperationsInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("list"), presentationId: z.uuid() }),
  z.strictObject({
    mode: z.literal("edit"),
    presentationId: z.uuid(),
    operations: z.array(operationSchema).min(1).max(3 * maxSlideCount),
  }),
]);

type SlideReference = z.infer<typeof slideReferenceSchema>;
type SlidePosition = z.infer<typeof positionSchema>;

function slideIndex(slides: readonly PresentationSlide[], reference: SlideReference) {
  return "slideId" in reference
    ? slides.findIndex(({ slideId }) => slideId === reference.slideId)
    : reference.currentSlideNumber <= slides.length ? reference.currentSlideNumber - 1 : -1;
}

function insertionIndex(slides: readonly PresentationSlide[], position: SlidePosition) {
  if (position.kind === "start") return 0;
  if (position.kind === "end") return slides.length;
  const index = slideIndex(slides, position.target);
  return index < 0 ? -1 : index + Number(position.kind === "after");
}

function slideDirectory(slides: readonly PresentationSlide[]) {
  return slides.map(({ slideId, title, layout }, index) => ({ slideId, slideNumber: index + 1, title, layout }));
}

export function createAddRemoveOrMoveSlidesTool(userId: string, drafts: PresentationDrafts) {
  return tool({
    description: "List whole slides or stage an ordered batch that adds, removes, and/or moves whole slides in a PowerPoint draft. List first to resolve the user's original page numbers or titles to stable slide IDs. For a new cover, choose coverStyle full-bleed for a scenic background or split-right for a focused subject, and supply imageBriefs.image. New metrics slides use 1–3 sourced values with units, steps use 3–5 ordered nodes, image-focus uses imageBriefs.image for an AI illustration and 1–2 observations, and image-comparison uses leftCaption, rightCaption and both imageBriefs.leftImage and imageBriefs.rightImage. Use currentSlideNumber only when the user explicitly refers to the order after earlier operations. All references within one operation are resolved before that operation changes the order.",
    inputSchema: slideOperationsInputSchema,
    execute: async (input, { abortSignal }) => {
      const { presentationId } = input;
      try {
        if (input.mode === "list") {
          const draft = drafts.get(presentationId);
          const result = draft ?? readPresentationSource(await getPrisma().presentation.findUnique({
            where: { id: presentationId, userId },
            select: { source: true },
          }));
          abortSignal?.throwIfAborted();
          if ("error" in result) return result;
          return { presentationId, slides: slideDirectory(result.source.slides) };
        }

        return await drafts.edit(presentationId, abortSignal, async ({ source, images, stage }) => {
          let slides = [...source.slides];
          for (const [index, operation] of input.operations.entries()) {
            const label = `第 ${index + 1} 个操作`;
            if (operation.op === "remove") {
              const targets = new Set(operation.targets.map((target) => slideIndex(slides, target)));
              if (targets.has(-1)) return { error: `${label}的待删除页面不存在。` };
              if (targets.size !== operation.targets.length) return { error: `${label}包含重复的待删除页面。` };
              slides = slides.filter((_, slideIndex) => !targets.has(slideIndex));
              continue;
            }

            const destination = insertionIndex(slides, operation.position);
            if (destination < 0) return { error: `${label}指定的目标位置不存在。` };
            if (operation.op === "add") {
              const added = operation.slides.map((slide) => ({ ...slide, slideId: randomUUID() }));
              slides.splice(destination, 0, ...added);
              continue;
            }

            const from = slideIndex(slides, operation.target);
            if (from < 0) return { error: `${label}的待移动页面不存在。` };
            const [page] = slides.splice(from, 1);
            slides.splice(destination - Number(from < destination), 0, page);
          }

          if (slides.length < 1 || slides.length > maxSlideCount) {
            return { error: `修改后必须保留 1–${maxSlideCount} 页幻灯片。` };
          }
          const directory = slideDirectory(slides);
          if (slides.length === source.slides.length && slides.every((page, index) => page === source.slides[index])) {
            return { presentationId, changed: false, slides: directory };
          }

          const originalAppearances = new Map(source.slides.map((page, index) =>
            [page.slideId, getSlideAppearance(page, index, source.slides.length)] as const));
          const addedIds = new Set<string>();
          const remainingIds = new Set(slides.map(({ slideId }) => slideId));
          for (const [elementId, image] of images) {
            if (!remainingIds.has(image.slideId)) images.delete(elementId);
          }
          slides = slides.map((page, index) => {
            const original = originalAppearances.get(page.slideId);
            if (!original) {
              addedIds.add(page.slideId);
              return page;
            }
            const current = getSlideAppearance(page, index, slides.length);
            return current.firstSlide === original.firstSlide && current.darkBackground === original.darkBackground
              ? page : { ...page, appearance: original };
          });

          const revised = { ...source, slides };
          if (addedIds.size) {
            const addedImages = await preparePresentationImages(revised, abortSignal, addedIds);
            for (const [elementId, image] of addedImages) images.set(elementId, image);
          }
          stage(revised);
          return { presentationId, changed: true, slides: directory };
        });
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Slide edit failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "PPT 页面操作失败，请稍后重试。" };
      }
    },
  });
}
