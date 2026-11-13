# Agent 生图与 PowerPoint 生成变更总结

2026 年 11 月 13 日

## 聊天与模型

- 聊天模型提供方从 OpenAI 切换到 DeepSeek，默认使用 `deepseek-flash`，并以非思考模式调用工具。时区查询迁移到独立工具模块。
- 聊天接口将登录用户的 ID 传给生成工具，并将流式请求超时从 60 秒延长到 270 秒，为生成文件预留时间。
- 聊天工作区新增生图和 PPT 示例提示。生成成功后可在聊天中预览并下载图片，或通过包含标题、页数和备用配图页数的卡片下载 PPT。生成期间会显示进度状态，失败或中断后会显示对应提示。

## 图片与 PowerPoint

- 接入阿里云百炼 DashScope 文生图，默认模型为 `wan2.6-t2i`。支持方形、横向和纵向构图，服务端使用 Sharp 将返回的图片转换为 JPEG。
- PPT 工具从对话提取主题、受众等信息，生成并校验逐页内容，再输出可编辑的 `.pptx`。支持 1–12 页，默认 8 页，提供封面、要点、双栏和总结四种版式，以及三种配色主题。未配置百炼或单页配图失败时使用备用插图。
- 新增 `GeneratedImage`、`Presentation` 数据模型和相应 Prisma 迁移。生成文件以二进制保存在 PostgreSQL 中，图片和 PPT 接口仅向生成文件的登录账号提供访问。

## 配置与样例

- `.env.example` 和 `compose.yaml` 使用 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`，并新增 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`DASHSCOPE_IMAGE_MODEL`。README 更新了配置和使用示例。
- 依赖由 `@ai-sdk/openai` 切换到 `@ai-sdk/deepseek`，并加入 `pptxgenjs`、`jszip`、`sharp`。同时纳入 Next.js 生成的 `AGENTS.md`。
- `output/武汉城市名片.pptx` 是一页武汉城市名片样例。`.wuhan-build/` 包含内容相同的草稿、检查记录和校验报告。

## 验证

- `npm run lint` 和 `npm run typecheck` 均通过。
- 样例 PPT 与草稿均通过 ZIP 完整性检查，SHA-256 一致。
- 本次提交前的验证范围为静态检查和样例文件完整性，未联调 DeepSeek、百炼或数据库。
