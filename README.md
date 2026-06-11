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
npm run setup:model        # pulls qwen2.5

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

# NOTE: invoke tsx directly. `npm run chat -- --user ...` drops the flags under
# PowerShell (npm's `--` forwarding is broken there), so pass args via tsx:

```bash
# Start a chat (the thread is created and owned by the user on first use)
npx tsx src/05-chat.ts --user u1 --thread t1 "Hi, my name is Bob. Remember it."
npx tsx src/05-chat.ts --user u1 --thread t1 "What is my name?"   # → recalls "Bob"

# A different thread has its own separate history
npx tsx src/05-chat.ts --user u1 --thread t2 "What is my name?"   # → doesn't know

# Authorization: another user cannot open someone else's thread
npx tsx src/05-chat.ts --user u2 --thread t1 "..."                # → rejected

# List a user's chats ("choose a chat next time")
npx tsx src/05-chat.ts --user u1 --list

# Omit --thread to start a "New Chat" (a thread id is generated and printed)
npx tsx src/05-chat.ts --user u1 "A brand new conversation"
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
| `OLLAMA_MODEL` | `qwen2.5` | Model name (must support tool-calling for Phases 3–4) |
| `DEMO_MCP_URL` | `http://localhost:3001/mcp` | URL of the custom MCP server (Phase 4 client) |
| `MCP_SERVER_PORT` | `3001` | Port the custom MCP server listens on |
| `MCP_DEBUG` | _(unset)_ | Set to `1` to log JSON-RPC traffic in the MCP server |
| `DATABASE_URL` | `postgresql://langchain:langchain@localhost:5544/langchain` | Postgres for the Phase 5 checkpointer + metadata |

## Note on the local model

The default is **`qwen2.5`** — it follows instructions and tool-calls reliably.
It runs on **CPU** here, so agent runs (multiple model passes) can be slow, but
the answers are sound.

Memory: since it's CPU-only, models load into **system RAM**. RAG keeps two
models resident at once (the chat model + `nomic-embed-text` for embeddings),
~5–6 GB total. To bound this, you can unload idle models faster via the
`ollama` service env in `docker-compose.yml`:

```yaml
environment:
  OLLAMA_KEEP_ALIVE: "1m"          # unload after 1 min idle (default 5m)
  OLLAMA_MAX_LOADED_MODELS: "2"    # chat + embeddings
```

If RAM is tight, use a smaller variant such as `qwen2.5:3b` (~2 GB).

## Learning roadmap (what to build next)

Covered so far: models, prompts, LCEL/Runnables, structured output, agents +
tools, MCP (incl. a custom server), middleware, persistence/checkpointers,
context trimming, and RAG. What's left turns this from "works in a terminal"
into a real product.

### Tier 1 — to ship a real app
- [ ] **Streaming** — `.stream()` / `.streamEvents()` for token-by-token output
      and live tool steps (the ChatGPT typing UX).
- [ ] **Serve it (API + frontend)** — wrap the agent in an HTTP/SSE endpoint and
      a simple chat UI; ties chat + RAG + memory together for a real user.
- [ ] **Error handling / resilience** — retries, timeouts, model fallbacks
      (`modelRetryMiddleware`, `modelFallbackMiddleware`), graceful failures.
- [ ] **Observability** — LangSmith tracing to see every step/token/tool.

### Tier 2 — make it good *and* safe
- [ ] **Evaluation / testing** — LLM-as-judge, eval sets, regression tests so you
      *know* the RAG/agent is correct (not just eyeballing).
- [ ] **Security: prompt injection** — with RAG + memory + tools, a malicious doc
      or message can hijack the model. The #1 real-world LLM risk.
- [ ] **Advanced RAG** — re-ranking, hybrid (keyword + vector) search, metadata
      filtering, citations, query rewriting.
- [ ] **Summarization memory** — long-thread memory beyond trimming (the
      "forgot the early context" fix); `summarizationMiddleware`.

### Tier 3 — agent depth
- [ ] **Author a custom LangGraph** — your own nodes/branches/state (vs. the
      prebuilt `createAgent`).
- [ ] **Human-in-the-loop** — approval/interrupt before an agent takes a real
      action (`humanInTheLoopMiddleware`).
- [ ] **Multi-agent / orchestration** — supervisor + sub-agents for complex tasks.

> Suggested path: **streaming → serve as API → simple chat UI**, which pulls in
> several Tier-1 topics at once and produces a demoable product.
