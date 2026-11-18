# Agent Practice

一个 TypeScript 全栈 Agent 项目。Next.js App Router 同时提供 React 页面、Better Auth 接口和 Agent 接口。PostgreSQL 通过 Prisma 保存账号和会话，对话消息保留在当前页面内存中。

## 用 Docker Compose 启动

需要 Docker 和 Docker Compose。

```bash
cp .env.example .env
openssl rand -hex 32
```

把生成的值写入 `.env` 的 `BETTER_AUTH_SECRET`，并从 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 获取密钥，填入 `DEEPSEEK_API_KEY`。默认使用 `deepseek-flash`，可将 `DEEPSEEK_MODEL` 设为 `deepseek-v4-pro`。当前 Agent 使用非思考模式执行工具调用。

```bash
docker compose up --build
```

Compose 等待 PostgreSQL 就绪后执行 Prisma 迁移，再启动应用。先按下方「邮箱认证」配置 SMTP，然后打开 [http://localhost:3000](http://localhost:3000)，注册、验证邮箱并登录，点击「查询上海时间」填入示例，然后发送。Agent 调用工具时，聊天会显示工具执行状态和流式回复。没有模型密钥时仍可注册和登录。

在聊天里输入「做一份 8 页的武汉城市介绍 PPT」，Agent 会生成可编辑的 `.pptx`，并根据每页内容决定是否配图。无图页会使用纯文字版式。完成后在聊天里点击「下载 PPT」。支持 1–12 页，默认 8 页。需要配图的页面在生图失败时会使用备用插图，下载卡片会显示使用备用图的页数。

联网资料研究复用 `.env` 中的 `DEEPSEEK_API_KEY`，无需单独配置搜索服务密钥。聊天输入框上方可选择「自动搜索」「联网搜索」「仅用提供的资料」。自动模式会根据主题决定是否研究公开资料；用户明确要求仅根据材料时也不会搜索。搜索与原文读取使用 [DeepSeek Search & Fetch API](https://api-docs.deepseek.com/guides/search/)，分别调用 `POST /v1/tools/search` 和 `POST /v1/tools/fetch`。搜索摘要不作为重要事实的最终依据。每轮最多 4 次搜索、读取 6 篇原文，单条搜索词最多 128 个 Unicode 字符，按查询和来源去重缓存，外部请求有 20 秒超时并跟随停止生成取消。Search 与 Fetch 按成功请求单独计费，使用同一 DeepSeek 账户余额，具体规则见官方文档。

PPT 在大纲规划前提取原文证据，写作时同步选择所用来源，不再执行独立的事实核验或核验失败后的自动改写。引用编号附在对应文字旁，当页底部显示可点击的简短来源，完整 URL、原文摘录、统计时期和计算说明写入演讲者备注；不额外增加参考文献页。用户材料标记为「未独立核实」。来源、证据、页面和文本目标之间的对应关系保存在现有 `Presentation.source` JSON 中，无需数据库迁移。移动页面和修改样式会保留引用；修改正文后自动清理对应的旧引用，其余引用保留，不因事实核验结果阻止保存。旧版无来源数据的 PPT 保持原有编辑行为，不自动补造来源。

自动模式遇到未配置密钥或检索失败，会在下载卡片提示，内容仅采用用户材料和不依赖外部数据的分析；显式选择「联网搜索」时，没有取得可读取原文会停止生成并说明原因；已读取原文但没有可引用片段时会继续生成。原文摘录的存在及引用 ID 由程序校验，当前已取消模型语义核验；来源标注不代表事实已经核实。第一版使用限定轮次的研究，不包含大纲后的自动补查或图片授权检索。

PPT 默认在左上角加入与标题对齐的短横主题色条，内容页标题下使用中性灰细线分隔；封面和一句话收尾页使用稍大的色条和短灰线，满版配图内容页省略长分隔线。配色适配深浅背景，装饰与已编辑元素冲突时自动省略。主题的 `headerStyle` 默认是 `accent-rule`，用户要求无页眉装饰时可规划为 `none`。旧版 `legacyLayout` 沿用原有样式。

逐页文案生成时，LLM 通过 `textHighlights` 决定是否使用主题色强调关键词或关键短句，例如 `{"point1":["提高效率"]}`；不强调时返回 `{}`。同一文本框内只给选中短语上色，颜色使用当前深浅背景的 `accentText`。支持聊天中调整或取消模板文本的局部强调，修改文案时自动清理不再匹配的短语；显式设置的整框文字颜色优先。历史页面未提供该字段时保留原有配色。

要启用阿里云百炼生图，在 `.env` 中填入 `DASHSCOPE_API_KEY` 和百炼控制台提供的 DashScope 专属地址 `DASHSCOPE_BASE_URL`（以 `/api/v1` 结尾）。默认模型是 `wan2.6-t2i`。在聊天里输入「生成一张在窗边晒太阳的橘猫插画」，可以直接预览和下载图片。生成的图片和 PPT 保存在 PostgreSQL 中，由生成它们的账号访问。

Compose 默认将应用和数据库端口绑定到本机，数据库使用开发凭据。部署到其他地址时，配置外部访问地址作为 `BETTER_AUTH_URL`，并为 PostgreSQL 配置部署凭据。

## 本地开发

使用 Node.js 22.12+ 或 24+。先按上面的步骤创建并填写 `.env`。可使用 Compose 单独启动数据库，或把 `DATABASE_URL` 指向现有 PostgreSQL。

```bash
docker compose up -d --wait db
npm ci
npm run db:deploy
npm run dev
```

`npm ci` 会生成 Prisma Client。修改 Prisma schema 后可通过 `npm run db:migrate -- --name <名称>` 创建并应用开发迁移。

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## 邮箱认证

支持邮箱密码注册、邮箱验证、登录、退出和密码找回。注册不会自动登录，必须先输入真实邮件中的六位数字验证码；已有未验证账号也需补验证，原账号 ID、PPT 和图片保持不变。工作台和业务 API 都会检查邮箱验证状态。

在 `.env` 中配置以下参数（请勿将真实凭据提交到 Git）：

```dotenv
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-address@qq.com
SMTP_PASS=your-smtp-authorization-code
MAIL_FROM="Agent Practice <your-address@qq.com>"
```

QQ 邮箱需在网页端「设置 → 账号与安全 → 安全设置」开启 SMTP 服务并生成授权码。`SMTP_PASS` 使用授权码，不使用 QQ 登录密码；`MAIL_FROM` 的邮箱应与发信账号一致。465 使用 `SMTP_SECURE=true`；若其他服务商要求 587/STARTTLS，则使用 `false`，连接仍强制启用 TLS。修改环境变量后重启应用；Docker 部署需要重建/重新创建 app 服务以应用新代码和环境变量。

页面入口：`/login`、`/register`、`/verify-email`、`/forgot-password` 和 `/reset-password`。邮箱验证码有效期 5 分钟、最多允许 5 次错误尝试，成功后只能使用一次；验证码以哈希形式保存，重发后旧验证码失效。旧版邮箱验证链接停用。密码重置邮件有效期 30 分钟，重置链接只能使用一次，成功后撤销该用户的所有旧会话。重发按钮冷却 60 秒，验证码发送接口对同一客户端每分钟最多允许 1 次请求；服务端同时限制注册、登录和发信请求频率（当前为单实例内存计数，重启后重置）。

发信失败时页面会提供重试提示。若注册时邮件未能发出，账号可能已创建，可进入「验证邮箱」页重新发送，无需重复注册。若注册邮箱已存在，界面会返回通用提示；已有账号请直接登录，忘记密码请走找回流程。

本地开发保留 `BETTER_AUTH_URL=http://localhost:3000`，密码重置邮件链接应在运行项目的这台电脑上打开。邮箱验证邮件可以在手机等其他设备上查看，然后在项目页面输入验证码。需要跨设备访问时，改成设备可访问的应用地址，并从该地址打开网站；正式部署使用 HTTPS。账号验证和密码重置邮件均由真实 SMTP 服务发送。

运行 `npm test` 可验证注册验证流程、重发、密码重置单次使用、旧会话撤销、验证码过期与错误次数、重发失效和单次使用、过期重置链接、跳转校验、发信错误和限流。测试使用隔离的内存数据库与捕获邮件，不会给真实用户发送邮件。

## 项目入口

| 路径 | 用途 |
| --- | --- |
| `src/app/page.tsx` | 注册、登录和聊天的页面入口 |
| `src/components/ui/`、`components.json` | shadcn/ui 组件及 CLI 配置 |
| `src/stores/chat-store.ts` | Zustand 管理聊天草稿，AI SDK 管理流式消息 |
| `src/app/api/auth/[...all]/route.ts` | Better Auth 邮箱认证接口及邮件发送状态处理 |
| `src/app/(auth)/`、`src/components/auth-form.tsx` | 登录、注册、验证邮箱与密码找回页面 |
| `src/server/mail.ts`、`src/server/email-auth-options.ts` | SMTP 真实发信与邮箱认证策略 |
| `src/app/api/chat/route.ts` | 校验会话和请求，返回 AI SDK UI 消息 SSE |
| `src/server/agent.ts` | TypeScript Agent Runtime，注册时间查询、图片生成和 PPT 生成工具 |
| `src/app/api/health/route.ts` | `GET /api/health` 检查应用进程 |
| `prisma/` | PostgreSQL 数据模型和迁移 |
