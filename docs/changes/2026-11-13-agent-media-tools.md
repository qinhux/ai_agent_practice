# Agent 生图与 PowerPoint 生成变更总结

2026 年 11 月 13 日 · 对应功能提交 `53b4c4e`

## 功能调用链

- **聊天** · `Chat` 发送消息到 `POST /api/chat`。接口验证请求后创建 Agent，并把模型回复和工具状态通过流式响应传回聊天界面。
- **生图** · Agent 调用 `generateImage`，从百炼生成 JPEG 并写入 `GeneratedImage`。前端拿到文件 ID 后，通过 `GET /api/images/[id]` 预览和下载。
- **PPT** · Agent 调用 `generatePresentation`，生成逐页内容和配图，再导出 PPTX 并写入 `Presentation`。前端通过 `GET /api/presentations/[id]` 提供下载。

## 聊天入口与 Agent

### [src/components/agent-workspace.tsx](../../src/components/agent-workspace.tsx)

- `AgentWorkspace` 处理会话检查、登录表单和退出。登录后按用户 ID 挂载 `Chat`。
- `Chat` 使用 `useChat<AgentMessage>` 接收流式消息，管理发送、停止和新对话。空会话中的时间、生图和 PPT 示例按钮把对应提示词填入输入框。
- 消息渲染按 `message.parts` 的类型分支。文本分支显示对话内容，`tool-getCurrentTime` 分支显示查询状态。新增的 `tool-generateImage` 分支通过图片 ID 构造预览和下载地址，`tool-generatePresentation` 分支展示标题、页数、下载入口，并在使用备用图时显示受影响页数。生成过程、失败和中断也由各工具分支展示。

### [src/app/api/chat/route.ts](../../src/app/api/chat/route.ts)

- `POST` 的入口检查核对请求来源、登录会话和服务端的 `DEEPSEEK_API_KEY`。消息校验限制请求大小和消息数量，要求最后一条消息包含有效的用户文本，并拒绝系统消息与文件附件。
- `createAgent(apiKey, session.user.id)` 把当前账号传给生成工具。接口用已注册的工具定义验证 UI 消息，再调用 `convertToModelMessages` 转成模型输入。
- `agent.stream` 接收请求的中止信号，超时由 60 秒延长到 270 秒。响应使用 AI SDK 的 UI 消息流，包含文本和工具状态。

### [src/server/agent.ts](../../src/server/agent.ts)

- `providerOptions` 关闭 DeepSeek 的思考模式。`createAgent` 创建 DeepSeek 模型实例，读取 `DEEPSEEK_MODEL`，未设置时使用 `deepseek-flash`。
- `ToolLoopAgent` 的指令说明何时查询时间、何时生成单张图片、何时把对话背景交给 PPT 工具。`tools` 注册这三个工具，其中生图和 PPT 工具接收当前用户 ID。
- `AgentMessage` 从 Agent 的工具定义推导 UI 消息类型，供聊天接口和前端使用。

### [src/server/time-tool.ts](../../src/server/time-tool.ts)

- `getCurrentTime` 是从 `agent.ts` 移出的时区查询工具。输入校验限制时区字符串长度，`execute` 使用 `Intl.DateTimeFormat` 返回指定 IANA 时区的本地时间和 UTC 时间，时区无效时返回错误。

## 图片生成

### [src/server/image-tool.ts](../../src/server/image-tool.ts)

- `createImageTool(userId)` 定义 `generateImage` 的输入，接收文字描述和可选宽高比，默认使用方形。
- `execute` 检查百炼配置并调用 `generateImageAsset`，把 JPEG 和用户 ID 写入 `GeneratedImage`，返回图片 ID。缺少配置或生成失败时返回对应提示，请求取消时传播中止信号。

### [src/server/images.ts](../../src/server/images.ts)

- `imageAspectRatios` 和 `imageSizes` 定义方形、横向和纵向比例与百炼请求尺寸的对应关系。`imageResponse` 校验服务响应结构。
- `generateImageAsset` 读取百炼地址、密钥与模型，默认使用 `wan2.6-t2i`。它在进程内把请求启动时间间隔设为 1.1 秒，并在请求启动后为生成和下载设置共同的 45 秒时限。
- 下载段校验服务端点和图片链接均使用阿里云域名下的 HTTPS 地址，禁止重定向，并在读取响应体时限制文件大小为 12 MiB。处理段用 Sharp 校验图像格式和像素数、调整尺寸，并统一输出 JPEG。聊天生图和 PPT 配图共用这个函数。

## PowerPoint 生成

### [src/server/presentation-tool.ts](../../src/server/presentation-tool.ts)

- `createPresentationTool` 定义 `generatePresentation` 的输入，包括主题、受众、页数、风格、语言和对话背景。页数支持 1–12 页，默认 8 页。
- `writePresentation` 调用模型生成标题和逐页 JSON，校验页数、版式和各字段长度。第一次返回的 JSON 无效或字段校验失败时，附带校验反馈再尝试一次。两次尝试共用 45 秒时限。
- `execute` 串联内容生成、配图、PPTX 渲染和数据库写入，保存标题、文件字节和用户 ID，并把文件 ID、标题、页数和备用图页数返回给聊天界面。

### [src/server/presentations.ts](../../src/server/presentations.ts)

- `slideText`、`slidePoints` 和 `presentationSchema` 定义可用于排版的单行文本、要点数量和四种页面结构。封面接收标题及可选副标题，要点页和总结页使用要点列表，双栏页分别接收左右栏标题和要点。每页都包含配图描述。
- `presentationStyles` 和 `themes` 定义专业、暖色和极简三套配色。`imageBoxes` 为每种版式指定插图的位置和尺寸。
- `preparePresentationImages` 最多同时处理三页，按页面版式组织生图请求并裁切图片。缺少百炼配置或某页生图失败时，`fallbackImage` 根据主题生成本地装饰图。
- `renderPresentation` 使用 PptxGenJS 创建宽屏幻灯片，将文字写入可编辑的文本框并嵌入配图。导出后用 JSZip 移除内容类型清单中指向不存在的幻灯片母版的声明，再返回 PPTX 字节。

## 文件读取与数据库

### 下载接口

- [src/app/api/images/\[id\]/route.ts](../../src/app/api/images/%5Bid%5D/route.ts) 的 `GET` 检查登录状态和 UUID，用文件 ID 与用户 ID 查询记录，返回 JPEG，并设置私有、禁止缓存的响应头。未登录返回 401，找不到当前用户的文件返回 404。
- [src/app/api/presentations/\[id\]/route.ts](../../src/app/api/presentations/%5Bid%5D/route.ts) 的 `GET` 使用相同的会话与所有权校验，返回 PPTX 附件。文件名由标题清理后编码，支持中文名称。

### 数据模型和迁移

- [prisma/schema.prisma](../../prisma/schema.prisma) 的 `User` 新增 `generatedImages` 和 `presentations` 两组关系。两个产物模型都保存 UUID、用户 ID、二进制内容和创建时间。`Presentation` 还保存下载时使用的标题。
- [prisma/migrations/20261112000000_add_presentations/migration.sql](../../prisma/migrations/20261112000000_add_presentations/migration.sql) 创建 `Presentation` 表。
- [prisma/migrations/20261113000000_add_generated_images/migration.sql](../../prisma/migrations/20261113000000_add_generated_images/migration.sql) 创建 `GeneratedImage` 表。
- 两份迁移均使用 `BYTEA` 保存文件内容，并给 `userId` 建索引和外键。删除用户时会级联删除其生成记录。

## 配置、依赖与样例

| 文件 | 变更及各部分作用 |
| --- | --- |
| [.env.example](../../.env.example) | DeepSeek 配置提供聊天密钥和模型。DashScope 配置提供生图密钥、以 `/api/v1` 结尾的服务地址和图像模型。 |
| [compose.yaml](../../compose.yaml) | `app.environment` 向应用容器传入 DeepSeek 和 DashScope 配置。`db` 提供 PostgreSQL，`migrate` 等待数据库健康后应用迁移，应用等待迁移成功后启动。 |
| [package.json](../../package.json) | `dependencies` 用 `@ai-sdk/deepseek` 替换 `@ai-sdk/openai`。PptxGenJS 生成幻灯片，JSZip 处理 PPTX 包，Sharp 处理图片。 |
| [package-lock.json](../../package-lock.json) | 同步根包声明和 `node_modules/*` 依赖条目，锁定安装时使用的直接与传递依赖版本。 |
| [README.md](../../README.md) | Docker Compose 启动章节更新密钥配置，加入生图和 PPT 操作示例及文件访问说明。项目入口表更新 Agent 的职责。 |
| [AGENTS.md](../../AGENTS.md) | 纳入 Next.js 生成的项目说明，指向本地 Next.js 文档，并记录开发服务器重新生成该说明的行为。 |
| [output/武汉城市名片.pptx](../../output/武汉城市名片.pptx) | 一页武汉城市名片样例。 |
| [.wuhan-build/draft.pptx](../../.wuhan-build/draft.pptx) | 样例草稿，与最终样例的 SHA-256 一致。 |
| [.wuhan-build/draft.pptx.inspect.ndjson](../../.wuhan-build/draft.pptx.inspect.ndjson) | 逐行记录演示文稿、版式、页面及页面元素的信息。 |
| [.wuhan-build/validation.json](../../.wuhan-build/validation.json) | 记录样例文件哈希、包结构、页面布局、字体及导入检查结果。 |

## 验证

- 功能提交前，`npm run lint` 和 `npm run typecheck` 均通过。
- 样例 PPT 和草稿均通过 ZIP 完整性检查，SHA-256 一致。
- 本次功能提交前未联调 DeepSeek、百炼或数据库。
