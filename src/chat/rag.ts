/**
 * RAG over the firm's office info, using pgvector directly via the `pg` driver
 * (no vector-store library) so the similarity SQL is visible.
 *
 * - Ingestion (one-time / on data change): read office-info.md -> split into
 *   sections -> embed each with a local Ollama model -> store in `office_docs`.
 * - Retrieval (per question): embed the query -> nearest neighbours by cosine
 *   distance (`<=>`).
 *
 * Embeddings: nomic-embed-text (768 dimensions) served by local Ollama.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OllamaEmbeddings } from "@langchain/ollama";
import { OLLAMA_BASE_URL } from "../config.js";
import { pool } from "./store.js";

const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const EMBED_DIM = 768; // nomic-embed-text output dimensions

const officeInfoPath = fileURLToPath(
  new URL("./office-info.md", import.meta.url),
);

const embeddings = new OllamaEmbeddings({
  model: EMBED_MODEL,
  baseUrl: OLLAMA_BASE_URL,
});

/** pgvector accepts a vector literal as the string "[1,2,3]". */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/** Split the markdown into one chunk per "## " section (semantic chunking). */
function splitIntoSections(markdown: string): string[] {
  return markdown
    .split(/^## /m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("# ")) // drop the H1 preamble
    .map((s) => `## ${s}`);
}

export async function ensureVectorSchema(): Promise<void> {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector;");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS office_docs (
      id        BIGSERIAL PRIMARY KEY,
      content   TEXT NOT NULL,
      embedding vector(${EMBED_DIM}) NOT NULL
    );
  `);
}

/** Read the office doc, embed each section, and (re)store it. Idempotent. */
export async function ingestOfficeInfo(): Promise<number> {
  await ensureVectorSchema();
  const chunks = splitIntoSections(readFileSync(officeInfoPath, "utf8"));

  const vectors = await embeddings.embedDocuments(chunks);

  // Idempotent: clear then re-insert so re-running never duplicates rows.
  await pool.query("TRUNCATE office_docs RESTART IDENTITY;");
  for (let i = 0; i < chunks.length; i++) {
    await pool.query(
      "INSERT INTO office_docs (content, embedding) VALUES ($1, $2);",
      [chunks[i], toVectorLiteral(vectors[i])],
    );
  }
  return chunks.length;
}

/** Embed the query and return the top-k most similar chunks (cosine distance). */
export async function retrieveOfficeInfo(
  query: string,
  k = 3,
): Promise<string[]> {
  const qvec = await embeddings.embedQuery(query);
  const { rows } = await pool.query<{ content: string }>(
    "SELECT content FROM office_docs ORDER BY embedding <=> $1 LIMIT $2;",
    [toVectorLiteral(qvec), k],
  );
  return rows.map((r) => r.content);
}
