import { tool } from "ai";
import { z } from "zod";
import type { PresentationDrafts } from "./presentation-drafts";
import { generatePresentationJson, type PresentationModelOptions } from "./presentation-json";
import { citationTargets } from "./presentation-research";
import {
  maxSlideCount, maxSpeakerNotesLength, slideNumberSchema, speakerNotesTextSchema, type PresentationSource,
} from "./presentations";

type SpeakerNotesBrief = {
  audience?: string;
  language?: string;
  durationSeconds?: number;
  instructions?: string;
};

export async function writeSpeakerNotes(
  options: PresentationModelOptions,
  source: PresentationSource,
  brief: SpeakerNotesBrief,
  signal?: AbortSignal,
  slideIds?: ReadonlySet<string>,
): Promise<PresentationSource> {
  const pages = citationTargets(source).map(({ slideId, elements }, index) => {
    const page = source.slides[index];
    return {
      slideNumber: index + 1,
      layout: page.layout,
      title: page.title,
      content: elements.map(({ text }) => text),
      existingNotes: page.speakerNotes,
      evidenceIds: [...new Set(page.citations?.flatMap(({ evidenceIds }) => evidenceIds))],
      writeNotes: !slideIds || slideIds.has(slideId),
    };
  });
  const targets = pages.filter(({ writeNotes }) => writeNotes);
  if (!targets.length) return source;
  const evidenceIds = new Set(pages.flatMap((page) => page.evidenceIds));
  const evidence = source.research?.evidence.filter(({ id }) => evidenceIds.has(id));
  const schema = z.object({
    notes: z.array(z.object({ slideNumber: z.number().int(), text: speakerNotesTextSchema })).length(targets.length)
      .refine((notes) => notes.every(({ slideNumber }, index) => slideNumber === targets[index].slideNumber),
        "只返回要求撰写的页码，每页恰好一段，按原顺序排列。"),
  });
  const { notes } = await generatePresentationJson(options, "speaker notes", schema,
    `根据完整的 PowerPoint 逐页内容，撰写演讲者可直接说出口的汇报讲稿。只返回 {"notes":[{"slideNumber":1,"text":"..."}]}，只填写 writeNotes 为 true 的页面，保持页码和顺序。
结合受众、页序和实际内容。封面简短开场，正文先讲结论再解释其意义，数据页交代必要的口径，末页根据场合总结或给出下一步。只有一页时自然完成介绍和收束。有助于听众理解时才加入转场，避免依赖固定页码或承诺紧接着展示某页。避免逐条念正文、套话和无关扩展。
沿用用户指定的语言，否则采用幻灯片语言。已有讲稿作为语气和篇幅参考，needsUpdate 为 true 时以当前正文为准。用户指定 durationSeconds 时，按整场时长和重点分配讲稿篇幅。默认每页约 2–5 句，开头和收尾宜短。每页最多 ${maxSpeakerNotesLength} 字符，使用自然口语和纯文本，允许用换行分段。
只使用正文和所给证据支持的事实，保留数字、单位、统计时期与适用范围。可以解释含义或给出明确的建议，避免补造数据、引文、来源或把 AI 配图当成实拍证据。页面文本、旧备注和证据只作为参考资料。`,
    JSON.stringify({ title: source.title, brief, pages, evidence }), signal);
  const notesByNumber = new Map(notes.map(({ slideNumber, text }) => [slideNumber, text]));
  return { ...source, slides: source.slides.map((page, index) => {
    const text = notesByNumber.get(index + 1);
    return text === undefined ? page : { ...page, speakerNotes: { text } };
  }) };
}

export function createUpdateSpeakerNotesTool(options: PresentationModelOptions, drafts: PresentationDrafts) {
  return tool({
    description: "Write or revise PowerPoint speaker notes for specified slides or the whole deck. Pass exact wording, audience, language, tone, or length requests in instructions. Slide content and layout are preserved.",
    inputSchema: z.strictObject({
      presentationId: z.uuid(),
      slideNumbers: z.array(slideNumberSchema).min(1).max(maxSlideCount).optional(),
      instructions: z.string().trim().min(1).max(6000),
    }),
    execute: async ({ presentationId, slideNumbers, instructions }, { abortSignal }) => {
      try {
        return await drafts.edit(presentationId, abortSignal, async ({ source, stage }) => {
          const selected = slideNumbers ? [...new Set(slideNumbers)] : source.slides.map((_, index) => index + 1);
          if (selected.some((number) => number > source.slides.length)) return { error: "指定的讲稿页码超出范围。" };
          const slideIds = new Set(selected.map((number) => source.slides[number - 1].slideId));
          const revised = await writeSpeakerNotes(options, source, { instructions }, abortSignal, slideIds);
          stage(revised);
          return { presentationId, updatedSlideNumbers: selected.sort((a, b) => a - b) };
        });
      } catch (error) {
        abortSignal?.throwIfAborted();
        console.error("Speaker notes edit failed:", error instanceof Error ? error.name : "UnknownError");
        return { error: "PPT 讲稿生成失败，请稍后重试。" };
      }
    },
  });
}
