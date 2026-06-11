# langchainall

A LangChain.js + TypeScript demo that runs entirely on a **local model via Ollama**
(no API keys), and grows from a single LLM call into an **MCP-extended tool-calling agent**.

## Phases

| File | npm script | What it shows |
|---|---|---|
| `src/01-hello.ts` | `npm run hello` | A single prompt → model → reply |
| `src/02-chain.ts` | `npm run chain` | LCEL prompt chains + Zod structured output |
| `src/03-agent.ts` | `npm run agent` | A ReAct agent calling local tools (calculator, weather) |
| `src/04-mcp-agent.ts` | `npm run mcp` | The same agent, **extended with MCP tools** (filesystem server) |

## Prerequisites

- Node.js 20+
- Docker (to run Ollama). A GPU is optional — see the commented block in `docker-compose.yml`.

## Setup

```bash
# 1. Install JS dependencies
npm install

# 2. Start the local Ollama server (http://localhost:11434)
npm run ollama:up

# 3. Pull the model (a few GB — first run only). Must support tool-calling.
npm run setup:model        # pulls llama3.1

# 4. (optional) configure overrides
cp .env.example .env
```

## Run

```bash
npm run hello     # Phase 1
npm run chain     # Phase 2
npm run agent     # Phase 3
npm run mcp       # Phase 4 (MCP)
```

Stop the server with `npm run ollama:down`.

## How the MCP extension works (Phase 4)

`src/04-mcp-agent.ts` uses `@langchain/mcp-adapters`'s `MultiServerMCPClient` to launch
the official **filesystem** MCP server (`@modelcontextprotocol/server-filesystem`) over
stdio via `npx`. Its tools are loaded with `client.getTools()` and merged with the local
tools, then handed to the exact same `createReactAgent` from Phase 3:

```ts
const mcpTools = await client.getTools();
const agent = createReactAgent({ llm, tools: [...localTools, ...mcpTools] });
```

To add more MCP servers, add entries under `mcpServers` in that file.

## Config

| Env var | Default | Meaning |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.1` | Model name (must support tool-calling for Phases 3–4) |
