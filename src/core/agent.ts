/**
 * The conversational layer: an ADK `LlmAgent` with tools, on top of the
 * retrieval pipeline.
 *
 * This is the half of the demo that makes TabFind an agent rather than a search
 * box. "find the refund thing" is retrieval; "close the ones about flights" is
 * an agent deciding to call `closeTabs` with specific ids it learned from a
 * previous `searchTabs` call.
 *
 * It is also the only part that exercises the adapter's tool-calling path
 * end-to-end. Chrome's Prompt API has no function calling that hands control
 * back to the caller, so every tool call here is synthesised by
 * `ChromePromptApiLlm` out of a constrained-JSON decode and then dispatched by
 * ADK's runner — with ADK's tool callbacks, events and session state all intact.
 *
 * The architectural split worth noticing: retrieval is a *deterministic
 * pipeline* (stages that always run in the same order), while this layer is a
 * *conversational agent* (the model decides what happens next). Using an agent
 * for retrieval would make it slower and less reliable; using a pipeline for
 * conversation would make it useless. ADK gives you both, and they compose.
 */

import { LlmAgent, FunctionTool, Runner, InMemorySessionService } from '@google/adk';
import type { BaseLlm } from '@google/adk';
import { ASSISTANT_SYSTEM } from './prompts.js';
import type { TabSearchPipeline } from './pipeline.js';
import type { RankedResult } from './types.js';

const APP_NAME = 'tabfind-chat';
const USER_ID = 'local';

export interface TabAgentDeps {
  model: BaseLlm;
  pipeline: TabSearchPipeline;
  focusTab: (tabId: number) => Promise<void>;
  closeTabs: (tabIds: number[]) => Promise<number>;
  /** Asked before anything destructive. Return false to veto. */
  confirmClose?: (tabs: Array<{ tabId: number; title: string }>) => Promise<boolean>;
  /**
   * Hard ceiling on model calls in a single turn. Default 8.
   *
   * ADK's default is 500, which is a reasonable backstop for a fast cloud model
   * and completely wrong for on-device inference: a small model that fails to
   * notice its work is done will happily re-call the same tool forever, and 500
   * local inferences is minutes of a frozen panel. Observed in testing — the
   * model kept re-issuing `closeTabs` after the tabs were already closed.
   *
   * Small models loop. Budget for it in code rather than trusting the prompt.
   */
  maxLlmCalls?: number;
}

export interface AgentTurn {
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Results from the most recent searchTabs call, for the UI to render. */
  lastResults: RankedResult[];
}

/**
 * Builds the agent and its tools.
 *
 * Four tools, flat, no nesting. A small model degrades quickly as the tool
 * inventory grows, and every declaration also consumes context window because
 * the adapter has to describe them in the prompt.
 */
export function createTabAgent(deps: TabAgentDeps) {
  let lastResults: RankedResult[] = [];
  const toolCalls: AgentTurn['toolCalls'] = [];

  const searchTabs = new FunctionTool({
    name: 'searchTabs',
    description:
      'Search the user\'s open tabs by meaning. Use this whenever they refer to a '
      + 'tab without giving its exact title. Returns matching tabs with their ids.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What the user is looking for, in their own words.',
        },
      },
      required: ['query'],
    } as never,
    execute: async (args: { query: string }) => {
      toolCalls.push({ name: 'searchTabs', args });
      const results: RankedResult[] = [];
      for await (const ev of deps.pipeline.search(args.query)) {
        if (ev.type === 'done') results.push(...ev.results);
      }
      lastResults = results;
      // Return only what the model needs to act. Page text here would blow the
      // context window for no benefit.
      return JSON.stringify({
        matches: results.slice(0, 8).map((r) => ({
          tabId: r.tab.tabId,
          title: r.tab.title,
          score: r.score,
        })),
      });
    },
  });

  const focusTab = new FunctionTool({
    name: 'focusTab',
    description: 'Switch to a tab. Requires a tabId from a previous searchTabs call.',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'integer', description: 'Tab id to focus.' } },
      required: ['tabId'],
    } as never,
    execute: async (args: { tabId: number }) => {
      toolCalls.push({ name: 'focusTab', args });
      await deps.focusTab(args.tabId);
      return JSON.stringify({ ok: true });
    },
  });

  const closeTabs = new FunctionTool({
    name: 'closeTabs',
    description:
      'Close one or more tabs. Requires tabIds from a previous searchTabs call. '
      + 'Only use when the user clearly asked to close, remove or clean up tabs.',
    parameters: {
      type: 'object',
      properties: {
        tabIds: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Tab ids to close.',
        },
      },
      required: ['tabIds'],
    } as never,
    execute: async (args: { tabIds: number[] }) => {
      toolCalls.push({ name: 'closeTabs', args });
      const ids = (args.tabIds ?? []).filter((n) => Number.isInteger(n));
      if (!ids.length) return JSON.stringify({ closed: 0, reason: 'no valid tab ids' });

      // Closing tabs is irreversible and the model is small. Confirmation is a
      // hard gate in code rather than an instruction the model might ignore.
      if (deps.confirmClose) {
        const titles = ids.map((id) => ({
          tabId: id,
          title: lastResults.find((r) => r.tab.tabId === id)?.tab.title ?? `tab ${id}`,
        }));
        if (!(await deps.confirmClose(titles))) {
          return JSON.stringify({ closed: 0, reason: 'the user declined' });
        }
      }
      const closed = await deps.closeTabs(ids);
      return JSON.stringify({ closed });
    },
  });

  const agent = new LlmAgent({
    name: 'tabfind_assistant',
    model: deps.model,
    instruction: ASSISTANT_SYSTEM,
    tools: [searchTabs, focusTab, closeTabs],
  });

  const sessions = new InMemorySessionService();
  const runner = new Runner({ appName: APP_NAME, agent, sessionService: sessions });
  let sessionId: string | undefined;

  return {
    agent,
    /** Sends one user message and runs the agent loop to completion. */
    async send(message: string, signal?: AbortSignal): Promise<AgentTurn> {
      toolCalls.length = 0;
      if (!sessionId) {
        const s = await sessions.createSession({ appName: APP_NAME, userId: USER_ID });
        sessionId = s.id;
      }

      let text = '';
      let hitLimit = false;
      try {
        for await (const event of runner.runAsync({
          userId: USER_ID,
          sessionId,
          newMessage: { role: 'user', parts: [{ text: message }] },
          runConfig: {
            maxLlmCalls: deps.maxLlmCalls ?? 8,
            ...(signal ? { signal } : {}),
          } as never,
        })) {
          if (event.errorMessage) throw new Error(event.errorMessage);
          if (event.author === 'tabfind_assistant') {
            const t = (event.content?.parts ?? []).map((p) => p.text ?? '').join('');
            if (t) text = t;
          }
        }
      } catch (err) {
        // Running out of budget is a normal outcome for a small model, not a
        // crash. The tools that already ran did run; report what happened
        // instead of losing the turn.
        if (!/max number of llm calls/i.test((err as Error).message ?? '')) throw err;
        hitLimit = true;
      }

      if (hitLimit && !text) {
        text = toolCalls.length
          ? 'I stopped after a few steps. Here is what I did.'
          : 'I could not work out what to do with that.';
      }

      return { text: text.trim(), toolCalls: [...toolCalls], lastResults };
    },
    /** Starts a fresh conversation. */
    reset() {
      sessionId = undefined;
      lastResults = [];
    },
  };
}
