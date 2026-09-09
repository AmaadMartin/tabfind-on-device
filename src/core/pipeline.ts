/**
 * The TabFind retrieval pipeline.
 *
 *   query --> [1] expand (LlmAgent, schema-constrained)
 *         --> [2] BM25 prefilter (no model, ~1ms)
 *         --> [3] rerank (ParallelAgent, one child LlmAgent per candidate)
 *         --> ranked results
 *
 * Stage 3 is the important design choice. The obvious implementation — hand all
 * forty tabs to the model and ask which are relevant — is exactly what a small
 * model is worst at, and it blows the context window besides. Instead each
 * candidate gets its own child agent asking a single bounded question: "here is
 * one page, score it 0-3 and say why in twelve words." That is a judgement a
 * small model makes reliably.
 *
 * Stage 2 is deterministic on purpose. Every tab BM25 eliminates is an inference
 * call that never happens, and it cannot hallucinate.
 *
 * Stage 1 is what keeps stage 2 honest. Run BM25 on the raw query and the tab
 * titled "Order #48213 - Return authorization" never survives the query "that
 * thing about the refund" — which is precisely the result that makes this worth
 * building.
 */

import {
  LlmAgent,
  ParallelAgent,
  Runner,
  InMemorySessionService,
  type BaseLlm,
  type Event,
} from '@google/adk';
import type { Schema } from '@google/genai';
import { Bm25Index } from './bm25.js';
import {
  EXPAND_SCHEMA,
  EXPAND_SYSTEM,
  RERANK_SCHEMA,
  RERANK_SYSTEM,
  expandUserPrompt,
  rerankUserPrompt,
} from './prompts.js';
import type {
  Candidate,
  ExpandedQuery,
  IndexedTab,
  RankedResult,
  SearchEvent,
} from './types.js';

const APP_NAME = 'tabfind';
const USER_ID = 'local';

export interface PipelineOptions {
  model: BaseLlm;
  /** Candidates sent to the reranker. Keep small; this bounds worst-case latency. */
  candidateLimit?: number;
  /** Results with a score below this are dropped. Default 1. */
  minScore?: number;
  /** Skips stage 1 and uses the raw query. For the eval's ablation arm. */
  skipExpansion?: boolean;
}

/** Sanitises a tab id into a valid ADK agent name. */
function agentNameFor(tabId: number): string {
  return `rerank_${String(tabId).replace(/[^0-9]/g, '')}`;
}

export class TabSearchPipeline {
  private readonly index = new Bm25Index();
  private readonly sessions = new InMemorySessionService();

  constructor(private readonly opts: PipelineOptions) {}

  /** Replaces the searchable corpus. Cheap; call whenever tabs change. */
  setTabs(tabs: IndexedTab[]) {
    this.index.rebuild(tabs);
  }

  get indexedCount() {
    return this.index.size;
  }

  /**
   * Runs a search, yielding progress as it goes.
   *
   * Results stream out one at a time rather than arriving as a batch. That is
   * partly UX — tabs lighting up one by one reads as the model considering each
   * one — and partly insurance: if inference serialises on a single model
   * instance, progressive reveal keeps the interface responsive anyway.
   */
  async *search(query: string, signal?: AbortSignal): AsyncGenerator<SearchEvent> {
    try {
      const tExpand = performance.now();
      const expanded = this.opts.skipExpansion
        ? { original: query, keywords: [], intent: query }
        : await this.expand(query, signal);
      yield { type: 'expanded', query: expanded, ms: performance.now() - tExpand };

      const tFilter = performance.now();
      const candidates = this.index.prefilter(expanded, this.opts.candidateLimit ?? 10);
      yield {
        type: 'prefiltered',
        candidates,
        totalIndexed: this.index.size,
        ms: performance.now() - tFilter,
      };

      if (!candidates.length) {
        yield { type: 'done', results: [], ms: 0 };
        return;
      }

      const tRank = performance.now();
      const results: RankedResult[] = [];
      const minScore = this.opts.minScore ?? 1;

      for await (const r of this.rerank(query, expanded, candidates, signal)) {
        results.push(r);
        yield { type: 'result', result: r, index: results.length, of: candidates.length };
      }

      results.sort(
        (a, b) => b.score - a.score || b.lexicalScore - a.lexicalScore,
      );
      yield {
        type: 'done',
        results: results.filter((r) => r.score >= minScore),
        ms: performance.now() - tRank,
      };
    } catch (err) {
      yield { type: 'error', message: (err as Error)?.message ?? String(err) };
    }
  }

  /* --------------------------- stage 1 --------------------------- */

  private async expand(query: string, signal?: AbortSignal): Promise<ExpandedQuery> {
    const agent = new LlmAgent({
      name: 'expand_query',
      model: this.opts.model,
      // Constant instruction -> constant system prompt -> the adapter's warm base
      // session is reused across every search. The query travels in the user
      // message, so `includeContents` must stay at its default; 'none' would
      // strip the only thing this agent needs to see.
      instruction: EXPAND_SYSTEM,
      outputSchema: EXPAND_SCHEMA as unknown as Schema,
    });

    const text = await this.runToText(agent, expandUserPrompt(query), signal);
    const parsed = safeJson(text);

    // Expansion is an optimisation, not a correctness requirement. If the model
    // returns nonsense we degrade to the raw query rather than failing the search.
    return {
      original: query,
      keywords: Array.isArray(parsed?.keywords)
        ? parsed.keywords.filter((k: unknown) => typeof k === 'string').slice(0, 12)
        : [],
      intent: typeof parsed?.intent === 'string' ? parsed.intent : query,
    };
  }

  /* --------------------------- stage 3 --------------------------- */

  /**
   * Fans out one child agent per candidate under a ParallelAgent and yields each
   * verdict as its child finishes.
   */
  private async *rerank(
    query: string,
    expanded: ExpandedQuery,
    candidates: Candidate[],
    signal?: AbortSignal,
  ): AsyncGenerator<RankedResult> {
    const byAgentName = new Map<string, Candidate>();

    const children = candidates.map((c) => {
      const name = agentNameFor(c.tab.tabId);
      byAgentName.set(name, c);
      const prompt = rerankUserPrompt({
        query,
        intent: expanded.intent,
        title: c.tab.title,
        url: c.tab.url,
        text: c.tab.text,
      });
      return new LlmAgent({
        name,
        model: this.opts.model,
        // Every child shares the *identical* instruction on purpose. The adapter
        // keys its warm base session on the system prompt, so a shared
        // instruction means one `LanguageModel.create()` for the whole fan-out
        // and a cheap `clone()` per candidate. Putting the page in the
        // instruction instead — the obvious first attempt — gives every child a
        // different system prompt and silently costs a full session creation per
        // tab, which is the single most expensive thing you can do here.
        instruction: RERANK_SYSTEM,
        // The candidate is injected as the user turn instead.
        includeContents: 'none',
        beforeModelCallback: ({ request }) => {
          request.contents = [{ role: 'user', parts: [{ text: prompt }] }];
          return undefined;
        },
        outputSchema: RERANK_SCHEMA as unknown as Schema,
        outputKey: name,
      });
    });

    const fanout = new ParallelAgent({
      name: 'rerank_fanout',
      subAgents: children,
      description: 'Scores each candidate tab independently.',
    });

    const runner = new Runner({
      appName: APP_NAME,
      agent: fanout,
      sessionService: this.sessions,
    });
    const session = await this.sessions.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    const seen = new Set<string>();

    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: 'Score the candidate.' }] },
      runConfig: signal ? ({ signal } as never) : undefined,
    })) {
      const hit = this.resultFromEvent(event, byAgentName, seen);
      if (hit) yield hit;
    }

    // Anything that produced no parseable verdict still needs to be accounted
    // for, otherwise a tab silently disappears from the results.
    for (const [name, cand] of byAgentName) {
      if (seen.has(name)) continue;
      yield {
        tab: cand.tab,
        score: 0,
        why: 'the model did not return a verdict for this tab',
        lexicalScore: cand.lexicalScore,
      };
    }
  }

  /** Turns a child agent's completion event into a result, once. */
  private resultFromEvent(
    event: Event,
    byAgentName: Map<string, Candidate>,
    seen: Set<string>,
  ): RankedResult | undefined {
    const name = event.author;
    if (!name || seen.has(name)) return undefined;
    const cand = byAgentName.get(name);
    if (!cand) return undefined;

    const text = (event.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) return undefined;

    const parsed = safeJson(text);
    if (!parsed || typeof parsed.score !== 'number') return undefined;

    seen.add(name);
    return {
      tab: cand.tab,
      // Clamp: a schema-constrained model should never exceed 0..3, but the
      // fallback JSON-salvage path in the adapter can produce anything.
      score: Math.max(0, Math.min(3, Math.round(parsed.score))),
      why: typeof parsed.why === 'string' ? parsed.why : '',
      lexicalScore: cand.lexicalScore,
    };
  }

  /* --------------------------- plumbing --------------------------- */

  /** Runs a single agent to completion and returns its final text. */
  private async runToText(
    agent: LlmAgent,
    message: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const runner = new Runner({
      appName: APP_NAME,
      agent,
      sessionService: this.sessions,
    });
    const session = await this.sessions.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    let out = '';
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: message }] },
      runConfig: signal ? ({ signal } as never) : undefined,
    })) {
      if (event.errorMessage) throw new Error(event.errorMessage);
      const text = (event.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (text) out += text;
    }
    return out.trim();
  }
}

/** JSON.parse that tolerates fenced or prose-wrapped output. */
export function safeJson(text: string): any {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]);
    } catch {
      return undefined;
    }
  }
}
