// background.js
//
// This is the ONLY file in the whole extension that talks to GitHub.
// It receives a message from a content-script "bridge" after a
// successful submission, fetches whatever public metadata it needs,
// and pushes files straight to api.github.com using the token the
// user pasted into the options page.
//
// KEY DIFFERENCE FROM LEETHUB AND SIMILAR TOOLS:
// Instead of using the GitHub Contents API (PUT /repos/.../contents/...)
// which registers multiple file changes as a single "push event" and
// undercounts contribution graph squares, this uses the low-level Git
// Data API to construct real git commits — the same object model that
// `git push` produces. GitHub counts each of these commits individually
// in the contribution graph, so 4 commits per problem = 4 green squares.
// The four commits are built first and `main` is moved once at the end, so
// they arrive as a single push of four commits, like `git push` does.
//
// Nothing else is ever contacted. Nothing is ever written to disk.
// The token lives only in chrome.storage.local (this browser profile).

const LANG_EXT = {
  // LeetCode-style names
  python3: 'py', python: 'py', java: 'java', cpp: 'cpp', c: 'c',
  javascript: 'js', typescript: 'ts', csharp: 'cs', golang: 'go',
  kotlin: 'kt', swift: 'swift', rust: 'rs', ruby: 'rb', scala: 'scala',
  php: 'php', racket: 'rkt', erlang: 'erl', elixir: 'ex', dart: 'dart',
  // Ace editor mode IDs (GFG) — e.g. "ace/mode/c_cpp" -> "c_cpp"
  c_cpp: 'cpp', golang_ace: 'go'
};

function extFor(lang) {
  return LANG_EXT[(lang || '').toLowerCase()] || 'txt';
}

async function getConfig() {
  return chrome.storage.local.get(['token', 'leetcodeRepo', 'gfgRepo']);
}

// Accepts "owner/repo", "https://github.com/owner/repo", "owner/repo.git",
// and tolerates stray whitespace. Returns null if it can't be parsed.
function parseRepo(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = cleaned.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

function b64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function fromB64(str) {
  return decodeURIComponent(escape(atob(str.replace(/\n/g, ''))));
}

// ─── GitHub Git Data API helpers ────────────────────────────────────────────
// These construct real git objects (blobs → tree → commit → ref update),
// which GitHub treats identically to `git push` and counts individually
// in the contribution graph — unlike the Contents API which batches them.

async function ghFetch(token, path, opts = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
}

// Get the SHA of the current HEAD commit on main
async function getHeadSha(token, owner, repo) {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/git/refs/heads/main`);
  if (!res.ok) throw new Error(`getHeadSha failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.object.sha;
}

// Get the tree SHA that a commit points at
async function getCommitTreeSha(token, owner, repo, commitSha) {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/git/commits/${commitSha}`);
  if (!res.ok) throw new Error(`getCommitTreeSha failed: ${res.status}`);
  const data = await res.json();
  return data.tree.sha;
}

// Create a blob (file content object) and return its SHA
async function createBlob(token, owner, repo, content) {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: b64(content), encoding: 'base64' })
  });
  if (!res.ok) throw new Error(`createBlob failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.sha;
}

// Create a tree with one or more file changes on top of a base tree
// files: [{ path, content }]
async function createTree(token, owner, repo, baseTreeSha, files) {
  // Create blobs for all files in parallel
  const blobs = await Promise.all(
    files.map(f => createBlob(token, owner, repo, f.content))
  );

  const treeItems = files.map((f, i) => ({
    path: f.path,
    mode: '100644', // regular file
    type: 'blob',
    sha: blobs[i]
  }));

  const res = await ghFetch(token, `/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems })
  });
  if (!res.ok) throw new Error(`createTree failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.sha;
}

// The identity to stamp on commits. GitHub only counts a commit toward the
// contribution graph if its author email belongs to the account, so rather
// than relying on whatever the API infers, use the account's own noreply
// address (<id>+<login>@users.noreply.github.com), which is always linked.
// If the lookup fails, commits are made without an explicit author and
// GitHub falls back to the token owner, as before.
let identityCache = null;

async function getIdentity(token) {
  if (identityCache && identityCache.token === token) return identityCache.value;
  try {
    const res = await ghFetch(token, '/user');
    if (!res.ok) return null;
    const u = await res.json();
    if (!u.id || !u.login) return null;
    const value = { name: u.name || u.login, email: `${u.id}+${u.login}@users.noreply.github.com` };
    identityCache = { token, value };
    return value;
  } catch {
    return null;
  }
}

// Create a commit object pointing at a tree, with a parent commit
async function createCommit(token, owner, repo, message, treeSha, parentSha) {
  const payload = { message, tree: treeSha, parents: [parentSha] };

  const identity = await getIdentity(token);
  if (identity) {
    const stamp = { ...identity, date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
    payload.author = stamp;
    payload.committer = stamp;
  }

  const res = await ghFetch(token, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`createCommit failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.sha;
}

// Advance the main branch pointer to the new commit
async function updateRef(token, owner, repo, commitSha) {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/git/refs/heads/main`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commitSha, force: false })
  });
  if (!res.ok) throw new Error(`updateRef failed: ${res.status} ${await res.text()}`);
}

// Build ONE commit on top of parentSha WITHOUT moving the branch, and return
// the new commit's SHA. Git objects are addressable by SHA as soon as they
// exist, so the next commit can be chained onto this one before any branch
// pointer has moved. The caller moves `main` once, after every commit is built.
async function buildCommit(token, owner, repo, parentSha, files, message) {
  const treeSha = await getCommitTreeSha(token, owner, repo, parentSha);
  const newTreeSha = await createTree(token, owner, repo, treeSha, files);
  return createCommit(token, owner, repo, message, newTreeSha, parentSha);
}

// ─── Stats / README helpers ──────────────────────────────────────────────────

async function getJsonFile(token, owner, repo, path, fallback) {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
  if (res.status === 404) return { data: fallback, ok: true };
  if (!res.ok) return { data: null, ok: false };
  const meta = await res.json();
  try {
    return { data: JSON.parse(fromB64(meta.content)), ok: true };
  } catch {
    return { data: null, ok: false };
  }
}

// ─── Concurrency guards ──────────────────────────────────────────────────────
// Two problems these solve:
//
// 1. The same submission can reach this file twice within milliseconds
//    (e.g. a page-script injected twice after an extension reload). The
//    persistent dedupe store below can't stop that on its own, because it
//    does read → await → write, so two near-simultaneous messages both
//    read "not seen yet". `inFlight` is checked and set synchronously,
//    before any await, so only the first message proceeds.
//
// 2. Two different problems submitted close together would otherwise build
//    commit chains on the same branch at the same time, and one chain's
//    ref update fails as a non-fast-forward. `enqueue` runs pushes to the
//    same repo strictly one after another.
const inFlight = new Set();
const repoQueues = new Map();

function enqueue(key, task) {
  const prev = repoQueues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  repoQueues.set(key, next);
  // Don't let the map grow forever
  next.finally(() => {
    if (repoQueues.get(key) === next) repoQueues.delete(key);
  }).catch(() => {});
  return next;
}

// ─── Duplicate-push guard ────────────────────────────────────────────────────
// LeetCode does a full page navigation to the submission's permalink after
// "Accepted", and that new page independently re-issues its own
// submissionDetails query to render the results view. A content script's
// in-memory `seen` Set can't catch that second firing — it's a fresh script
// instance with no memory of the first one. This persists dedup state in
// chrome.storage.local instead, which survives navigations and service
// worker restarts.
const DEDUPE_STORE_KEY = 'recentPushes';
const DEDUPE_WINDOW_MS = 60 * 1000; // for slug-based (no stable ID) dedupe
const MAX_DEDUPE_ENTRIES = 500;

async function isDuplicatePush(dedupeKey, permanent) {
  const { [DEDUPE_STORE_KEY]: store = {} } = await chrome.storage.local.get(DEDUPE_STORE_KEY);
  const now = Date.now();
  const prev = store[dedupeKey];

  if (prev !== undefined) {
    if (permanent) return true; // same exact submission ID — always a duplicate
    if (now - prev < DEDUPE_WINDOW_MS) return true; // same slug pushed moments ago
  }

  store[dedupeKey] = now;

  const keys = Object.keys(store);
  if (keys.length > MAX_DEDUPE_ENTRIES) {
    keys.sort((a, b) => store[a] - store[b]);
    for (let i = 0; i < keys.length - MAX_DEDUPE_ENTRIES; i++) delete store[keys[i]];
  }

  await chrome.storage.local.set({ [DEDUPE_STORE_KEY]: store });
  return false;
}

// If a push fails, forget that we ever tried it — otherwise the failed
// submission stays marked as "already pushed" and a retry is silently skipped.
async function releaseDedupeKey(dedupeKey) {
  const { [DEDUPE_STORE_KEY]: store = {} } = await chrome.storage.local.get(DEDUPE_STORE_KEY);
  if (store[dedupeKey] === undefined) return;
  delete store[dedupeKey];
  await chrome.storage.local.set({ [DEDUPE_STORE_KEY]: store });
}

// ─── Offscreen document management ───────────────────────────────────────────
// The service worker has no DOM, so real HTML parsing happens in a hidden
// offscreen document instead (offscreen.js) — see manifest.json's
// "offscreen" permission. A real parser sees the actual tag structure
// instead of guessing from text patterns.
let offscreenCreating = null;

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Parse problem HTML into Markdown using DOMParser, unavailable in the service worker.'
    }).catch(err => {
      // Already exists (e.g. survived a service worker restart) — fine.
      if (!/already exists|single offscreen/i.test(String(err))) throw err;
    }).finally(() => {
      offscreenCreating = null;
    });
  }
  await offscreenCreating;
}

// Last-resort text extraction if the offscreen parser can't be reached, so a
// problem description is never lost entirely.
function crudeStripHtml(html) {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|pre|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function htmlToMarkdown(html) {
  if (!html) return '';

  let converted = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ensureOffscreenDocument();
      const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'CONVERT_HTML', html });
      if (response && typeof response.markdown === 'string' && response.markdown.trim()) {
        converted = response.markdown;
        break;
      }
    } catch (e) {
      console.warn('[private-sync] HTML→Markdown attempt failed:', e);
    }
    // The offscreen document may still be starting up — wait and retry.
    await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
  }

  if (!converted) {
    console.warn('[private-sync] HTML→Markdown conversion returned nothing — falling back to plain text.');
    return crudeStripHtml(html);
  }

  return bulletizeLeftoverConstraints(normalizeInlineExamples(splitConcatenatedConstraints(fixConstraintsBlock(converted))));
}

// Catches any constraint-shaped line that wasn't already turned into a
// bullet by the two functions above — most commonly a single, standalone
// constraint clause (splitConcatenatedConstraints only fires when it finds
// 2+ clauses run together, so a lone one was falling through untouched).
// Also handles a "**Constraints:**" label with just one clause attached on
// the same line, splitting it into its own heading plus a bullet below.
function bulletizeLeftoverConstraints(markdown) {
  return markdown.split('\n').map(line => {
    if (/^\s*-\s/.test(line)) return line; // already a bullet, leave alone
    const trimmed = line.trim();
    if (!trimmed) return line;

    const headingMatch = trimmed.match(/^(\*\*Constraints:\*\*|Constraints:)\s*(.*)$/i);
    const heading = headingMatch ? headingMatch[1] : null;
    const rest = headingMatch ? headingMatch[2].trim() : trimmed;
    if (!rest) return line;

    const looksLikeConstraint = /(≤|≥|<=|>=|[<>])/.test(rest) && rest.length <= 150 &&
      !/[{};]|function\s|def\s|class\s|for\s*\(|while\s*\(|return\s/.test(rest);
    if (!looksLikeConstraint) return line;

    const bullet = `- ${/`/.test(rest) ? rest : `\`${rest}\``}`;
    return heading ? `${heading}\n\n${bullet}` : bullet;
  }).join('\n');
}

// Detects a fenced code block whose every line "looks like" a constraint
// (a short comparison expression, or a short plain-English sentence) rather
// than actual code, and converts it into a real bullet list. Refuses to
// touch anything that also contains Input/Output/Example markers — that
// signals a mixed legacy block (example + constraints combined), which
// should be left alone rather than partially bulleted.
function looksLikeConstraintLine(line) {
  if (!line || line.length > 120) return false;
  const looksLikeCode = /[{};]|=>|function\s|def\s|class\s|for\s*\(|while\s*\(|return\s|console\.|System\.|public\s|private\s|import\s/.test(line);
  if (looksLikeCode) return false;
  if (/<=|>=|==|!=|≤|≥|[<>]/.test(line)) return true;
  const words = line.split(/\s+/).length;
  return words <= 14 && /^[A-Za-z`]/.test(line);
}

function fixConstraintsBlock(markdown) {
  return markdown.replace(/```\n([\s\S]*?)\n```/g, (whole, body) => {
    if (/\b(Input|Output|Example)\s*:/i.test(body)) return whole; // mixed block, leave it alone
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length || !lines.every(looksLikeConstraintLine)) return whole;
    return lines.map(line => `- ${/`/.test(line) ? line : `\`${line}\``}`).join('\n');
  });
}

// Some GFG problems render multiple constraint clauses as one run-on line
// with nothing but a stray space (or nothing at all) between them, e.g.
// "2 ≤ arr.size() ≤ 10^61 ≤ arr[i] ≤ 10^7" — two separate constraints
// squashed together with zero separator. This detects repeated
// "value OP ... OP value" clauses within a line and splits each onto its
// own bullet, treating exponent notation (10^6) as one atomic number so it
// doesn't get misread as the start of the next clause.
function splitConcatenatedConstraints(markdown) {
  const clauseRe = /\d+(?:\^\d+)?\s*(?:≤|<=|>=|≥|<|>)\s*[^\d≤≥<>=\n^]+?\s*(?:≤|<=|>=|≥|<|>)\s*\d+(?:\^\d+)?/g;
  return markdown.replace(/^(?!-\s).*(?:≤|<=|>=|≥).*(?:≤|<=|>=|≥).*$/gm, (line) => {
    const clauses = line.match(clauseRe);
    if (!clauses || clauses.length < 2) return line;

    // Preserve any label before the first clause on the line (e.g.
    // "**Constraints:**") instead of discarding it during the split.
    const firstIdx = line.indexOf(clauses[0]);
    const prefix = line.slice(0, firstIdx).trim();
    const bullets = clauses.map(c => `- \`${c.trim()}\``).join('\n');

    return prefix ? `${prefix}\n\n${bullets}` : bullets;
  });
}

// Some examples show as separate "- Input: ..." / "- Output: ..." bullet
// lines (from a real <li> list) while other examples on the SAME page show
// as a proper boxed example (from a <pre> block) — a formatting
// inconsistency GFG itself has, not something we introduced. This groups
// consecutive Input/Output/Explanation bullets into one small fenced block
// so every example ends up looking the same.
function normalizeInlineExamples(markdown) {
  return markdown.replace(
    /(?:^- (?:Input|Output|Explanation):.*$\n?){2,}/gim,
    (block) => {
      const lines = block.trim().split('\n').map(l => l.replace(/^- /, ''));
      return `\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`;
    }
  );
}

function renderReadme(entries) {
  const counts = { Easy: 0, Medium: 0, Hard: 0 };
  entries.forEach(e => { counts[e.difficulty] = (counts[e.difficulty] || 0) + 1; });

  const header =
    `# Solutions\n\n` +
    `**Total solved:** ${entries.length}` +
    ` &nbsp;|&nbsp; 🟢 Easy: ${counts.Easy || 0}` +
    ` &nbsp;|&nbsp; 🟡 Medium: ${counts.Medium || 0}` +
    ` &nbsp;|&nbsp; 🔴 Hard: ${counts.Hard || 0}\n\n` +
    `_Auto-generated. Do not edit by hand — it will be overwritten on the next sync._\n\n`;

  // Group by topic — a problem with several tags (e.g. Array, DP, Greedy on
  // LeetCode) appears once in EACH relevant table, not just its first tag.
  const byTopic = {};
  entries.forEach(e => {
    const topics = Array.isArray(e.topics) && e.topics.length
      ? e.topics
      : (e.topic ? [e.topic] : ['Uncategorized']); // back-compat with older entries
    topics.forEach(topic => {
      (byTopic[topic] = byTopic[topic] || []).push(e);
    });
  });

  const topics = Object.keys(byTopic).sort((a, b) => {
    if (a === 'Uncategorized') return 1;
    if (b === 'Uncategorized') return -1;
    return a.localeCompare(b);
  });

  const sections = topics.map(topic => {
    const rows = byTopic[topic]
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((e, i) => `| ${i + 1} | [${e.title}](${e.path}) | ${e.difficulty} | ${e.language} |`)
      .join('\n');

    return `## ${topic}\n\n| # | My Solution | Difficulty | Language |\n|---|---|---|---|\n${rows}`;
  });

  return header + sections.join('\n\n') + '\n';
}

// ─── Main push logic ─────────────────────────────────────────────────────────
// Four real git commits are built one on top of another, then `main` is
// moved ONCE to the last of them. That is exactly what `git push` of four
// commits does: a single push event carrying four commits, which GitHub
// counts as four contributions. (Moving the branch after every commit
// produced four rapid-fire push events, and the contribution graph
// processed those unreliably — sometimes counting only 1, 2 or 3.)
//
// All four commits are ALWAYS made, even if the problem description could not
// be fetched — in that case the README holds a short placeholder instead.

const NO_DESCRIPTION_TEXT = '_The problem description was not available when this solution was synced._';

async function recordAndPush({ token, owner, repo, slug, title, difficulty, language, description, code, url, topics }) {
  const folder = slug;
  const ext = extFor(language);

  let head = await getHeadSha(token, owner, repo);

  // Commit 1: solution code
  head = await buildCommit(
    token, owner, repo, head,
    [{ path: `${folder}/Solution.${ext}`, content: code }],
    `feat: solve ${title}`
  );

  // Commit 2: problem description README (always — placeholder if empty)
  const heading = url ? `# [${title}](${url})` : `# ${title}`;
  const body = description && description.trim() ? description : NO_DESCRIPTION_TEXT;
  const readmeBody = `${heading}\n\n**Difficulty:** ${difficulty}\n\n${body}\n`;
  head = await buildCommit(
    token, owner, repo, head,
    [{ path: `${folder}/README.md`, content: readmeBody }],
    `docs: add ${title} description`
  );

  // Commit 3: update stats.json
  // (Reading it from main is safe: commits 1 and 2 don't touch this file.)
  const statsPath = '.sync-meta/stats.json';
  const statsResult = await getJsonFile(token, owner, repo, statsPath, []);

  if (!statsResult.ok) {
    console.error(`[private-sync] Could not read stats.json safely — skipping stats/README update for "${title}" to avoid data loss. Solution files were still pushed.`);
    await updateRef(token, owner, repo, head); // still publish commits 1 and 2
    return;
  }

  const stats = statsResult.data;
  const idx = stats.findIndex(e => e.slug === slug);
  const entry = { slug, title, difficulty, language, path: `${folder}/`, url, topics: (topics && topics.length ? topics : ['Uncategorized']) };
  if (idx >= 0) stats[idx] = entry; else stats.push(entry);

  head = await buildCommit(
    token, owner, repo, head,
    [{ path: statsPath, content: JSON.stringify(stats, null, 2) }],
    `chore: update stats (${title})`
  );

  // Commit 4: update root README
  head = await buildCommit(
    token, owner, repo, head,
    [{ path: 'README.md', content: renderReadme(stats) }],
    `docs: update README (${title})`
  );

  // One push: move main to the last commit, publishing all four together.
  await updateRef(token, owner, repo, head);
}

// If the branch moved underneath us (something else pushed to main between
// our read and our update), the ref update is rejected and nothing has
// landed. Rebuild the commits on the new head and try once more.
async function recordAndPushWithRetry(args) {
  try {
    return await recordAndPush(args);
  } catch (e) {
    if (/updateRef failed: 422/.test(String(e))) {
      console.warn('[private-sync] main moved during push — rebuilding on the new head and retrying once.');
      return recordAndPush(args);
    }
    throw e;
  }
}

// ─── Platform handlers ───────────────────────────────────────────────────────

async function fetchLeetCodeProblem(slug) {
  const res = await fetch('https://leetcode.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query($slug: String!) { question(titleSlug: $slug) { title difficulty content topicTags { name } } }`,
      variables: { slug }
    })
  });
  const json = await res.json();
  return json?.data?.question;
}

async function handleMessage(msg) {
  if (!msg || (msg.platform !== 'leetcode' && msg.platform !== 'gfg')) return;

  // Work out the dedupe key up front, synchronously, so the in-flight check
  // below happens before any await and two identical messages can't both pass.
  const isLeetcode = msg.platform === 'leetcode';
  const dedupeKey = isLeetcode
    ? (msg.submissionId ? `leetcode:sub:${msg.submissionId}` : `leetcode:slug:${msg.slug}`)
    : `gfg:slug:${msg.slug}`;
  const permanent = isLeetcode && !!msg.submissionId;

  if (inFlight.has(dedupeKey)) {
    console.log(`[private-sync] Already processing ${dedupeKey} — ignoring duplicate message.`);
    return;
  }
  inFlight.add(dedupeKey);

  let claimed = false; // true once the persistent dedupe store has recorded this push
  try {
    const { token, leetcodeRepo, gfgRepo } = await getConfig();
    if (!token) { console.warn('[private-sync] No GitHub token set — open the extension options page.'); return; }

    const repoValue = isLeetcode ? leetcodeRepo : gfgRepo;
    if (!repoValue) {
      console.warn(`[private-sync] No ${isLeetcode ? 'LeetCode' : 'GFG'} repo configured.`);
      return;
    }
    const parsed = parseRepo(repoValue);
    if (!parsed) {
      console.error(`[private-sync] Repo "${repoValue}" is not in "owner/repo" form — fix it in the options page.`);
      return;
    }
    const { owner, repo } = parsed;

    if (await isDuplicatePush(dedupeKey, permanent)) {
      console.log(`[private-sync] Skipped duplicate push for ${msg.slug}` + (msg.submissionId ? ` (submission ${msg.submissionId})` : ''));
      return;
    }
    claimed = true;

    if (isLeetcode) {
      const problem = await fetchLeetCodeProblem(msg.slug);
      const description = await htmlToMarkdown(problem?.content);
      await enqueue(`${owner}/${repo}`, () => recordAndPushWithRetry({
        token, owner, repo,
        slug: msg.slug,
        title: problem?.title || msg.slug,
        difficulty: problem?.difficulty || 'Unknown',
        language: msg.lang,
        description,
        code: msg.code,
        url: `https://leetcode.com/problems/${msg.slug}/`,
        topics: (problem?.topicTags || []).map(t => t.name)
      }));
    } else {
      const description = await htmlToMarkdown(msg.description);
      if (!description) {
        console.warn(`[private-sync] GFG message for "${msg.slug}" had no description — using placeholder README.`);
      }
      await enqueue(`${owner}/${repo}`, () => recordAndPushWithRetry({
        token, owner, repo,
        slug: msg.slug,
        title: msg.title || msg.slug,
        difficulty: msg.difficulty || 'Unknown',
        language: msg.lang,
        description,
        code: msg.code,
        url: `https://www.geeksforgeeks.org/problems/${msg.slug}/1`,
        topics: msg.topics
      }));
    }
  } catch (err) {
    // Let a retry of this same submission go through instead of being
    // silently skipped as an "already pushed" duplicate.
    if (claimed) await releaseDedupeKey(dedupeKey).catch(() => {});
    throw err;
  } finally {
    inFlight.delete(dedupeKey);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages addressed to the offscreen document aren't ours to answer.
  if (!msg || msg.target === 'offscreen') return false;

  handleMessage(msg)
    .then(() => sendResponse({ ok: true }))
    .catch(err => { console.error('[private-sync]', err); sendResponse({ ok: false, error: String(err) }); });
  return true;
});

const RECONNECT_TARGETS = [
  {
    pattern: 'https://leetcode.com/problems/*',
    files: [
      { file: 'content-scripts/leetcode-main.js', world: 'MAIN' },
      { file: 'content-scripts/leetcode-bridge.js' }
    ]
  },
  {
    pattern: 'https://www.geeksforgeeks.org/problems/*',
    files: [
      { file: 'content-scripts/gfg-main.js', world: 'MAIN' },
      { file: 'content-scripts/gfg-bridge.js' }
    ]
  }
];

async function reconnectOpenTabs() {
  for (const { pattern, files } of RECONNECT_TARGETS) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: pattern });
    } catch (e) {
      console.warn('[private-sync] Could not query tabs for', pattern, e);
      continue;
    }

    for (const tab of tabs) {
      for (const { file, world } of files) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: [file],
            ...(world ? { world } : {})
          });
        } catch (e) {
          // Tab may have navigated away or closed between query and inject — harmless.
          console.warn('[private-sync] Reinject skipped for tab', tab.id, file, e);
        }
      }
    }
  }
}

chrome.runtime.onInstalled.addListener(() => reconnectOpenTabs());

chrome.runtime.onStartup.addListener(() => reconnectOpenTabs());