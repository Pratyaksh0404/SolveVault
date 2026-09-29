// content-scripts/gfg-bridge.js  (isolated world — has chrome.* access)
// Relays the window message from gfg-main.js into the extension.
// Never touches the network itself.
//
// If more than one copy of this script is alive in a tab (for example after
// the extension was reloaded), a copy whose connection to the extension is
// dead must not reload the page when a working copy already handled the
// submission. Working copies leave a marker in the page's DOM (shared by
// all copies); a dead copy waits briefly, checks for it, and only steps in
// — by saving the submission and reloading — when nobody relayed it.

(() => {
  const PENDING_KEY = '__privateSyncPending';
  const RELOAD_KEY = '__privateSyncReloadedAt';
  const RELAY_ATTR = 'data-private-sync-relayed';
  const ORPHAN_GRACE_MS = 1200;    // how long a dead copy waits for a live one to relay
  const RELOAD_COOLDOWN_MS = 30000; // never reload more than once per 30 s

  const myGeneration = Symbol('gfg-bridge-generation');
  window.__privateSyncGfgBridgeGeneration = myGeneration;

  const isAlive = () => {
    try {
      return !!chrome?.runtime?.id;
    } catch {
      return false;
    }
  };

  // ---- pending queue (sessionStorage survives a reload of the tab)
  const readPending = () => {
    try {
      return JSON.parse(sessionStorage.getItem(PENDING_KEY) || '[]');
    } catch {
      return [];
    }
  };

  const writePending = (list) => {
    try {
      if (list.length) sessionStorage.setItem(PENDING_KEY, JSON.stringify(list));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* storage unavailable — nothing more we can do */
    }
  };

  const enqueue = (payload) => {
    const list = readPending();
    if (!list.some((p) => p.slug === payload.slug)) {
      list.push(payload);
      writePending(list);
    }
  };

  // ---- relay marker (lives in the DOM, so every copy of the script sees it)
  const markRelayed = (key) => {
    try {
      document.documentElement.setAttribute(RELAY_ATTR, `${key}|${Date.now()}`);
    } catch {
      /* ignore */
    }
  };

  const wasRelayedRecently = (key) => {
    try {
      const raw = document.documentElement.getAttribute(RELAY_ATTR) || '';
      const i = raw.lastIndexOf('|');
      if (i < 0) return false;
      return raw.slice(0, i) === key && Date.now() - Number(raw.slice(i + 1)) < 10000;
    } catch {
      return false;
    }
  };

  // ---- sending
  // Fire-and-forget. The background script may not call sendResponse, so a
  // lastError such as "message port closed" is NOT a failure. Only a dead
  // extension context (or a synchronous throw) counts as failed.
  const send = (payload) => {
    if (!isAlive()) return false;
    try {
      chrome.runtime.sendMessage(payload, () => {
        try { void chrome.runtime.lastError; } catch { /* ignore */ }
      });
      return true;
    } catch {
      return false; // "Extension context invalidated"
    }
  };

  const flushPending = () => {
    const list = readPending();
    if (!list.length) return;
    writePending([]); // claim them first so another copy can't double-send
    const failed = [];
    for (const payload of list) {
      if (send(payload)) markRelayed(String(payload.slug));
      else failed.push(payload);
    }
    if (failed.length) writePending([...readPending(), ...failed]);
  };

  const reloadSoon = (delay = 0) => {
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
      if (Date.now() - last < RELOAD_COOLDOWN_MS) return; // avoid reload loops
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {
      /* if storage is unavailable, still allow one reload */
    }
    setTimeout(() => location.reload(), delay);
  };

  // ---- injection-time check
  if (!isAlive()) {
    // Stale at injection: refresh (at most once per cooldown) so it's fixed
    // before any submission is attempted on this tab.
    reloadSoon();
    return;
  }

  flushPending(); // deliver anything saved before the last reload

  // ---- relay messages from gfg-main.js
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'PRIVATE_SYNC_SUCCESS') return;
    if (event.data.platform !== 'gfg') return;

    // A newer copy of this script has since been injected — let it handle
    // this (or a future) message instead of sending a duplicate.
    if (window.__privateSyncGfgBridgeGeneration !== myGeneration) return;

    // Forward everything gfg-main.js sent (slug, title, difficulty, lang,
    // code, description, topics, ...) except the internal message type.
    const { type, ...rest } = event.data;
    const payload = { ...rest, platform: 'gfg' };
    if (payload.lang === undefined && rest.language !== undefined) payload.lang = rest.language;

    const key = String(payload.slug);

    if (send(payload)) {
      markRelayed(key);
      return;
    }

    // This copy's connection is dead. If a working copy relays the same
    // submission, stay silent; otherwise save it and reload so the fresh
    // script instance delivers it.
    setTimeout(() => {
      if (wasRelayedRecently(key)) return;
      enqueue(payload);
      console.debug('[private-sync] Extension was reloaded mid-session — submission queued; reloading tab to deliver it.');
      reloadSoon();
    }, ORPHAN_GRACE_MS);
  });
})();