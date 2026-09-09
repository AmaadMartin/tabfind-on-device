/**
 * Prompts and response schemas for the two model-backed stages.
 *
 * Two rules govern everything in this file, both of them consequences of running
 * on a small on-device model:
 *
 *   1. Every call is a short, bounded, local judgement. Never "rank these twelve
 *      tabs" — always "here is one page, score it".
 *   2. Every call is schema-constrained. We never parse free-form output.
 *
 * Scores are an integer enum rather than a 0..1 float on purpose: small models
 * pick reliably from four labels and calibrate floats badly.
 */

/* ------------------------------ stage 1 ------------------------------ */

export const EXPAND_SYSTEM = [
  'You turn a vague description of a web page into search terms.',
  'The user is trying to find one of their open browser tabs but cannot remember',
  'its title. Think about what words would actually appear on that page.',
  '',
  'Include the obvious synonyms and the formal or technical wording a real site',
  'would use. For example a user saying "refund" should also produce "return",',
  '"RMA", "order", "authorization"; "my flight" should also produce "itinerary",',
  '"booking", "boarding pass", "reservation".',
  '',
  'Reply with JSON only.',
].join('\n');

export const EXPAND_SCHEMA = {
  type: 'object',
  properties: {
    keywords: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 12,
    },
    intent: { type: 'string', maxLength: 60 },
  },
  required: ['keywords', 'intent'],
} as const;

export function expandUserPrompt(query: string): string {
  return `QUERY: ${query}\n\nGive up to 12 search keywords and a short intent phrase.`;
}

/* ------------------------------ stage 3 ------------------------------ */

export const RERANK_SYSTEM = [
  'You decide whether one web page is what the user is looking for.',
  '',
  'Scoring:',
  '  3 = this is exactly the page they described',
  '  2 = clearly related and plausibly the one they want',
  '  1 = same general topic but probably not it',
  '  0 = unrelated',
  '',
  'The user rarely remembers the exact title, so judge by meaning, not by',
  'matching words. A page titled "Order #48213 - Return authorization" is a 3',
  'for the query "that thing about the refund".',
  '',
  'In "why", say in at most 12 words what this page actually is. Never repeat',
  'the query back. Reply with JSON only.',
].join('\n');

export const RERANK_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', enum: [0, 1, 2, 3] },
    why: { type: 'string', maxLength: 80 },
  },
  required: ['score', 'why'],
} as const;

/** Body text is truncated hard; the context window is small and this runs per tab. */
export const MAX_PAGE_CHARS = 700;

export function rerankUserPrompt(args: {
  query: string;
  intent: string;
  title: string;
  url: string;
  text: string;
}): string {
  const body = (args.text || '').slice(0, MAX_PAGE_CHARS);
  return [
    `QUERY: ${args.query}`,
    `LOOKING FOR: ${args.intent}`,
    '',
    `PAGE TITLE: ${args.title}`,
    `PAGE URL: ${args.url}`,
    `PAGE TEXT: ${body || '(no text could be extracted)'}`,
    '',
    'Score this page.',
  ].join('\n');
}

/* --------------------------- conversation --------------------------- */

export const ASSISTANT_SYSTEM = [
  'You are TabFind, an assistant that manages the user\'s open browser tabs.',
  'You can search their tabs, focus one, and close tabs.',
  '',
  'Rules:',
  '- To find tabs, always call searchTabs. Never guess what is open.',
  '- Call exactly one tool at a time.',
  '- Before closing anything, make sure you have the tab ids from a search.',
  '- Keep replies to one or two short sentences.',
].join('\n');
