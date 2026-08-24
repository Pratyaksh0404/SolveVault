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

// Create a commit object pointing at a tree, with a parent commit
async function createCommit(token, owner, repo, message, treeSha, parentSha) {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] })
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

// Push a single commit containing one or more files, chained onto the
// current HEAD. Returns the new HEAD SHA so the next push can chain off it.
async function pushCommit(token, owner, repo, headSha, files, message) {
  const treeSha = await getCommitTreeSha(token, owner, repo, headSha);
  const newTreeSha = await createTree(token, owner, repo, treeSha, files);
  const newCommitSha = await createCommit(token, owner, repo, message, newTreeSha, headSha);
  await updateRef(token, owner, repo, newCommitSha);
  return newCommitSha; // caller chains the next commit off this
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

// ─── Offscreen document management ───────────────────────────────────────────
// The service worker has no DOM, so real HTML parsing happens in a hidden
// offscreen document instead (offscreen.js) — see manifest.json's
// "offscreen" permission. This replaces the old regex-based HTML-to-Markdown
// converter, which kept breaking on edge cases regex fundamentally can't
// distinguish (e.g. "this dash is a bullet" vs "this dash is in a code
// example") — a real parser sees the actual tag structure instead of
// guessing from text patterns.
let offscreenReady = null;

async function ensureOffscreenDocument() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Parse problem HTML into Markdown using DOMParser, unavailable in the service worker.'
  }).catch(err => {
    // Already exists (e.g. survived a service worker restart) — fine.
    if (!/already exists|single offscreen/i.test(String(err))) throw err;
  });
  return offscreenReady;
}

async function htmlToMarkdown(html) {
  if (!html) return '';
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'CONVERT_HTML', html });
  const converted = response?.markdown || '';
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
// Each file change is its own real git commit, chained sequentially.
// GitHub counts every one of them in the contribution graph.

async function recordAndPush({ token, owner, repo, slug, title, difficulty, language, description, code, url, topics }) {
  const folder = slug;
  const ext = extFor(language);

  // Get current HEAD once — each pushCommit returns the new HEAD for the next
  let head = await getHeadSha(token, owner, repo);

  // Commit 1: solution code
  head = await pushCommit(
    token, owner, repo, head,
    [{ path: `${folder}/Solution.${ext}`, content: code }],
    `feat: solve ${title}`
  );

  // Commit 2: problem description README (only if we have one)
  if (description) {
    const heading = url ? `# [${title}](${url})` : `# ${title}`;
    const readmeBody = `${heading}\n\n**Difficulty:** ${difficulty}\n\n${description}\n`;
    head = await pushCommit(
      token, owner, repo, head,
      [{ path: `${folder}/README.md`, content: readmeBody }],
      `docs: add ${title} description`
    );
  }

  // Commit 3: update stats.json
  const statsPath = '.sync-meta/stats.json';
  const statsResult = await getJsonFile(token, owner, repo, statsPath, []);

  if (!statsResult.ok) {
    console.error(`[private-sync] Could not read stats.json safely — skipping stats/README update for "${title}" to avoid data loss. Solution files were still pushed.`);
    return;
  }

  const stats = statsResult.data;
  const idx = stats.findIndex(e => e.slug === slug);
  const entry = { slug, title, difficulty, language, path: `${folder}/`, url, topics: (topics && topics.length ? topics : ['Uncategorized']) };
  if (idx >= 0) stats[idx] = entry; else stats.push(entry);

  head = await pushCommit(
    token, owner, repo, head,
    [{ path: statsPath, content: JSON.stringify(stats, null, 2) }],
    `chore: update stats (${title})`
  );

  // Commit 4: update root README
  await pushCommit(
    token, owner, repo, head,
    [{ path: 'README.md', content: renderReadme(stats) }],
    `docs: update README (${title})`
  );
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
  const { token, leetcodeRepo, gfgRepo } = await getConfig();
  if (!token) { console.warn('[private-sync] No GitHub token set — open the extension options page.'); return; }

  if (msg.platform === 'leetcode') {
    if (!leetcodeRepo) { console.warn('[private-sync] No LeetCode repo configured.'); return; }

    const dedupeKey = msg.submissionId ? `leetcode:sub:${msg.submissionId}` : `leetcode:slug:${msg.slug}`;
    if (await isDuplicatePush(dedupeKey, !!msg.submissionId)) {
      console.log(`[private-sync] Skipped duplicate push for ${msg.slug} (submission ${msg.submissionId})`);
      return;
    }

    const [owner, repo] = leetcodeRepo.split('/');
    const problem = await fetchLeetCodeProblem(msg.slug);
    const description = await htmlToMarkdown(problem?.content);
    await recordAndPush({
      token, owner, repo,
      slug: msg.slug,
      title: problem?.title || msg.slug,
      difficulty: problem?.difficulty || 'Unknown',
      language: msg.lang,
      description,
      code: msg.code,
      url: `https://leetcode.com/problems/${msg.slug}/`,
      topics: (problem?.topicTags || []).map(t => t.name)
    });
  }

  if (msg.platform === 'gfg') {
    if (!gfgRepo) { console.warn('[private-sync] No GFG repo configured.'); return; }

    if (await isDuplicatePush(`gfg:slug:${msg.slug}`, false)) {
      console.log(`[private-sync] Skipped duplicate push for ${msg.slug}`);
      return;
    }

    const [owner, repo] = gfgRepo.split('/');
    const description = await htmlToMarkdown(msg.description);
    await recordAndPush({
      token, owner, repo,
      slug: msg.slug,
      title: msg.title || msg.slug,
      difficulty: msg.difficulty || 'Unknown',
      language: msg.lang,
      description,
      code: msg.code,
      url: `https://www.geeksforgeeks.org/problems/${msg.slug}/1`,
      topics: msg.topics
    });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg)
    .then(() => sendResponse({ ok: true }))
    .catch(err => { console.error('[private-sync]', err); sendResponse({ ok: false, error: String(err) }); });
  return true;
});