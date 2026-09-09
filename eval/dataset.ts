/**
 * Evaluation set for tab retrieval over the DEMO_TABS corpus.
 *
 * `expect` is matched as a case-insensitive substring of the tab title, so the
 * cases stay readable and survive small edits to the corpus.
 *
 * `zeroOverlap` marks the cases where the query shares no content word with the
 * target title. Those are reported separately because they are the ones that
 * actually distinguish semantic retrieval from string matching — a system can
 * score well overall while failing every one of them.
 */

export interface EvalCase {
  query: string;
  expect: string;
  zeroOverlap?: boolean;
}

export const EVAL_CASES: EvalCase[] = [
  // --- zero lexical overlap with the target title ---
  { query: 'that thing about the refund', expect: 'Return authorization', zeroOverlap: true },
  { query: 'the flight thing', expect: 'Itinerary confirmation', zeroOverlap: true },
  { query: 'what do I need to sign', expect: 'Awaiting your signature', zeroOverlap: true },
  { query: 'the doctor thing', expect: 'Lab results', zeroOverlap: true },
  { query: 'where I said I would take the job', expect: 'Offer acceptance', zeroOverlap: true },
  { query: 'money I owe someone', expect: 'Invoice', zeroOverlap: true },
  { query: 'the place I might move to', expect: 'Bermondsey', zeroOverlap: true },
  { query: 'my car paperwork', expect: 'vehicle registration', zeroOverlap: true },
  { query: 'the thing that broke last week', expect: 'postmortem', zeroOverlap: true },
  { query: 'where I keep my money', expect: 'Statement', zeroOverlap: true },

  // --- partial overlap ---
  { query: 'the pricing change', expect: 'Pricing page redesign' },
  { query: 'something about retry backoff', expect: 'retry backoff' },
  { query: 'the pasta one', expect: 'tomato pasta' },
  { query: 'safari dropdown bug', expect: 'dropdown closes on scroll' },
  { query: 'my hotel booking', expect: 'Hotel Verde' },
  { query: 'the transformer paper', expect: 'Attention Is All You Need' },
  { query: 'quarterly planning', expect: 'Q3 planning' },
  { query: 'how do I authenticate with the api', expect: 'authentication' },
  { query: 'insurance claim status', expect: 'Claim' },
  { query: 'sourdough problems', expect: 'Sourdough starter' },
];
