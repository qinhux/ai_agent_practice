# 从聊天生成 PPT 到跨页批量编辑

面试讲述稿 · 2026 年 11 月 15 日 · 已提交实现以 `0fa02cf` 为基线

## 开场讲法

> 我先实现了在聊天里生成并下载一份可编辑的 PowerPoint。DeepSeek 根据用户需求输出逐页 JSON，服务端校验后，用固定版式和 PptxGenJS 生成文件。第一版只保存了下载文件。要支持“把第二页改短一点”，我给每个版本保存了可编辑源数据和独立的配图，并用 `parentId` 记录版本关系。之后先实现文字编辑，再支持换图，最后把两条编辑路径合并。用户现在可以一句话改多页的文字、样式、位置和配图，服务端校验后一次生成一个新版本。

## 1. 按 Git 提交讲迭代

| 提交 | 修改的入口或数据层 | 面试中可以讲的开发决策 |
| --- | --- | --- |
| `53b4c4e` · 11 月 13 日 | `agent.ts`、`presentation-tool.ts`、`presentations.ts`、聊天和下载路由、Prisma | 先跑通生成、存储、下载。Agent 接收自然语言，服务端把逐页数据渲染成原生文字和图片，聊天卡片用返回的文件 ID 下载。 |
| `af9626a`、`595b237` · 11 月 13–14 日 | 生成工具、渲染和配图逻辑 | 把配图改成按页可选，只有提供 `imageBrief` 的页面才请求生图。随后让模型生成全稿配色，由服务端检查色值和亮度，并在需要时使用默认配色。 |
| `88b0cfd`、`aeb58dd` · 11 月 14 日 | `presentations.ts` | 首页从右侧等高贴边图迭代为优先使用接近 16:9 的全幅图，右侧等高图作为备选。按文字脚本设置中英文标题和正文字体。 |
| `9d8e60d` · 11 月 14 日 | Prisma、数据迁移、生成与渲染 | 存储可编辑的 `source`、独立的配图和版本关联。迁移给已有逐页源数据的页面补 `slideId`，再把图片关联从页索引改为 `slideId`。 |
| `5ca3cc7`、`fbd66ea` · 11 月 15 日 | `save-presentation.ts`、`update-text-element-tool.ts` | 抽出公共渲染和保存路径。先支持版式内的文字、字体、字号和颜色，编辑后复用原有图片，另存新版本。 |
| `4dea26e`、`6570503` · 11 月 15 日 | Agent、聊天路由、下载卡片、变更文档 | 把文字编辑接入对话，支持引用最近成功的版本，处理旧工具消息，复用下载卡片。 |
| `034f8ea` · 11 月 15 日 | `replace-image-element-tool.ts`、`images.ts`、聊天卡片 | 一次替换某页已有图片。支持根据提示词生成或复用聊天生成图，按原图框适配并提示明显放大带来的画质问题。此时改字和换图还是两个工具，混合请求会请用户先选一项。 |
| `0fa02cf` · 11 月 15 日 | `update-slide-elements-tool.ts`、`presentations.ts`、Agent、聊天路由 | 合并两个编辑工具，支持多页、多元素、多种修改一次提交。把文字框的默认坐标和实际样式提取出来，让编辑模型看到的元素与 PPT 渲染器使用的是同一套布局。 |

逐期记录见[聊天媒体工具](changes/2026-11-13-agent-media-tools.md)、[配图、配色与排版](changes/2026-11-14-powerpoint-generation.md)、[文字编辑接入](changes/2026-11-15-powerpoint-text-editing-in-chat.md)。

## 2. 生成一份 PPT 的完整链路

1. **聊天入口。** 用户发出“生成一份五页的市场分析 PPT”。`POST /api/chat` 校验登录和消息，创建基于 AI SDK 的 `ToolLoopAgent`，把文本和工具状态流式发回页面。Agent 调用 `generatePresentation`，传入主题、页数及对话背景，受众和语言也可单独传入。支持 1–12 页，未指定时是 8 页。
2. **生成内容。** 工具内部调用 `generateText`，让 DeepSeek 输出标题、整稿配色和逐页 JSON。页面版式限定为封面、要点、双栏和总结。服务端用 Zod 检查页数、版式字段和文本限制。格式无效时会带上反馈重试一次，两次尝试共享 45 秒时限。通过后服务端为每页分配 `slideId`。
3. **准备图片。** `preparePresentationImages` 对有 `imageBrief` 的页面请求阿里云百炼生图，最多三路并行，用 Sharp 按版式的图片框处理尺寸和裁切。生图失败或服务未配置时，该页使用备用装饰图。省略 `imageBrief` 的页面走无图布局。
4. **导出和交付。** `savePresentation` 调用 `renderPresentation`，保存文件和可编辑数据，返回 `id`、标题、页数和备用图页数。前端用 `id` 构造 `/api/presentations/[id]`，下载路由按登录用户和 ID 查询文件。

对应代码见[聊天路由](../src/app/api/chat/route.ts)、[Agent](../src/server/agent.ts)、[生成工具](../src/server/presentation-tool.ts)、[配图与渲染](../src/server/presentations.ts)、[下载路由](../src/app/api/presentations/%5Bid%5D/route.ts)。

### 数据库里存了什么

| 字段 | 内容 | 用途 |
| --- | --- | --- |
| `Presentation.bytes` | 完整的 `.pptx` 二进制 | 下载时直接返回文件 |
| `Presentation.source` | 一份 JSON，包含标题、配色、逐页版式、文字、`slideId` 和可选的样式、文字框覆盖 | 作为下一次编辑和重新渲染的输入 |
| `PresentationImage` | 配图字节、位置尺寸 `box`、备用图标记 | 重用配图、换图和重新排版。提交基线按 `presentationId + slideId` 关联图片，每页一张 |
| `Presentation.parentId` | 本次编辑所基于的版本 ID | 下一次延续最近成功的版本，也可以按用户指定从旧版继续 |

第一版数据库只有文件字节。缺少可编辑 `source` 的旧记录仍可下载，编辑工具会返回缺少逐页数据的错误。新版本的 `presentationId` 会变化，同一份 PPT 迭代时已有页的 `slideId` 会保留。页码用于用户表达，`slideId` 用于程序定位。见[数据库定义](../prisma/schema.prisma)和[保存函数](../src/server/save-presentation.ts)。

## 3. 用一个请求讲清跨页编辑怎么传数据

> 第 2 页标题改成「市场概览」，加粗并上移 0.3 英寸。第 4 页右栏第一条改成「优先覆盖核心客户」，配图换成城市夜景，宽度改为 4 英寸。

### 第一段 · Agent 调用编辑工具

Agent 从成功的 PPT 工具结果里拿到目标版本 ID，发起一次 `updateSlideElements` 调用：

```json
{
  "presentationId": "11111111-1111-4111-8111-111111111111",
  "slideNumbers": [2, 4],
  "instructions": "第 2 页标题改成「市场概览」，加粗并上移 0.3 英寸。第 4 页右栏第一条改成「优先覆盖核心客户」，配图换成城市夜景，宽度改为 4 英寸。"
}
```

`slideNumbers` 是读取范围，页码从 1 开始。按文字内容定位或修改全稿时可以省略。具体改哪些元素由 `instructions` 表达，精确文案也在这里传递。

### 第二段 · 工具读取实际元素，再调一次模型

工具按 `presentationId + userId` 读取源数据和图片，解析第 2、4 页的 `slideId`，算出当前有效的样式和文字框。随后用 `prompt: JSON.stringify({ instructions, slides })` 调用模型。这里会把收到的 `instructions` 再传一次，同时附上实际的页面数据。提交基线的每页数据包含 `slideId`、`slideNumber`、`layout`、`textElements` 和存在时的 `image`。例如，`textElements` 会告诉模型第 4 页有哪些要点及各自的键。图片只提供框、文字描述和适配设置等信息，图片字节保留在服务端。

下面截取第二次模型调用中的第 4 页，省略该页其他元素：

```json
{
  "slideId": "44444444-4444-4444-8444-444444444444",
  "slideNumber": 4,
  "layout": "two-columns",
  "textElements": [
    {
      "element": "rightPoint1",
      "text": "扩大客户覆盖",
      "box": { "x": 7, "y": 4.73, "w": 5.4, "h": 0.74 },
      "style": { "fontFace": "Arial", "fontSize": 17, "color": "142846" }
    }
  ],
  "image": {
    "element": "image",
    "box": { "x": 0.85, "y": 1.73, "w": 11.63, "h": 2.22 },
    "description": "商务园区"
  }
}
```

第一次模型调用负责理解聊天意图和选择工具。这次工具内部调用负责在实际页面里找目标，把“右栏第一条”变成 `rightPoint1`，把“上移 0.3”换算成最终坐标。

### 第三段 · 模型返回结构化计划

下面是 `0fa02cf` 的数据结构示例。假设第 2 页标题当前的 `y` 为 `0.5`，上移后是 `0.2`。

```json
{
  "pages": [
    {
      "slideId": "22222222-2222-4222-8222-222222222222",
      "edits": [
        {
          "element": "title",
          "text": "市场概览",
          "style": { "bold": true },
          "box": { "y": 0.2 }
        }
      ]
    },
    {
      "slideId": "44444444-4444-4444-8444-444444444444",
      "edits": [
        {
          "element": "rightPoint1",
          "text": "优先覆盖核心客户"
        },
        {
          "element": "image",
          "source": { "kind": "prompt", "prompt": "城市夜景" },
          "box": { "w": 4 }
        }
      ]
    }
  ]
}
```

计划按 `slideId + element` 定位。一条记录可以同时改同一个元素的多个属性。文字支持内容、字体、字号、颜色、粗体、斜体、对齐和位置尺寸。图片支持位置尺寸、图片来源和适配方式。`box` 的 `x / y / w / h` 是以英寸为单位的左上角坐标、宽和高，字段可按需提供。聊天中讨论过的 `moveBy` 属于备选设计。已提交代码让模型根据当前坐标直接返回最终的 `box.y`。

### 第四段 · 服务端用计划更新源数据

| 计划项 | 实际怎么改 |
| --- | --- |
| 第 2 页 `title.text` | 修改内存中 `slides[1].title`。 |
| 第 2 页 `title.style` | 按字段合并进 `slides[1].textStyles.title`。如果标题已经按模板加粗，就无需额外写一个粗体覆盖。 |
| 第 2 页 `title.box` | 把 `y: 0.2` 合并进当前完整文字框，再保存到 `slides[1].textBoxes.title`。其余坐标和尺寸沿用当前值。 |
| 第 4 页 `rightPoint1.text` | 由服务端把元素键映射到 `slides[3].right.points[0]`，只更新这一条。 |
| 第 4 页 `image` | 按 `slideId` 找到图片，沿用 `x`、`y`，将宽改为 4 英寸。只指定宽时按原框比例算高。假设原框为 11.63 × 2.22 英寸，新的高度约为 0.76 英寸。根据最终框选生图尺寸，并在渲染时适配到框内。 |

执行顺序是先用 Zod 校验计划，再检查页码范围、重复目标、元素存在性、文案长度、页面边界等。显式传了 `[2, 4]` 时，两页都必须出现在计划里。文字修改先在内存中完成，图片任务在整批检查后执行。复用聊天生成图时，还要确认图 ID 出现在指令里且归当前用户所有。换图时可用 `cover` 裁切填满，或用 `contain` 完整显示。

整批修改校验完成、所需图片准备成功后，工具调用一次 `savePresentation`。校验、换图或渲染失败时返回错误，原版本仍可使用。若所有元素本来就符合要求，也无需生成新版本。见[批量编辑工具](../src/server/update-slide-elements-tool.ts)。

### 第五段 · 从修改后的数据重新生成文件

1. `renderPresentation` 创建一个宽屏的 PptxGenJS 文档，遍历更新后的 `source.slides` 并逐页调用 `addSlide()`。
2. 渲染器根据版式和配色得出默认样式及坐标，再应用 `textStyles` 和 `textBoxes` 覆盖。标题和每条要点通过 `slide.addText()` 写成原生文本框。配图按图片框处理后调用 `slide.addImage()`。因此第二页标题的文字和位置直接来自更新后的数据。
3. `pptx.write({ outputType: "nodebuffer" })` 生成 PPTX 字节。项目用 JSZip 后处理 PPTX 内部的 XML，使东亚文字字体和渐变遮罩按预期写入。
4. `savePresentation` 用一次 Prisma 嵌套创建写入新记录、更新后的源 JSON、文件字节和配图，`parentId` 指向本次编辑所基于的版本。聊天卡片收到新 `id` 后生成下载入口。下载时直接读取已保存的文件字节。

面试被问到为什么要存两份时，可以回答：“JSON 提供按页和元素做增量编辑的入口，PPTX 二进制可以直接下载。生成和编辑复用同一个渲染函数，避免维护两套排版逻辑。代价是一次小编辑也要重新渲染整份文件，并保存一个新版本。”见[渲染与导出](../src/server/presentations.ts)、[保存和版本关联](../src/server/save-presentation.ts)。

## 4. 面试追问

**为什么模型调用两次？** 聊天阶段主要有对话上下文和历史版本 ID。工具读取页面后，规划阶段才有真实的文字、尺寸和元素键，可以结合原始指令生成可校验的修改计划。两次调用增加延迟，换来基于实际页面定位元素的能力。最终由服务端负责校验、计算图片比例、生成文件和写库。

**旧聊天里的编辑记录还能继续用吗？** 提交基线保留了 `editPresentation`、`updateTextElement` 和 `replaceImageElement` 的历史输入输出定义，供聊天路由校验和转换旧消息。新请求从 Agent 的工具列表调用 `updateSlideElements`，旧成功结果仍可提供版本 ID 和下载入口。见[历史工具定义](../src/server/agent.ts)和[聊天路由](../src/app/api/chat/route.ts)。

**验证到了哪一层？** 早期变更文档记录了 lint、类型检查，以及对导出样例的 ZIP 完整性、首页图片布局和字体属性检查。记录也注明使用过本地样例或模拟生图，文字编辑接入当时未完成聊天编辑和下载的端到端验证。面试可以据实描述这些检查。本讲述稿基于提交、代码和既有记录整理，本次整理未运行真实 DeepSeek、百炼或数据库联调。

## 5. 当前工作区的后续迭代

截至整理时，`0fa02cf` 之后还有未提交的修改。它解决的是“同页多张图或元素可增删时，怎么稳定定位”的问题。下面是工作区代码的设计，面试中可以作为正在推进的下一轮讲。

- 模板元素仍沿用版式字段，程序把 `slideId` 和模板键拼成稳定 ID，例如 `<slideId>:title`。新元素由服务端分配 UUID。跨页编辑计划仍然按 `pages[].slideId` 分组，每条修改改用 `type + elementId`，例如 `{"type":"text","elementId":"<slideId>:title","text":"市场概览"}`。
- 图片表新增 `elementId`，主键改为 `presentationId + elementId`，保留 `slideId` 记录归属页，让同一页可以存多张图。迁移给旧配图填入 `<slideId>:image`。
- 新增只读的 `listSlideElements` 和单页写入工具 `addOrRemoveSlideElements`。删除前先查同一版本、同一页的真实 ID。新增时提供内容和完整图片框或文字框。新增配图使用当前用户已生成图片的 ID。
- 多页批量更新在一次 `updateSlideElements` 调用中保存一个版本。涉及增删及其他需要分步写入的请求时，后一步使用前一步成功返回的新版本 ID，所以每次写入可以独立留下一个版本。

对应工作区文件见[元素查询与增删](../src/server/slide-element-tools.ts)、[批量修改](../src/server/update-slide-elements-tool.ts)、[元素 ID 迁移](../prisma/migrations/20261115000000_add_presentation_image_element_ids/migration.sql)。
