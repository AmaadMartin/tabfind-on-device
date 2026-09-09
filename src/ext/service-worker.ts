/**
 * MV3 service worker.
 *
 * Deliberately thin. It does *not* run inference: the Prompt API is documented
 * as unavailable in Web Workers, and an MV3 service worker is a worker context.
 * All model work happens in the side panel document, which is a real document
 * with the API available. The worker only handles lifecycle:
 *
 *   - open the side panel when the toolbar action is clicked
 *   - tell the panel to re-index when the tab set changes
 *
 * Keeping it thin also dodges MV3's aggressive worker termination, which would
 * otherwise kill a long-running model session mid-search.
 */

const RE_INDEX_MESSAGE = 'tabfind:tabs-changed';

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // Older Chrome builds do not support this; the action handler below covers it.
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) {
    void chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

/**
 * Nudges the panel to re-index. Debounced because a single navigation can emit
 * several onUpdated events, and re-indexing re-extracts page text.
 */
let pending: ReturnType<typeof setTimeout> | undefined;
function notifyTabsChanged(tabId?: number) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = undefined;
    // No receiver when the panel is closed; that rejection is expected.
    chrome.runtime
      .sendMessage({ type: RE_INDEX_MESSAGE, tabId })
      .catch(() => undefined);
  }, 400);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Only a completed navigation changes what the page says.
  if (changeInfo.status === 'complete' || changeInfo.title) notifyTabsChanged(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => notifyTabsChanged(tabId));
chrome.tabs.onCreated.addListener(() => notifyTabsChanged());
