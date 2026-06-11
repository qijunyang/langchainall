/**
 * Human-in-the-loop verification (Phase: HITL, step 1).
 *
 * Asks the agent for the user ID. The get_user_id tool is guarded, so the agent
 * INTERRUPTS for approval instead of running it. We then resume two threads —
 * one approving, one rejecting — to prove the mechanics before touching the API/UI.
 *
 *   npx tsx src/07-hitl.ts
 */
import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { buildChatAgent } from "./chat/agent.js";
import { ensureSchema, authorizeOrCreate, closeStore } from "./chat/store.js";

function lastText(res: { messages: Array<{ content?: unknown }> }): string {
  const c = res.messages.at(-1)?.content;
  return typeof c === "string" ? c : JSON.stringify(c);
}

async function main(): Promise<void> {
  await ensureSchema();
  const agent = await buildChatAgent();
  const userId = "hitl-user";

  // ---------- thread A: approve ----------
  const tA = randomUUID();
  await authorizeOrCreate(tA, userId, "hitl approve");
  const cfgA = { configurable: { thread_id: tA } };

  console.log("=== ask for ID (thread A) -> expect an interrupt ===");
  const r1 = (await agent.invoke(
    { messages: [new HumanMessage("show me my id")] },
    cfgA,
  )) as { __interrupt__?: unknown };
  console.log("__interrupt__:", JSON.stringify(r1.__interrupt__, null, 2));
  const stateA = (await agent.getState(cfgA)) as { next?: readonly string[] };
  console.log("paused, next nodes:", JSON.stringify(stateA.next));

  console.log("\n=== resume APPROVE -> expect the ID ===");
  const r2 = await agent.invoke(
    new Command({ resume: { decisions: [{ type: "approve" }] } }),
    cfgA,
  );
  console.log("final:", lastText(r2));

  // ---------- thread B: reject ----------
  const tB = randomUUID();
  await authorizeOrCreate(tB, userId, "hitl reject");
  const cfgB = { configurable: { thread_id: tB } };

  console.log("\n=== ask for ID (thread B) then resume REJECT ===");
  await agent.invoke({ messages: [new HumanMessage("show me my id")] }, cfgB);
  const r3 = await agent.invoke(
    new Command({
      resume: { decisions: [{ type: "reject", message: "User declined." }] },
    }),
    cfgB,
  );
  console.log("final:", lastText(r3));
}

main()
  .catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeStore());
