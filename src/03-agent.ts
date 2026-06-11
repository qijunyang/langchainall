/**
 * Phase 3 — A tool-calling ReAct agent with local tools.
 * The model decides when to call the calculator / weather tools.
 * Run: npm run agent
 */
import { createAgent } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { createModel } from "./config.js";
import { localTools } from "./tools/index.js";

async function main(): Promise<void> {
  const agent = createAgent({
    model: createModel(),
    tools: localTools,
  });

  const result = await agent.invoke({
    messages: [
      new HumanMessage(
        "Can you say something to welcome people?",
      ),
    ],
  });

  const last = result.messages[result.messages.length - 1];
  console.log(last.content);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});