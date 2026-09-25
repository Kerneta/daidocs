// Service worker: the only part of the extension that talks to the network.
// Content scripts message here; this fetches the local capture server. Host
// permission for 127.0.0.1 lets this fetch skip CORS entirely, and keeping
// network access out of content scripts keeps the page's CSP out of play.
//
// Also owns dynamic registration: when "all websites" (or a specific site)
// is toggled on in options, content/browse.js is registered for those hosts
// at runtime via chrome.scripting. Static matches stay minimal on purpose.
//
// No em dashes in this file, per project rule.

const DEFAULTS = { port: 41100, token: '', encrypt: false, allWebsites: true, browseToggles: {} };

function settings() {
  return new Promise(res => chrome.storage.sync.get(DEFAULTS, res));
}

async function post(pathName, payload) {
  const s = await settings();
  const headers = { 'Content-Type': 'application/json' };
  if (s.token) headers.Authorization = 'Bearer ' + s.token;
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}${pathName}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function getJson(pathName) {
  const s = await settings();
  const headers = {};
  if (s.token) headers.Authorization = 'Bearer ' + s.token;
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}${pathName}`, { headers });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ------------------------------------------- dynamic browse registration ----

const DYN_ID = 'daidocs-browse-dyn';
const CHAT_HOSTS = ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com'];
// Every host that already has a static content_scripts entry in manifest.json.
// The dynamic <all_urls> registration must exclude all of them, subdomains
// included, or these sites get the content scripts injected twice.
const STATIC_BROWSE = [
  'x.com', 'twitter.com', 'mobile.twitter.com',
  'youtube.com', 'linkedin.com', 'instagram.com',
  'reddit.com', 'tiktok.com', 'threads.net', 'threads.com',
];

async function syncDynamicScripts() {
  const s = await settings();
  const wanted = [];
  if (s.allWebsites) {
    wanted.push('<all_urls>');
  } else {
    for (const k of Object.keys(s.browseToggles || {})) {
      if (k.startsWith('web:') && s.browseToggles[k]) wanted.push(`*://${k.slice(4)}/*`);
    }
  }
  try { await chrome.scripting.unregisterContentScripts({ ids: [DYN_ID] }); } catch (_) {}
  if (!wanted.length) return;
  const granted = await chrome.permissions.contains(
    s.allWebsites ? { origins: ['<all_urls>'] } : { origins: wanted }
  );
  if (!granted) return;   // options page requests the permission; until then, nothing runs
  // Both the bare host and any subdomain, so www./m. variants are excluded too.
  const exclude = CHAT_HOSTS.concat(STATIC_BROWSE)
    .flatMap(h => [`*://${h}/*`, `*://*.${h}/*`]);
  await chrome.scripting.registerContentScripts([{
    id: DYN_ID,
    matches: wanted,
    excludeMatches: exclude,
    js: ['content/exclusions.js', 'content/browse.js', 'content/pill.js'],
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }]);
}

chrome.runtime.onInstalled.addListener(syncDynamicScripts);
chrome.runtime.onStartup.addListener(syncDynamicScripts);

// On first install, open the consent page. Capture stays off until the user
// accepts there (the content scripts gate on consentAccepted).
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    chrome.storage.sync.get({ consentAccepted: false }, s => {
      if (!s.consentAccepted) chrome.tabs.create({ url: chrome.runtime.getURL('consent.html') });
    });
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.allWebsites || changes.browseToggles)) syncDynamicScripts();
});

// ----------------------------------------------------------- message hub ----

// Encryption self-heal: only encrypt if the setting is on AND a vault actually
// exists in the current store. If encryption is on but there is no vault, fall
// back to plaintext and turn the setting off, so capture can never get stuck in
// the "encryption on, no vault" state.
async function shouldEncrypt(s) {
  if (!s.encrypt) return false;
  const st = await getJson('/vault/status');
  if (st && st.ok && st.initialized) return true;
  chrome.storage.sync.set({ encrypt: false });   // heal the stuck setting
  return false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'capture') {
    settings().then(async s => post('/capture', (await shouldEncrypt(s)) ? { ...msg.payload, vault: true } : msg.payload)).then(sendResponse);
    return true; // async response
  }
  if (msg && msg.type === 'browse_capture') {
    settings().then(async s => post('/browse', (await shouldEncrypt(s)) ? { ...msg.payload, vault: true } : msg.payload)).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'vault_status') {
    getJson('/vault/status').then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'perm_all_urls') {
    // Content scripts cannot read chrome.permissions, so the pill asks here.
    chrome.permissions.contains({ origins: ['<all_urls>'] }, granted => sendResponse({ ok: true, granted }));
    return true;
  }
  if (msg && msg.type === 'open_options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'open_viewer') {
    settings().then(s => chrome.tabs.create({ url: `http://127.0.0.1:${s.port}/viewer` }));
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'open_consent') {
    chrome.tabs.create({ url: chrome.runtime.getURL('consent.html') });
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'launch_server') {
    // The only way an extension may start a local program is a registered
    // native-messaging host. If it is not installed, report needsSetup so the
    // UI can point the user at the double-click launcher instead.
    try {
      if (!chrome.runtime.sendNativeMessage) { sendResponse({ ok: false, needsSetup: true }); return false; }
      chrome.runtime.sendNativeMessage('com.daidocs.launcher', { action: 'start' }, resp => {
        if (chrome.runtime.lastError) { sendResponse({ ok: false, needsSetup: true }); return; }
        // Give the server a moment, then confirm via health.
        setTimeout(() => getJson('/health').then(h => sendResponse({ ok: !!(h && h.ok), resp })), 1500);
      });
    } catch (e) {
      sendResponse({ ok: false, needsSetup: true });
    }
    return true;
  }
  if (msg && msg.type === 'open_dashboard') {
    settings().then(s => chrome.tabs.create({ url: `http://127.0.0.1:${s.port}/dashboard` }));
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'get') {            // generic localhost GET (config, fs/list)
    getJson(msg.path).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'post') {           // generic localhost POST (config/store, fs/mkdir, vault/*)
    post(msg.path, msg.body || {}).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'badge') {
    chrome.action.setBadgeBackgroundColor({ color: msg.text === '!' ? '#c0392b' : '#4f7cff' });
    chrome.action.setBadgeText({ text: msg.text || '', tabId: sender.tab && sender.tab.id });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
