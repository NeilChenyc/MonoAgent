<p align="center">
  <img src="assets/monoagent-logo.png" alt="MonoAgent" width="360">
</p>

<p align="center">
  MonoAgent 是一个轻量级 Agent 运行时，提供 Docker 沙箱、分层记忆与多模型路由。
</p>

## 简介

MonoAgent 是单进程 Node 运行时，在隔离容器中执行 Agent。Agent 层与模型层基于 `pi-agent-core` 与 `pi-ai`，支持 MCP 风格 IPC 工具，并内置飞书（Lark）接入。

## 核心能力

- Docker 沙箱化 Bash 工具，支持流式输出与截断
- 渐进式上下文披露 + 分层记忆 + QMD 混合检索
- `pi-ai` 多模型路由
- SQLite 持久化（消息、会话、任务、记忆）
- 异步 Cron 任务调度
- Skill 注册与 MCP 兼容工具面
- 飞书事件回调接入

## 快速开始

```bash
npm install
npm run build
```

构建容器镜像：

```bash
cd container
./build.sh
```

启动主进程：

```bash
npm start
```

## 配置

### 飞书

在 `.env` 或环境变量中设置：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN`（推荐）
- `FEISHU_PORT`（默认 3002）

### 模型路由

编辑 `config/models.json`，按标签（`general`、`code`、`fast`）路由模型。

### Embedding（OpenAI 兼容）

- `EMBEDDINGS_API_KEY`
- `EMBEDDINGS_BASE_URL`（默认 `https://api.openai.com/v1`）
- `EMBEDDINGS_MODEL`（默认 `text-embedding-3-large`）

### Skill

编辑 `skills/manifest.json`，用于追加系统提示词补丁或启用/禁用工具。

## 架构（简版）

```
飞书 --> SQLite --> Router --> Container (pi-agent-core/pi-ai)
                 ^         |
                 |         +--> IPC 工具（任务、记忆、发送消息）
                 |
              Scheduler
```

## 许可证

MIT
