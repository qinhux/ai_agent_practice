# 聊天中的 PowerPoint 元素编辑与草稿交付变更总结

2026 年 11 月 16 日 · 文档基线 `6570503` · 记录至 `7a638e1`

[上一份变更总结](./2026-11-15-powerpoint-text-editing-in-chat.md)记录了 PPT 文字编辑接入聊天。此后的提交增加了换图、跨页批量编辑和单页元素增删，并将 PPT 的生成与修改统一为本轮暂存、回合结束时保存。下文的功能说明以 `7a638e1` 的行为为准。

## 提交记录

| 提交 | 变更 |
| --- | --- |
| `034f8ea` | 新增 `replaceImageElement`，可在原图片框中按描述生成替换图，也可复用聊天中生成的图片。加入裁切、完整显示和放大画质提示。 |
| `0fa02cf` | 用 `updateSlideElements` 统一文字编辑和配图替换，一次处理同一份 PPT 的多页修改，并支持调整元素位置和尺寸。 |
| `cbafb62` | 新增 `listSlideElements` 和 `addOrRemoveSlideElements`，支持查询元素及在单页增删文本框或图片。图片存储改为按元素 ID 区分。 |
| `54d7a9e` | 增加面试讲解文档，梳理生成链路、跨页编辑计划与版本保存。[PowerPoint 开发面试文档](../powerpoint-development-interview.md) |
| `7a638e1` | 生成和编辑工具在当前请求中暂存草稿。聊天接口在确认本轮文件操作完成后统一保存，并通过消息流交付下载入口。 |

## 功能调用链

1. 用户可以在生成 PPT 后继续说「精简第 2 页标题，替换第 4 页配图，再删除第 4 页原有的副标题」。Agent 从已交付文件中取得版本 ID，默认使用最近交付的版本，也可使用用户指定的旧版。
2. Agent 将文字和图片修改集中交给 `updateSlideElements`。增删集中到对应页的 `addOrRemoveSlideElements` 调用，删除前通过 `listSlideElements` 查询该页的实际元素 ID。同一份 PPT 的工具操作按顺序使用同一个 ID，后续调用读取最新草稿。
3. 文件操作全部完成后，Agent 单独调用 `completeFileWork`。聊天接口满足保存条件时渲染并写入数据库，提交成功后发送文件信息。界面展示文件名、页数、下载按钮以及适用的备用配图或画质提示。[Agent 配置](../../src/server/agent.ts) · [聊天接口](../../src/app/api/chat/route.ts) · [聊天界面](../../src/components/agent-workspace.tsx)

## 跨页修改文字与图片

- `updateSlideElements` 接收版本 ID、修改说明和可选的 `slideNumbers`。页码从 1 开始，按内容定位或全稿修改时可省略页码。工具把候选页的版式、元素 ID、内容和位置交给模型生成编辑计划，由服务端校验页码覆盖、ID、类型、重复项、文本格式和页面边界。校验或图片处理失败时，本次修改不会写入草稿。
- 文字可修改内容、字体、字号、颜色、粗体、斜体、对齐方式和位置尺寸。图片可移动、缩放或更换来源，只给宽或高时等比缩放。`cover` 会裁切以填满图片框，`contain` 会完整显示图片。换图或调整尺寸时，图片需要明显放大则返回画质提示。
- 换图可按描述调用百炼，或使用当前用户已有的 `generateImage` 结果。复用图片时，服务端检查 ID 出现在修改说明中并属于当前用户。按描述生图时，`wan2.6-t2i` 优先根据图片框计算自定义尺寸，其他模型使用预设比例。

实现见 [update-slide-elements-tool.ts](../../src/server/update-slide-elements-tool.ts) 和 [images.ts](../../src/server/images.ts)。

## 单页元素查询与增删

- `listSlideElements` 返回指定页的可编辑元素及其 ID、内容和位置尺寸。`addOrRemoveSlideElements` 可在一次调用中处理同页的新增和删除。新增文本框或图片时传入以英寸为单位的 `x`、`y`、`w`、`h`，由服务端分配 ID。新增图片引用当前用户已生成的图片。
- 逐页源数据通过 `addedElements` 保存新增元素，通过 `removedElementIds` 标记移除的模板元素。移除模板配图时会固定该页剩余模板文字的位置，避免渲染时切换到无图版式而移动文字。[slide-element-tools.ts](../../src/server/slide-element-tools.ts) · [presentations.ts](../../src/server/presentations.ts)
- `PresentationImage` 的主键从 `presentationId`、`slideId` 改为 `presentationId`、`elementId`，同页可以存多张图片。迁移将旧图片的 `elementId` 回填为 `<slideId>:image`，并保留 `slideId` 记录所属页面。[Prisma 模型](../../prisma/schema.prisma) · [数据库迁移](../../prisma/migrations/20261115000000_add_presentation_image_element_ids/migration.sql)

## 草稿保存与下载

- 每次 `POST /api/chat` 创建一个只在当前请求中使用的 `FileDrafts`。新建 PPT 的工具先生成逐页源数据和配图，返回临时 `presentationId`。编辑已有 PPT 时按当前用户和版本 ID 读取源数据及配图，后续编辑优先读取草稿。同一 ID 的并发编辑会被拒绝。[presentation-tool.ts](../../src/server/presentation-tool.ts) · [draft-store.ts](../../src/server/draft-store.ts) · [presentation-drafts.ts](../../src/server/presentation-drafts.ts)
- 接口要求倒数第二步单独调用 `completeFileWork` 并返回 `ready: true`，最后一步没有工具调用且以 `stop` 结束。流异常、请求中止或任一工具失败都会阻止保存。若消息流正常结束但缺少有效确认或工具失败，接口会发送 `data-file-error` 提示草稿未保存。[聊天接口](../../src/app/api/chat/route.ts)
- 所有待交付 PPT 先渲染，再通过同一个 Prisma 事务写入 PPTX、逐页源数据和配图。对同一个已保存版本连续修改时，本轮合并成一个新版本，`parentId` 指向修改所基于的版本。新建草稿的临时 ID 仅供本轮工具调用，交付使用数据库生成的 ID。[file-drafts.ts](../../src/server/file-drafts.ts) · [save-presentation.ts](../../src/server/save-presentation.ts)
- 保存成功后，接口通过 `data-files` 发送 `/api/presentations/[id]` 下载路径及摘要，并在后续对话中将已交付文件的 ID、类型和名称传给模型。界面继续渲染带有已保存文件信息的旧 PPT 工具结果。独立 `generateImage` 仍在工具内保存图片，并从工具结果显示预览和下载。[交付数据定义](../../src/lib/file-delivery.ts) · [聊天界面](../../src/components/agent-workspace.tsx) · [image-tool.ts](../../src/server/image-tool.ts)

## 验证记录

- 文档中的提交范围、调用链和迁移说明已与 Git 提交快照核对。
- 本次文档整理未运行数据库迁移，也未进行 DeepSeek、百炼和聊天下载的端到端联调。
