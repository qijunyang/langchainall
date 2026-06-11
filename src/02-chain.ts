/**
 * Phase 2 — Prompts, LCEL chains, and structured output.
 * Run: npm run chain
 */
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableLambda } from "@langchain/core/runnables";
import { z } from "zod";
import { createModel } from "./config.js";

/**
 * A custom Runnable that taps the value flowing through the chain:
 * it prints the result, then returns it unchanged so downstream
 * steps (and the caller of `.invoke()`) still receive the data.
 */
const printResult = new RunnableLambda<string, string>({
  func: (value: string): string => {
    console.log("=== LCEL chain output (printed by runnable) ===\n" + value);
    return value;
  },
});

async function main(): Promise<void> {
  const model = createModel();

  // 1) A simple LCEL chain: prompt -> model -> string parser -> print tap.
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "You are a concise assistant. Answer in one sentence."],
    ["human", "Explain {topic} to a {audience}."],
  ]);
  const chain = prompt
    .pipe(model)
    .pipe(new StringOutputParser())
    .pipe(printResult);
  const text = await chain.invoke({
    topic: "vector embeddings",
    audience: "five-year-old",
  });
  // The runnable already printed; `text` is the same value, returned to us.
  console.log(`(runnable returned ${text.length} chars to the caller)\n`);

  // 2) Structured output enforced by a Zod schema.
  const schema = z.object({
    name: z.string().describe("the language's name"),
    paradigms: z.array(z.string()).describe("programming paradigms it supports"),
    difficulty: z.enum(["easy", "medium", "hard"]),
  });
  const structured = model.withStructuredOutput(schema);
  const obj = await structured.invoke(
    "Describe the TypeScript programming language.",
  );
  console.log("=== Structured output ===");
  console.log(obj);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
