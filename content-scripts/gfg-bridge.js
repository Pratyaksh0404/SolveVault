// content-scripts/gfg-bridge.js  (isolated world — has chrome.* access)

(() => {

  const myGeneration = Symbol('gfg-bridge-generation');
  window.__privateSyncGfgBridgeGeneration = myGeneration;

  if (!chrome?.runtime?.id) {
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
    if (event.data.platform !== 'gfg') return;

    if (window.__privateSyncGfgBridgeGeneration !== myGeneration) return;

    if (!chrome?.runtime?.id) {
      console.warn('[private-sync] Extension was reloaded mid-session — this submission could not be sent. Reloading the tab now so the next one works without manual intervention.');
      setTimeout(() => location.reload(), 1500);
      return;
    }

    chrome.runtime.sendMessage({
      platform: 'gfg',
      slug: event.data.slug,
      title: event.data.title,
      difficulty: event.data.difficulty,
      topics: event.data.topics,
      code: event.data.code,
      lang: event.data.lang,
      description: event.data.description
    });
  });
})();
