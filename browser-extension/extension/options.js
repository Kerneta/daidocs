// Options page logic. Kept in its own file because MV3 CSP forbids inline
// scripts on extension pages.
//
// No em dashes in this file, per project rule.

const DEFAULTS = {
  port: 41100, token: '',
  chatToggles: { chatgpt: true, claude: true, gemini: true },
  browseToggles: {},            // { x: bool, 'web:<host>': bool }
  allWebsites: true,
  showPill: true,
  encrypt: false,
};

const $ = id => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, s => {
  $('port').value = s.port;
  $('token').value = s.token;
  $('t_chatgpt').checked = s.chatToggles.chatgpt !== false;
  $('t_claude').checked = s.chatToggles.claude !== false;
  $('t_gemini').checked = s.chatToggles.gemini !== false;
  $('t_x').checked = !!s.browseToggles.x;
  $('t_all').checked = !!s.allWebsites;
  $('t_pill').checked = s.showPill !== false;
  $('t_encchats').checked = !!s.encrypt;
});

// "All websites" needs the <all_urls> host permission; ask on the click
// itself (a user gesture), and only keep the box checked if it was granted.
$('t_all').addEventListener('change', async e => {
  if (!e.target.checked) return;
  const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
  if (!granted) e.target.checked = false;
});

// Vault status via the background worker (which talks to the local server).
chrome.runtime.sendMessage({ type: 'vault_status' }).then(v => {
  const el = $('vaultstate');
  if (!v || !v.ok) { el.textContent = 'Capture server not reachable. Start it with: npm run capture'; return; }
  if (!v.initialized) { el.textContent = 'Vault not set up yet. Run: node vault.mjs init --password <your password>'; return; }
  const parts = Object.entries(v.folders || {}).map(([k, f]) => `${k}: ${f.entries}`);
  el.textContent = 'Vault ready. Encrypted entries: ' + (parts.join(' | ') || 'none yet')
    + (v.unlocked ? '  (currently UNLOCKED: run node vault.mjs lock)' : '');
}).catch(() => { $('vaultstate').textContent = 'Capture server not reachable.'; });

$('save').addEventListener('click', () => {
  const s = {
    port: parseInt($('port').value, 10) || DEFAULTS.port,
    token: $('token').value.trim(),
    chatToggles: {
      chatgpt: $('t_chatgpt').checked,
      claude: $('t_claude').checked,
      gemini: $('t_gemini').checked,
    },
    allWebsites: $('t_all').checked,
    showPill: $('t_pill').checked,
    encrypt: $("t_encchats").checked,
  };
  chrome.storage.sync.get({ browseToggles: {} }, cur => {
    const bt = cur.browseToggles || {};
    bt.x = $('t_x').checked;
    s.browseToggles = bt;               // per-host web: entries are kept as set from the pill
    chrome.storage.sync.set(s, () => {
      const el = $('status');
      el.textContent = 'Saved';
      setTimeout(() => { el.textContent = ''; }, 1500);
    });
  });
});
