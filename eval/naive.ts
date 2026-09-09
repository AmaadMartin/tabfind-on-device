/**
 * The control arm: the obvious implementation.
 *
 * One agent, one prompt, every tab in the context, "return the three most
 * relevant". This is what you write first, and it is the thing the pipeline is
 * arguing against.
 *
 * Note a structural difference that holds even with a perfect model: forty tabs
 * of *body text* will not fit in a small context window, so the naive arm can
 * only ever see titles and URLs. The pipeline, by narrowing to a handful of
 * candidates first, can afford to show the model real page content for each one.
 * The funnel does not just save time — it buys evidence.
 */

import { LlmAgent, Runner, InMemorySessionService, type BaseLlm } from '@google/adk';
import type { Part, Schema } from '@google/genai';
import type { IndexedTab } from '../src/core/types.js';
import { safeJson } from '../src/core/pipeline.js';

export const NAIVE_SYSTEM = [
  'You help the user find one of their open browser tabs.',
  'You are given the full list of open tabs, numbered.',
  'Return the numbers of the three most relevant tabs, best first.',
  'The user rarely remembers exact titles, so judge by meaning.',
  'Reply with JSON only.',
].join('\n');

const NAIVE_SCHEMA = {
  type: 'object',
  properties: {
    picks: { type: 'array', items: { type: 'integer' }, maxItems: 3 },
  },
  required: ['picks'],
};

export function naivePrompt(query: string, tabs: IndexedTab[]): string {
  const list = tabs.map((t, i) => `${i + 1}. ${t.title} — ${t.url}`).join('\n');
  return `TABS:\n${list}\n\nQUERY: ${query}\n\nReturn the three best tab numbers.`;
}

export async function naiveSearch(
  model: BaseLlm,
  tabs: IndexedTab[],
  query: string,
): Promise<IndexedTab[]> {
  const agent = new LlmAgent({
    name: 'naive_search',
    model,
    instruction: NAIVE_SYSTEM,
    outputSchema: NAIVE_SCHEMA as unknown as Schema,
  });

  const sessions = new InMemorySessionService();
  const runner = new Runner({ appName: 'eval-naive', agent, sessionService: sessions });
  const session = await sessions.createSession({ appName: 'eval-naive', userId: 'eval' });

  let out = '';
  for await (const event of runner.runAsync({
    userId: 'eval',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: naivePrompt(query, tabs) }] },
  })) {
    if (event.errorMessage) throw new Error(event.errorMessage);
    out += (event.content?.parts ?? [])
      .map((p: Part) => p.text ?? '')
      .join('');
  }

  const parsed = safeJson(out.trim());
  const picks: number[] = Array.isArray(parsed?.picks) ? parsed.picks : [];
  return picks
    .map((n) => tabs[n - 1])
    .filter((t): t is IndexedTab => Boolean(t))
    .slice(0, 3);
}
