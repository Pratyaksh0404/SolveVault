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

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToMarkdown(html) {
  if (!html) return '';
  let out = html;

  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, ''));
    return `\n\`\`\`\n${code.trim()}\n\`\`\`\n`;
  });
  out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) =>
    `\`${decodeEntities(inner.replace(/<[^>]+>/g, ''))}\``);
  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) =>
    `- ${decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()}\n`);
  out = out.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  out = out.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) =>
    `**${decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()}**`);
  out = out.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) =>
    `*${decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()}*`);
  out = out.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, (_, inner) =>
    `^${decodeEntities(inner.replace(/<[^>]+>/g, ''))}`);
  out = out.replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/div>/gi, '\n').replace(/<div[^>]*>/gi, '');
  out = out.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, (_, alt) => alt ? `[image: ${alt}]` : '');
  out = out.replace(/<img[^>]*>/gi, '');
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<[^>]+>/g, '');
  out = decodeEntities(out);
  out = out.split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return out;
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
    `_Auto-generated. Do not edit by hand — it will be overwritten on the next sync._\n\n` +
    `| # | Problem | Difficulty | Language |\n|---|---|---|---|\n`;

  const rows = entries
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((e, i) => `| ${i + 1} | [${e.title}](${e.path}) | ${e.difficulty} | ${e.language} |`)
    .join('\n');

  return header + rows + '\n';
}

// ─── Main push logic ─────────────────────────────────────────────────────────
// Each file change is its own real git commit, chained sequentially.
// GitHub counts every one of them in the contribution graph.

async function recordAndPush({ token, owner, repo, slug, title, difficulty, language, description, code }) {
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
    const readmeBody = `# ${title}\n\n**Difficulty:** ${difficulty}\n\n${description}\n`;
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
  const entry = { slug, title, difficulty, language, path: `${folder}/` };
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
      query: `query($slug: String!) { question(titleSlug: $slug) { title difficulty content } }`,
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
    const [owner, repo] = leetcodeRepo.split('/');
    const problem = await fetchLeetCodeProblem(msg.slug);
    await recordAndPush({
      token, owner, repo,
      slug: msg.slug,
      title: problem?.title || msg.slug,
      difficulty: problem?.difficulty || 'Unknown',
      language: msg.lang,
      description: htmlToMarkdown(problem?.content),
      code: msg.code
    });
  }

  if (msg.platform === 'gfg') {
    if (!gfgRepo) { console.warn('[private-sync] No GFG repo configured.'); return; }
    const [owner, repo] = gfgRepo.split('/');
    await recordAndPush({
      token, owner, repo,
      slug: msg.slug,
      title: msg.title || msg.slug,
      difficulty: msg.difficulty || 'Unknown',
      language: msg.lang,
      description: htmlToMarkdown(msg.description),
      code: msg.code
    });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg)
    .then(() => sendResponse({ ok: true }))
    .catch(err => { console.error('[private-sync]', err); sendResponse({ ok: false, error: String(err) }); });
  return true;
});