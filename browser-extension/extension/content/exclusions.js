// Sensitive-site exclusion list, shared by the capture script and the pill UI.
// A host on this list is NEVER captured, even when "all websites" is on and even
// if the user toggles the site. Loaded before browse.js and pill.js.
//
// Two layers: a built-in default set (banking, payments, webmail, health,
// government, password managers) matched by keyword or exact host, plus a
// user-editable list in chrome.storage.sync ('excludedHosts'). The capture
// server enforces the same defaults independently, so a bug here cannot leak a
// sensitive page into the store.
//
// No em dashes in this file, per project rule.

(function () {
  'use strict';

  // Keyword fragments: if the hostname contains one, it is excluded. Broad on
  // purpose; capturing one fewer site is the safe failure.
  const KEYWORDS = [
    'bank', 'paypal', 'stripe', 'venmo', 'wise', 'revolut', 'coinbase', 'binance',
    'wellsfargo', 'chase', 'citi', 'hsbc', 'barclays', 'santander', 'amex',
    'americanexpress', 'capitalone', 'schwab', 'fidelity', 'vanguard',
    'health', 'mychart', 'patient', 'medical', 'clinic', 'insurance', 'nhs',
    'webmail', 'login', 'signin', 'account', 'wallet', 'crypto',
  ];

  // Exact hosts (after stripping a leading www.).
  const EXACT = new Set([
    'mail.google.com', 'outlook.office.com', 'outlook.live.com', 'mail.yahoo.com',
    'mail.proton.me', 'proton.me', 'icloud.com', 'mail.aol.com',
    'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com',
    '1password.com', 'my.1password.com', 'bitwarden.com', 'vault.bitwarden.com',
    'lastpass.com', 'dashlane.com', 'keepersecurity.com',
    'gov.uk', 'irs.gov', 'ssa.gov', 'login.gov', 'id.me',
  ]);

  function isDefaultExcluded(host) {
    if (!host) return false;
    const h = host.replace(/^www\./, '').toLowerCase();
    if (EXACT.has(h)) return true;
    for (const k of KEYWORDS) if (h.includes(k)) return true;
    return false;
  }

  // Combined check including the user's custom list. Async because the custom
  // list lives in storage; a sync default check is exposed too for fast paths.
  function isExcluded(host, cb) {
    if (isDefaultExcluded(host)) { cb(true, 'default'); return; }
    chrome.storage.sync.get({ excludedHosts: [] }, s => {
      const h = (host || '').replace(/^www\./, '').toLowerCase();
      cb(s.excludedHosts.map(x => x.toLowerCase()).includes(h), s.excludedHosts.includes(h) ? 'user' : null);
    });
  }

  window.__daidocsExclusions = { isDefaultExcluded, isExcluded, KEYWORDS, EXACT };
})();
