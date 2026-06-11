/**
 * Phase 6 — RAG ingestion + a quick retrieval check (standalone, before the
 * chat integration).
 *
 * Ingest (one-time / when office-info.md changes):
 *   npx tsx src/06-rag-ingest.ts
 *
 * Test retrieval for a question:
 *   npx tsx src/06-rag-ingest.ts "what time does the office open?"
 */
import { ingestOfficeInfo, retrieveOfficeInfo } from "./chat/rag.js";
import { closeStore } from "./chat/store.js";

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim();

  if (query) {
    const hits = await retrieveOfficeInfo(query, 3);
    console.log(`Top ${hits.length} chunks for: "${query}"\n`);
    hits.forEach((c, i) => console.log(`--- #${i + 1} ---\n${c}\n`));
    return;
  }

  const n = await ingestOfficeInfo();
  console.log(`Ingested ${n} office-info chunks into pgvector (office_docs).`);
}

main()
  .catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeStore());
