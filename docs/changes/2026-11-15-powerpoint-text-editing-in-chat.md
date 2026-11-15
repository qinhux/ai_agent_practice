# 聊天中的 PowerPoint 文字编辑变更总结

2026 年 11 月 15 日 · 对应功能提交 `4dea26e`

本次提交将 `fbd66ea` 引入的 PPT 文字编辑工具接入 Agent、聊天接口和界面。PPT 生成和排版见[上一份变更总结](./2026-11-14-powerpoint-generation.md)。

## 功能调用链

1. 用户在生成一份 PPT 后，可以直接追问「第二页再简洁一点」。Agent 从对话中成功的 PPT 工具结果里取得目标版本 ID，并调用 `updateTextElement`。
2. 工具根据用户要求修改已有幻灯片的文字内容、字体、字号或文字颜色，复用原版配图并保存新版本。新版本通过 `parentId` 关联本次修改所基于的版本。实现见 [update-text-element-tool.ts](../../src/server/update-text-element-tool.ts) 和 [save-presentation.ts](../../src/server/save-presentation.ts)。
3. 聊天界面展示修改版的标题和页数，并使用新版本 ID 构造下载链接。继续修改同一份 PPT 时，Agent 默认使用最近一次成功生成或修改的版本，也可以按用户指定的较早版本修改。

## 聊天入口与 Agent

### [src/server/agent.ts](../../src/server/agent.ts)

- 注册 `updateTextElement`，并把 `instructions` 改为中文，保留原有工具名以及按用户所用语言回复的规则。新建 PPT 时调用 `generatePresentation`，修改已有 PPT 的文字或支持的文字样式时调用 `updateTextElement`。
- 指令要求在目标不明确或当前对话没有可用 PPT 时请用户确认。用户只要建议或文案草稿时直接在聊天中回复。对于修改图片、其他样式、元素位置或页序的请求，说明当前支持的编辑范围。
- 针对同一份 PPT 的单次请求，指令要求最多调用一次 PPT 工具。成功后提示下载，工具返回错误时告知用户并等待下一条消息。
- 新增前端使用的 `ChatMessage` 类型，使消息片段同时接受当前的 `tool-updateTextElement` 和旧的 `tool-editPresentation`。

### [src/app/api/chat/route.ts](../../src/app/api/chat/route.ts)

- `POST /api/chat` 在执行 `safeValidateUIMessages` 前，将收到的旧版 `tool-editPresentation` 消息片段的 `type` 转为 `tool-updateTextElement`，保留片段的其余字段，再用当前注册的工具定义校验消息。

### [src/components/agent-workspace.tsx](../../src/components/agent-workspace.tsx)

- `Chat` 使用 `useChat<ChatMessage>`，复用 PPT 卡片展示生成结果以及新旧两种编辑工具的结果。编辑成功时显示「下载修改版 PPT」，链接指向 `/api/presentations/[id]`，其中 `[id]` 为修改版 ID。有备用图时继续显示使用备用图的页数。
- PPT 消息根据操作显示生成或修改的进行中、失败及中断状态。工具返回具体错误信息时，优先展示该信息。

## 验证记录

- 功能提交前，`npm run lint`、`npm run typecheck` 和 `git diff --check` 均通过。
- 聊天中的 PPT 编辑和下载尚未进行端到端验证。
