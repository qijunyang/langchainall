/**
 * A standalone custom MCP server over the modern Streamable HTTP transport,
 * run in STATELESS mode.
 *
 * Start it yourself (long-running app):
 *   npm run mcp:server          (defaults to http://localhost:3001/mcp)
 *
 * The agent (04-mcp-agent.ts) connects to it remotely over the network.
 *
 * Why stateless? Each request gets a fresh server + transport and shares no
 * state between calls, so there is NO session map to track, expire, or reap
 * (no TTL/heartbeat needed) and it scales horizontally behind a plain
 * round-robin load balancer — no sticky sessions. This is the main reason the
 * spec now prefers Streamable HTTP over the deprecated SSE transport.
 *
 * Single endpoint:
 *   POST /mcp   -> one request/response per JSON-RPC message
 *   GET/DELETE  -> 405 (those are only used by stateful, session-based servers)
 */
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** Build a fresh MCP server with our tools (called per request in stateless mode). */
function createServer(): McpServer {
  const server = new McpServer({ name: "demo-mcp", version: "1.0.0" });

  // Deterministic tool — easy to verify the agent actually called it.
  server.registerTool(
    "reverse_text",
    {
      title: "Reverse Text",
      description: "Reverse the characters of the given text and return the result.",
      inputSchema: { text: z.string().describe("the text to reverse") },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: text.split("").reverse().join("") }],
    }),
  );

  // Non-deterministic tool — shows a random side effect.
  server.registerTool(
    "roll_dice",
    {
      title: "Roll Dice",
      description: "Roll an N-sided dice and return the rolled number.",
      inputSchema: {
        sides: z.number().int().min(2).max(100).describe("number of sides on the dice"),
      },
    },
    async ({ sides }) => ({
      content: [
        { type: "text", text: String(Math.floor(Math.random() * sides) + 1) },
      ],
    }),
  );

  return server;
}

// Set MCP_DEBUG=1 to print the JSON-RPC traffic to the console (stderr).
const DEBUG = process.env.MCP_DEBUG === "1";
const logRpc = (dir: "in" | "out", msg: unknown): void => {
  if (DEBUG) console.error(`[MCP ${dir === "in" ? "←in " : "out→"}]`, JSON.stringify(msg));
};

const app = express();
app.use(express.json()); // Streamable HTTP reads the parsed JSON body.

app.post("/mcp", async (req: Request, res: Response) => {
  // Stateless: brand-new server + transport for this single request.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // undefined => stateless (no session id)
  });

  // Log every server->client message by wrapping transport.send (do this
  // BEFORE connect, since connect wires up the protocol around the transport).
  const originalSend = transport.send.bind(transport);
  transport.send = async (message, options) => {
    logRpc("out", message);
    return originalSend(message, options);
  };

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    logRpc("in", req.body); // client->server request (already parsed JSON-RPC)
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode has no session stream / session teardown to serve.
const methodNotAllowed = (_req: Request, res: Response): void => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const port = Number(process.env.MCP_SERVER_PORT ?? 3001);
app.listen(port, () => {
  console.error(
    `demo-mcp Streamable HTTP server listening on http://localhost:${port}/mcp`,
  );
});
