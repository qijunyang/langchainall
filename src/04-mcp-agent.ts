/**
 * Phase 4 — The MCP extension.
 * Connects to an MCP server (the official filesystem server, run via npx),
 * loads its tools, and hands them to the SAME ReAct agent from Phase 3 —
 * alongside our local tools. The agent is extended without being rewritten.
 *
 * Run: npm run mcp
 * Requires: Node + npx available (the MCP server is launched as a subprocess).
 */
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import {
  createAgent,
  toolRetryMiddleware,
  toolCallLimitMiddleware,
} from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { createModel } from "./config.js";
import { localTools } from "./tools/index.js";

// URL of our standalone demo MCP server (start it first: `npm run mcp:server`).
const DEMO_MCP_URL =
  process.env.DEMO_MCP_URL ?? "http://localhost:3001/mcp";

async function main(): Promise<void> {
  // Connect to two MCP servers over different transports:
  //  - filesystem: official server, spawned locally over stdio
  //  - demo:       our standalone server, connected REMOTELY over Streamable HTTP
  const client = new MultiServerMCPClient({
    mcpServers: {
      filesystem: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
      },
      demo: {
        transport: "http",
        url: DEMO_MCP_URL,
      },
    },
  });

  try {
    const mcpTools = await client.getTools();
    console.log(
      `Loaded ${mcpTools.length} MCP tool(s): ${mcpTools
        .map((t) => t.name)
        .join(", ")}\n`,
    );

    const agent = createAgent({
      model: createModel(),
      tools: [...localTools, ...mcpTools],
      // Tool-level resilience: retry a flaky/failing tool a couple times, and
      // cap total tool calls per run so a misbehaving loop can't run away.
      middleware: [
        toolRetryMiddleware({ maxRetries: 2, initialDelayMs: 300, jitter: true }),
        toolCallLimitMiddleware({ runLimit: 10 }),
      ],
    });

    const result = await agent.invoke({
      messages: [
        new HumanMessage(`You are a customized agent and you can only use all your tools to
          answer questions. if there is no tool that can help then you just say I don't know.`),
        new HumanMessage(
          // Test mcp tools
          "Reverse the text 'langchain' using a tool"

          // Test local tools
          // "A friend just come and wha you will say to him?"
        ),
      ],
    });

    const last = result.messages[result.messages.length - 1];
    console.log(last.content);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
