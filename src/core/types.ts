/** Shared types for the TabFind retrieval pipeline. */

/** A tab as indexed for search. */
export interface IndexedTab {
  tabId: number;
  windowId?: number;
  url: string;
  title: string;
  favIconUrl?: string;
  /** Extracted, truncated visible page text. Empty if extraction was blocked. */
  text: string;
  /** One-line description produced during background indexing (optional). */
  gist?: string;
  /** When this entry was indexed. */
  indexedAt: number;
  /** True when we could not inject a content script (chrome://, PDFs, ...). */
  extractionBlocked?: boolean;
}

/** Output of stage 1, query understanding. */
export interface ExpandedQuery {
  /** The user's words, normalised. */
  original: string;
  /** Expanded search terms: synonyms, near-misses, domain words. */
  keywords: string[];
  /** What the user is actually looking for, in one short phrase. */
  intent: string;
}

/** A candidate surviving the lexical prefilter. */
export interface Candidate {
  tab: IndexedTab;
  /** BM25 score from the deterministic prefilter. */
  lexicalScore: number;
}

/** A reranked, user-visible result. */
export interface RankedResult {
  tab: IndexedTab;
  /** 0 unrelated, 1 weak, 2 good, 3 exact. */
  score: number;
  /** Short natural-language justification shown in the UI. */
  why: string;
  lexicalScore: number;
}

/** Progress events emitted while a search runs, for streaming UI. */
export type SearchEvent =
  | { type: 'expanded'; query: ExpandedQuery; ms: number }
  | { type: 'prefiltered'; candidates: Candidate[]; totalIndexed: number; ms: number }
  | { type: 'result'; result: RankedResult; index: number; of: number }
  | { type: 'done'; results: RankedResult[]; ms: number }
  | { type: 'error'; message: string };
