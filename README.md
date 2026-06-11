# langchainall

A progressive **LangChain.js + TypeScript** demo that runs entirely on a **local
model via Ollama** (no API keys) and grows from a single LLM call into a
**tool-calling agent**, an **MCP-extended agent**, and finally a **persistent,
multi-chat agent** backed by Postgres.

## Phases

| File | npm script | What it shows |
|---|---|---|
| `src/01-hello.ts` | `npm run hello` | A single prompt → `ChatOllama` reply |
| `src/02-chain.ts` | `npm run chain` | LCEL prompt chains, Zod structured output, a custom `RunnableLambda` tap |
| `src/03-agent.ts` | `npm run agent` | A tool-calling agent (`createAgent`) with local tools (calculator, weather, welcome) |
| `src/04-mcp-agent.ts` | `npm run mcp` | The same agent extended with **MCP tools** over **mixed transports** |
| `src/05-chat.ts` | `npm run chat` | **Persistent multi-chat**: one stateless agent + a Postgres checkpointer keyed by `thread_id`, with per-user ownership (ChatGPT-style) |

## Prerequisites

- **Node.js 20+**
- **Docker** (runs Ollama + Postgres). A GPU is optional — see the commented block in `docker-compose.yml`.

## Setup

```bash
# 1. Install JS dependencies
npm install

# 2. Start the local infrastructure (Ollama + Postgres) — the `dev` profile
npm run ollama:up

# 3. Pull the model (a few GB, first run only). Must support tool-calling.
npm run setup:model        # pulls llama3.1

# 4. (optional) configure overrides
cp .env.example .env
```

> `npm run ollama:up` brings up **both** services (they share the `dev` profile):
> Ollama on `localhost:11434` and Postgres on `localhost:5544`. Stop them with
> `npm run ollama:down`.

## Run the phases

```bash
npm run hello     # Phase 1
npm run chain     # Phase 2
npm run agent     # Phase 3
```

### Phase 4 — MCP (two terminals)

The agent connects to two MCP servers: the official **filesystem** server
(spawned locally over **stdio**) and our **custom demo server** (a standalone
app connected remotely over **Streamable HTTP**).

```bash
# Terminal 1 — start the custom MCP server (long-running)
npm run mcp:server          # http://localhost:3001/mcp
#   set MCP_DEBUG=1 to print JSON-RPC traffic, e.g. (PowerShell):
#   $env:MCP_DEBUG="1"; npm run mcp:server

# Terminal 2 — run the agent
npm run mcp
```

### Phase 5 — Persistent multi-chat

One **stateless** agent; conversation history lives in a **Postgres
checkpointer** keyed by `thread_id`. Ownership/metadata (`userId`, title) live in
a separate `chat_threads` table — the "app DB", distinct from the checkpointer.
Each run is a separate process, so memory persists across runs.

```bash
# Start a chat (the thread is created and owned by the user on first use)
npm run chat -- --user u1 --thread t1 "Hi, my name is Bob. Remember it."
npm run chat -- --user u1 --thread t1 "What is my name?"   # → recalls "Bob"

# A different thread has its own separate history
npm run chat -- --user u1 --thread t2 "What is my name?"   # → doesn't know

# Authorization: another user cannot open someone else's thread
npm run chat -- --user u2 --thread t1 "..."                # → rejected

# List a user's chats ("choose a chat next time")
npm run chat -- --user u1 --list

# Omit --thread to start a "New Chat" (a thread id is generated and printed)
npm run chat -- --user u1 "A brand new conversation"
```

## How it fits together

- **Everything is a Runnable** (`.invoke()`): a chain pipes Runnables in a fixed
  order; an agent is a Runnable with a loop where the model picks tools; MCP
  tools are adapted into Runnable tools indistinguishable from local ones.
- **MCP transports**: `stdio` = a local subprocess (filesystem server);
  **Streamable HTTP** = a real web app you deploy (our demo server, stateless —
  no session map, no TTL, scales horizontally).
- **Persistence (Phase 5)** is the "stateless compute + external state" pattern:
  one shared agent, state in a networked checkpointer keyed by `thread_id`, and
  `userId`/metadata in a separate shared DB — already the distributed-ready
  shape (add a per-thread distributed lock for multi-instance writes).

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.1` | Model name (must support tool-calling for Phases 3–4) |
| `DEMO_MCP_URL` | `http://localhost:3001/mcp` | URL of the custom MCP server (Phase 4 client) |
| `MCP_SERVER_PORT` | `3001` | Port the custom MCP server listens on |
| `MCP_DEBUG` | _(unset)_ | Set to `1` to log JSON-RPC traffic in the MCP server |
| `DATABASE_URL` | `postgresql://langchain:langchain@localhost:5544/langchain` | Postgres for the Phase 5 checkpointer + metadata |

## Note on the local model

`llama3.1` runs on **CPU** here, so agent runs (multiple model passes) can be
slow, and it occasionally fumbles tool-calling on conversational input. If you
want crisper, faster agent behavior, pull a stronger tool-caller and point the
model at it:

```bash
docker compose exec ollama ollama pull qwen2.5
#   then set OLLAMA_MODEL=qwen2.5 in .env
```
