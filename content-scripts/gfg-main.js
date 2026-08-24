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

  function getDifficulty() {
    // Try a targeted element first — more reliable than scanning all page text.
    const el = document.querySelector('[class*="difficulty" i]');
    if (el) {
      const m = el.innerText.match(/Easy|Medium|Hard|Basic|School/i);
      if (m) return m[0];
    }
    // Fallback: search the whole page's visible text for "Difficulty: X".
    const bodyMatch = document.body.innerText.match(/Difficulty:\s*(Easy|Medium|Hard|Basic|School)/i);
    return bodyMatch ? bodyMatch[1] : undefined;
  }

  function getTopics() {

    const pills = document.querySelectorAll('[class*="problems_tag_label" i]');
    const topics = [];

    pills.forEach(pill => {
      const section = pill.closest('[class*="problems_accordion_tags" i]');
      const title = section?.querySelector('[class*="problems_active_tag_title" i]')?.innerText?.trim();
      if (title && /^topic tags?$/i.test(title)) {
        topics.push(pill.innerText.trim());
      }
    });

    return [...new Set(topics)].filter(Boolean);
  }

  function getProblemMeta() {
    // document.title is reliably set by GFG for SEO (e.g. "Word in Grid -
    // All Occurrences | Practice | GeeksforGeeks"), which is more robust
    // than guessing at a heading's CSS class.
    let title = document.title.split('|')[0].trim();
    if (!title) title = document.querySelector('h1')?.innerText?.trim();

    return { title, difficulty: getDifficulty(), topics: getTopics() };
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

      // The success banner and the rest of the page chrome (difficulty
      // badge, etc.) don't always finish rendering in the same tick — give
      // it a brief moment before reading metadata, rather than reading it
      // the instant the banner appears and sometimes missing it.
      setTimeout(() => {
        const { title, difficulty, topics } = getProblemMeta();
        const slug = location.pathname.split('/problems/')[1]?.split('/')[0] || document.title;

        window.postMessage({
          type: 'PRIVATE_SYNC_SUCCESS',
          platform: 'gfg',
          slug, title, difficulty, topics,
          code,
          lang: getLangFromEditor(),
          description: getDescription()
        }, '*');
      }, 600);
    }
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();