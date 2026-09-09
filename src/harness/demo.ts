/**
 * The recording stage.
 *
 * Same `Panel`, same pipeline, same ADK agents as everything else — this only
 * adds presentation around them: a caption bar, the tab corpus rendered beside
 * the panel, and hooks the recorder script drives.
 *
 * Showing all 40 tab titles next to the panel is the point of this layout. It
 * lets a viewer see for themselves that the tab the model returns does not
 * contain the words that were typed, which is the claim the whole demo rests on.
 */

import { Panel } from '../ui/panel.js';
import { DemoTabProvider } from '../ui/tab-provider.js';
import { DEMO_TABS } from '../core/demo-tabs.js';

const provider = new DemoTabProvider();
let panel: Panel;

function renderTabs() {
  const host = document.getElementById('tabs')!;
  host.innerHTML = '';
  for (const t of DEMO_TABS) {
    const row = document.createElement('div');
    row.className = 'tabrow';
    row.id = `tab-${t.tabId}`;
    row.textContent = t.title;
    host.appendChild(row);
  }
}

/** Hooks the recorder calls. Kept on window so the script can stay declarative. */
const api = {
  caption(main: string, sub = '') {
    document.getElementById('cap-main')!.textContent = main;
    document.getElementById('cap-sub')!.textContent = sub;
  },

  note(text: string) {
    const el = document.getElementById('note')!;
    if (!text) {
      el.classList.remove('show');
      return;
    }
    el.textContent = text;
    el.classList.add('show');
  },

  /** Highlights tabs in the corpus list by id. */
  highlight(tabIds: number[]) {
    document.querySelectorAll('.tabrow.hit').forEach((e) => e.classList.remove('hit'));
    for (const id of tabIds) document.getElementById(`tab-${id}`)?.classList.add('hit');
  },

  markGone(tabIds: number[]) {
    for (const id of tabIds) document.getElementById(`tab-${id}`)?.classList.add('gone');
  },

  /** Types into the search box one character at a time, like a person. */
  async type(text: string, msPerChar = 55) {
    const input = document.getElementById('tf-input') as HTMLInputElement;
    input.focus();
    input.value = '';
    for (const ch of text) {
      input.value += ch;
      await new Promise((r) => setTimeout(r, msPerChar));
    }
  },

  submit() {
    document.getElementById('tf-form')!
      .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  },

  /** Result titles currently rendered, for the recorder to assert against. */
  results(): string[] {
    return [...document.querySelectorAll('.tf-card-title')].map((e) => e.textContent ?? '');
  },

  reply(): string {
    return document.querySelector('.tf-reply')?.textContent ?? '';
  },

  trace(): string[] {
    return [...document.querySelectorAll('.tf-trace-row')].map((e) => e.textContent ?? '');
  },

  tabCount(): number {
    return document.querySelectorAll('.tabrow:not(.gone)').length;
  },

  setTabsHead(text: string) {
    document.getElementById('tabs-head')!.textContent = text;
  },

  modelKind(): string {
    return document.querySelector('.tf-badge')?.textContent ?? '';
  },

  reset() {
    provider.reset();
    renderTabs();
    return panel.reindex();
  },
};

async function main() {
  renderTabs();
  panel = new Panel({ root: document.getElementById('panel')!, provider });
  await panel.init();
  (window as unknown as { demo: typeof api }).demo = api;
  (window as unknown as { demoReady: boolean }).demoReady = true;
}

void main();
