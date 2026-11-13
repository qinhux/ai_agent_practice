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

Compose 等待 PostgreSQL 就绪后执行 Prisma 迁移，再启动应用。打开 [http://localhost:3000](http://localhost:3000)，注册并登录，点击「查询上海时间」填入示例，然后发送。Agent 调用工具时，聊天会显示工具执行状态和流式回复。没有模型密钥时仍可注册和登录。

在聊天里输入「做一份 8 页的武汉城市介绍 PPT」，Agent 会生成带逐页配图的可编辑 `.pptx`。完成后在聊天里点击「下载 PPT」。支持 1–12 页，默认 8 页。单页配图失败时会使用备用插图，下载卡片会显示使用备用图的页数。

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
npm run build
```

## 项目入口

| 路径 | 用途 |
| --- | --- |
| `src/app/page.tsx` | 注册、登录和聊天的页面入口 |
| `src/components/ui/`、`components.json` | shadcn/ui 组件及 CLI 配置 |
| `src/stores/chat-store.ts` | Zustand 管理聊天草稿，AI SDK 管理流式消息 |
| `src/app/api/auth/[...all]/route.ts` | Better Auth 邮箱密码注册、登录和会话 |
| `src/app/api/chat/route.ts` | 校验会话和请求，返回 AI SDK UI 消息 SSE |
| `src/server/agent.ts` | TypeScript Agent Runtime，注册时间查询、图片生成和 PPT 生成工具 |
| `src/app/api/health/route.ts` | `GET /api/health` 检查应用进程 |
| `prisma/` | PostgreSQL 数据模型和迁移 |
