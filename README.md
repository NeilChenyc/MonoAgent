
<p align="center">
  MonoAgent is a lightweight agent runtime with Docker sandboxing, layered memory, and multi-provider model routing.
</p>

## What It Is

MonoAgent is a single-process Node runtime that executes agents inside isolated containers. It uses `pi-agent-core` and `pi-ai` for agent orchestration and model access, supports MCP-style IPC tools, and ships with a first-party Feishu (Lark) channel.

## Core Capabilities

- Docker sandboxed Bash tool with streaming + output truncation
- Progressive context disclosure with layered memory + QMD retrieval
- Multi-provider model routing via `pi-ai`
- SQLite persistence for chats, sessions, tasks, memory
- Async cron scheduling with IPC tools
- Skill registry (manifest) and MCP-compatible tool surface
- IM access via Feishu event callbacks

## Quick Start

```bash
npm install
npm run build
```

Build the container image:

```bash
cd container
./build.sh
```

Run the host process:

```bash
npm start
```

## Configuration

### Feishu

Set these environment variables (in `.env` or exported):

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN` (optional but recommended)
- `FEISHU_PORT` (default: 3002)

### Models

Edit `config/models.json` to route models by tag (`general`, `code`, `fast`).

### Embeddings (OpenAI-compatible)

- `EMBEDDINGS_API_KEY`
- `EMBEDDINGS_BASE_URL` (default: `https://api.openai.com/v1`)
- `EMBEDDINGS_MODEL` (default: `text-embedding-3-large`)

### Skills

Edit `skills/manifest.json` to add system prompt patches or enable/disable tools per skill.

## Architecture (High-Level)

```
Feishu --> SQLite --> Router --> Container (pi-agent-core/pi-ai)
                   ^         |
                   |         +--> IPC tools (tasks, memory, send_message)
                   |
              Scheduler
```

## License

MIT
