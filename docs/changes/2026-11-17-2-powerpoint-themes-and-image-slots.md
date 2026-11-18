# PowerPoint 共享主题、配图槽位与深浅配色变更总结

2026 年 11 月 17 日 · 文档基线 `0dd0ddd` · 记录至 `1e3f776`

本文覆盖 `0dd0ddd` 之后的 5 个功能提交。`0dd0ddd` 新增的上一份总结记录了整页编辑、工具路由和新版式，功能说明截至 `813fefa`。[上一份变更总结](./2026-11-17-powerpoint-slide-operations-and-layouts.md)

## 提交记录

| 提交 | 变更 |
| --- | --- |
| `f478362` | 全稿共用结构化主题，统一控制配色、字体、网格和形状，并兼容已有演示文稿。 |
| `0f4f4ca` | 将版式适用场景、内容约束和配图规则整理为表格，供大纲规划使用。 |
| `c9b0f10` | 按版式槽位规划、生成和编辑配图，新增双图对比页。 |
| `3c3bbed` | 将主图的渐变遮罩统一为从左侧 60% 不透明度过渡到右侧全透明的黑色渐变。 |
| `1e3f776` | 为浅色和深色模式分别定义并校验强调文字色。 |

## 共享主题与页面配色

- 规划阶段一次生成全稿共用的 `theme` 和逐页大纲。主题包含主色、次色、品牌强调色、深浅配色、字体和字号，以及网格、间距、形状和配图风格。页面使用 16:9 比例和 12 列网格。导出和页内元素查询使用同一套布局逻辑。[主题结构](../../src/server/theme-generator.ts) · [大纲规划](../../src/server/presentation-planner.ts) · [页面渲染](../../src/server/presentations.ts)
- 页面可以显式指定 `backgroundMode`。默认情况下，多页稿的首页封面及符合条件的一句话收尾页使用深色，其余页面使用浅色。已有页面重排时保留记录下来的外观。新生成的主题必须为每种模式提供 `accentText`，普通文字色和强调文字色相对各自背景的对比度都须达到 4.5:1。[主题校验](../../src/server/theme-generator.ts) · [页面配色](../../src/server/presentations.ts)
- 强调文字色用于指标数值、步骤标记和常规双栏小标题。双栏页使用全幅主图时，小标题取当前模式的普通文字色。历史主题缺少 `accentText` 时，品牌强调色达到 4.5:1 才用于文字，否则使用普通文字色。读取旧版源数据时，将原配色和字体预设转换为主题，同时保留旧版布局规则。[旧主题转换](../../src/server/theme-generator.ts) · [文字样式](../../src/server/presentations.ts)
- 主图需要遮罩时，导出流程先添加和图片同尺寸的矩形，再在 PPTX 的幻灯片 XML 中写入黑色渐变。文字元素绘制在遮罩上方。[PPTX 渲染](../../src/server/presentations.ts)

## 版式规划与按槽位生图

| 版式 | 配图槽位 | 图片放置方式 |
| --- | --- | --- |
| 封面、要点、双栏、总结 | 可选 `image` | 裁切填满图框。 |
| 指标、步骤 | 无 | — |
| 图文解读 `image-focus` | 必填 `image` | 按原比例完整显示，旁边放 1–2 条解读。 |
| 双图对比 `image-comparison` | 必填 `leftImage` 和 `rightImage` | 两张图分别裁切至左右图框，图注放在对应栏内。 |

1. 大纲提示词根据版式目录展示适用场景、内容约束及槽位要求。每页通过 `imageSlots` 声明需要的槽位。校验会拒绝重复槽位、版式不支持的槽位以及缺少必填槽位的大纲。[大纲规划](../../src/server/presentation-planner.ts)
2. 逐页文案用 `imageBriefs` 提供配图描述，键必须与大纲的 `imageSlots` 一致。双图对比页另外提供 `leftCaption` 和 `rightCaption`，每条最多 80 字。聊天插页也会检查必填槽位。读取历史源数据时，主图仍可从旧的 `imageBrief` 取描述。[逐页内容生成](../../src/server/slide-generator.ts) · [插页校验](../../src/server/add-remove-or-move-slides-tool.ts) · [源数据结构](../../src/server/presentations.ts)
3. 生图时，每个槽位独立生成一张图，并按页面 ID 和槽位生成稳定的元素 ID。双图对比的左右图均请求 16:9 配图。生成与替换图片的提示词都带入全稿的配图风格，左右图片可独立替换或删除，两条图注也可独立编辑。[配图处理](../../src/server/asset-manager.ts) · [元素修改](../../src/server/update-slide-elements-tool.ts) · [元素删除](../../src/server/slide-element-tools.ts)

## 缺图与交付提示

- 未配置生图服务或生成失败时，可选槽位使用备用装饰图，交付时按页统计。图文解读页缺图时使用通栏文字，交付提示标出最终页码。[配图处理](../../src/server/asset-manager.ts) · [交付提示](../../src/server/save-presentation.ts)
- 双图对比页缺一张图时，已生成的图留在原栏，缺图一侧保留图注。两张图均缺失时，两条图注上移至内容区顶部。交付提示按最终页码标明缺失的左图或右图。用户主动删除的图片不计为生成失败。[页面渲染](../../src/server/presentations.ts) · [交付提示](../../src/server/save-presentation.ts)

## 验证记录

- 已依据 Git 提交和源码核对配色校验、槽位规则、缺图排版及交付提示，并校验 Markdown 相对链接和补丁空白。
- 本次只整理文档，未运行应用测试或联调生图与 PPTX 导出。
