/**
 * ChromePromptApiLlm — an ADK `BaseLlm` backed by Chrome's built-in on-device
 * model via the Prompt API (`LanguageModel`).
 *
 * This is the reusable piece. Everything else in this repo is a demo of it.
 *
 * ## The problem it solves
 *
 * ADK's agent loop is built around a model that can emit *function calls*: the
 * Runner inspects them, applies before/after-tool callbacks, executes the tool,
 * appends a function response, and loops. Chrome's Prompt API gives you
 * `prompt()` and `promptStreaming()`, which return a plain string.
 *
 * Chrome does expose a `tools` option on `LanguageModel.create()`, but its
 * contract is different in a way that matters: each tool carries an `execute()`
 * callback and *the browser runs the tool itself*, feeding the result back into
 * the model internally. You get the final text, not the intermediate call. That
 * removes ADK from its own loop — no tool callbacks, no per-call events, no
 * confirmation hooks, no session state updates, nothing to trace.
 *
 * So the primary strategy here is `toolMode: 'constrained'`: we describe the
 * available tools in the system prompt and force the model to answer with JSON
 * matching a schema whose branches are "final answer" or "call this exact tool
 * with these exact arguments" (via `responseConstraint`). We parse that back into
 * genai `functionCall` parts and hand them to ADK, which stays in control.
 *
 * `toolMode: 'native'` is also implemented, for benchmarking the two against each
 * other. It delegates execution to Chrome and surfaces only the final text.
 *
 * ## Session strategy
 *
 * ADK is stateless per request: it re-sends the whole conversation every time.
 * Chrome sessions are stateful and expensive to create. We therefore keep one
 * warm "base" session that contains only the system prompt, and `clone()` it per
 * request — the docs describe `clone()` as forking a session while preserving
 * context and initial prompts, specifically to preserve resources. The clone is
 * destroyed after the turn. The conversation history rides in the prompt input.
 */

import { BaseLlm } from '@google/adk';
import type { LlmRequest, LlmResponse, BaseLlmConnection } from '@google/adk';
import type { Content, Part, FunctionDeclaration } from '@google/genai';

/** How tool calling is realised on top of the Prompt API. */
export type ToolMode = 'constrained' | 'native';

export interface ChromePromptApiLlmOptions {
  /** Model id used for ADK registry matching. Defaults to `chrome-on-device`. */
  model?: string;
  /**
   * See {@link ToolMode}. Defaults to `'constrained'`, which keeps ADK in
   * control of the agent loop.
   */
  toolMode?: ToolMode;
  /**
   * Injects an alternative implementation of the global `LanguageModel`. Used by
   * the test/demo fake. Defaults to `globalThis.LanguageModel`.
   */
  languageModel?: typeof LanguageModel;
  /** Sampling. `temperature`/`topK` only work in extension contexts. */
  temperature?: number;
  topK?: number;
  /** Modalities to declare at session creation. */
  expectedInputs?: LanguageModelExpected[];
  expectedOutputs?: LanguageModelExpected[];
  /** Called with 0..1 progress while the model downloads on first use. */
  onDownloadProgress?: (loaded: number) => void;
  /** Retries when the model emits JSON that does not parse. Default 1. */
  maxParseRetries?: number;
  /**
   * Rewrites the system prompt before a session is created.
   *
   * Exists because of a specific and costly interaction with ADK. Every request
   * is prefixed by ADK's identity processor with:
   *
   *   You are an agent. Your internal name is "<agent name>".
   *
   * That is unconditional and not configurable. Under a `ParallelAgent` fan-out
   * each child has a different name, so every child produces a *different*
   * system prompt, so the warm base session never hits and you pay a full
   * `LanguageModel.create()` per candidate — the most expensive call available.
   *
   * Pass {@link stripAdkIdentityPreamble} to drop it. Safe whenever agent
   * transfer is disabled (which ADK forces on any agent with an `outputSchema`),
   * because the identity line exists to support transfer. Leave it alone for
   * multi-agent setups that actually route by name.
   */
  normalizeSystemPrompt?: (systemPrompt: string) => string;
  /** Emits timing/context diagnostics. */
  onDiagnostic?: (d: ChromeLlmDiagnostic) => void;
}

export interface ChromeLlmDiagnostic {
  phase: 'create' | 'prompt' | 'parse-retry' | 'context-overflow';
  ms?: number;
  contextUsage?: number;
  contextWindow?: number;
  note?: string;
}

/** Thrown when the browser has no usable on-device model. */
export class ModelUnavailableError extends Error {
  constructor(public readonly availability: Availability | 'missing-api') {
    super(
      availability === 'missing-api'
        ? 'This browser does not expose the Prompt API (window.LanguageModel is undefined).'
        : `Chrome's built-in model is not available (availability: "${availability}").`,
    );
    this.name = 'ModelUnavailableError';
  }
}

/* ------------------------------------------------------------------ *
 * Schema conversion
 * ------------------------------------------------------------------ */

/**
 * genai `Schema` uses OpenAPI-style uppercase type names (`OBJECT`, `STRING`)
 * while `responseConstraint` wants standard JSON Schema (`object`, `string`).
 * Also strips genai-only keys that a JSON Schema validator will reject.
 */
export function genaiSchemaToJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const s = schema as Record<string, any>;
  const out: Record<string, any> = {};

  if (typeof s.type === 'string') out.type = s.type.toLowerCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.format) out.format = s.format;
  if (Array.isArray(s.required) && s.required.length) out.required = s.required;

  if (s.properties && typeof s.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) {
      out.properties[k] = genaiSchemaToJsonSchema(v);
    }
  }
  if (s.items) out.items = genaiSchemaToJsonSchema(s.items);
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

/** Pulls function declarations out of an ADK request's tool config. */
function collectFunctionDeclarations(llmRequest: LlmRequest): FunctionDeclaration[] {
  const tools = llmRequest.config?.tools ?? [];
  const decls: FunctionDeclaration[] = [];
  for (const t of tools as any[]) {
    if (t?.functionDeclarations) decls.push(...t.functionDeclarations);
  }
  return decls;
}

/**
 * Builds the constrained-decoding schema: a union of "final answer" and one
 * branch per available tool, each carrying that tool's exact argument schema.
 *
 * Single-value `enum` is used rather than `const`; it is semantically identical
 * and more widely supported across constraint engines.
 */
export function buildToolChoiceSchema(
  decls: FunctionDeclaration[],
): Record<string, unknown> {
  const branches: Record<string, unknown>[] = [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['final'] },
        text: { type: 'string' },
      },
      required: ['kind', 'text'],
    },
  ];

  for (const d of decls) {
    if (!d.name) continue;
    const args = d.parametersJsonSchema
      ? (d.parametersJsonSchema as Record<string, unknown>)
      : genaiSchemaToJsonSchema(d.parameters);
    branches.push({
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['tool'] },
        name: { type: 'string', enum: [d.name] },
        args,
      },
      required: ['kind', 'name', 'args'],
    });
  }

  return branches.length === 1 ? branches[0] : { anyOf: branches };
}

/** Renders tool declarations into instructions the model can act on. */
export function renderToolInstructions(decls: FunctionDeclaration[]): string {
  if (!decls.length) return '';
  const lines = decls.map((d) => {
    const args = d.parametersJsonSchema
      ? (d.parametersJsonSchema as Record<string, unknown>)
      : genaiSchemaToJsonSchema(d.parameters);
    return `- ${d.name}: ${d.description ?? ''}\n  arguments: ${JSON.stringify(args)}`;
  });
  return [
    'You can call these tools:',
    ...lines,
    '',
    'Reply with JSON only. To call a tool use {"kind":"tool","name":<tool>,"args":{...}}.',
    'When you have the answer use {"kind":"final","text":<answer>}.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Content mapping
 * ------------------------------------------------------------------ */

/**
 * Renders a tool result as text the model can actually read.
 *
 * ADK wraps a tool's string return value as `{ result: "<the string>" }`. Naively
 * JSON-stringifying that produces double-encoded output:
 *
 *   [tool_result] searchTabs -> {"result":"{\"matches\":[{\"tabId\":8, ...
 *
 * Every quote is escaped twice. A large model shrugs at this; a small one has to
 * spend attention unpicking the encoding before it can find `tabId`, and often
 * just fails. Unwrapping the single `result` key and re-emitting it as plain JSON
 * costs nothing and gives the model something legible:
 *
 *   [tool_result] searchTabs -> {"matches":[{"tabId":8, ...
 */
export function renderToolResult(response: unknown): string {
  if (response == null) return '{}';
  let value: unknown = response;

  // Unwrap ADK's { result: ... } envelope.
  if (
    typeof value === 'object'
    && value !== null
    && Object.keys(value as object).length === 1
    && 'result' in (value as Record<string, unknown>)
  ) {
    value = (value as Record<string, unknown>).result;
  }

  // If it is a JSON string, splice it in rather than escaping it again.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Maps genai `Content[]` to Prompt API messages.
 *
 * Function calls and responses have no native representation in a Prompt API
 * message, so they are serialised to text. Without this the model loses the
 * thread of a multi-step tool interaction.
 */
export function contentsToMessages(contents: Content[]): LanguageModelMessage[] {
  const msgs: LanguageModelMessage[] = [];

  for (const c of contents ?? []) {
    const role: 'user' | 'assistant' = c.role === 'model' ? 'assistant' : 'user';
    const chunks: string[] = [];
    const rich: LanguageModelMessageContent[] = [];

    for (const p of (c.parts ?? []) as Part[]) {
      if (p.text) chunks.push(p.text);
      if (p.functionCall) {
        chunks.push(
          `[tool_call] ${p.functionCall.name}(${JSON.stringify(p.functionCall.args ?? {})})`,
        );
      }
      if (p.functionResponse) {
        chunks.push(
          `[tool_result] ${p.functionResponse.name} -> ${renderToolResult(
            p.functionResponse.response,
          )}`,
        );
      }
      if (p.inlineData?.data && p.inlineData.mimeType?.startsWith('image/')) {
        // Kept for multimodal callers; harmless when unused.
        rich.push({ type: 'image', value: p.inlineData.data as unknown as string });
      }
    }

    if (rich.length) {
      if (chunks.length) rich.unshift({ type: 'text', value: chunks.join('\n') });
      msgs.push({ role, content: rich });
    } else if (chunks.length) {
      msgs.push({ role, content: chunks.join('\n') });
    }
  }

  return msgs;
}

/** Extracts the system instruction from an ADK request as plain text. */
export function extractSystemInstruction(llmRequest: LlmRequest): string {
  const si: any = llmRequest.config?.systemInstruction;
  if (!si) return '';
  if (typeof si === 'string') return si;
  if (Array.isArray(si)) {
    return si
      .map((x) => (typeof x === 'string' ? x : (x?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  if (si.parts) return si.parts.map((p: Part) => p.text ?? '').filter(Boolean).join('\n');
  return String(si);
}

/**
 * Removes ADK's per-agent identity preamble from a system prompt.
 *
 * Turns:
 *   You are an agent. Your internal name is "rerank_11".
 *   The description about you is "..."
 *
 *   <the actual instruction>
 *
 * into just the instruction, so that N sibling agents sharing one instruction
 * also share one cached session. See {@link ChromePromptApiLlmOptions.normalizeSystemPrompt}.
 */
export function stripAdkIdentityPreamble(systemPrompt: string): string {
  return systemPrompt
    .replace(/^You are an agent\. Your internal name is "[^"]*"\.\s*/m, '')
    .replace(/^The description about you is "[^"]*"\s*/m, '')
    .trimStart();
}

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

export class ChromePromptApiLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    /^chrome-on-device$/,
    /^chrome\/.*/,
  ];

  private readonly opts: Required<
    Pick<ChromePromptApiLlmOptions, 'toolMode' | 'maxParseRetries'>
  > &
    ChromePromptApiLlmOptions;

  /**
   * Warm session holding only the system prompt; cloned per request.
   *
   * The *promise* is memoised, not the resolved session. Under a ParallelAgent
   * fan-out every child calls this at the same instant, and caching only the
   * resolved value means they all observe an empty cache and each create their
   * own session — turning the optimisation into a no-op precisely when it
   * matters most. Sharing the in-flight promise collapses them onto one create.
   */
  private baseSessionPromise?: Promise<LanguageModel>;
  private baseSession?: LanguageModel;
  private baseSessionKey?: string;

  constructor(options: ChromePromptApiLlmOptions = {}) {
    super({ model: options.model ?? 'chrome-on-device' });
    this.opts = {
      toolMode: options.toolMode ?? 'constrained',
      maxParseRetries: options.maxParseRetries ?? 1,
      ...options,
    };
  }

  private get api(): typeof LanguageModel {
    const api = this.opts.languageModel ?? (globalThis as any).LanguageModel;
    if (!api) throw new ModelUnavailableError('missing-api');
    return api;
  }

  /** Reports whether this browser can actually run the model. */
  async availability(): Promise<Availability> {
    try {
      return await this.api.availability({
        expectedInputs: this.opts.expectedInputs,
        expectedOutputs: this.opts.expectedOutputs,
      } as LanguageModelCreateCoreOptions);
    } catch {
      return 'unavailable';
    }
  }

  private diag(d: ChromeLlmDiagnostic) {
    this.opts.onDiagnostic?.(d);
  }

  /**
   * Returns a session cloned from a warm base carrying `systemPrompt`.
   * Rebuilds the base only when the system prompt or sampling changes.
   */
  private async acquireSession(
    systemPrompt: string,
    nativeTools: LanguageModelTool[] | undefined,
    signal?: AbortSignal,
  ): Promise<LanguageModel> {
    const key = JSON.stringify([
      systemPrompt,
      this.opts.temperature,
      this.opts.topK,
      this.opts.expectedInputs,
      nativeTools?.map((t) => t.name),
    ]);

    if (this.baseSessionKey === key && this.baseSessionPromise) {
      const base = await this.baseSessionPromise;
      return base.clone({ signal });
    }

    this.baseSessionKey = key;
    // Deliberately not awaited before being stored: concurrent callers must be
    // able to find and share this promise while it is still pending.
    this.baseSessionPromise = this.createBaseSession(systemPrompt, nativeTools, signal);
    try {
      const base = await this.baseSessionPromise;
      return base.clone({ signal });
    } catch (err) {
      // A failed creation must not poison the cache for later attempts.
      this.baseSessionPromise = undefined;
      this.baseSessionKey = undefined;
      throw err;
    }
  }

  private async createBaseSession(
    systemPrompt: string,
    nativeTools: LanguageModelTool[] | undefined,
    signal?: AbortSignal,
  ): Promise<LanguageModel> {
    const availability = await this.availability();
    if (availability === 'unavailable') throw new ModelUnavailableError(availability);

    const createOpts: LanguageModelCreateOptions = {
      signal,
      monitor: this.opts.onDownloadProgress
        ? (m: CreateMonitor) => {
            m.addEventListener('downloadprogress', (e: ProgressEvent) => {
              this.opts.onDownloadProgress!(e.loaded);
            });
          }
        : undefined,
    };
    if (systemPrompt) {
      createOpts.initialPrompts = [{ role: 'system', content: systemPrompt }];
    }
    if (this.opts.expectedInputs) createOpts.expectedInputs = this.opts.expectedInputs;
    if (this.opts.expectedOutputs) createOpts.expectedOutputs = this.opts.expectedOutputs;
    // temperature/topK are extension-only; passing them on the web throws.
    if (this.opts.temperature !== undefined) {
      (createOpts as any).temperature = this.opts.temperature;
      (createOpts as any).topK = this.opts.topK ?? 3;
    }
    if (nativeTools?.length) (createOpts as any).tools = nativeTools;

    const t0 = performance.now();
    let session: LanguageModel;
    try {
      session = await this.api.create(createOpts);
    } catch (err) {
      // Sampling params are rejected outside extension contexts. Retry clean so
      // the same code path works on a plain web page.
      if (this.opts.temperature !== undefined) {
        delete (createOpts as any).temperature;
        delete (createOpts as any).topK;
        session = await this.api.create(createOpts);
      } else {
        throw err;
      }
    }
    this.diag({ phase: 'create', ms: performance.now() - t0 });

    session.addEventListener?.('contextoverflow', () => {
      this.diag({
        phase: 'context-overflow',
        note: 'history truncated by the browser',
        contextUsage: session.contextUsage,
        contextWindow: session.contextWindow,
      });
    });

    this.baseSession = session;
    return session;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const decls = collectFunctionDeclarations(llmRequest);
    const useConstrainedTools = decls.length > 0 && this.opts.toolMode === 'constrained';

    const rawSystem = extractSystemInstruction(llmRequest);
    const systemParts = [
      this.opts.normalizeSystemPrompt ? this.opts.normalizeSystemPrompt(rawSystem) : rawSystem,
    ];
    if (useConstrainedTools) systemParts.push(renderToolInstructions(decls));
    const systemPrompt = systemParts.filter(Boolean).join('\n\n');

    const nativeTools =
      decls.length && this.opts.toolMode === 'native'
        ? decls.map((d) => this.toNativeTool(d, llmRequest))
        : undefined;

    const messages = contentsToMessages(llmRequest.contents ?? []);
    if (!messages.length) messages.push({ role: 'user', content: 'Continue.' });

    let session: LanguageModel | undefined;
    try {
      session = await this.acquireSession(systemPrompt, nativeTools, abortSignal);

      // An ADK output schema maps straight onto responseConstraint.
      const adkOutputSchema = (llmRequest.config as any)?.responseJsonSchema
        ?? (llmRequest.config as any)?.responseSchema;

      const responseConstraint = useConstrainedTools
        ? buildToolChoiceSchema(decls)
        : adkOutputSchema
          ? genaiSchemaToJsonSchema(adkOutputSchema)
          : undefined;

      // Streaming is only meaningful for free text. When the reply must satisfy a
      // schema we need the whole document before it means anything.
      if (stream && !responseConstraint) {
        yield* this.streamText(session, messages, abortSignal);
        return;
      }

      const raw = await this.promptOnce(session, messages, responseConstraint, abortSignal);

      if (useConstrainedTools) {
        yield this.parseToolChoice(raw, decls);
      } else {
        yield finalText(raw);
      }
    } catch (err) {
      yield errorResponse(err);
    } finally {
      // Only destroy clones; the base session stays warm.
      if (session && session !== this.baseSession) session.destroy?.();
    }
  }

  private async promptOnce(
    session: LanguageModel,
    messages: LanguageModelMessage[],
    responseConstraint: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const t0 = performance.now();
    const out = await session.prompt(messages as LanguageModelPrompt, {
      signal,
      ...(responseConstraint
        ? { responseConstraint, omitResponseConstraintInput: true }
        : {}),
    });
    this.diag({
      phase: 'prompt',
      ms: performance.now() - t0,
      contextUsage: session.contextUsage,
      contextWindow: session.contextWindow,
    });
    return out;
  }

  private async *streamText(
    session: LanguageModel,
    messages: LanguageModelMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const streamed = session.promptStreaming(messages as LanguageModelPrompt, { signal });
    const reader = streamed.getReader();
    let acc = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += value;
        yield {
          content: { role: 'model', parts: [{ text: value }] },
          partial: true,
        };
      }
    } finally {
      reader.releaseLock();
    }
    yield { content: { role: 'model', parts: [{ text: acc }] }, turnComplete: true };
  }

  /** Turns the constrained JSON reply into an ADK response. */
  private parseToolChoice(raw: string, decls: FunctionDeclaration[]): LlmResponse {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The constraint should make this impossible, but small models sometimes
      // wrap output in prose or fences. Salvage the first JSON object.
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* fall through */
        }
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      this.diag({ phase: 'parse-retry', note: 'unparseable JSON; treated as text' });
      return finalText(raw);
    }

    if (parsed.kind === 'tool' && parsed.name) {
      const known = decls.some((d) => d.name === parsed.name);
      if (!known) {
        return finalText(
          `The model requested an unknown tool "${parsed.name}".`,
        );
      }
      return {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: `chrome-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: parsed.name,
                args: parsed.args ?? {},
              },
            },
          ],
        },
        turnComplete: true,
      };
    }

    return finalText(typeof parsed.text === 'string' ? parsed.text : raw);
  }

  /**
   * Bridges an ADK tool into Chrome's native tool shape. Chrome executes these
   * itself, so ADK's tool callbacks and events do not fire — see the file header.
   */
  private toNativeTool(d: FunctionDeclaration, llmRequest: LlmRequest): LanguageModelTool {
    const tool = llmRequest.toolsDict?.[d.name!];
    return {
      name: d.name!,
      description: d.description ?? '',
      inputSchema: d.parametersJsonSchema
        ? (d.parametersJsonSchema as object)
        : genaiSchemaToJsonSchema(d.parameters),
      execute: async (args: Record<string, unknown>) => {
        if (!tool) return JSON.stringify({ error: `unknown tool ${d.name}` });
        const result = await (tool as any).runAsync({ args, context: undefined });
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'Chrome\'s Prompt API has no bidirectional live mode; connect() is not supported.',
    );
  }

  /** Releases the warm base session. */
  destroy() {
    this.baseSession?.destroy?.();
    this.baseSession = undefined;
    this.baseSessionKey = undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function finalText(text: string): LlmResponse {
  return { content: { role: 'model', parts: [{ text }] }, turnComplete: true };
}

function errorResponse(err: unknown): LlmResponse {
  const e = err as any;
  const isQuota = e?.name === 'QuotaExceededError';
  return {
    errorCode: e?.name ?? 'UnknownError',
    errorMessage: isQuota
      ? `Prompt exceeded the context window (requested ${e.requested} of ${e.contextWindow} tokens).`
      : (e?.message ?? String(err)),
    turnComplete: true,
  };
}
