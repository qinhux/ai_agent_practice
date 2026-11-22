import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import JSZip from "jszip";
import { MockLanguageModelV3 } from "ai/test";
import { WebResearch } from "../src/server/web-research.ts";
import { extractEvidence, bindCitationReferences, researchPresentation, validatePresentationCitations } from "../src/server/presentation-research.ts";
import { presentationSourceSchema, getSlideColors, getSlideElements, getCitationBand, renderPresentation, templateElementId } from "../src/server/presentations.ts";
import { PresentationDrafts } from "../src/server/presentation-drafts.ts";
import { createPresentationTool } from "../src/server/presentation-tool.ts";
import { createAddRemoveOrMoveSlidesTool } from "../src/server/add-remove-or-move-slides-tool.ts";
import { createUpdateSpeakerNotesTool } from "../src/server/presentation-speaker-notes.ts";
import { reviewPresentation } from "../src/server/presentation-visual-review.ts";
import { preparePresentationDrafts } from "../src/server/save-presentation.ts";

function modelFor(...outputs) {
  return new MockLanguageModelV3({ doGenerate: outputs.map((output) => ({
    content: [{ type: "text", text: JSON.stringify(output) }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } }, warnings: [],
  })) });
}
function fixture() {
  const sourceId = randomUUID(), evidenceId = randomUUID(), slideId = randomUUID();
  return presentationSourceSchema.parse({
    title: "资料引用测试",
    theme: { themeId: "research", colors: { primary: "17324D", secondary: "718096", accent: "E5A64B",
      modes: { light: { background: "FFFFFF", text: "17324D", accentText: "8A5314" },
        dark: { background: "17324D", text: "FFFFFF", accentText: "E5A64B" } } },
      visualStyle: "简洁", imageStyle: "插画",
    },
    slides: [{ slideId, layout: "bullets", title: "产业发展概览", points: ["2025 年示例地区产值为 100 亿元。", "建议结合地方条件制定发展计划。"],
      citations: [{ target: "point1", text: "2025 年示例地区产值为 100 亿元。", evidenceIds: [evidenceId] }] }],
    research: { mode: "auto", status: "completed", warnings: [], sources: [{ id: sourceId, kind: "web",
      title: "示例统计公报（测试数据）", publisher: "统计机构", url: "https://example.org/report?a=1&b=2",
      accessedAt: "2026-11-18T00:00:00.000Z", publishedAt: "2026-02-01", content: "2025 年示例地区产值为 100 亿元。" }],
      evidence: [{ id: evidenceId, sourceId, claim: "2025 年产值为100亿元", quote: "2025 年示例地区产值为 100 亿元。", period: "2025年", scope: "示例地区", location: "产业统计" }] },
  });
}

test("network disabled and missing credentials fail without sending a request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected network"); });
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await assert.rejects(new WebResearch("off").search("公开主题"), /仅使用提供/);
    await assert.rejects(new WebResearch().search("公开主题"), /DEEPSEEK_API_KEY/);
    assert.equal(calls, 0);
  } finally { if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous; }
});

test("DeepSeek Search/Fetch protocol, metadata and caching preserve actual source provenance", async (t) => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.method, "POST");
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json(url.endsWith("/search") ? { results: [
      { title: "报告", url: "https://example.org/report", snippet: "短摘要", summary: "搜索摘要",
        site_name: "发布机构", date: "2026-11-01T00:00:00Z", authority: 3, rerank_score: 2.4 },
      { title: "不可读", url: "https://example.org/blocked", snippet: "不能引用的数字999", site_name: null, date: null },
      { title: "不安全协议", url: "file:///private/report", summary: "" },
    ] } : JSON.parse(init.body).url.endsWith("blocked")
      ? { title: "不可读", content: " " }
      : { title: "原文页面标题", content: "实际原文100" });
  });
  try {
    const web = new WebResearch();
    const [hits, repeated] = await Promise.all([web.search("报告"), web.search("报告")]);
    assert.deepEqual(hits, repeated);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].snippet, "搜索摘要");
    assert.equal(hits[1].snippet, "不能引用的数字999");
    const [read, readAgain] = await Promise.all([web.read(hits[0].id), web.read(hits[0].id)]);
    assert.deepEqual(read, readAgain);
    assert.equal(read.id, hits[0].id);
    assert.equal(read.content, "实际原文100");
    assert.equal(read.title, "原文页面标题");
    assert.equal(read.publisher, "发布机构");
    assert.equal(read.publishedAt, "2026-11-01T00:00:00Z");
    await assert.rejects(web.read(hits[1].id), /不能将搜索摘要/);
    assert.equal((await web.sources()).length, 1);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], { url: "https://api.deepseek.com/v1/tools/search", body: { query: "报告", count: 4, need_content: false } });
    assert.deepEqual(calls[1], { url: "https://api.deepseek.com/v1/tools/fetch", body: { url: "https://example.org/report" } });
    await assert.rejects(web.read(randomUUID()), /先搜索/);
  } finally { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; }
});

test("automatic search failure produces an explicit warning; required search stops", async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const plan = { useWeb: true, queries: ["城市 官方统计"] };
    const auto = await researchPresentation({ model: modelFor(plan) }, { topic: "城市", slideCount: 1 }, "", new WebResearch());
    assert.equal(auto.status, "unavailable");
    assert.match(auto.warnings[0], /DEEPSEEK_API_KEY/);
    await assert.rejects(researchPresentation({ model: modelFor(plan) }, { topic: "城市", slideCount: 1 }, "", new WebResearch("on")), /DEEPSEEK_API_KEY/);
  } finally { if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous; }
});

test("DeepSeek query limit rejects invalid input without truncation and counts Unicode characters", async (t) => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).query, "😀".repeat(128));
    return Response.json({ results: [] });
  });
  try {
    const web = new WebResearch();
    await assert.rejects(web.search("字".repeat(129)), /1–128/);
    await assert.rejects(web.search(" "), /1–128/);
    assert.equal(calls, 0);
    assert.deepEqual(await web.search("😀".repeat(128)), []);
    assert.equal(calls, 1);
  } finally { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; }
});

test("DeepSeek HTTP failures and malformed Fetch responses never create source evidence", async (t) => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  let response;
  t.mock.method(globalThis, "fetch", async () => response.clone());
  try {
    for (const status of [401, 402, 403, 404, 429, 500]) {
      response = Response.json({ error: { message: "not exposed" } }, { status });
      await assert.rejects(new WebResearch().search("主题"), new RegExp(`HTTP ${status}`));
    }
    const web = new WebResearch();
    response = Response.json({ results: [{ title: "报告", url: "https://example.org/report", summary: "不能用作原文" }] });
    const [hit] = await web.search("报告");
    response = Response.json({ title: "格式错误", content: null });
    await assert.rejects(web.read(hit.id), /读取结果格式无效/);
    assert.deepEqual(await web.sources(), []);
    response = Response.json({ error: { message: "wrong schema" } });
    await assert.rejects(new WebResearch().search("报告"), /搜索结果格式无效/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(new WebResearch().search("报告", controller.signal), { name: "AbortError" });
  } finally { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; }
});

test("evidence extraction rejects quotes not present in the retrieved original", async () => {
  const source = fixture().research.sources[0];
  const model = modelFor({ evidence: [
    { sourceId: source.id, claim: "有效证据", quote: "2025 年示例地区产值为 100 亿元。" },
    { sourceId: source.id, claim: "伪造摘录", quote: "产值为999亿元" },
    { sourceId: randomUUID(), claim: "伪造来源", quote: source.content },
  ] });
  const evidence = await extractEvidence({ model }, [source], "产业");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].claim, "有效证据");
});

test("readable sources without extracted quotes continue generation without a verification gate", async () => {
  const source = fixture().research.sources[0];
  const web = { mode: "on", search: async () => [{ id: source.id }], read: async () => source };
  const research = await researchPresentation({ model: modelFor({ useWeb: true, queries: ["资料"] }, { evidence: [] }) },
    { topic: "产业", slideCount: 1 }, "", web);
  assert.equal(research.status, "completed");
  assert.equal(research.evidence.length, 0);
  assert.match(research.warnings[0], /仍会继续生成/);
});

test("explicit user prohibition overrides enabled search; the off switch never permits network access", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("unexpected request"); });
  const brief = { topic: "内部方案", slideCount: 1 };
  const prohibited = await researchPresentation({ model: modelFor({ useWeb: true, userProhibitsWeb: true, queries: ["主题"] }) },
    brief, "", new WebResearch("on"));
  assert.equal(prohibited.status, "skipped");
  const disabled = await researchPresentation({ model: modelFor({ useWeb: true, queries: ["主题"] }) }, brief, "", new WebResearch("off"));
  assert.equal(disabled.status, "skipped");
  assert.equal(requests, 0);
});

test("writer references bind without model review; invalid targets and IDs are omitted", () => {
  const source = fixture();
  const binding = { slideId: source.slides[0].slideId, target: "point1", evidenceIds: [source.research.evidence[0].id] };
  const bound = bindCitationReferences(source, [binding,
    { ...binding, target: "missing" }, { ...binding, target: "point2", evidenceIds: [randomUUID()] }]);
  validatePresentationCitations(bound);
  assert.equal(bound.slides[0].citations.length, 1);
  assert.equal(bound.slides[0].citations[0].text, source.slides[0].points[0]);
  const edited = structuredClone(bound);
  edited.slides[0].points[0] = "产值999亿元";
  assert.throws(() => validatePresentationCitations(edited), /引用记录与当前文本不一致/);
  const tampered = structuredClone(source);
  tampered.research.evidence[0].quote = "捏造的原文";
  assert.throws(() => validatePresentationCitations(tampered), /原文不一致/);
});

test("moving/styling preserves citations; content edits succeed and remove stale citations", async () => {
  const source = fixture();
  source.slides.push({ ...structuredClone(source.slides[0]), slideId: randomUUID(), title: "第二页" });
  const drafts = new PresentationDrafts("test");
  const id = drafts.create(source, new Map());
  await drafts.edit(id, undefined, async ({ source, stage }) => {
    stage({ ...source, slides: source.slides.map((page) => ({ ...page, textStyles: { point1: { bold: true } } })) });
    return { ok: true };
  });
  assert.deepEqual(drafts.get(id).source.slides[0].citations, source.slides[0].citations);
  await drafts.edit(id, undefined, async ({ source, stage }) => {
    stage({ ...source, slides: [...source.slides].reverse() });
    return { ok: true };
  });
  assert.equal(drafts.get(id).source.slides[0].slideId, source.slides[1].slideId);
  validatePresentationCitations(drafts.get(id).source);
  assert.deepEqual(drafts.get(id).source.slides[0].citations, source.slides[1].citations);
  const result = await drafts.edit(id, undefined, async ({ source, stage }) => {
    stage({ ...source, slides: source.slides.map((page) => ({ ...page, points: ["产值999亿元"] })) });
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal(drafts.get(id).source.slides[0].points[0], "产值999亿元");
  assert.deepEqual(drafts.get(id).source.slides[0].citations, []);
});

test("many sources reserve multiple rows, and custom text cannot silently cover the source band", async () => {
  const source = fixture();
  for (let n = 1; n < 6; n++) {
    const id = randomUUID(), evidenceId = randomUUID();
    source.research.sources.push({ ...source.research.sources[0], id, title: `来源${n}` });
    source.research.evidence.push({ ...source.research.evidence[0], id: evidenceId, sourceId: id });
    source.slides[0].citations.push({ target: `point${n + 1}`, text: "引用内容", evidenceIds: [evidenceId] });
  }
  source.slides[0].points = ["内容一", "内容二", "内容三", "内容四"];
  const band = getCitationBand(source.slides[0], source);
  assert.equal(band.columns, 2);
  assert.equal(band.rows, 3);
  const colors = getSlideColors(source);
  const elements = getSlideElements(source.slides[0], colors[0], 0, new Map(), source);
  assert.ok(elements.every((item) => item.box.y + item.box.h <= band.y - 0.12 + 1e-9));
  source.slides[0].textBoxes = { point1: { x: 1, y: 6.5, w: 5, h: 0.5 } };
  assert.throws(() => getSlideElements(source.slides[0], colors[0], 0, new Map(), source), /引用来源区重叠/);
});

test("editing an uncited field keeps other references without any model calls", async () => {
  const source = fixture();
  const drafts = new PresentationDrafts("test");
  const id = drafts.create(source, new Map());
  const result = await drafts.edit(id, undefined, async ({ source, stage }) => {
    stage({ ...source, slides: source.slides.map((page) => ({ ...page, points: [page.points[0], "新增分析内容"] })) });
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.deepEqual(drafts.get(id).source.slides[0].citations, source.slides[0].citations);
  validatePresentationCitations(drafts.get(id).source);
});

test("generation writes content and citations in one pass without review or corrective regeneration", async () => {
  const original = fixture();
  const stages = [];
  const model = new MockLanguageModelV3({ doGenerate: async ({ prompt }) => {
    const system = prompt.find((message) => message.role === "system").content;
    const data = JSON.parse(prompt.find((message) => message.role === "user").content[0].text);
    let output;
    if (system.includes("制定资料搜索计划")) {
      stages.push("research"); output = { useWeb: false, queries: [] };
    } else if (system.includes("从给定来源提取")) {
      stages.push("evidence"); output = { evidence: [{ sourceId: data.sources[0].id, claim: "2025年产值100亿元",
        quote: "2025 年示例地区产值为 100 亿元。", period: "2025年" }] };
    } else if (system.includes("为目标受众策划 PowerPoint")) {
      stages.push("outline"); output = { theme: { ...original.theme, defaultBackgroundMode: "light" },
        plan: { title: original.title, slides: [{ layout: "bullets", goal: "呈现产业发展", keyPoints: ["2025年产值100亿元"], imageSlots: [] }] } };
    } else if (system.includes("写出逐页内容")) {
      stages.push("content");
      output = { slides: [{ slideNumber: 1, content: { layout: "bullets", title: "产业概览", textHighlights: {},
        points: ["2025 年示例地区产值为 100 亿元。", "未核验的新指标999。"] },
        citations: [{ target: "point1", evidenceIds: [data.brief.research.evidence[0].id] }] }] };
    } else if (system.includes("撰写演讲者可直接说出口的汇报讲稿")) {
      stages.push("notes");
      assert.equal(data.brief.durationSeconds, 60);
      assert.equal(data.brief.audience, "项目团队");
      assert.match(data.pages[0].content[1], /100 亿元/);
      assert.equal(data.evidence[0].period, "2025年");
      output = { notes: [{ slideNumber: 1, text: "我们先看 2025 年的数据。示例地区的产值为 100 亿元。" }] };
    } else throw new Error(`unexpected stage: ${system.slice(0, 80)}`);
    return { content: [{ type: "text", text: JSON.stringify(output) }], finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } }, warnings: [] };
  } });
  const drafts = new PresentationDrafts("test");
  const tool = createPresentationTool(model, drafts, undefined, {
    userText: "仅根据这些材料做一页PPT：2025 年示例地区产值为 100 亿元。", webResearch: new WebResearch("off"),
  });
  const result = await tool.execute({ topic: "产业概览", slideCount: 1, durationSeconds: 60, audience: "项目团队" },
    { toolCallId: "test", messages: [] });
  assert.ok(result.presentationId, JSON.stringify(result));
  assert.deepEqual(stages, ["research", "evidence", "outline", "content", "notes"]);
  const source = drafts.get(result.presentationId).source;
  assert.equal(source.slides.length, 1);
  assert.match(source.slides[0].points[0], /100/);
  assert.match(source.slides[0].points[1], /999/);
  assert.equal(source.slides[0].citations.length, 1);
  assert.match(source.slides[0].speakerNotes.text, /我们先看 2025 年的数据/);
  validatePresentationCitations(source);

  stages.length = 0;
  const optedOut = await tool.execute({ topic: "产业概览", slideCount: 1, includeSpeakerNotes: false },
    { toolCallId: "opt-out", messages: [] });
  assert.deepEqual(stages, ["research", "evidence", "outline", "content"]);
  assert.equal(drafts.get(optedOut.presentationId).source.slides[0].speakerNotes, undefined);
});

test("speaker notes follow their slide, are marked after content edits, and can be rewritten individually", async () => {
  const source = fixture();
  const original = source.slides[0];
  original.speakerNotes = { text: "原来的讲稿" };
  const drafts = new PresentationDrafts("test");
  const presentationId = drafts.create(source, new Map());
  const context = { toolCallId: "test", messages: [] };
  const model = modelFor(
    { notes: [{ slideNumber: 2, text: "页码错误，应重试。" }] },
    { notes: [{ slideNumber: 1, text: "新增页讲稿" }] },
    { notes: [{ slideNumber: 2, text: "更新后的讲稿" }] },
  );
  const editSlides = createAddRemoveOrMoveSlidesTool("test", drafts, { model });
  const added = await editSlides.execute({ mode: "edit", presentationId, operations: [{ op: "add",
    position: { kind: "start" }, slides: [{ layout: "summary", title: "简报", points: ["先介绍背景。"] }],
  }] }, context);
  assert.equal(added.changed, true);
  const [first, second] = drafts.get(presentationId).source.slides;
  assert.equal(first.speakerNotes.text, "新增页讲稿");
  assert.equal(second.slideId, original.slideId);
  assert.deepEqual(second.speakerNotes, original.speakerNotes);

  await drafts.edit(presentationId, undefined, async ({ source, stage }) => {
    stage({ ...source, slides: [first, { ...second, textStyles: { title: { bold: true } } }] });
    return { ok: true };
  });
  assert.deepEqual(drafts.get(presentationId).source.slides[1].speakerNotes, original.speakerNotes);
  await drafts.edit(presentationId, undefined, async ({ source, stage }) => {
    stage({ ...source, slides: [first, { ...source.slides[1], title: "更新过的产业概览" }] });
    return { ok: true };
  });
  assert.deepEqual(drafts.get(presentationId).source.slides[1].speakerNotes, { text: "原来的讲稿", needsUpdate: true });

  const editNotes = createUpdateSpeakerNotesTool({ model }, drafts);
  const result = await editNotes.execute({ presentationId, slideNumbers: [2], instructions: "重写第二页讲稿。" }, context);
  assert.deepEqual(result.updatedSlideNumbers, [2]);
  const revised = presentationSourceSchema.parse(drafts.get(presentationId).source);
  assert.deepEqual(revised.slides[0].speakerNotes, first.speakerNotes);
  assert.deepEqual(revised.slides[1].speakerNotes, { text: "更新后的讲稿" });
  assert.equal(revised.slides[1].title, "更新过的产业概览");
  assert.deepEqual(revised.slides[1].citations, original.citations);
  assert.equal(model.doGenerateCalls.length, 3);
});

test("PPTX stores the speaker script in notes for cited and uncited slides", async () => {
  const source = fixture();
  const first = source.slides[0];
  first.speakerNotes = { text: "先介绍 A & B 的背景。\n接下来解释这组数据。" };
  source.slides.push({ slideId: randomUUID(), layout: "summary", title: "下一步",
    points: ["制定发展计划"], speakerNotes: { text: "最后谈谈下一步。" } });
  const archive = await JSZip.loadAsync(await renderPresentation(source, getSlideColors(source), new Map()));
  const notes = await archive.file("ppt/notesSlides/notesSlide1.xml").async("string");
  assert.match(notes, /<a:t>先介绍 A &amp; B 的背景。<\/a:t>.*?<\/a:p><a:p>.*?<a:t>接下来解释这组数据。<\/a:t>/);
  assert.match(notes, /接下来解释这组数据。.*引用详情.*原文：2025 年示例地区产值为 100 亿元/);
  assert.match(await archive.file("ppt/notesSlides/notesSlide2.xml").async("string"), /最后谈谈下一步。/);
  assert.doesNotMatch(await archive.file("ppt/slides/slide1.xml").async("string"), /接下来解释这组数据/);
  assert.doesNotMatch(await archive.file("ppt/slides/slide2.xml").async("string"), /最后谈谈下一步/);
});

test("PPTX exports source links, per-content markers, original evidence notes, and a reserved source band", async () => {
  const source = fixture();
  source.slides.push({ ...structuredClone(source.slides[0]), slideId: randomUUID(), backgroundMode: "dark" });
  const colors = getSlideColors(source);
  for (const [index, page] of source.slides.entries()) {
    const band = getCitationBand(page, source);
    const elements = getSlideElements(page, colors[index], index, new Map(), source);
    assert.ok(elements.filter((item) => item.type === "text").every((item) => item.box.y + item.box.h <= band.y - 0.12 + 1e-9));
  }
  const bytes = await renderPresentation(source, colors, new Map());
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("ppt/slides/slide1.xml").async("string");
  const rels = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
  const notes = await zip.file("ppt/notesSlides/notesSlide1.xml").async("string");
  assert.match(xml, /来源 \[1\]/);
  assert.match(xml, /\[1\]/);
  assert.match(rels, /https:\/\/example.org\/report\?a=1&amp;b=2/);
  assert.match(notes, /原文：2025 年示例地区产值为 100 亿元/);
  assert.match(notes, /统计时期：2025年/);
  assert.equal(Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path)).length, 2);
  if (process.env.PPT_RESEARCH_PREVIEW_DIR) {
    await mkdir(process.env.PPT_RESEARCH_PREVIEW_DIR, { recursive: true });
    await writeFile(`${process.env.PPT_RESEARCH_PREVIEW_DIR}/research-preview.pptx`, bytes);
  }
});

function renderedWords(source, omittedKey) {
  const colors = getSlideColors(source);
  return source.slides.map((slide, index) =>
    getSlideElements(slide, colors[index], index, new Map(), source)
      .filter(({ type, templateKey }) => type === "text" && (omittedKey === undefined || templateKey !== omittedKey))
      .map(({ text, box }) => ({ text, box: { ...box, w: 0.2, h: 0.1 } })));
}

test("visual review adopts one verified text repair with the same content and citations", async () => {
  const source = fixture();
  let renders = 0;
  const result = await reviewPresentation(source, new Map(), new AbortController().signal, { readLayout: async () =>
    renderedWords(source, ++renders === 1 ? "title" : undefined) });
  assert.equal(renders, 2);
  assert.deepEqual(result.repairedPages, [1]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.source.slides[0].title, source.slides[0].title);
  assert.deepEqual(result.source.slides[0].citations, source.slides[0].citations);
  assert.ok(result.source.slides[0].textBoxes?.title || result.source.slides[0].textStyles?.title?.fontSize);
  validatePresentationCitations(result.source);
  const archive = await JSZip.loadAsync(result.bytes);
  assert.match(await archive.file("ppt/slides/slide1.xml").async("string"), /产业发展概览/);
});

test("visual review keeps the original when a second render still has problems, or the renderer is unavailable", async () => {
  const source = fixture();
  const signal = new AbortController().signal;
  const attempts = [];
  const unchanged = await reviewPresentation(source, new Map(), signal, { readLayout: async (bytes) => {
    attempts.push(bytes);
    return renderedWords(source, "title");
  } });
  assert.equal(attempts.length, 2);
  assert.equal(unchanged.source, source);
  assert.equal(unchanged.bytes, attempts[0]);
  assert.equal(unchanged.checked, true);
  assert.match(unchanged.issues[0].message, /未完整匹配/);
  assert.deepEqual(unchanged.repairedPages, []);

  const unavailable = await reviewPresentation(source, new Map(), signal, { readLayout: async () => {
    throw new Error("Renderer unavailable");
  } });
  assert.equal(unavailable.source, source);
  assert.equal(unavailable.checked, false);
  assert.ok(unavailable.bytes.length > 0);
  assert.deepEqual(unavailable.issues, []);
});

test("visual review leaves an explicitly positioned textbox in place and reports its page", async () => {
  const source = fixture();
  source.slides[0].textBoxes = { title: { x: 0.6, y: 0.45, w: 8, h: 0.5 } };
  let renders = 0;
  const result = await reviewPresentation(source, new Map(), new AbortController().signal, { readLayout: async () => {
    renders++;
    return renderedWords(source, "title");
  } });
  assert.equal(renders, 1);
  assert.equal(result.source, source);
  assert.deepEqual(result.issues.map(({ page }) => page), [1]);
});

test("visual review reports overlapping rendered text without moving user-positioned boxes", async () => {
  const source = fixture();
  const box = { x: 0.7, y: 0.5, w: 8, h: 0.7 };
  source.slides[0].textBoxes = { title: box, point2: box };
  const result = await reviewPresentation(source, new Map(), new AbortController().signal, { readLayout: async () =>
    renderedWords(source) });
  assert.equal(result.source, source);
  assert.deepEqual(result.issues.map(({ page }) => page), [1]);
  assert.match(result.issues[0].message, /可能重叠/);
});

test("the model proposes explicit text and image adjustments for the affected slide", async () => {
  const source = fixture();
  const { slideId, title, citations } = source.slides[0];
  source.slides[0].imageBriefs = { image: "示例图" };
  const imageId = templateElementId(slideId, "image");
  const titleId = templateElementId(slideId, "title");
  const initialBox = { x: 0.5, y: 0.4, w: 2, h: 1 };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const images = new Map([[imageId, { slideId, bytes: png, box: initialBox, fallback: false }]]);
  const model = modelFor({ pages: [{ slideId, edits: [
    { elementId: titleId, box: { w: 5.3 } },
    { elementId: imageId, box: { x: 8, w: 3 } },
  ] }] });
  const result = await reviewPresentation(source, images, new AbortController().signal, {
    model: { model }, readLayout: async () => renderedWords(source),
  });
  assert.equal(model.doGenerateCalls.length, 1);
  assert.deepEqual(result.repairedPages, [1]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.source.slides[0].textBoxes.title.w, 5.3);
  assert.equal(result.source.slides[0].title, title);
  assert.deepEqual(result.source.slides[0].citations, citations);
  assert.deepEqual(result.images.get(imageId).box, { x: 8, y: 0.4, w: 3, h: 1.5 });
  assert.deepEqual(images.get(imageId).box, initialBox);
});

test("a repair plan cannot change manually positioned text or target a clean slide", async () => {
  const source = fixture();
  const { slideId } = source.slides[0];
  source.slides[0].textBoxes = { title: { x: 0.6, y: 0.45, w: 8, h: 0.5 } };
  const clean = { ...source.slides[0], slideId: randomUUID() };
  source.slides.push(clean);
  const signal = new AbortController().signal;
  for (const id of [slideId, clean.slideId]) {
    const model = modelFor({ pages: [{ slideId: id, edits: [
      { elementId: templateElementId(id, "title"), box: { x: 1 } },
    ] }] });
    let renders = 0;
    const result = await reviewPresentation(source, new Map(), signal, {
      model: { model }, async readLayout() {
        renders++;
        return [renderedWords(source, "title")[0], renderedWords(source)[1]];
      },
    });
    assert.equal(model.doGenerateCalls.length, 1);
    assert.equal(result.source, source);
    assert.equal(renders, 1);
    assert.deepEqual(result.repairedPages, []);
    assert.deepEqual(result.issues.map(({ page }) => page), [1]);
  }
});

test("LibreOffice and Poppler review the rendered text in a dense Chinese revision", {
  skip: !process.env.PPT_VISUAL_INTEGRATION,
}, async () => {
  const source = fixture();
  source.slides[0].textHighlights = { title: ["产业发展"], point1: ["100 亿元"] };
  const longPoint = "这条说明包含相对密集的中文正文与不同的数字口径，需要在同一段里保留单位和统计时期。";
  source.slides.push({
    slideId: randomUUID(), layout: "two-columns",
    title: "这是一个用来验证中文换行和多栏排版的较长页面标题",
    left: { heading: "左栏重点", points: [longPoint, "集中说明左栏负责的环节", "确认所有原始统计时期与单位"] },
    right: { heading: "右栏重点", points: ["这里展示右栏情况", "说明实施条件与预期变化", "梳理各项任务的执行顺序"] },
  });
  const id = randomUUID();
  const parentId = randomUUID();
  const save = await preparePresentationDrafts("account", [{ source, images: new Map(), parentId, warnings: [] }],
    new AbortController().signal);
  const result = await save({ presentation: { async create({ data }) {
    assert.equal(data.parentId, parentId);
    assert.equal(data.userId, "account");
    assert.deepEqual(data.source.slides[0].citations, source.slides[0].citations);
    assert.equal(data.bytes[0], 0x50);
    assert.equal(data.bytes[1], 0x4b);
    return { id, title: data.title };
  } } });
  assert.deepEqual(result[0].warnings, []);
});
