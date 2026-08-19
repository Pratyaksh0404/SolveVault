# SolveVault

Automatically pushes accepted submissions from LeetCode and GeeksforGeeks to your own GitHub repos the moment they're accepted — full solution code, a formatted problem description, and an auto-updating stats table, all without a single OAuth app, relay server, or third party in the loop.

> Built for competitive programmers and DSA practitioners who want a private, automatic, zero-trust archive of everything they've solved.

---

## Trust model

```
Your browser (SolveVault extension) ──HTTPS──> api.github.com
                                     ──HTTPS──> leetcode.com / geeksforgeeks.org
```

That's the entire network graph. Nobody's server sits in the middle. The token lives only in `chrome.storage.local` on your machine, scoped by GitHub itself to exactly the two repos you choose. Your code is read from the page, pushed, and discarded — never written to disk, never sent anywhere but GitHub.

---

## What it does

- Watches LeetCode submissions via its internal GraphQL API (the same calls LeetCode's own UI makes) and detects an "Accepted" verdict
- Watches GFG submissions via DOM detection for its "Problem Solved Successfully" banner (GFG has no public submission API)
- On success, automatically:
  - Pushes `Solution.<ext>` with your exact submitted code
  - Creates a `README.md` inside the problem folder with the full formatted problem statement — real bullet lists, bold text, and fenced code blocks, not a flattened wall of text
  - Updates the repo-wide `README.md` stats table (total solved, difficulty breakdown, problem index)
- All of the above happens in one commit sequence, seconds after you hit Submit

**Supported platforms**

| Platform | Status |
|:---------|:------:|
| LeetCode | ✅ Working |
| GeeksforGeeks | ✅ Working |
| Codeforces | 🔜 Planned |
| CodeChef | 🔜 Planned |
| HackerRank | 🔜 Planned |

---

## Setup

### 1. Create your GitHub repos

On github.com, create two **empty** repos (private or public, your choice):
- `leetcode-solutions`
- `gfg-solutions`

Don't clone them anywhere. SolveVault talks to them purely via the GitHub REST API — no local git clone is needed or used.

### 2. Create a fine-grained Personal Access Token

Go to **github.com/settings/personal-access-tokens/new**:
- Resource owner → your account
- Repository access → **Only select repositories** → pick the two repos above
- Permissions → **Contents: Read and write** (only this — nothing else needed)
- Set an expiry (90 days recommended; GitHub will remind you to rotate)
- Click Generate, copy the token once

This token can *only* touch those two repos. It cannot read your email, your other repos, your org data, or perform any administrative action. If it ever leaked, the blast radius is "someone could write files to two solution repos" — nothing more.

### 3. Load the extension

1. Clone or download this repo to a permanent location (don't delete the folder after loading — Chrome loads unpacked extensions by reference)
2. Go to `chrome://extensions`
3. Toggle **Developer mode** on (top right)
4. Click **Load unpacked** → select the project folder
5. Pin the extension icon if you like (optional)

### 4. Configure it

Right-click the extension icon → **Options** (or click the icon if it opens Options directly). Fill in:
- Your Personal Access Token
- `yourname/leetcode-solutions`
- `yourname/gfg-solutions`

Click **Save**.

### 5. Use it

Solve a problem on LeetCode or GFG, click Submit, wait for the accepted verdict — that's it. Check your GitHub repo; the commit will already be there.

---

## What ends up in your repo

```
leetcode-solutions/
├── .sync-meta/
│   └── stats.json          ← internal stats, do not edit manually
├── two-sum/
│   ├── Solution.py
│   └── README.md           ← formatted problem statement
├── longest-palindrome/
│   ├── Solution.py
│   └── README.md
└── README.md               ← auto-generated index table, updated on every solve
```

The root `README.md` looks like this:

| # | Problem | Difficulty | Language |
|---|---|---|---|
| 1 | Longest Palindrome | Easy | python3 |
| 2 | Two Sum | Easy | python3 |

---

## Privacy and security

SolveVault was built specifically to fix the privacy problem with tools like LeetHub v2, which require authorizing a third-party GitHub OAuth App — meaning the original developer's server sits in the token exchange path and could theoretically intercept credentials or log submissions.

SolveVault eliminates that entirely:

- **No OAuth App.** You generate the token yourself on GitHub's own settings page.
- **No relay server.** The extension talks directly from your browser to `api.github.com` over HTTPS.
- **No backend.** There is no server to host, compromise, or trust.
- **Fine-grained token.** GitHub scopes it to only the two repos you chose, with only Contents permission. Even in the worst case, it cannot touch anything else on your account.
- **No local storage of code.** Your solution is held in a JS variable for the milliseconds it takes to push, then discarded. Nothing is written to disk except your GitHub repo.

You can verify all of this by reading the source — every network call the extension makes is in `background.js`, and it contacts exactly three domains: `api.github.com`, `leetcode.com`, and `geeksforgeeks.org`.

---

## What NOT to do

- **Never commit your token** into any file in this repo. It lives in browser storage only.
- **Don't widen `host_permissions`** in `manifest.json` beyond the three domains already listed — every extra host is extra attack surface.
- **Don't add analytics, telemetry, or an update-check ping** to any server. If you fork this and add a backend for any reason, you've reintroduced the exact trust problem this project exists to solve.
- **Don't use a classic OAuth App** if you add a nicer login flow later — always use fine-grained PATs or GitHub Apps with explicitly scoped repo permissions.

---

## Notes on GFG

GFG's frontend markup changes more often than LeetCode's since there's no stable public API to depend on. The detection relies on watching for the "Problem Solved Successfully" banner via `MutationObserver`. If it ever silently stops working after a GFG redesign, see the comments at the top of `content-scripts/gfg-main.js` for exactly what to re-verify in DevTools (typically: the success text, the editor type, and the difficulty selector).

---

## Token rotation

Your fine-grained PAT expires on whatever schedule you chose (90 days recommended). When it expires:

1. Go to **github.com/settings/personal-access-tokens**
2. Delete the old token
3. Generate a new one with the same settings
4. Open the SolveVault options page and paste the new token → Save

Nothing in your repos is affected — the token only controls write access, not repo contents.

---

## License

MIT — see `LICENSE`. Use it, fork it, publish it.

If you publish your own build or fork, keep the trust model intact: no server in the middle, no OAuth App you don't control, no telemetry. The whole point is that users never have to trust anyone but GitHub itself.
