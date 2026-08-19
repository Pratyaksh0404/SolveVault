// content-scripts/leetcode-main.js  (runs in the PAGE's own JS context — "world": "MAIN")
//
// LeetCode's submission flow goes through XMLHttpRequest calls to /graphql/,
// not fetch() and not the old REST-style /submit/ + /check/ endpoints. This
// hooks XHR and watches specifically for the "submissionDetails" query,
// which fires once with the full verdict + code + language in one response.

(() => {
  if (window.__privateSyncHooked) return;
  window.__privateSyncHooked = true;
  console.log('[private-sync] hook installed on', location.href);

  const seen = new Set(); // avoid re-pushing if you revisit an old submission page

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__psUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__psUrl || '';
    if (!url.includes('/graphql')) return origSend.call(this, body);

    let opName = null;
    try { opName = JSON.parse(body || '{}').operationName; } catch (e) {}

    if (opName === 'submissionDetails') {
      this.addEventListener('load', () => {
        try {
          const blob = this.response; // responseType is 'blob' here — can't use responseText
          blob.text().then(text => {
            const data = JSON.parse(text);
            const d = data?.data?.submissionDetails;
            if (!d) return;

            console.log('[private-sync] submissionDetails verdict:', d.statusCode, d.question?.titleSlug);

            if (d.statusCode !== 10) return; // 10 = Accepted on LeetCode

            const subId = JSON.parse(body).variables.submissionId;
            if (seen.has(subId)) return;
            seen.add(subId);

            window.postMessage({
              type: 'PRIVATE_SYNC_SUCCESS',
              platform: 'leetcode',
              slug: d.question?.titleSlug,
              code: d.code,
              lang: d.lang?.name
            }, '*');
          }).catch(() => {});
        } catch (e) {}
      });
    }

    return origSend.call(this, body);
  };
})();