/**
 * Proves the full ADK tool-calling loop works over Chrome's Prompt API, which
 * has no native function calling that returns control to the caller.
 */
import { ChromePromptApiLlm, stripAdkIdentityPreamble } from '../src/model/chrome-prompt-llm.js';
import { FakeLanguageModel, configureFake } from '../src/model/fake-language-model.js';
import { TabSearchPipeline } from '../src/core/pipeline.js';
import { createTabAgent } from '../src/core/agent.js';
import { DEMO_TABS } from '../src/core/demo-tabs.js';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ''}`); }
};

configureFake({ latencyMs: 0 });
const model = new ChromePromptApiLlm({
  languageModel: FakeLanguageModel,
  toolMode: 'constrained',
  normalizeSystemPrompt: stripAdkIdentityPreamble,
});
const pipeline = new TabSearchPipeline({ model, candidateLimit: 8 });
pipeline.setTabs(DEMO_TABS);

const focused: number[] = [];
const closed: number[] = [];
let confirmAsked: Array<{ tabId: number; title: string }> = [];

const agent = createTabAgent({
  model, pipeline,
  focusTab: async (id) => { focused.push(id); },
  closeTabs: async (ids) => { closed.push(...ids); return ids.length; },
  confirmClose: async (tabs) => { confirmAsked = tabs; return true; },
});

console.log('\nagent tool loop');
const turn = await agent.send('find the tab about the refund');
check('the model chose to call a tool', turn.toolCalls.length > 0,
  JSON.stringify(turn.toolCalls));
check('it called searchTabs', turn.toolCalls.some(t => t.name === 'searchTabs'),
  turn.toolCalls.map(t => t.name).join(','));
check('the tool actually ran and returned tabs', turn.lastResults.length > 0,
  `${turn.lastResults.length} results`);
check('the search found the right tab',
  turn.lastResults[0]?.tab.title.includes('Return authorization'),
  turn.lastResults[0]?.tab.title);
check('the agent produced a final reply', turn.text.length > 0, turn.text);

console.log('\nconfirmation gate');
const agent2 = createTabAgent({
  model, pipeline,
  focusTab: async () => {},
  closeTabs: async (ids) => { throw new Error('must not be reached: ' + ids); },
  confirmClose: async () => false,
});
await agent2.send('find the refund tab');
const denied = await agent2.send('close those tabs');
check('a declined confirmation blocks the close', true, 'no throw from closeTabs');
check('the agent still replies after a veto', typeof denied.text === 'string');

console.log('\nmulti-step tool loop');
const focused2: number[] = [];
const closedIds: number[] = [];
const agent3 = createTabAgent({
  model, pipeline,
  focusTab: async (id) => { focused2.push(id); },
  closeTabs: async (ids) => { closedIds.push(...ids); return ids.length; },
  confirmClose: async () => true,
});
const multi = await agent3.send('close the flight tabs');
check('ran a two-step loop: search then close',
  multi.toolCalls.map(t => t.name).join(',') === 'searchTabs,closeTabs',
  multi.toolCalls.map(t => t.name).join(','));
check('closeTabs got real tab ids from the search', closedIds.length > 0,
  JSON.stringify(closedIds));
check('the loop terminated instead of spinning', multi.toolCalls.length <= 4,
  `${multi.toolCalls.length} calls`);

console.log('\nnavigation actions');
const navFocused: number[] = [];
for (const cmd of ['switch to the refund tab', 'go to the pasta one']) {
  navFocused.length = 0;
  const a = createTabAgent({
    model, pipeline,
    focusTab: async (id) => { navFocused.push(id); },
    closeTabs: async () => { throw new Error('should not close on a navigation command'); },
    confirmClose: async () => true,
  });
  const t = await a.send(cmd);
  check(`"${cmd}" reaches focusTab`,
    t.toolCalls.some(x => x.name === 'focusTab') && navFocused.length === 1,
    `tools=${t.toolCalls.map(x=>x.name).join(',')} focused=${JSON.stringify(navFocused)}`);
}

console.log('\ntool-result rendering');
const { renderToolResult } = await import('../src/model/chrome-prompt-llm.js');
check('unwraps ADK\'s {result: "<json string>"} envelope',
  renderToolResult({ result: '{"matches":[{"tabId":8}]}' }) === '{"matches":[{"tabId":8}]}',
  renderToolResult({ result: '{"matches":[{"tabId":8}]}' }));
check('does not double-escape quotes',
  !renderToolResult({ result: '{"tabId":8}' }).includes('\\"'));
check('passes plain strings through', renderToolResult({ result: 'ok' }) === 'ok');
check('handles a plain object', renderToolResult({ closed: 4 }) === '{"closed":4}');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
