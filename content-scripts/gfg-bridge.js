// content-scripts/gfg-bridge.js  (isolated world — has chrome.* access)
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== 'PRIVATE_SYNC_SUCCESS') return;
  if (event.data.platform !== 'gfg') return;

  if (!chrome?.runtime?.id) {
    console.warn('[private-sync] Extension was reloaded — refresh this tab to reconnect.');
    return;
  }

  chrome.runtime.sendMessage({
    platform: 'gfg',
    slug: event.data.slug,
    title: event.data.title,
    difficulty: event.data.difficulty,
    code: event.data.code,
    lang: event.data.lang,
    description: event.data.description
  });
});
