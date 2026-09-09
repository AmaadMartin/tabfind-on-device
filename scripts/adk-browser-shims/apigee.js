/**
 * Stub for @google/adk's dist/web/models/apigee_llm.js.
 *
 * The published web build of that module contains invalid downleveled output:
 *
 *   yield* __yieldStar(super.generateContentAsync(llmRequest, stream, abortSignal));
 *
 * `super` cannot appear inside the transformed `__asyncGenerator` closure, so
 * esbuild (correctly) refuses to parse it. It is unreachable for us regardless:
 * LlmAgent -> models/registry.js -> apigee_llm.js exists only so the registry can
 * register the `apigee/*` model prefix, which this demo never uses.
 *
 * We register a class with the same static shape so LLMRegistry stays happy, and
 * throw if anyone ever actually instantiates it.
 */
export class ApigeeLlm {
  constructor() {
    throw new Error(
      'ApigeeLlm is stubbed out in the browser build of this extension.',
    );
  }
}

ApigeeLlm.supportedModels = [/apigee\/.*/];

export function apigeeToGeminiInitParams(params) {
  return params;
}

export default { ApigeeLlm, apigeeToGeminiInitParams };
