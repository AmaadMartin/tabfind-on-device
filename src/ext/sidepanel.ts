/**
 * Side panel entry point — the real extension.
 *
 * This document is where inference runs. See service-worker.ts for why it
 * cannot live in the worker.
 */

import { Panel } from '../ui/panel.js';
import { ChromeTabProvider } from '../ui/tab-provider.js';

async function main() {
  const provider = new ChromeTabProvider();
  const panel = new Panel({
    root: document.getElementById('panel')!,
    provider,
  });
  await panel.init();

  // The worker tells us when the tab set changed. Re-index in the background so
  // the next search does not pay for extraction.
  chrome.runtime.onMessage.addListener((msg: { type?: string; tabId?: number }) => {
    if (msg?.type !== 'tabfind:tabs-changed') return;
    if (typeof msg.tabId === 'number') provider.invalidate(msg.tabId);
    void panel.reindex();
  });

  // Focus the input as soon as the panel opens; this is a keyboard-first tool.
  (document.getElementById('tf-input') as HTMLInputElement | null)?.focus();
}

void main();
