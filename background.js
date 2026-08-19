// background.js
//
// This is the ONLY file in the whole extension that talks to GitHub.
// It receives a message from a content-script "bridge" after a
// successful submission, fetches whatever public metadata it needs,
// and pushes files straight to api.github.com using the token the
// user pasted into the options page.
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

async function ghFetch(token, path, opts = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {})
    }
  });
}

async function getFileSha(token, owner, repo, path) {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
  if (res.status === 200) {
    const data = await res.json();
    return data.sha;
  }
  return undefined;
}

async function putFile(token, owner, repo, path, content, message) {
  const sha = await getFileSha(token, owner, repo, path);
  const res = await ghFetch(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: b64(content), sha, branch: 'main' })
  });
  if (!res.ok) {
    console.error('GitHub push failed for', path, await res.text());
  }
  return res.ok;
}

async function getJsonFile(token, owner, repo, path, fallback) {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);

  // File genuinely doesn't exist yet — safe to start from the fallback (empty list).
  if (res.status === 404) return { data: fallback, ok: true };

  // Any other non-200 (rate limit, transient 5xx, auth hiccup, etc.) — do NOT
  // treat this as "empty". Signal failure so the caller can skip the write
  // instead of silently wiping out everything that was there before.
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

// Converts raw problem-statement HTML (from either platform) into proper
// GitHub-flavored Markdown — real bold text, real bullet lists, real fenced
// code blocks — rather than flattening everything into a single run-on
// paragraph, which is what plain tag-stripping does (Markdown ignores single
// line breaks, so structure has to be expressed with real Markdown syntax).
function htmlToMarkdown(html) {
  if (!html) return '';
  let out = html;

  // Code / preformatted blocks first, before any other tag stripping touches
  // their contents — wrap in fences and preserve internal whitespace as-is.
  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, ''));
    return `\n\`\`\`\n${code.trim()}\n\`\`\`\n`;
  });

  // Inline code (not already inside a fence, those are gone now)
  out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${decodeEntities(inner.replace(/<[^>]+>/g, ''))}\``);

  // List items -> "- item", one per line
  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `- ${decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()}\n`);
  out = out.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');

  // Bold / italic
  out = out.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => `**${decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()}**`);
  out = out.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => `*${decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()}*`);

  // Superscript (e.g. 2^n)
  out = out.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, (_, inner) => `^${decodeEntities(inner.replace(/<[^>]+>/g, ''))}`);

  // Paragraphs and line breaks -> real blank-line-separated paragraphs
  out = out.replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/div>/gi, '\n').replace(/<div[^>]*>/gi, '');

  // Drop images (can't easily rehost them) but keep alt text if present
  out = out.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, (_, alt) => (alt ? `[image: ${alt}]` : ''));
  out = out.replace(/<img[^>]*>/gi, '');

  // Anything left (headings, spans, script/style, etc.)
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<[^>]+>/g, '');

  out = decodeEntities(out);

  // Collapse excess blank lines and trim trailing spaces per line
  out = out
    .split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

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

async function recordAndPush({ token, owner, repo, slug, title, difficulty, language, description, code }) {
  const folder = slug;
  const ext = extFor(language);

  await putFile(token, owner, repo, `${folder}/Solution.${ext}`, code, `feat: solve ${title}`);

  if (description) {
    const body = `# ${title}\n\n**Difficulty:** ${difficulty}\n\n${description}\n`;
    await putFile(token, owner, repo, `${folder}/README.md`, body, `docs: add ${title} description`);
  }

  // Stats file lives IN the repo (not locally) so counts/README survive
  // across browsers/devices and there's nothing to keep in sync locally.
  const statsPath = '.sync-meta/stats.json';
  const statsResult = await getJsonFile(token, owner, repo, statsPath, []);

  if (!statsResult.ok) {
    // Could not safely confirm the current stats list — DO NOT overwrite it
    // with an empty one. The solution + description above are already
    // pushed successfully; only the stats/README refresh is skipped this
    // time. It'll catch up correctly on the next successful submission.
    console.error(`[private-sync] Could not read existing stats.json safely — skipped stats/README update for "${title}" to avoid data loss. Solution files were still pushed.`);
    return;
  }

  const stats = statsResult.data;
  const idx = stats.findIndex(e => e.slug === slug);
  const entry = { slug, title, difficulty, language, path: `${folder}/` };
  if (idx >= 0) stats[idx] = entry; else stats.push(entry);
  await putFile(token, owner, repo, statsPath, JSON.stringify(stats, null, 2), `chore: update stats (${title})`);

  await putFile(token, owner, repo, 'README.md', renderReadme(stats), `docs: update README (${title})`);
}

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
  return true; // keep the message channel open for the async response
});
