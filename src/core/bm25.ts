/**
 * Stage 2 of the pipeline: a deterministic lexical prefilter.
 *
 * No model runs here. This exists so the on-device model is never asked to hold
 * 40 documents in its head at once — it narrows the field to a handful of
 * candidates in about a millisecond, and every tab it eliminates is an inference
 * call we don't make. That is the difference between a two-second search and a
 * forty-second one.
 *
 * It only works as well as it does because stage 1 already expanded the user's
 * fuzzy phrasing into concrete terms. On the raw query, BM25 would throw away the
 * very tabs that make semantic search worth doing.
 */

import type { IndexedTab, Candidate, ExpandedQuery } from './types.js';

const K1 = 1.5;
const B = 0.75;

/** Words too common to carry signal. */
const STOPWORDS = new Set([
  'a', 'about', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been',
  'but', 'by', 'can', 'did', 'do', 'does', 'for', 'from', 'get', 'had', 'has',
  'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me',
  'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 's', 'she', 'so', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up',
  'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'will',
  'with', 'would', 'you', 'your',
  // Conversational filler. People describe a tab as "that thing about X" or
  // "the pasta one", and without these the filler words match real page text:
  // "the pasta ONE" scores against "you have ONE document awaiting completion",
  // and "what do I NEED to sign" against "Attention Is All You NEED".
  'thing', 'things', 'stuff', 'one', 'ones', 'need', 'needed', 'want', 'find',
  'look', 'looking', 'put', 'said', 'say', 'take', 'took', 'go', 'got', 'know',
  'something', 'somewhere', 'anything', 'page', 'tab', 'open',
]);

/** Lowercases, strips punctuation, splits, drops stopwords and 1-char tokens. */
export function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * A very small amount of morphology. Full stemming is overkill for tab titles
 * and costs more than it returns; folding common suffixes catches most of the
 * refund/refunds, return/returns, book/booking cases that matter here.
 */
export function fold(token: string): string {
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'ers', 'er', 'ies', 'es', 's']) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

interface Doc {
  tab: IndexedTab;
  tokens: string[];
  tf: Map<string, number>;
  length: number;
}

/** Builds the searchable document for a tab, weighting the title and URL. */
function buildDoc(tab: IndexedTab): Doc {
  // Title and URL words are repeated so they outweigh body text, which is both
  // longer and noisier. A match in the title is a much stronger signal.
  const urlWords = tab.url.replace(/https?:\/\//, '').replace(/[/\-_.?=&]+/g, ' ');
  const parts = [
    tab.title, tab.title, tab.title,
    urlWords, urlWords,
    tab.gist ?? '', tab.gist ?? '',
    tab.text,
  ];
  const tokens = tokenize(parts.join(' ')).map(fold);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { tab, tokens, tf, length: tokens.length };
}

export class Bm25Index {
  private docs: Doc[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(tabs: IndexedTab[] = []) {
    this.rebuild(tabs);
  }

  rebuild(tabs: IndexedTab[]) {
    this.docs = tabs.map(buildDoc);
    this.df.clear();
    for (const d of this.docs) {
      for (const term of new Set(d.tokens)) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
    this.avgLen = this.docs.length
      ? this.docs.reduce((s, d) => s + d.length, 0) / this.docs.length
      : 0;
  }

  get size() {
    return this.docs.length;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    // Standard BM25 idf, floored so that a term appearing in every document
    // contributes nothing rather than going negative.
    return Math.max(0, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  /** Scores every document against the expanded query terms. */
  score(query: ExpandedQuery): Candidate[] {
    // Original words count more than machine-generated expansions, so a literal
    // match still wins when the user did type the exact word.
    const weighted = new Map<string, number>();
    for (const t of tokenize(query.original).map(fold)) {
      weighted.set(t, Math.max(weighted.get(t) ?? 0, 1.0));
    }
    for (const kw of query.keywords) {
      for (const t of tokenize(kw).map(fold)) {
        weighted.set(t, Math.max(weighted.get(t) ?? 0, 0.6));
      }
    }
    for (const t of tokenize(query.intent).map(fold)) {
      weighted.set(t, Math.max(weighted.get(t) ?? 0, 0.4));
    }

    const out: Candidate[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const [term, weight] of weighted) {
        const f = d.tf.get(term);
        if (!f) continue;
        const denom = f + K1 * (1 - B + (B * d.length) / (this.avgLen || 1));
        score += weight * this.idf(term) * ((f * (K1 + 1)) / denom);
      }
      if (score > 0) out.push({ tab: d.tab, lexicalScore: score });
    }
    out.sort((a, b) => b.lexicalScore - a.lexicalScore);
    return out;
  }

  /**
   * Top-N candidates for reranking.
   *
   * If lexical matching finds nothing at all (the expansion missed), we fall back
   * to the most recently indexed tabs rather than returning an empty list — the
   * model still gets a chance to recognise something, which is strictly better
   * than telling the user "no results" because BM25 had a bad day.
   */
  prefilter(query: ExpandedQuery, limit: number): Candidate[] {
    const scored = this.score(query);
    if (scored.length >= Math.min(3, this.docs.length)) return scored.slice(0, limit);
    const seen = new Set(scored.map((c) => c.tab.tabId));
    const filler = this.docs
      .filter((d) => !seen.has(d.tab.tabId))
      .sort((a, b) => b.tab.indexedAt - a.tab.indexedAt)
      .slice(0, limit - scored.length)
      .map((d) => ({ tab: d.tab, lexicalScore: 0 }));
    return [...scored, ...filler];
  }
}
