# PowerPoint 整页编辑、工具路由与新版式变更总结

2026 年 11 月 17 日 · 文档基线 `52fbdca` · 记录至 `813fefa`

[上一份变更总结](./2026-11-16-powerpoint-element-editing-and-file-delivery.md)记录了页内元素编辑和草稿交付。本文覆盖此后 4 个提交，功能说明以 `813fefa` 为准。

## 提交记录

| 提交 | 变更 |
| --- | --- |
| `34ad903` | 新增 `addRemoveOrMoveSlides`，支持查询页面目录，以及批量新增、删除和移动幻灯片。 |
| `f77cbd9` | 将工具分为 PPT、独立生图和时间查询三个能力域，按本轮请求和对话上下文启用。 |
| `57a6142` | 拆分 PPT 生成模块，先规划主题与大纲，再生成逐页内容和配图。 |
| `813fefa` | 新增指标、步骤和图文解读三种版式，接入生成、插页、元素编辑和交付提示。 |

## 聊天中的整页编辑

1. 用户可以说「删除第 2 页，把第 5 页移到最前面，再在末尾增加一页总结」。Agent 先通过 `addRemoveOrMoveSlides` 的 `list` 模式取得目录，其中包含每页的 `slideId`、页码、标题和版式。目录优先读取本轮草稿，也可按用户和版本 ID 读取已保存的源数据。
2. Agent 将整页操作按顺序放进一次 `edit` 调用。例子中的第 2 页和第 5 页都按操作前的目录绑定到稳定的 `slideId`。用户明确说「删掉第 2 页后，把新的第 5 页移到最前面」时，使用 `currentSlideNumber` 按操作后的顺序定位。插入和移动支持开头、末尾及指定页面之前或之后，新增页默认放在末尾。
3. 服务端校验操作目标和最终页数，要求编辑结果保留 1–12 页。删除页面时移除草稿中归属该页的配图，新增页分配新 ID，并只为本批次中仍保留的新增页准备所需配图。重新排序时，已有页面的首页排版标记和深浅背景随原页面保留。
4. 工具返回新的页面目录。同一轮还需编辑页内元素时，Agent 用原页面 ID 在新目录里找到当前页码。全部修改完成后，由 `completeFileWork` 确认交付，聊天接口在回合结束时保存并发送下载入口。只读查询或顺序和内容均无变化时，无需保存新版本。

实现见 [整页编辑工具](../../src/server/add-remove-or-move-slides-tool.ts)、[PPT 工具指令](../../src/server/tool-registry.ts)和[聊天界面](../../src/components/agent-workspace.tsx)。

## Agent 工具路由

- 聊天接口先用完整工具注册表和旧版工具的历史定义校验消息。校验后，路由模型根据最新用户消息、至多 8 条前序消息及各类型最近交付的文件摘要，选择 `ppt`、`image`、`time` 中所需的域。闲聊、建议和文案草稿可以返回空列表。路由超时或输出无效时启用全部域，用户中止请求时传播中止信号。[聊天接口](../../src/app/api/chat/route.ts) · [路由实现](../../src/server/tool-router.ts)
- Agent 在每一步加载已启用域的工具与指令。需要额外能力时，`requestToolDomains` 可在下一步追加对应的域。例如，先进入 PPT 域，再启用独立生图，为已有页面新增一张图片。新建 PPT 的逐页配图由生成工具内部处理，直接使用 PPT 域即可。调用 `completeFileWork` 后，后续步骤关闭工具，只输出回复。[工具注册表](../../src/server/tool-registry.ts) · [Agent 步骤配置](../../src/server/agent.ts)

## PPT 生成流程

| 模块 | 职责 |
| --- | --- |
| [presentation-tool.ts](../../src/server/presentation-tool.ts) | 接收主题、受众、页数、语言和对话背景，依次调用规划、逐页内容生成和配图处理，将结果写入本轮草稿。支持 1–12 页，默认 8 页。 |
| [presentation-planner.ts](../../src/server/presentation-planner.ts) | 一次模型调用生成整份主题和大纲，确定标题、各页版式、叙事目标、要点和配图意图。校验页数及封面位置后为每页分配稳定 ID。 |
| [theme-generator.ts](../../src/server/theme-generator.ts) | 定义配色、视觉风格、配图风格和字体预设。经典预设使用 Georgia / 宋体-简作为标题字体，现代预设的标题与两种预设的正文均使用 Arial / 微软雅黑。 |
| [slide-generator.ts](../../src/server/slide-generator.ts) | 根据大纲生成逐页结构化文案，校验页码、顺序、版式和配图描述与大纲一致，并关联规划阶段生成的页面 ID。 |
| [presentation-json.ts](../../src/server/presentation-json.ts) | 为规划和内容生成提供公共的 JSON 校验与重试逻辑。每个阶段各有 45 秒时限，首次输出的 JSON 无效或校验失败时附带反馈重试一次。 |
| [asset-manager.ts](../../src/server/asset-manager.ts) 与 [presentations.ts](../../src/server/presentations.ts) | 前者按版式准备和适配配图，生成与插页共用。后者定义可编辑源数据和页面元素，并在交付时渲染 PPTX。 |

## 三种内容版式

| 版式 | 内容与排版 |
| --- | --- |
| 指标 `metrics` | 横向排列 1–3 项已有材料支持的指标，每项包含带必要单位的数值、名称和口径说明。数值用大号文字突出，模板采用无图布局。 |
| 步骤 `steps` | 横向排列 3–5 个有序步骤或里程碑，每项包含标题、说明和可选标记。省略标记时自动编号，对齐且有足够间距的相邻标记之间绘制连线。模板采用无图布局。 |
| 图文解读 `image-focus` | 左侧完整显示 AI 配图，右侧排 1–2 条解读。生成和插页均要求提供 `imageBrief`。缺少生图配置或生图失败时改为通栏纯文字，并在交付时按最终页码提示。 |

指标的数值、名称和说明，步骤的标记、标题和说明，以及图文解读的要点，均作为可编辑文本元素导出。聊天中的元素查询会返回这些元素的 ID，`updateSlideElements` 按对应字段校验修改内容。[页面结构与渲染](../../src/server/presentations.ts) · [元素编辑](../../src/server/update-slide-elements-tool.ts) · [交付提示](../../src/server/save-presentation.ts)

## 验证记录

- 提交范围、工具调用链和版式行为已与 Git 提交及源码核对。
- 本次文档整理校验了 Markdown 相对链接和补丁空白，未运行应用测试或联调 DeepSeek、百炼和 PPT 下载。
