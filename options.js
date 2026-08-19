const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await chrome.storage.local.get(['token', 'leetcodeRepo', 'gfgRepo']);
  $('token').value = cfg.token || '';
  $('lcRepo').value = cfg.leetcodeRepo || '';
  $('gfgRepo').value = cfg.gfgRepo || '';
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    token: $('token').value.trim(),
    leetcodeRepo: $('lcRepo').value.trim(),
    gfgRepo: $('gfgRepo').value.trim()
  });
  $('status').textContent = 'Saved locally ✓';
  setTimeout(() => { $('status').textContent = ''; }, 2000);
});

load();
