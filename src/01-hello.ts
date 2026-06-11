/**
 * Phase 1 — "Hello LLM".
 * Sends a single prompt to the local Ollama model and prints the reply.
 * Run: npm run hello
 */
import { createModel } from "./config.js";

async function main(): Promise<void> {
  const model = createModel();
  const res = await model.invoke("In one sentence, what is LangChain?");
  console.log(res.content);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
