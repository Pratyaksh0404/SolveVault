// content-scripts/leetcode-bridge.js  (isolated world — has chrome.* access)
// Just relays the window message from leetcode-main.js into the extension.
// Never touches the network itself.

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== 'PRIVATE_SYNC_SUCCESS') return;
  if (event.data.platform !== 'leetcode') return;

  chrome.runtime.sendMessage({
    platform: 'leetcode',
    slug: event.data.slug,
    code: event.data.code,
    lang: event.data.lang
  });
});
