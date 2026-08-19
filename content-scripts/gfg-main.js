// content-scripts/gfg-main.js  (runs in the PAGE's own JS context — "world": "MAIN")
//
// GeeksforGeeks doesn't expose a stable, public submission API the way
// LeetCode does, so this watches the DOM for the verdict banner instead.
//
// ⚠️ VERIFY BEFORE RELYING ON THIS: the description selector in particular
// is a best guess — open DevTools → Elements on a GFG problem page and
// confirm/adjust getDescription()'s selector if it comes back empty.

(() => {
  if (window.__privateSyncGfgHooked) return;
  window.__privateSyncGfgHooked = true;

  // GFG shows "Problem Solved Successfully" on accept — kept "accepted" too
  // in case wording differs on older/newer pages.
  const SUCCESS_TEXT = /problem solved successfully|accepted/i;
  let lastSent = 0;

  function getEditorCode() {
    const cmEl = document.querySelector('.CodeMirror');
    if (cmEl?.CodeMirror) return cmEl.CodeMirror.getValue();

    const aceEl = document.querySelector('.ace_editor');
    if (aceEl && window.ace) return window.ace.edit(aceEl).getValue();

    return null;
  }

  function getLangFromEditor() {
    // More reliable than scraping the UI dropdown (which isn't a native
    // <select> on GFG) — ask the Ace editor instance directly what mode
    // it's in, e.g. "ace/mode/python" -> "python", "ace/mode/c_cpp" -> "c_cpp".
    const aceEl = document.querySelector('.ace_editor');
    if (aceEl && window.ace) {
      try {
        const modeId = window.ace.edit(aceEl).session.getMode().$id || '';
        const short = modeId.split('/').pop();
        if (short) return short;
      } catch (e) { /* fall through */ }
    }
    return 'text';
  }

  function getProblemMeta() {
    // document.title is reliably set by GFG for SEO (e.g. "Word in Grid -
    // All Occurrences | Practice | GeeksforGeeks"), which is more robust
    // than guessing at a heading's CSS class.
    let title = document.title.split('|')[0].trim();
    if (!title) title = document.querySelector('h1')?.innerText?.trim();

    // Difficulty is shown as plain visible text like "Difficulty: Medium" —
    // search for that pattern directly instead of relying on a class name.
    const match = document.body.innerText.match(/Difficulty:\s*(Easy|Medium|Hard|Basic|School)/i);
    const difficulty = match ? match[1] : undefined;

    return { title, difficulty };
  }

  function getDescription() {
    // Best-effort: GFG uses hashed CSS-module class names that change
    // between builds, so this tries a few common patterns. If it comes
    // back empty, inspect the problem statement block in DevTools and
    // adjust the selector below.
    //
    // Sends raw innerHTML (not innerText) — background.js runs this through
    // the same HTML-to-Markdown converter used for LeetCode, so headings,
    // lists, and code blocks come out properly structured instead of
    // collapsing into one run-on paragraph.
    const el = document.querySelector(
      '[class*="problem_content" i], [class*="problemStatement" i], .problem-statement, article'
    );
    return el ? el.innerHTML : '';
  }

  const observer = new MutationObserver(() => {
    const bodyText = document.body.innerText || '';
    if (SUCCESS_TEXT.test(bodyText) && Date.now() - lastSent > 5000) {
      const code = getEditorCode();
      if (!code) return; // editor not found yet this tick, try again next mutation

      lastSent = Date.now();
      const { title, difficulty } = getProblemMeta();
      const slug = location.pathname.split('/problems/')[1]?.split('/')[0] || document.title;

      window.postMessage({
        type: 'PRIVATE_SYNC_SUCCESS',
        platform: 'gfg',
        slug, title, difficulty,
        code,
        lang: getLangFromEditor(),
        description: getDescription()
      }, '*');
    }
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
