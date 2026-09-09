/**
 * Harness entry point: mounts the panel against the synthetic tab corpus.
 *
 * Also exposes `window.tabfind` so the whole pipeline can be driven from the
 * console or from browser automation without touching the DOM.
 */

import { Panel } from '../ui/panel.js';
import { DemoTabProvider } from '../ui/tab-provider.js';
import { probeAvailability } from '../model/create-model.js';
import { TabSearchPipeline } from '../core/pipeline.js';
import { createModel } from '../model/create-model.js';
import { DEMO_TABS } from '../core/demo-tabs.js';
import type { RankedResult } from '../core/types.js';

const SAMPLE_QUERIES = [
  'that thing about the refund',
  'the flight thing',
  'what do I need to sign',
  'the doctor thing',
  'where I said I would take the job',
  'the pricing change',
  'something about retry backoff',
  'the pasta one',
];

/** Headless entry point for automation: runs a query, returns plain data. */
async function runQuery(query: string, forceSimulated = true) {
  const { model, status } = await createModel({ forceSimulated });
  const pipeline = new TabSearchPipeline({ model, candidateLimit: 10 });
  pipeline.setTabs(DEMO_TABS);

  const trace: Array<Record<string, unknown>> = [];
  let results: RankedResult[] = [];
  const t0 = performance.now();

  for await (const ev of pipeline.search(query)) {
    if (ev.type === 'expanded') {
      trace.push({ stage: 'expand', ms: Math.round(ev.ms), keywords: ev.query.keywords });
    } else if (ev.type === 'prefiltered') {
      trace.push({
        stage: 'prefilter',
        ms: Math.round(ev.ms),
        from: ev.totalIndexed,
        to: ev.candidates.length,
      });
    } else if (ev.type === 'done') {
      results = ev.results;
    } else if (ev.type === 'error') {
      throw new Error(ev.message);
    }
  }

  return {
    query,
    modelKind: status.kind,
    totalMs: Math.round(performance.now() - t0),
    trace,
    results: results.map((r) => ({
      title: r.tab.title,
      url: r.tab.url,
      score: r.score,
      why: r.why,
    })),
  };
}

async function main() {
  const provider = new DemoTabProvider();
  const panel = new Panel({ root: document.getElementById('panel')!, provider });
  await panel.init();

  const qs = document.getElementById('queries')!;
  for (const q of SAMPLE_QUERIES) {
    const b = document.createElement('button');
    b.className = 'harness-q';
    b.textContent = q;
    b.addEventListener('click', () => {
      const input = document.getElementById('tf-input') as HTMLInputElement;
      input.value = q;
      void panel.search(q);
    });
    qs.appendChild(b);
  }

  const availability = await probeAvailability();
  document.getElementById('model-note')!.textContent =
    availability === 'available'
      ? 'This browser has a usable built-in model; the panel is using it.'
      : `Browser reports availability "${availability}", so the panel fell back to `
        + 'the scripted stand-in. Output is labelled SIMULATED.';

  Object.assign(window as never, { tabfind: { runQuery, SAMPLE_QUERIES, DEMO_TABS } });
}

void main();
