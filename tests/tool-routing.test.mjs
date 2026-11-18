import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { MockLanguageModelV3 } from "ai/test";
import { createAgent } from "../src/server/agent.ts";
import { FileDrafts } from "../src/server/file-drafts.ts";
import { createToolRegistry } from "../src/server/tool-registry.ts";
import { routeToolDomains } from "../src/server/tool-router.ts";

const usage = { inputTokens: { total: 10 }, outputTokens: { total: 10 } };
const user = (text) => ({ id: randomUUID(), role: "user", parts: [{ type: "text", text }] });
const assistant = (...parts) => ({ id: randomUUID(), role: "assistant", parts });
const toolPart = (name, state, output) => ({
  type: `tool-${name}`, toolCallId: randomUUID(), state, input: {},
  ...(state === "output-available" ? { output } : { errorText: "上轮操作失败" }),
});
function modelFor(output) {
  return new MockLanguageModelV3({ doGenerate: {
    content: [{ type: "text", text: JSON.stringify(output) }],
    finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [],
  } });
}
function registryFor(model) {
  return createToolRegistry(model, "test", new FileDrafts("test"), undefined, { userText: "测试" });
}
async function route(messages, output) {
  const model = modelFor(output);
  const registry = registryFor(model);
  return { domains: await routeToolDomains(messages, registry, model, undefined, new AbortController().signal), registry };
}

test("empty routing cannot hide the presentation tool behind requestToolDomains", async () => {
  const { domains, registry } = await route([user("继续生成 PPT")], { domains: [] });
  assert.deepEqual(domains, registry.domains);
  assert.ok(registry.toolNamesFor(new Set(domains)).includes("generatePresentation"));
});

test("selective routing remains selective for a new non-PPT task", async () => {
  const { domains, registry } = await route([user("上海现在几点")], { domains: ["time"] });
  assert.deepEqual(domains, ["time"]);
  assert.ok(!registry.toolNamesFor(new Set(domains)).includes("generatePresentation"));
});

test("a successfully enabled PPT domain survives a follow-up with an empty classification", async () => {
  const { domains } = await route([
    user("做 PPT"), assistant(toolPart("requestToolDomains", "output-available", { domains: ["ppt"] })), user("继续"),
  ], { domains: [] });
  assert.deepEqual(domains, ["ppt"]);
});

test("PPT retries and legacy tool history preserve PPT while adding research", async () => {
  for (const name of ["generatePresentation", "editPresentation", "replaceImageElement"]) {
    const { domains } = await route([
      assistant(toolPart(name, "output-error")), user("再试一下，补充搜索资料"),
    ], { domains: ["research"] });
    assert.deepEqual(domains, ["ppt", "research"]);
  }
});

test("malformed historical enable results are ignored and invalid new routing falls back safely", async () => {
  const { domains } = await route([
    assistant(toolPart("requestToolDomains", "output-available", { domains: ["missing-domain"] })), user("几点"),
  ], { domains: ["time"] });
  assert.deepEqual(domains, ["time"]);
  const fallback = await route([user("生成 PPT")], { domains: ["invalid"] });
  assert.deepEqual(fallback.domains, fallback.registry.domains);
});

test("streaming agent enables PPT, calls generation, then disables tools after completion", async () => {
  let step = 0;
  let generated = 0;
  const available = [];
  const calls = [
    { name: "requestToolDomains", input: { domains: ["ppt"] } },
    { name: "generatePresentation", input: { topic: "测试", slideCount: 1 } },
    { name: "completeFileWork", input: {} },
  ];
  const model = new MockLanguageModelV3({ doStream: async ({ tools, toolChoice, prompt }) => {
    available.push((tools ?? []).map((tool) => tool.name));
    const call = calls[step++];
    if (call?.name === "requestToolDomains") {
      assert.match(prompt.find((message) => message.role === "system").content, /已经注册/);
    }
    if (!call) assert.equal(toolChoice.type, "none");
    const chunks = call ? [{ type: "tool-call", toolCallId: randomUUID(), toolName: call.name, input: JSON.stringify(call.input) }]
      : [{ type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "已完成" }, { type: "text-end", id: "text" }];
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.enqueue({ type: "finish", finishReason: { unified: call ? "tool-calls" : "stop", raw: call ? "tool_calls" : "stop" }, usage });
      controller.close();
    } }) };
  } });
  const registry = registryFor(model);
  registry.tools.generatePresentation.execute = async () => { generated++; return { presentationId: randomUUID(), title: "测试", slideCount: 1 }; };
  registry.tools.completeFileWork.execute = async () => ({ ready: true });
  const result = await createAgent(model, registry, []).stream({ prompt: "生成一页 PPT" });
  for await (const chunk of result.fullStream) if (chunk.type === "error") throw chunk.error;
  assert.equal(generated, 1);
  assert.deepEqual(available[0], ["requestToolDomains"]);
  assert.ok(available[1].includes("generatePresentation"));
  assert.ok(available[2].includes("generatePresentation"));
  assert.deepEqual(available[3], []);
  assert.equal((await result.steps).length, 4);
});
