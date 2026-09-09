/**
 * The TabFind panel UI, shared by the extension side panel and the harness page.
 *
 * Framework-free on purpose: this is sample code people will read, and a build
 * with no UI dependencies is one less thing between them and the interesting
 * part. It is also the only code on the main thread besides inference, and the
 * Prompt API is not available in Web Workers — so keeping the UI cheap is a
 * correctness concern, not just taste.
 *
 * Results render progressively, one card at a time, as each candidate is scored.
 */

import { TabSearchPipeline } from '../core/pipeline.js';
import { createTabAgent } from '../core/agent.js';
import { createModel, type ModelStatus } from '../model/create-model.js';
import type { RankedResult, SearchEvent } from '../core/types.js';
import type { TabProvider } from './tab-provider.js';

const SCORE_LABEL = ['unrelated', 'weak', 'good', 'exact'];

/**
 * Decides whether input is a search or an instruction.
 *
 * Searching is the fast path: it skips straight to the retrieval pipeline. Only
 * phrasing that asks for an *action* is routed through the conversational agent,
 * which costs an extra model call to decide what to do. Routing everything
 * through the agent would make every search slower and add a chance for a small
 * model to forget to call `searchTabs` at all.
 */
export function looksLikeCommand(input: string): boolean {
  return /^\s*(close|shut|kill|remove|dismiss|clean up|get rid of|switch to|go to|open|focus|jump to)\b/i
    .test(input);
}

export interface PanelOptions {
  root: HTMLElement;
  provider: TabProvider;
  /** Starts in simulated mode regardless of what the browser supports. */
  forceSimulated?: boolean;
}

export class Panel {
  private pipeline!: TabSearchPipeline;
  private agent!: ReturnType<typeof createTabAgent>;
  private status!: ModelStatus;
  private provider: TabProvider;
  private root: HTMLElement;
  private abort?: AbortController;
  private indexing = false;

  private el!: {
    input: HTMLInputElement;
    results: HTMLElement;
    stats: HTMLElement;
    badge: HTMLElement;
    trace: HTMLElement;
    reindex: HTMLButtonElement;
  };

  constructor(private readonly opts: PanelOptions) {
    this.provider = opts.provider;
    this.root = opts.root;
  }

  async init() {
    this.renderChrome();
    const { model, status } = await createModel({
      forceSimulated: this.opts.forceSimulated,
      onDownloadProgress: (loaded) => {
        this.setStats(`Downloading the on-device model… ${Math.round(loaded * 100)}%`);
      },
      temperature: 0.3,
      topK: 3,
    });
    this.status = status;
    this.pipeline = new TabSearchPipeline({ model, candidateLimit: 10 });
    this.agent = createTabAgent({
      model,
      pipeline: this.pipeline,
      focusTab: (id) => this.provider.focusTab(id),
      closeTabs: (ids) => this.provider.closeTabs(ids),
      // A hard gate in code, not an instruction the model might ignore.
      confirmClose: (tabs) =>
        Promise.resolve(
          confirm(
            `Close ${tabs.length} tab${tabs.length === 1 ? '' : 's'}?\n\n`
            + tabs.map((t) => `· ${t.title}`).join('\n'),
          ),
        ),
    });
    this.renderBadge();
    await this.reindex();
  }

  /* ------------------------------ chrome ------------------------------ */

  private renderChrome() {
    this.root.innerHTML = `
      <div class="tf">
        <header class="tf-head">
          <div class="tf-title">TabFind</div>
          <div class="tf-badge" id="tf-badge"></div>
        </header>
        <form class="tf-searchbar" id="tf-form">
          <input id="tf-input" type="search" autocomplete="off"
                 placeholder="describe the tab you&#39;re looking for…" />
          <button type="submit" id="tf-go">Search</button>
        </form>
        <div class="tf-stats" id="tf-stats">starting…</div>
        <div class="tf-trace" id="tf-trace"></div>
        <div class="tf-results" id="tf-results"></div>
        <footer class="tf-foot">
          <button id="tf-reindex" type="button">Re-index tabs</button>
          <span class="tf-hint">Runs entirely on your device.</span>
        </footer>
      </div>`;

    this.el = {
      input: this.root.querySelector('#tf-input')!,
      results: this.root.querySelector('#tf-results')!,
      stats: this.root.querySelector('#tf-stats')!,
      badge: this.root.querySelector('#tf-badge')!,
      trace: this.root.querySelector('#tf-trace')!,
      reindex: this.root.querySelector('#tf-reindex')!,
    };

    this.root.querySelector('#tf-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.search(this.el.input.value.trim());
    });
    this.el.reindex.addEventListener('click', () => void this.reindex());
  }

  private renderBadge() {
    const simulated = this.status.kind === 'simulated';
    this.el.badge.className = `tf-badge ${simulated ? 'tf-badge-sim' : 'tf-badge-live'}`;
    this.el.badge.textContent = simulated ? 'SIMULATED MODEL' : 'ON-DEVICE';
    this.el.badge.title = this.status.detail;
    if (simulated) {
      // Never let simulated output be mistaken for model output.
      const note = document.createElement('div');
      note.className = 'tf-warn';
      note.textContent = this.status.detail;
      this.root.querySelector('.tf')!.insertBefore(
        note,
        this.root.querySelector('.tf-searchbar'),
      );
    }
  }

  /* ------------------------------ indexing ---------------------------- */

  async reindex() {
    if (this.indexing) return;
    this.indexing = true;
    this.setStats('Indexing tabs…');
    try {
      const tabs = await this.provider.listTabs();
      this.pipeline.setTabs(tabs);
      const blocked = tabs.filter((t) => t.extractionBlocked).length;
      this.setStats(
        `${tabs.length} tabs indexed`
        + (blocked ? ` · ${blocked} without readable text` : ''),
      );
    } catch (err) {
      this.setStats(`Indexing failed: ${(err as Error).message}`);
    } finally {
      this.indexing = false;
    }
  }

  /* ------------------------------- search ----------------------------- */

  async search(query: string) {
    if (!query) return;
    this.abort?.abort();
    this.abort = new AbortController();

    this.el.results.innerHTML = '';
    this.el.trace.innerHTML = '';
    this.setStats('Thinking…');

    if (looksLikeCommand(query)) {
      await this.runCommand(query);
      return;
    }

    const started = performance.now();
    let shown = 0;
    const pending: RankedResult[] = [];

    try {
      for await (const ev of this.pipeline.search(query, this.abort.signal)) {
        this.handleEvent(ev, pending, () => shown++);
        if (ev.type === 'result') shown = this.renderIncremental(pending);
      }
      const ms = Math.round(performance.now() - started);
      const kept = this.el.results.querySelectorAll('.tf-card').length;
      this.setStats(
        kept
          ? `${kept} result${kept === 1 ? '' : 's'} in ${ms} ms`
          : `No matching tabs (${ms} ms)`,
      );
    } catch (err) {
      this.setStats(`Search failed: ${(err as Error).message}`);
    }
  }

  /**
   * Routes an instruction through the conversational agent, which decides which
   * tools to call. Unlike search, the agent owns the whole turn, so there is
   * nothing to stream until it finishes.
   */
  private async runCommand(instruction: string) {
    const started = performance.now();
    this.addTrace('routing to the agent (tool calling)', 0);
    try {
      const turn = await this.agent.send(instruction, this.abort?.signal);

      for (const call of turn.toolCalls) {
        this.addTrace(`tool → ${call.name}(${JSON.stringify(call.args).slice(0, 60)})`, 0);
      }
      if (turn.lastResults.length) this.renderFinal(turn.lastResults);

      const reply = document.createElement('div');
      reply.className = 'tf-reply';
      reply.textContent = turn.text || 'Done.';
      this.el.results.prepend(reply);

      this.setStats(`${Math.round(performance.now() - started)} ms`);
      await this.reindex();
    } catch (err) {
      this.setStats(`Command failed: ${(err as Error).message}`);
    }
  }

  private handleEvent(ev: SearchEvent, pending: RankedResult[], _bump: () => void) {
    switch (ev.type) {
      case 'expanded':
        this.addTrace(
          `expanded → ${ev.query.keywords.slice(0, 8).join(', ') || '(none)'}`,
          Math.round(ev.ms),
        );
        break;
      case 'prefiltered':
        this.addTrace(
          `prefiltered ${ev.totalIndexed} tabs → ${ev.candidates.length} candidates`,
          Math.round(ev.ms),
        );
        break;
      case 'result':
        pending.push(ev.result);
        break;
      case 'done':
        // Re-render sorted, replacing the progressive list.
        this.renderFinal(ev.results);
        break;
      case 'error':
        this.setStats(`Error: ${ev.message}`);
        break;
    }
  }

  /** Shows results as they stream in, best-so-far first. */
  private renderIncremental(pending: RankedResult[]): number {
    const sorted = [...pending]
      .filter((r) => r.score >= 1)
      .sort((a, b) => b.score - a.score || b.lexicalScore - a.lexicalScore);
    this.el.results.innerHTML = '';
    for (const r of sorted) this.el.results.appendChild(this.card(r));
    return sorted.length;
  }

  private renderFinal(results: RankedResult[]) {
    this.el.results.innerHTML = '';
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'tf-empty';
      empty.textContent = 'Nothing matched. Try describing it differently.';
      this.el.results.appendChild(empty);
      return;
    }
    for (const r of results) this.el.results.appendChild(this.card(r));
  }

  private card(r: RankedResult): HTMLElement {
    const el = document.createElement('div');
    el.className = `tf-card tf-score-${r.score}`;

    const host = safeHost(r.tab.url);
    el.innerHTML = `
      <div class="tf-card-main">
        <div class="tf-card-title"></div>
        <div class="tf-card-why"></div>
        <div class="tf-card-url"></div>
      </div>
      <div class="tf-card-side">
        <span class="tf-pip" title="${SCORE_LABEL[r.score]}">${r.score}</span>
        <button class="tf-close" title="Close this tab">×</button>
      </div>`;

    // textContent throughout: page titles are untrusted input.
    el.querySelector('.tf-card-title')!.textContent = r.tab.title;
    el.querySelector('.tf-card-why')!.textContent = r.why;
    el.querySelector('.tf-card-url')!.textContent = host;

    el.querySelector('.tf-card-main')!.addEventListener('click', () => {
      void this.provider.focusTab(r.tab.tabId);
    });
    el.querySelector('.tf-close')!.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.provider.closeTabs([r.tab.tabId]);
      el.remove();
      await this.reindex();
    });
    return el;
  }

  private addTrace(text: string, ms: number) {
    const row = document.createElement('div');
    row.className = 'tf-trace-row';
    const label = document.createElement('span');
    label.textContent = text;
    const timing = document.createElement('span');
    timing.className = 'tf-trace-ms';
    timing.textContent = `${ms} ms`;
    row.append(label, timing);
    this.el.trace.appendChild(row);
  }

  private setStats(text: string) {
    this.el.stats.textContent = text;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
