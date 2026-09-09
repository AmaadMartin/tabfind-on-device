/**
 * Compares two ways of finding a tab with a small on-device model:
 *
 *   A  naive     one prompt, all 40 tabs, "pick the best three"
 *   B  pipeline  expand -> BM25 prefilter -> per-candidate scoring
 *
 * Reports recall@3 overall, recall@3 restricted to the zero-lexical-overlap
 * cases, wall-clock latency, and the number of model calls each arm makes.
 *
 * READ THIS BEFORE QUOTING THE NUMBERS
 *
 * Run against the scripted stand-in (no on-device model present), the *quality*
 * comparison between arms is not a model comparison and must not be presented as
 * one. The stand-in cannot reproduce how a real small model degrades when asked
 * to rank forty items in one context. What it does measure faithfully, even
 * without a model, is structural: how many model calls each arm makes, and how
 * much evidence each arm can put in front of the model. Run it on a machine with
 * the built-in model to get quality numbers worth publishing.
 *
 * THE PIPELINE IS NOT A LATENCY OPTIMISATION
 *
 * Running this made it obvious that an early framing was wrong. Against a single
 * prompt containing all forty titles, the pipeline makes roughly nine times as
 * many model calls and takes longer. The prefilter saves calls only relative to
 * "score every tab individually", not relative to "ask once". What the pipeline
 * actually buys is per-candidate attention and the ability to show the model
 * real page text — quality under a model that cannot reliably rank forty items
 * at once. Anyone presenting this should make that trade explicit rather than
 * claiming the funnel is simply faster.
 *
 *   node run-eval.mjs
 */

import { ChromePromptApiLlm, stripAdkIdentityPreamble } from '../src/model/chrome-prompt-llm.js';
import { FakeLanguageModel } from '../src/model/fake-language-model.js';
import { TabSearchPipeline } from '../src/core/pipeline.js';
import { DEMO_TABS } from '../src/core/demo-tabs.js';
import { EVAL_CASES } from './dataset.js';
import { naiveSearch } from './naive.js';
import type { IndexedTab } from '../src/core/types.js';

interface ArmResult {
  name: string;
  hits: number;
  zeroOverlapHits: number;
  zeroOverlapTotal: number;
  totalMs: number;
  modelCalls: number;
  failures: Array<{ query: string; expect: string; got: string }>;
}

function hit(tabs: IndexedTab[], expect: string): boolean {
  return tabs.some((t) => t.title.toLowerCase().includes(expect.toLowerCase()));
}

/** Wraps the Prompt API so we can count how many calls an arm actually makes. */
function countingApi(inner: typeof LanguageModel) {
  const counter = { prompts: 0, creates: 0 };
  const wrapped = {
    availability: (...a: unknown[]) => (inner as any).availability(...a),
    async create(opts: unknown) {
      counter.creates++;
      const session = await (inner as any).create(opts);
      return wrapSession(session);
    },
    params: () => (inner as any).params?.(),
  };
  function wrapSession(session: any) {
    return new Proxy(session, {
      get(target, prop, recv) {
        if (prop === 'prompt') {
          return async (...args: unknown[]) => {
            counter.prompts++;
            return target.prompt(...args);
          };
        }
        if (prop === 'clone') {
          return async (...args: unknown[]) => wrapSession(await target.clone(...args));
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }
  return { api: wrapped as unknown as typeof LanguageModel, counter };
}

async function runNaive(): Promise<ArmResult> {
  const { api, counter } = countingApi(FakeLanguageModel);
  const model = new ChromePromptApiLlm({
    languageModel: api,
    normalizeSystemPrompt: stripAdkIdentityPreamble,
  });

  const res: ArmResult = {
    name: 'A  naive (one prompt, all tabs)',
    hits: 0, zeroOverlapHits: 0, zeroOverlapTotal: 0,
    totalMs: 0, modelCalls: 0, failures: [],
  };
  const t0 = performance.now();
  for (const c of EVAL_CASES) {
    if (c.zeroOverlap) res.zeroOverlapTotal++;
    const picks = await naiveSearch(model, DEMO_TABS, c.query);
    if (hit(picks, c.expect)) {
      res.hits++;
      if (c.zeroOverlap) res.zeroOverlapHits++;
    } else {
      res.failures.push({
        query: c.query,
        expect: c.expect,
        got: picks[0]?.title ?? '(nothing)',
      });
    }
  }
  res.totalMs = performance.now() - t0;
  res.modelCalls = counter.prompts;
  return res;
}

async function runPipeline(): Promise<ArmResult> {
  const { api, counter } = countingApi(FakeLanguageModel);
  const model = new ChromePromptApiLlm({
    languageModel: api,
    normalizeSystemPrompt: stripAdkIdentityPreamble,
  });
  const pipeline = new TabSearchPipeline({ model, candidateLimit: 10 });
  pipeline.setTabs(DEMO_TABS);

  const res: ArmResult = {
    name: 'B  pipeline (expand -> filter -> rerank)',
    hits: 0, zeroOverlapHits: 0, zeroOverlapTotal: 0,
    totalMs: 0, modelCalls: 0, failures: [],
  };
  const t0 = performance.now();
  for (const c of EVAL_CASES) {
    if (c.zeroOverlap) res.zeroOverlapTotal++;
    let top: IndexedTab[] = [];
    for await (const ev of pipeline.search(c.query)) {
      if (ev.type === 'done') top = ev.results.slice(0, 3).map((r) => r.tab);
    }
    if (hit(top, c.expect)) {
      res.hits++;
      if (c.zeroOverlap) res.zeroOverlapHits++;
    } else {
      res.failures.push({
        query: c.query,
        expect: c.expect,
        got: top[0]?.title ?? '(nothing)',
      });
    }
  }
  res.totalMs = performance.now() - t0;
  res.modelCalls = counter.prompts;
  return res;
}

function pct(n: number, d: number) {
  return d ? `${Math.round((n / d) * 100)}%` : 'n/a';
}

async function main() {
  const usingFake = typeof (globalThis as any).LanguageModel === 'undefined'
    || (await (globalThis as any).LanguageModel?.availability?.()) !== 'available';

  console.log(`\nTabFind retrieval eval — ${EVAL_CASES.length} queries over ${DEMO_TABS.length} tabs\n`);
  if (usingFake) {
    console.log('  !! No on-device model available: running against the scripted');
    console.log('     stand-in. Structural numbers (model calls, candidates) are');
    console.log('     real; the A-vs-B quality gap is NOT a model comparison.\n');
  }

  const arms = [await runNaive(), await runPipeline()];

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('arm', 42) + pad('recall@3', 13) + pad('zero-overlap', 15)
    + pad('calls', 8) + 'ms/query');
  console.log('-'.repeat(88));
  for (const a of arms) {
    console.log(
      pad(a.name, 42)
      + pad(`${a.hits}/${EVAL_CASES.length} (${pct(a.hits, EVAL_CASES.length)})`, 13)
      + pad(`${a.zeroOverlapHits}/${a.zeroOverlapTotal} (${pct(a.zeroOverlapHits, a.zeroOverlapTotal)})`, 15)
      + pad(String(a.modelCalls), 8)
      + Math.round(a.totalMs / EVAL_CASES.length),
    );
  }

  const [naive, pipe] = arms;
  if (usingFake && naive.hits >= pipe.hits) {
    console.log(
      '\n  Reading this correctly: the arms tie on quality because the scripted\n'
      + '  stand-in has no long-context weakness to expose, and the naive arm is\n'
      + `  therefore strictly cheaper here (${naive.modelCalls} calls vs ${pipe.modelCalls}).\n`
      + '  That is the honest result, and it is the whole point: the pipeline is a\n'
      + '  quality mechanism for models that cannot rank 40 items in one context,\n'
      + '  not a speed optimisation. Demonstrating its benefit REQUIRES the real\n'
      + '  on-device model. Do not publish an A-vs-B quality claim from this run.',
    );
  }

  for (const a of arms) {
    if (!a.failures.length) continue;
    console.log(`\n  misses — ${a.name}`);
    for (const f of a.failures) {
      console.log(`    "${f.query}"\n      wanted /${f.expect}/  got: ${f.got}`);
    }
  }
  console.log();
}

void main();
