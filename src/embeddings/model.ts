/** The production embedding model; shared by the in-process embedder and the worker's main-thread proxy. */
export const BGE_MODEL = 'Xenova/bge-small-en-v1.5';
export const BGE_DIM = 384;
/**
 * BGE's retrieval instruction, added to short queries and never to passages
 * (the `BAAI/bge-small-en-v1.5` model card). Over croc's vault it raised title
 * queries' MRR from 0.586 to 0.632 and lifted sentences' from 0.557 to 0.588
 * (D47, `eval/embedding-summary-query-ab.ts --instruction`).
 */
export const BGE_QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';
