/**
 * End-to-end test of the retrieval pipeline against the fake Prompt API.
 *
 * This exercises the real ChromePromptApiLlm adapter (schema construction,
 * message mapping, session cloning, JSON parsing) and the real ADK agents —
 * only the browser's model is substituted.
 *
 * Run: npm test
 */

import { ChromePromptApiLlm } from '../src/model/chrome-prompt-llm.js';
import { FakeLanguageModel, configureFake } from '../src/model/fake-language-model.js';
import { TabSearchPipeline } from '../src/core/pipeline.js';
import { DEMO_TABS } from '../src/core/demo-tabs.js';
import type { RankedResult } from '../src/core/types.js';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function collect(
  pipeline: TabSearchPipeline,
  query: string,
): Promise<{ results: RankedResult[]; events: string[] }> {
  const events: string[] = [];
  let results: RankedResult[] = [];
  for await (const ev of pipeline.search(query)) {
    events.push(ev.type);
    if (ev.type === 'done') results = ev.results;
    if (ev.type === 'error') throw new Error(ev.message);
  }
  return { results, events };
}

async function main() {
  configureFake({ latencyMs: 1 });

  const model = new ChromePromptApiLlm({
    languageModel: FakeLanguageModel,
    toolMode: 'constrained',
  });

  const pipeline = new TabSearchPipeline({ model, candidateLimit: 10 });
  pipeline.setTabs(DEMO_TABS);

  console.log(`\nIndexed ${pipeline.indexedCount} tabs\n`);

  // --- 1. the pipeline runs and emits the expected event sequence -----------
  console.log('pipeline shape');
  const { results, events } = await collect(pipeline, 'that thing about the refund');
  check('emits expanded', events.includes('expanded'));
  check('emits prefiltered', events.includes('prefiltered'));
  check('streams individual results', events.filter((e) => e === 'result').length > 0);
  check('emits done', events.includes('done'));
  check('returns results', results.length > 0, `got ${results.length}`);

  // --- 2. the headline demo claim: semantic hit with no shared keywords ----
  console.log('\nzero-lexical-overlap retrieval');
  const top = results[0];
  check(
    'top hit is the return-authorization tab',
    !!top && top.tab.title.includes('Return authorization'),
    `top was "${top?.tab.title}"`,
  );
  check(
    'the query shares no words with that title',
    !!top &&
      !top.tab.title.toLowerCase().includes('refund') &&
      !top.tab.title.toLowerCase().includes('thing'),
  );
  check('the result carries a reason', !!top?.why && top.why.length > 0, top?.why);

  // --- 3. more fuzzy queries ------------------------------------------------
  console.log('\nother fuzzy queries');
  const cases: Array<[string, string]> = [
    ['the flight thing', 'Itinerary'],
    ['what do I need to sign', 'signature'],
    ['where did I put the pricing change', 'Pricing'],
  ];
  for (const [query, expectFragment] of cases) {
    const r = await collect(pipeline, query);
    const hit = r.results.find((x) =>
      x.tab.title.toLowerCase().includes(expectFragment.toLowerCase()),
    );
    check(
      `"${query}" -> a tab matching /${expectFragment}/i`,
      !!hit,
      `top was "${r.results[0]?.tab.title}"`,
    );
  }

  // --- 4. results are ordered and filtered ---------------------------------
  console.log('\nranking invariants');
  const sorted = results.every(
    (r, i) => i === 0 || results[i - 1].score >= r.score,
  );
  check('results are sorted by score descending', sorted);
  check('irrelevant tabs are filtered out', results.every((r) => r.score >= 1));
  check(
    'scores stay inside the 0-3 enum',
    results.every((r) => r.score >= 0 && r.score <= 3),
  );

  // --- 5. the adapter's tool-calling path ----------------------------------
  console.log('\nadapter: constrained tool calling');
  const { buildToolChoiceSchema, contentsToMessages } = await import(
    '../src/model/chrome-prompt-llm.js'
  );
  const schema: any = buildToolChoiceSchema([
    {
      name: 'searchTabs',
      description: 'Search open tabs',
      parametersJsonSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ]);
  check('tool schema is a union', Array.isArray(schema.anyOf));
  check('union has final + one tool branch', schema.anyOf.length === 2);
  check(
    'tool branch pins the tool name via enum',
    schema.anyOf[1].properties.name.enum[0] === 'searchTabs',
  );
  check(
    'tool branch carries the argument schema',
    schema.anyOf[1].properties.args.properties.query.type === 'string',
  );

  const msgs = contentsToMessages([
    { role: 'user', parts: [{ text: 'find my refund tab' }] },
    { role: 'model', parts: [{ functionCall: { name: 'searchTabs', args: { query: 'refund' } } }] },
    {
      role: 'user',
      parts: [{ functionResponse: { name: 'searchTabs', response: { hits: 2 } } }],
    },
  ]);
  check('maps model role to assistant', msgs[1].role === 'assistant');
  check(
    'serialises function calls into the transcript',
    String(msgs[1].content).includes('[tool_call] searchTabs'),
  );
  check(
    'serialises function responses into the transcript',
    String(msgs[2].content).includes('[tool_result] searchTabs'),
  );

  // --- 6. graceful degradation ---------------------------------------------
  console.log('\ndegradation');
  const emptyPipeline = new TabSearchPipeline({ model });
  emptyPipeline.setTabs([]);
  const empty = await collect(emptyPipeline, 'anything');
  check('empty index returns no results without throwing', empty.results.length === 0);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('test run threw:', e);
  process.exit(1);
});
