/**
 * A deterministic stand-in for Chrome's `LanguageModel`.
 *
 * IMPORTANT: this is not a language model. It is a hand-written heuristic that
 * imitates the *shape* of the Prompt API. Anything using it must say so in the
 * UI — see the "simulated" badge in the side panel. Never present output from
 * this file as on-device inference.
 *
 * It exists for three reasons:
 *
 *   1. **Testability.** CI and headless Chrome have no on-device model
 *      (`LanguageModel.availability()` returns "unavailable"). Because the fake
 *      implements the browser API rather than ADK's model interface, the real
 *      `ChromePromptApiLlm` — schema construction, message mapping, JSON parsing,
 *      session cloning — is fully exercised against it.
 *   2. **A stage fallback.** If the model is missing or mid-download on demo day,
 *      the demo still runs instead of dying in front of an audience.
 *   3. **A latency control.** `latencyMs` simulates realistic per-call cost so
 *      the streaming UI can be tuned without a GPU.
 *
 * Behaviour is keyed off `responseConstraint`, exactly as a real constrained
 * decoder would be: the schema shape tells it which task it is answering.
 */

import { tokenize, fold } from '../core/bm25.js';

/**
 * A small association table so the fake can "expand" a query the way a real
 * model would. Deliberately limited: it covers the demo domains and nothing
 * else, which is precisely why the real model is worth having.
 */
const ASSOCIATIONS: Record<string, string[]> = {
  refund: ['return', 'rma', 'authorization', 'order', 'money', 'back', 'reimbursement'],
  return: ['refund', 'rma', 'authorization', 'order'],
  flight: ['itinerary', 'booking', 'airline', 'boarding', 'reservation', 'departure', 'airport'],
  fly: ['flight', 'itinerary', 'airline'],
  trip: ['itinerary', 'booking', 'hotel', 'flight', 'reservation'],
  hotel: ['reservation', 'booking', 'checkin', 'nights', 'stay'],
  sign: ['signature', 'docusign', 'agreement', 'contract', 'esign', 'pending'],
  contract: ['agreement', 'signature', 'docusign', 'terms'],
  pricing: ['price', 'plan', 'cost', 'tier', 'billing', 'subscription', 'quote'],
  price: ['pricing', 'cost', 'plan', 'billing'],
  invoice: ['billing', 'payment', 'receipt', 'due', 'statement'],
  bill: ['invoice', 'billing', 'payment', 'statement', 'due'],
  tax: ['irs', 'w2', 'filing', 'deduction', 'return', 'withholding'],
  doctor: ['medical', 'appointment', 'clinic', 'health', 'patient', 'results'],
  medical: ['health', 'clinic', 'patient', 'results', 'lab', 'doctor'],
  recipe: ['ingredients', 'cook', 'bake', 'oven', 'minutes', 'servings'],
  bug: ['issue', 'ticket', 'defect', 'regression', 'stacktrace'],
  pr: ['pull', 'request', 'review', 'diff', 'merge'],
  review: ['pull', 'request', 'feedback', 'comments', 'approve'],
  deploy: ['release', 'rollout', 'production', 'ship', 'launch'],
  meeting: ['calendar', 'invite', 'agenda', 'notes', 'sync'],
  job: ['application', 'interview', 'resume', 'recruiter', 'offer', 'hiring',
        'acceptance', 'position', 'compensation', 'salary'],
  offer: ['acceptance', 'position', 'compensation', 'salary', 'job'],
  apartment: ['listing', 'rent', 'lease', 'bedroom', 'housing'],
  car: ['vehicle', 'insurance', 'registration', 'mileage', 'dealer'],
  paper: ['arxiv', 'abstract', 'research', 'citation', 'study'],
  buy: ['order', 'cart', 'checkout', 'purchase', 'shipping'],
  order: ['purchase', 'shipping', 'delivery', 'tracking', 'receipt'],
  shipping: ['delivery', 'tracking', 'package', 'order'],
  password: ['login', 'account', 'reset', 'security', 'credentials'],
  insurance: ['claim', 'policy', 'coverage', 'premium', 'deductible'],
  money: ['bank', 'account', 'balance', 'statement', 'payment', 'invoice', 'owe'],
  owe: ['invoice', 'due', 'payment', 'bill', 'balance'],
  move: ['listing', 'rent', 'lease', 'flat', 'apartment', 'property', 'housing'],
  place: ['listing', 'flat', 'apartment', 'property', 'rent'],
  broke: ['incident', 'postmortem', 'outage', 'failure', 'error', 'down'],
  broken: ['incident', 'postmortem', 'outage', 'failure', 'bug'],
};

export interface FakeLanguageModelOptions {
  /** Simulated per-call latency in ms. Default 45. */
  latencyMs?: number;
  /** Reported availability. Default 'available'. */
  availability?: Availability;
  /** Records every prompt for assertions in tests. */
  onCall?: (info: { input: unknown; constraint?: unknown; output: string }) => void;
}

let defaults: FakeLanguageModelOptions = {};

/** Configures the fake globally (used by the harness UI). */
export function configureFake(opts: FakeLanguageModelOptions) {
  defaults = { ...defaults, ...opts };
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Flattens the Prompt API's several accepted input shapes into plain text. */
function inputToText(input: LanguageModelPrompt): string {
  if (typeof input === 'string') return input;
  const out: string[] = [];
  for (const msg of input) {
    const c = (msg as LanguageModelMessage).content;
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) {
      for (const part of c) if (part.type === 'text') out.push(String(part.value));
    }
  }
  return out.join('\n');
}

function section(text: string, label: string): string {
  const m = text.match(new RegExp(`^${label}:\\s*(.*)$`, 'mi'));
  return m ? m[1].trim() : '';
}

/** Pulls everything after `PAGE TEXT:` to the end of the block. */
function pageText(text: string): string {
  const m = text.match(/^PAGE TEXT:\s*([\s\S]*?)(?:\n\nScore this page\.|$)/mi);
  return m ? m[1].trim() : '';
}

function expand(query: string): { keywords: string[]; intent: string } {
  const base = tokenize(query);
  const keywords = new Set<string>(base);
  for (const term of base) {
    for (const [key, vals] of Object.entries(ASSOCIATIONS)) {
      if (term === key || fold(term) === fold(key)) vals.forEach((v) => keywords.add(v));
    }
  }
  return {
    keywords: [...keywords].slice(0, 12),
    intent: base.length ? `a page about ${base.slice(0, 4).join(' ')}` : 'a page',
  };
}

/**
 * Scores a page the way the fake understands "relevance": expanded-term overlap,
 * weighted towards the title. Good enough to drive the UI and to prove the
 * pipeline wiring; not a substitute for the model's actual judgement.
 */
function scorePage(promptText: string): { score: number; why: string } {
  const query = section(promptText, 'QUERY');
  const title = section(promptText, 'PAGE TITLE');
  const url = section(promptText, 'PAGE URL');
  const body = pageText(promptText);

  const terms = new Set(expand(query).keywords.map(fold));
  const titleTerms = new Set(tokenize(title).map(fold));
  const urlTerms = new Set(tokenize(url).map(fold));
  const bodyTerms = new Set(tokenize(body).map(fold));

  // Score on *coverage* — the share of query terms the page accounts for —
  // rather than a raw hit count.
  //
  // Two failures forced this. Absolute counts over-reward long expansions: "the
  // flight thing" expands to eight terms, and "Bike service booking" scored as
  // highly as the user's actual itinerary on the strength of one shared word.
  // They equally under-reward short ones: "the pasta one" expands to a single
  // term, so even a perfect title match could never accumulate enough hits.
  // Normalising by the number of terms fixes both at once.
  let weightSum = 0;
  let titleHits = 0;
  for (const t of terms) {
    if (titleTerms.has(t)) {
      weightSum += 1.0;
      titleHits++;
    } else if (urlTerms.has(t)) weightSum += 0.7;
    else if (bodyTerms.has(t)) weightSum += 0.4;
  }
  const coverage = terms.size ? weightSum / terms.size : 0;

  let score: number;
  if (titleHits >= 2 || coverage >= 0.25) score = 3;
  else if (coverage >= 0.18) score = 2;
  else if (coverage >= 0.08) score = 1;
  else score = 0;

  return { score, why: describe(body, title, terms, score) };
}

/**
 * Builds the one-line justification.
 *
 * This is the single most important string in the UI: it is what convinces
 * someone that the match was understood rather than string-matched. Echoing the
 * title back proves nothing, so the fake instead surfaces the clause from the
 * page body that carries the most query-related terms — the same thing a real
 * model's "why" should be doing.
 */
function describe(
  body: string,
  title: string,
  terms: Set<string>,
  score: number,
): string {
  if (score === 0) return 'nothing here relates to what you described';

  const clauses = body
    .split(/(?<=[.!?])\s+|\s+[-–—]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);

  let best = '';
  let bestHits = 0;
  for (const clause of clauses) {
    const words = new Set(tokenize(clause).map(fold));
    let hits = 0;
    for (const t of terms) if (words.has(t)) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      best = clause;
    }
  }

  if (!best || bestHits === 0) {
    const t = title.length > 46 ? `${title.slice(0, 43)}...` : title;
    return `same general area as "${t}"`;
  }

  // Trim to a phrase rather than a sentence; the card has one line.
  const words = best.split(/\s+/);
  const phrase = words.slice(0, 11).join(' ').replace(/[,;:.]$/, '');
  return words.length > 11 ? `${phrase}…` : phrase;
}

/** Chooses a tool when handed a tool-choice union schema. */
function chooseTool(promptText: string, constraint: any): string {
  const names: string[] = [];
  for (const branch of constraint.anyOf ?? []) {
    const n = branch?.properties?.name?.enum?.[0];
    if (n) names.push(n);
  }
  const lower = promptText.toLowerCase();
  const lastUser = lower.split('\n').filter(Boolean).pop() ?? '';

  if (names.includes('searchTabs') && !lower.includes('[tool_result]')) {
    const q = lastUser.replace(/^user:\s*/, '').trim();
    return JSON.stringify({ kind: 'tool', name: 'searchTabs', args: { query: q } });
  }
  // Stop once the work is visibly done, rather than re-issuing the same call.
  if (lower.includes('[tool_result] closetabs')) {
    return JSON.stringify({ kind: 'final', text: 'Done — those tabs are closed.' });
  }
  if (lower.includes('[tool_result] focustab')) {
    return JSON.stringify({ kind: 'final', text: 'Switched to that tab.' });
  }

  // Tab ids come from the preceding searchTabs result, best match first.
  // Tolerate escaped quotes: tool results can arrive re-encoded.
  const ids = [...promptText.matchAll(/\\?"tabId\\?":\s*(\d+)/g)].map((m) => Number(m[1]));

  // Navigation acts on the single best match; closing acts on the whole set.
  if (
    names.includes('focusTab')
    && /\b(switch to|go to|jump to|focus|take me to|show me|open the)\b/.test(lower)
  ) {
    if (ids.length) {
      return JSON.stringify({ kind: 'tool', name: 'focusTab', args: { tabId: ids[0] } });
    }
  }
  if (names.includes('closeTabs') && /close|get rid of|dismiss|remove|clean up/.test(lower)) {
    if (ids.length) {
      return JSON.stringify({ kind: 'tool', name: 'closeTabs', args: { tabIds: ids } });
    }
  }
  return JSON.stringify({ kind: 'final', text: 'Here is what I found in your tabs.' });
}

/** Produces a response for one prompt, selected by the constraint's shape. */
function respond(input: LanguageModelPrompt, constraint: any): string {
  const text = inputToText(input);

  if (constraint?.anyOf) return chooseTool(text, constraint);

  const props = constraint?.properties ?? {};
  if (props.keywords) return JSON.stringify(expand(section(text, 'QUERY') || text));
  if (props.score) return JSON.stringify(scorePage(text));
  if (props.picks) return JSON.stringify({ picks: pickFromList(text) });

  return 'This is simulated output from TabFind\'s fake model.';
}

/**
 * Answers the eval's naive arm: rank a numbered list of tabs in one shot.
 *
 * Uses the *same* `expand()` the pipeline arm gets, on purpose. The two arms
 * must differ only in structure, never in simulated intelligence, or the
 * comparison is rigged. What the naive arm genuinely lacks is evidence: forty
 * tabs of body text do not fit in a small context window, so it sees titles and
 * URLs only. That limitation is real, not simulated.
 */
function pickFromList(promptText: string): number[] {
  const query = section(promptText, 'QUERY');
  const terms = new Set(expand(query).keywords.map(fold));

  const scored: Array<{ n: number; s: number }> = [];
  for (const line of promptText.split('\n')) {
    const m = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (!m) continue;
    const words = new Set(tokenize(m[2]).map(fold));
    let hits = 0;
    for (const t of terms) if (words.has(t)) hits++;
    if (hits > 0) scored.push({ n: Number(m[1]), s: hits / Math.max(1, terms.size) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 3).map((x) => x.n);
}

/** A fake `LanguageModel` session. Structurally compatible with the real one. */
export class FakeLanguageModelSession {
  readonly contextWindow = 4096;
  private used = 0;
  private destroyed = false;
  private listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor(
    private readonly createOptions: LanguageModelCreateOptions = {},
    private readonly opts: FakeLanguageModelOptions = {},
  ) {}

  get contextUsage() {
    return this.used;
  }

  private get latency() {
    return this.opts.latencyMs ?? defaults.latencyMs ?? 45;
  }

  async prompt(
    input: LanguageModelPrompt,
    options: LanguageModelPromptOptions = {},
  ): Promise<string> {
    if (this.destroyed) throw new Error('The session has been destroyed.');
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    await delay(this.latency);
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const output = respond(input, options.responseConstraint);
    this.used = Math.min(this.contextWindow, this.used + Math.ceil(output.length / 4) + 24);
    (this.opts.onCall ?? defaults.onCall)?.({
      input,
      constraint: options.responseConstraint,
      output,
    });
    return output;
  }

  promptStreaming(
    input: LanguageModelPrompt,
    options: LanguageModelPromptOptions = {},
  ): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      async start(controller) {
        const full = await self.prompt(input, options);
        // Emit in word chunks so streaming UI can be exercised realistically.
        const words = full.split(/(\s+)/);
        for (const w of words) {
          await delay(6);
          controller.enqueue(w);
        }
        controller.close();
      },
    });
  }

  async append(): Promise<undefined> {
    await delay(5);
    return undefined;
  }

  async measureContextUsage(input: LanguageModelPrompt): Promise<number> {
    return Math.ceil(inputToText(input).length / 4);
  }

  async clone(_options: LanguageModelCloneOptions = {}): Promise<FakeLanguageModelSession> {
    // Cloning is cheap, which is the whole point of using it in the adapter.
    await delay(1);
    return new FakeLanguageModelSession(this.createOptions, this.opts);
  }

  destroy(): undefined {
    this.destroyed = true;
    return undefined;
  }

  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
}

/** Static side of the fake: mirrors `LanguageModel.availability/create`. */
export const FakeLanguageModel = {
  async availability(): Promise<Availability> {
    return defaults.availability ?? 'available';
  },
  async create(options: LanguageModelCreateOptions = {}) {
    if (options.monitor) {
      // Exercise the download-progress path so the UI for it is real.
      options.monitor({
        addEventListener: (_t: string, fn: (e: ProgressEvent) => void) => {
          setTimeout(() => fn({ loaded: 1 } as ProgressEvent), 0);
        },
      } as unknown as CreateMonitor);
    }
    await delay(8);
    return new FakeLanguageModelSession(options, defaults);
  },
  async params() {
    return { defaultTopK: 3, maxTopK: 128, defaultTemperature: 1, maxTemperature: 2 };
  },
} as unknown as typeof LanguageModel;
