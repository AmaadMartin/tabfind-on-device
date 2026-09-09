/**
 * Chooses which model backs the demo, and reports honestly which one it picked.
 *
 * The extension prefers Chrome's real on-device model. If that is unavailable —
 * no Prompt API, unsupported hardware, model still downloading — it falls back
 * to the deterministic fake so the demo still runs. The distinction is surfaced
 * to the UI through {@link ModelStatus.kind} and must always be shown to the
 * user; simulated output must never be passed off as on-device inference.
 */

import { ChromePromptApiLlm, stripAdkIdentityPreamble } from './chrome-prompt-llm.js';
import { FakeLanguageModel } from './fake-language-model.js';

export type ModelKind = 'on-device' | 'simulated';

export interface ModelStatus {
  kind: ModelKind;
  /** Raw availability reported by the browser, when the API exists. */
  availability: Availability | 'missing-api';
  /** Human-readable explanation, shown in the UI. */
  detail: string;
}

export interface CreateModelResult {
  model: ChromePromptApiLlm;
  status: ModelStatus;
}

export interface CreateModelOptions {
  /** Forces the fake even when a real model is present. Useful for rehearsal. */
  forceSimulated?: boolean;
  /** Progress callback while Chrome downloads the model on first use. */
  onDownloadProgress?: (loaded: number) => void;
  /**
   * Sampling temperature. Only honoured in extension contexts; the adapter
   * retries without it when the page rejects sampling parameters.
   */
  temperature?: number;
  topK?: number;
}

/** Probes the browser for a usable built-in model. */
export async function probeAvailability(): Promise<Availability | 'missing-api'> {
  if (typeof (globalThis as any).LanguageModel === 'undefined') return 'missing-api';
  try {
    return await LanguageModel.availability();
  } catch {
    return 'unavailable';
  }
}

const DETAIL: Record<string, string> = {
  'missing-api':
    'This browser does not expose the Prompt API. Needs Chrome 138+ (extensions) '
    + 'or 148+ (web).',
  unavailable:
    'Chrome reports no usable built-in model. Needs ~22 GB free disk and either '
    + '>4 GB VRAM or 16 GB RAM with 4+ cores, on desktop.',
  downloadable: 'The model has not been downloaded yet.',
  downloading: 'The model is still downloading.',
};

/**
 * Builds the model, preferring the real one.
 *
 * `stripAdkIdentityPreamble` is applied because this app fans out over many
 * sibling agents; see the note on `normalizeSystemPrompt` for why that is worth
 * a 4x reduction in session creations.
 */
export async function createModel(
  options: CreateModelOptions = {},
): Promise<CreateModelResult> {
  const availability = options.forceSimulated ? 'unavailable' : await probeAvailability();

  // "downloadable" counts as usable. On a machine that has never run the model —
  // which is every machine the first time — this is what `availability()`
  // returns, and treating it as a failure means falling back to the stand-in
  // forever and never triggering the download at all.
  //
  // Calling `create()` in this state needs user activation, per Chrome's docs.
  // That works out here because the first `create()` happens lazily inside the
  // adapter during a search, which always follows a click or an Enter key. It
  // would *not* work if we created a session eagerly at page load, which is one
  // more reason the adapter builds its session on first use.
  const usable =
    availability === 'available'
    || availability === 'downloading'
    || availability === 'downloadable';

  if (usable && !options.forceSimulated) {
    return {
      model: new ChromePromptApiLlm({
        model: 'chrome-on-device',
        toolMode: 'constrained',
        normalizeSystemPrompt: stripAdkIdentityPreamble,
        onDownloadProgress: options.onDownloadProgress,
        temperature: options.temperature,
        topK: options.topK,
        // Chrome warns if these are omitted: "No output language was specified
        // in a LanguageModel API request. An output language should be specified
        // to ensure optimal output quality and properly attest to output
        // safety." Supported set is [de, en, es, fr, ja].
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      }),
      status: {
        kind: 'on-device',
        availability,
        detail:
          availability === 'available'
            ? 'Running on Chrome\'s built-in model. Nothing leaves this device.'
            : 'Chrome\'s built-in model needs to download first (a few GB). The first '
              + 'search will start it and show progress.',
      },
    };
  }

  return {
    model: new ChromePromptApiLlm({
      model: 'chrome-on-device-simulated',
      toolMode: 'constrained',
      normalizeSystemPrompt: stripAdkIdentityPreamble,
      languageModel: FakeLanguageModel,
    }),
    status: {
      kind: 'simulated',
      availability,
      detail: options.forceSimulated
        ? 'Simulated model forced on. Output is from a scripted heuristic, not a language model.'
        : `${DETAIL[availability] ?? 'Model unavailable.'} Falling back to a scripted `
          + 'heuristic so the demo still runs — this is not model output.',
    },
  };
}
