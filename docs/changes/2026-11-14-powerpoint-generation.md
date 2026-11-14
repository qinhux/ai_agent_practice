# PowerPoint 配图、配色与排版变更总结

2026 年 11 月 14 日 · 功能基线 `53b4c4e` · 记录至 `aeb58dd`

聊天入口、独立生图、文件存储与下载接口见[上一份变更总结](./2026-11-13-agent-media-tools.md)。本文记录基线之后的 PPT 生成改动，功能说明以 `aeb58dd` 的行为为准。

## 提交记录

| 提交 | 修改文件 | 文件中的改动 |
| --- | --- | --- |
| `af9626a` | [README.md](../../README.md) | 更新 PPT 使用说明，说明模型按页决定是否配图。 |
| `af9626a` | [src/server/presentation-tool.ts](../../src/server/presentation-tool.ts) | 将模型提示中的配图改为可选，统计实际使用备用图的页数。 |
| `af9626a` | [src/server/presentations.ts](../../src/server/presentations.ts) | 允许省略 `imageBrief`，跳过无图页的生图，并按有图或无图调整文字版式。 |
| `595b237` | [src/server/presentation-tool.ts](../../src/server/presentation-tool.ts) | 让模型根据需求生成整份配色，默认按页生成写实配图，将内容生成和校验重试提示改为中文。 |
| `595b237` | [src/server/presentations.ts](../../src/server/presentations.ts) | 校验配色并按页设置背景和文字颜色，生图根据当页描述进行，备用插图采用固定中性色。 |
| `ba18977` | [docs/changes/2026-11-13-agent-media-tools.md](./2026-11-13-agent-media-tools.md) | 扩写原始功能的调用链、文件职责和验证记录。 |
| `88b0cfd` | [src/server/presentations.ts](../../src/server/presentations.ts) | 将有图首页改为图片等高、右侧贴边，左侧排文字。 |
| `aeb58dd` | [src/server/presentations.ts](../../src/server/presentations.ts) | 首页优先用横图铺满页面，文字直接叠放，保留等高贴边作为备选，并为中英文标题和正文分别设置字体。 |

## 内容生成与按需配图

- `generatePresentation` 接收主题、受众、页数、语言和对话背景。用户指定的视觉风格、品牌色或配图偏好通过 `context` 传入。支持 1–12 页，默认 8 页。
- `writePresentation` 用中文提示生成标题、整份配色和逐页 JSON。正文按需求指定的语言生成，未指定时根据主题推断。JSON 字段与版式值沿用英文。首次输出格式无效时，附带中文校验反馈重试一次，两次尝试共用 45 秒时限。
- 封面、要点、双栏和总结四种版式均可选配图。模型逐页判断是否需要图片，仅为有配图需求的页面提供 `imageBrief`。生图根据当页主体与构图描述进行，默认采用自然光和真实质感的写实摄影，用户明确指定其他图片风格时按其要求生成。
- `preparePresentationImages` 跳过没有 `imageBrief` 的页面，文字按无图版式排版。需要配图的页面在百炼未配置或生图失败时使用中性装饰图，下载卡片按实际使用的备用图页数提示。

实现见 [presentation-tool.ts](../../src/server/presentation-tool.ts) 和 [presentations.ts](../../src/server/presentations.ts)。

## 幻灯片配色

- 模型按题材、受众和品牌要求生成一套 `palette`，包含浅色背景 `lightBackground`、深色背景 `darkBackground` 和强调色 `accent`。服务端检查六位十六进制色值和背景亮度，缺失或校验失败时使用默认配色。
- 多页 PPT 的首页封面与标记为 `closing: true`、只有一条不超过 50 字符结论的末页总结使用深底浅字。单页 PPT、普通内容页和信息较多的总结页使用浅底深字。
- 背景通过 PowerPoint 的原生背景属性写入。双栏小标题在强调色与背景的对比度达到 4.5:1 时采用强调色，全幅配图页和对比度不足时采用正文色。生图提示根据页面内容编写，页面背景色和强调色只用于幻灯片排版。

## 首页图片布局

| 情况 | 排版 |
| --- | --- |
| 生成图的宽高比与 16:9 页面相差不超过 2% | 图片按比例裁切并铺满整页。生图提示将主体放在右侧，左侧留出相对简洁的区域，供文字直接叠放。 |
| 生成图的宽高比差异较大，或该页使用备用图 | 图片与页面等高并贴齐右缘，文字排在左侧。 |
| 首页无配图 | 采用对应版式的纯文字排版。 |

首页优先向生图服务请求 16:9 横图，裁切和放置使用同一个图片框。规则按页序判断，适用于首页采用封面或内容版式的情况。

## 中英文字体

| 文本 | 中文 | 英文 |
| --- | --- | --- |
| 每页主标题 | 宋体-简（Songti SC），加粗 | Georgia，加粗 |
| 副标题与正文 | 微软雅黑（Microsoft YaHei） | Arial |

正文和副标题采用常规字重，双栏小标题沿用正文的字体组合并加粗。导出时分别写入西文和东亚文字字体属性，同一文本框可按文字使用相应字体。PPTX 记录字体名称，打开文件的设备需要有对应字体才能按预期显示。

## 验证记录

- 功能提交前已通过 `npm run lint` 和 `npm run typecheck`。
- 开发过程中使用本地样例或模拟生图结果检查了 PPTX 的背景色、首页图片位置和字体属性。真实 DeepSeek 与百炼的端到端生成未在上述验证中运行。
