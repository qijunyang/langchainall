import "dotenv/config";
import { ChatOllama, type ChatOllamaInput } from "@langchain/ollama";

/** Base URL of the local Ollama server (see docker-compose.yml). */
export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/** Model name. Must support tool-calling for the agent demos (Phases 3-4). */
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5";

/**
 * Create a ChatOllama model pointed at the local server.
 * Pass overrides (e.g. `{ temperature: 0.7 }`) to tweak per call site.
 */
export function createModel(
  overrides: Partial<ChatOllamaInput> = {},
): ChatOllama {
  return new ChatOllama({
    baseUrl: OLLAMA_BASE_URL,
    model: OLLAMA_MODEL,
    temperature: 0,
    ...overrides,
  });
}
