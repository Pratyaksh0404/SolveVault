// content-scripts/leetcode-bridge.js  (isolated world — has chrome.* access)
// Just relays the window message from leetcode-main.js into the extension.
// Never touches the network itself.

(() => {

  const myGeneration = Symbol('leetcode-bridge-generation');
  window.__privateSyncLeetcodeBridgeGeneration = myGeneration;

  if (!chrome?.runtime?.id) {
    // Extension context is stale at injection time — refresh once, right
    // now, so it's fixed before any submission is attempted on this tab.
    if (!sessionStorage.getItem('__privateSyncReloaded')) {
      sessionStorage.setItem('__privateSyncReloaded', '1');
      location.reload();
    }
    return;
  }

  sessionStorage.removeItem('__privateSyncReloaded');

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'PRIVATE_SYNC_SUCCESS') return;
    if (event.data.platform !== 'leetcode') return;

    // A newer copy of this script has since been injected — let it handle
    // this (or a future) message instead of sending a duplicate.
    if (window.__privateSyncLeetcodeBridgeGeneration !== myGeneration) return;

    if (!chrome?.runtime?.id) {
      console.warn('[private-sync] Extension was reloaded mid-session — this submission could not be sent. Reloading the tab now so the next one works without manual intervention.');
      setTimeout(() => location.reload(), 1500);
      return;
    }

    chrome.runtime.sendMessage({
      platform: 'leetcode',
      slug: event.data.slug,
      code: event.data.code,
      lang: event.data.lang,
      submissionId: event.data.submissionId
    });
  });
})();
