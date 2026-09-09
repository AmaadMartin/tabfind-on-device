/**
 * Abstracts where tabs come from, so the side panel and the standalone harness
 * run byte-identical UI and pipeline code.
 *
 *   ChromeTabProvider   - the real thing, backed by chrome.tabs
 *   DemoTabProvider     - a fixed synthetic corpus, no extension required
 *
 * Being able to run the whole demo as an ordinary web page matters more than it
 * sounds: it means the pipeline can be developed, tested and driven by
 * automation without loading an unpacked extension.
 */

import type { IndexedTab } from '../core/types.js';
import { DEMO_TABS } from '../core/demo-tabs.js';
import { MAX_PAGE_CHARS } from '../core/prompts.js';

export interface TabProvider {
  readonly name: string;
  /** Whether this provider can actually act on tabs. */
  readonly canAct: boolean;
  listTabs(): Promise<IndexedTab[]>;
  focusTab(tabId: number): Promise<void>;
  closeTabs(tabIds: number[]): Promise<number>;
}

/* --------------------------- demo provider --------------------------- */

export class DemoTabProvider implements TabProvider {
  readonly name = 'demo';
  readonly canAct = true;
  private tabs = [...DEMO_TABS];
  private focused?: number;

  async listTabs() {
    return this.tabs;
  }

  async focusTab(tabId: number) {
    this.focused = tabId;
  }

  async closeTabs(tabIds: number[]) {
    const before = this.tabs.length;
    this.tabs = this.tabs.filter((t) => !tabIds.includes(t.tabId));
    return before - this.tabs.length;
  }

  get focusedTabId() {
    return this.focused;
  }

  /** Restores the corpus after a demo run. */
  reset() {
    this.tabs = [...DEMO_TABS];
    this.focused = undefined;
  }
}

/* -------------------------- chrome provider -------------------------- */

/** Pages we cannot inject a content script into. */
function isRestricted(url: string): boolean {
  return (
    !url
    || url.startsWith('chrome://')
    || url.startsWith('chrome-extension://')
    || url.startsWith('devtools://')
    || url.startsWith('edge://')
    || url.startsWith('about:')
    || url.startsWith('https://chromewebstore.google.com')
    || url.startsWith('https://chrome.google.com/webstore')
  );
}

/**
 * Runs in the page. Kept deliberately small and dependency-free because it is
 * serialised and injected.
 */
function extractPageText(maxChars: number): { text: string } {
  const pick = (sel: string) => document.querySelector(sel)?.textContent ?? '';
  const meta =
    document.querySelector('meta[name="description"]')?.getAttribute('content')
    ?? document.querySelector('meta[property="og:description"]')?.getAttribute('content')
    ?? '';
  const main = pick('main') || pick('article') || document.body?.innerText || '';
  const text = `${meta}\n${main}`.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  return { text };
}

export class ChromeTabProvider implements TabProvider {
  readonly name = 'chrome';
  readonly canAct = true;

  /** Cached extractions keyed by `tabId:url`, so re-searching is free. */
  private cache = new Map<string, { text: string; at: number }>();

  async listTabs(): Promise<IndexedTab[]> {
    const tabs = await chrome.tabs.query({});
    const out: IndexedTab[] = [];

    // Extraction is concurrent but bounded; a window with 100 tabs should not
    // spawn 100 simultaneous script injections.
    const queue = tabs.filter((t) => t.id !== undefined);
    const CONCURRENCY = 6;
    let cursor = 0;

    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= queue.length) return;
        const t = queue[i];
        out.push(await this.toIndexedTab(t));
      }
    });
    await Promise.all(workers);

    out.sort((a, b) => a.tabId - b.tabId);
    return out;
  }

  private async toIndexedTab(t: chrome.tabs.Tab): Promise<IndexedTab> {
    const tabId = t.id!;
    const url = t.url ?? '';
    const key = `${tabId}:${url}`;
    const base: IndexedTab = {
      tabId,
      windowId: t.windowId,
      url,
      title: t.title ?? '(untitled)',
      favIconUrl: t.favIconUrl,
      text: '',
      indexedAt: Date.now(),
    };

    if (isRestricted(url)) return { ...base, extractionBlocked: true };

    const cached = this.cache.get(key);
    if (cached) return { ...base, text: cached.text, indexedAt: cached.at };

    // A discarded tab has no live document. Waking it to read text would be
    // hostile — the user parked it deliberately — so we index title and URL only.
    if (t.discarded || t.status === 'unloaded') {
      return { ...base, extractionBlocked: true };
    }

    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractPageText,
        args: [MAX_PAGE_CHARS * 3],
      });
      const text = (res?.result as { text: string } | undefined)?.text ?? '';
      this.cache.set(key, { text, at: Date.now() });
      return { ...base, text };
    } catch {
      // Injection can fail for reasons we cannot enumerate up front (CSP, the
      // tab closing mid-flight, enterprise policy). Degrade, never throw.
      return { ...base, extractionBlocked: true };
    }
  }

  async focusTab(tabId: number) {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  }

  async closeTabs(tabIds: number[]) {
    await chrome.tabs.remove(tabIds);
    for (const id of tabIds) {
      for (const key of [...this.cache.keys()]) {
        if (key.startsWith(`${id}:`)) this.cache.delete(key);
      }
    }
    return tabIds.length;
  }

  /** Drops a cache entry so the next index re-extracts. */
  invalidate(tabId: number) {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${tabId}:`)) this.cache.delete(key);
    }
  }
}
