// Browse capture: X timeline tweets and (opt-in) generic web pages.
// Separate from chat capture on purpose: different data, different folder,
// different rules. Everything captured here is sent with vault: true and the
// server stores it ENCRYPTED in the vault, never mixed with chat history.
//
// The pill: a small fixed indicator top-right of the page.
//   SAVING  blue, pulsing dot, "Saving to memory"
//   SAVED   green flash after a batch lands
//   OFF     grey, "Not saving"
// Clicking the pill toggles capture for this site. No silent capture: if the
// pill is not visible (user hid it in options), capture still only runs where
// a toggle is ON.
//
// No em dashes in this file, per project rule.

(function () {
  'use strict';
  if (window.top !== window) return;

  const HOST = location.hostname.replace(/^www\./, '');
  const IS_X = HOST === 'x.com' || HOST === 'twitter.com' || HOST === 'mobile.twitter.com';
  const SITE_KEY = IS_X ? 'x' : 'web:' + HOST;
  const SOCIAL_HOSTS = ['x.com', 'twitter.com', 'mobile.twitter.com', 'youtube.com', 'm.youtube.com',
    'linkedin.com', 'instagram.com', 'reddit.com', 'tiktok.com', 'threads.net', 'threads.com'];
  const IS_SOCIAL = SOCIAL_HOSTS.some(h => HOST === h || HOST.endsWith('.' + h));

  const DWELL_MS = IS_SOCIAL ? 1000 : 3000;   // on screen this long = actually seen
  const FLUSH_MS = 5000;
  const FLUSH_AT = 20;                    // entries per batch
  const MAX_PAGE_CHARS = 20000;

  let enabled = false;
  let perSiteStore = null;   // optional per-site store folder override

  // ------------------------------------------------------------- settings ----

  // Sensitive sites are never captured, whatever the toggles say.
  const EXCL = window.__daidocsExclusions;
  let excludedDefault = EXCL ? EXCL.isDefaultExcluded(HOST) : false;
  let excludedUser = false;

  function readSettings(cb) {
    chrome.storage.sync.get({ browseToggles: {}, allWebsites: false, excludedHosts: [], siteSettings: {}, consentAccepted: false }, s => {
      // No capture until the user has accepted the consent gate.
      if (!s.consentAccepted) { enabled = false; cb && cb(); return; }
      excludedUser = (s.excludedHosts || []).map(x => x.toLowerCase()).includes(HOST.toLowerCase());
      if (excludedDefault || excludedUser) { enabled = false; cb && cb(); return; }
      // A saved per-site setting (from "Manage websites") wins over everything.
      const ss = (s.siteSettings || {})[HOST];
      if (ss) {
        enabled = ss.capture !== false;
        perSiteStore = ss.store || null;
      } else if (IS_X) {
        enabled = !!s.browseToggles.x; perSiteStore = null;
      } else {
        const t = s.browseToggles[SITE_KEY];
        enabled = t !== undefined ? !!t : !!s.allWebsites;
        perSiteStore = null;
      }
      cb && cb();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.browseToggles || changes.allWebsites || changes.excludedHosts || changes.siteSettings) {
      readSettings(() => renderPill((excludedDefault || excludedUser) ? 'off' : (enabled ? 'idle' : 'off')));
    }
  });

  // ----------------------------------------------------------------- pill ----
  // The shared pill.js owns the on-page indicator and settings; this just
  // announces capture state to it via a CustomEvent.
  function renderPill(state, msg) {
    window.dispatchEvent(new CustomEvent('daidocs:state', { detail: { state, msg } }));
  }

  // -------------------------------------------------------------- privacy ----
  // Hard rule: capture only what is DISPLAYED on the page, never what the user
  // is typing or entering. So we exclude every editable and form control from
  // the extracted text, skip capture entirely while the user is typing in one,
  // and scrub high-risk personal numbers before anything leaves the page.

  function isEditableOrControl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION'
        || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
    if (el.isContentEditable) return true;                 // drafts, compose boxes
    const role = el.getAttribute && el.getAttribute('role');
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
    return false;
  }

  // Chrome/boilerplate to skip on generic pages so captures read as content, not
  // navigation. Excludes nav bars, headers, footers, sidebars and search UI.
  function isBoilerplate(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE') return true;
    const role = el.getAttribute && el.getAttribute('role');
    if (role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'complementary' || role === 'search') return true;
    return false;
  }

  // True while the user is focused in any editable field: do not capture then,
  // so a half-typed message or form is never snapshotted.
  function isTypingNow() {
    const a = document.activeElement;
    if (!a) return false;
    if (isEditableOrControl(a)) return true;
    for (let p = a; p; p = p.parentElement) if (p.isContentEditable) return true;
    return false;
  }

  // Displayed text only: walk text nodes, rejecting any inside an editable or
  // form control (innerText already omits input/textarea values, but not
  // contenteditable, which is exactly where typed drafts live).
  function displayedText(root, skipBoilerplate) {
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        for (let p = node.parentElement; p; p = p.parentElement) {
          if (isEditableOrControl(p)) return NodeFilter.FILTER_REJECT;
          if (skipBoilerplate && isBoilerplate(p)) return NodeFilter.FILTER_REJECT;
          // Block-level parents get a newline so the capture keeps structure
          // instead of becoming one run-on line.
        }
        return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const parts = [];
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.trim();
      if (!t) continue;
      // Newline when the text node sits in a block element, space otherwise.
      const disp = n.parentElement && getComputedStyle(n.parentElement).display;
      const block = disp && !disp.startsWith('inline');
      parts.push((block && parts.length ? '\n' : '') + t);
    }
    return parts.join(' ').replace(/[ \t]+/g, ' ').replace(/ *\n *\n* */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Harvest visible links (anchor text + href) from a page so "give me the link
  // to X" works on ordinary sites, not just the per-item adapters.
  function harvestLinks(root, max) {
    const out = [];
    const seen = new Set();
    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!href || !/^https?:/.test(href) || seen.has(href)) continue;
      let inControl = false;
      for (let p = a.parentElement; p; p = p.parentElement) { if (isBoilerplate(p)) { inControl = true; break; } }
      if (inControl) continue;
      const label = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (label.length < 4) continue;
      seen.add(href);
      out.push(label.slice(0, 100) + ' -> ' + href);
      if (out.length >= (max || 40)) break;
    }
    return out;
  }

  // Light client-side scrub of high-risk personal numbers, as defence in depth
  // before text leaves the page (the server also redacts credentials). Kept
  // conservative to avoid eating ordinary numbers: card numbers are Luhn-checked.
  function luhnOk(digits) {
    let sum = 0, alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return sum % 10 === 0;
  }
  function scrub(text) {
    if (!text) return text;
    // Credit-card-like: 13 to 19 digits, optional spaces or dashes, Luhn valid.
    text = text.replace(/\b(?:\d[ -]?){13,19}\b/g, m => {
      const digits = m.replace(/[ -]/g, '');
      return (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) ? '[CARD REDACTED]' : m;
    });
    // US SSN in the classic dashed form.
    text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN REDACTED]');
    return text;
  }

  // ---------------------------------------------------------------- queue ----

  const queue = [];
  const seen = new Map();   // id -> captured text length (longest wins)

  function push(entry) {
    const prev = seen.get(entry.id);
    if (prev !== undefined && entry.text.length <= prev) return;
    seen.set(entry.id, entry.text.length);
    queue.push(entry);
    renderPill('saving');
    if (queue.length >= FLUSH_AT) flush();
  }

  // In Manifest V3 the background service worker sleeps, and the FIRST message
  // to a sleeping worker can reject before it wakes ("Could not establish
  // connection"). That is not a real outage, so retry a couple of times with a
  // short backoff before showing the offline state; the queue is preserved
  // throughout so nothing is lost.
  function sendBatch(batch, attempt) {
    chrome.runtime.sendMessage({
      type: 'browse_capture',
      payload: { kind: (PLATFORM && PLATFORM.key) || 'web', host: HOST, entries: batch, store: perSiteStore || undefined },
    }).then(resp => {
      if (resp && resp.ok) { renderPill('saved'); return; }
      // resp.ok false = server reached but refused (e.g. excluded host, or
      // encryption on with no vault). Surface the real reason, not "offline".
      queue.unshift(...batch);
      const reason = resp && resp.error;
      if (reason && /vault/i.test(reason)) renderPill(enabled ? 'error' : 'off', 'Encryption on, no vault set');
      else renderPill(enabled ? 'error' : 'off', reason ? 'Not saved: ' + reason.slice(0, 60) : null);
    }).catch(() => {
      // No response: likely the worker was asleep. Retry before erroring.
      if (attempt < 3) { setTimeout(() => sendBatch(batch, attempt + 1), 600 * attempt); return; }
      queue.unshift(...batch);
      renderPill(enabled ? 'error' : 'off');
    });
  }

  function flush() {
    if (!queue.length || !enabled) return;
    const batch = queue.splice(0, queue.length);
    sendBatch(batch, 1);
  }
  setInterval(flush, FLUSH_MS);
  window.addEventListener('pagehide', flush);

  // -------------------------------------------------- per-platform feeds ----
  // Every social platform is the same shape: a feed of item cards, each with its
  // own permalink. One generic watcher drives them all; each platform supplies a
  // CSS selector for its cards and an extract(el) that returns the entry (with
  // the real permalink) or null. Adding a platform is one registry entry.

  function watchFeed(selector, extract) {
    const dwell = new Map();
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const el = e.target;
          dwell.set(el, setTimeout(() => {
            if (!enabled || isTypingNow()) return;
            const item = extract(el);
            if (item && item.text) push(item);
          }, DWELL_MS));
        } else { clearTimeout(dwell.get(e.target)); dwell.delete(e.target); }
      }
    }, { threshold: 0.5 });
    const seenEls = new WeakSet();
    function scan() {
      for (const el of document.querySelectorAll(selector)) {
        if (seenEls.has(el)) continue;
        seenEls.add(el);
        io.observe(el);
        // Re-capture when a watched card mutates (e.g. "show more" expands it).
        new MutationObserver(() => {
          if (!enabled) return;
          const item = extract(el);
          if (item && item.text) push(item);
        }).observe(el, { childList: true, subtree: true, characterData: true });
      }
    }
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    scan();
  }

  function tweetEntry(article) {
    const timeEl = article.querySelector('time[datetime]');
    const linkEl = timeEl && timeEl.closest('a[href*="/status/"]');
    const href = linkEl ? linkEl.getAttribute('href') : null;
    const m = href && href.match(/\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const nameEl = article.querySelector('[data-testid="User-Name"]');
    return {
      id: m[2],
      handle: '@' + m[1],
      name: nameEl ? (nameEl.innerText || '').split('\n')[0].trim().slice(0, 80) : '',
      at: timeEl.getAttribute('datetime'),
      seenAt: new Date().toISOString(),
      url: 'https://x.com' + href,
      text: scrub(textEl ? (textEl.innerText || '').trim() : displayedText(article).slice(0, 2000)),
    };
  }

  // ---------------------------------------------------- generic web pages ----

  function pageEntry() {
    if (isTypingNow()) return null;   // never snapshot while the user is typing
    const mainEl = document.querySelector('main') || document.querySelector('article') || document.body;
    let text = scrub(displayedText(mainEl, true).slice(0, MAX_PAGE_CHARS));
    if (text.length < 200) return null;
    const links = harvestLinks(mainEl, 40);
    if (links.length) text += '\n\nLinks:\n' + links.join('\n');
    return {
      // The query string is part of the page identity: on YouTube every video
      // is /watch?v=..., so pathname alone collapses all videos into one entry.
      id: (location.origin + location.pathname + location.search).slice(0, 300),
      title: document.title.slice(0, 200),
      url: location.href.slice(0, 500),
      seenAt: new Date().toISOString(),
      text,
    };
  }

  function watchWeb() {
    let lastPath = null;
    function look() {
      if (!enabled) return;
      const key = location.origin + location.pathname + location.search;
      if (key === lastPath) {
        const p = pageEntry();       // longest wins on the same page (SPA growth)
        if (p) push(p);
        return;
      }
      lastPath = key;
      setTimeout(() => { const p = pageEntry(); if (p) push(p); }, DWELL_MS);
    }
    setInterval(look, 4000);
    setTimeout(look, DWELL_MS);
  }

  // Helper: first non-empty text from a list of selectors within el.
  function pick(el, sels, attr) {
    for (const s of sels) {
      const n = el.querySelector(s);
      if (n) { const v = attr ? n.getAttribute(attr) : (n.innerText || n.textContent || ''); if (v && v.trim()) return v.trim(); }
    }
    return '';
  }
  function absUrl(href, origin) {
    if (!href) return '';
    if (/^https?:/.test(href)) return href;
    return (origin || location.origin) + href;
  }

  function ytEntry(card) {
    const link = card.querySelector('a#video-title, a#video-title-link, a[href*="/watch?v="]');
    const href = link && link.getAttribute('href');
    const m = href && href.match(/[?&]v=([\w-]{6,})/);
    if (!m) return null;
    const titleEl = card.querySelector('#video-title, #video-title-link, yt-formatted-string#video-title');
    const title = titleEl ? (titleEl.getAttribute('title') || titleEl.textContent || '').trim() : (link.textContent || '').trim();
    if (!title) return null;
    const channel = pick(card, ['ytd-channel-name #text', '#channel-name #text', '#channel-name']);
    const metaTxt = pick(card, ['#metadata-line']).replace(/\s+/g, ' ');
    return { id: m[1], title: title.slice(0, 200), channel: channel.slice(0, 100),
      url: 'https://www.youtube.com/watch?v=' + m[1], seenAt: new Date().toISOString(),
      text: scrub([title, channel, metaTxt].filter(Boolean).join(' | ')) };
  }

  // LinkedIn: feed posts carry a data-urn like urn:li:activity:123; the permalink
  // is /feed/update/<urn>.
  function liEntry(post) {
    const urn = post.getAttribute('data-urn') || (post.querySelector('[data-urn*="urn:li:activity"]') || {}).getAttribute && post.querySelector('[data-urn*="urn:li:activity"]').getAttribute('data-urn');
    const m = urn && urn.match(/urn:li:activity:\d+/);
    if (!m) return null;
    const author = pick(post, ['.update-components-actor__name', '.update-components-actor__title span[aria-hidden="true"]']);
    const body = pick(post, ['.update-components-text', '.feed-shared-update-v2__description', '.feed-shared-text']);
    if (!body && !author) return null;
    return { id: m[0], name: author.slice(0, 100), url: 'https://www.linkedin.com/feed/update/' + m[0],
      seenAt: new Date().toISOString(), text: scrub([author, body].filter(Boolean).join(': ').slice(0, 3000)) };
  }

  // Instagram: each post is an <article> with a permalink to /p/<code> or /reel/<code>.
  function igEntry(article) {
    const a = article.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    const href = a && a.getAttribute('href');
    const m = href && href.match(/\/(p|reel)\/([\w-]+)/);
    if (!m) return null;
    const author = pick(article, ['header a[role="link"]', 'header a']);
    const caption = pick(article, ['h1', 'ul li span', '[data-testid="post-comment-root"] span']);
    return { id: m[2], name: author.slice(0, 80), url: 'https://www.instagram.com/' + m[1] + '/' + m[2] + '/',
      seenAt: new Date().toISOString(), text: scrub([author, caption].filter(Boolean).join(': ').slice(0, 2000) || author) };
  }

  // Reddit (new): <shreddit-post> carries permalink, author and post-title attrs.
  function redditEntry(post) {
    const permalink = post.getAttribute('permalink') || (post.querySelector('a[href*="/comments/"]') || {}).getAttribute && post.querySelector('a[href*="/comments/"]').getAttribute('href');
    if (!permalink) return null;
    const id = post.getAttribute('id') || permalink;
    const title = post.getAttribute('post-title') || pick(post, ['a[slot="title"]', '[slot="title"]', 'h3']);
    const author = post.getAttribute('author') || pick(post, ['a[href^="/user/"]']);
    const body = pick(post, ['[slot="text-body"]', '[data-post-click-location="text-body"]']);
    if (!title && !body) return null;
    return { id: String(id).slice(0, 120), name: author ? 'u/' + author : '', url: absUrl(permalink, 'https://www.reddit.com'),
      seenAt: new Date().toISOString(), text: scrub([title, body].filter(Boolean).join('\n').slice(0, 3000)) };
  }

  // TikTok: video items link to /@user/video/<id>.
  function tiktokEntry(item) {
    const a = item.querySelector('a[href*="/video/"]');
    const href = a && a.getAttribute('href');
    const m = href && href.match(/\/(@[\w.]+)\/video\/(\d+)/);
    if (!m) return null;
    const caption = pick(item, ['[data-e2e="video-desc"]', 'a[href*="/video/"] img']) || pick(item, ['[data-e2e="video-desc"]'], 'alt');
    return { id: m[2], handle: m[1], url: absUrl(href, 'https://www.tiktok.com'),
      seenAt: new Date().toISOString(), text: scrub([m[1], caption].filter(Boolean).join(': ') || m[1]) };
  }

  // Threads: posts link to /@user/post/<code>.
  function threadsEntry(el) {
    const a = el.querySelector('a[href*="/post/"]');
    const href = a && a.getAttribute('href');
    const m = href && href.match(/\/(@[\w.]+)\/post\/([\w-]+)/);
    if (!m) return null;
    const body = pick(el, ['[data-pressable-container] span', 'span']);
    return { id: m[2], handle: m[1], url: absUrl(href, 'https://www.threads.net'),
      seenAt: new Date().toISOString(), text: scrub([m[1], body].filter(Boolean).join(': ').slice(0, 2000)) };
  }

  // Comments. A stable-enough id from author+text so re-renders dedupe. X and
  // Threads replies are already captured by the post extractors (a reply is a
  // post with its own permalink), so only the platforms whose comments live in
  // distinct elements need a comment extractor.
  function hash8(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
  function commentEntry(author, text, url) {
    const t = (text || '').trim();
    if (t.length < 2) return null;
    return { id: 'c_' + hash8((author || '') + '|' + t.slice(0, 120)), name: author || '',
      url: url || location.href, seenAt: new Date().toISOString(), text: scrub('[comment] ' + (author ? author + ': ' : '') + t).slice(0, 2000) };
  }
  function ytCommentEntry(el) {
    return commentEntry(pick(el, ['#author-text', '#author-text span']), pick(el, ['#content-text']), location.href);
  }
  function redditCommentEntry(el) {
    const author = el.getAttribute('author') || pick(el, ['a[href^="/user/"]']);
    const permalink = el.getAttribute('permalink');
    return commentEntry(author ? 'u/' + author : '', pick(el, ['[slot="comment"]', '.md', 'p']), permalink ? absUrl(permalink, 'https://www.reddit.com') : location.href);
  }
  function liCommentEntry(el) {
    return commentEntry(pick(el, ['.comments-comment-meta__description-title', '.comments-post-meta__name-text']), pick(el, ['.comments-comment-item__main-content', '.update-components-text']), location.href);
  }

  // Platform registry: host match -> capture key + card selector + extractor,
  // and optionally a comments selector + extractor.
  const PLATFORMS = [
    { key: 'x', hosts: ['x.com', 'twitter.com', 'mobile.twitter.com'], sel: 'article[data-testid="tweet"], article', extract: tweetEntry },
    { key: 'youtube', hosts: ['youtube.com', 'm.youtube.com'], sel: 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer', extract: ytEntry,
      comments: { sel: 'ytd-comment-thread-renderer, ytd-comment-view-model', extract: ytCommentEntry } },
    { key: 'linkedin', hosts: ['linkedin.com'], sel: '.feed-shared-update-v2, [data-urn*="urn:li:activity"]', extract: liEntry,
      comments: { sel: '.comments-comment-entity, .comments-comment-item', extract: liCommentEntry } },
    { key: 'instagram', hosts: ['instagram.com'], sel: 'article', extract: igEntry },
    { key: 'reddit', hosts: ['reddit.com'], sel: 'shreddit-post, [data-testid="post-container"]', extract: redditEntry,
      comments: { sel: 'shreddit-comment', extract: redditCommentEntry } },
    { key: 'tiktok', hosts: ['tiktok.com'], sel: '[data-e2e="recommend-list-item-container"], [class*="DivItemContainer"]', extract: tiktokEntry },
    { key: 'threads', hosts: ['threads.net', 'threads.com'], sel: '[data-pressable-container="true"]', extract: threadsEntry },
  ];
  function platformFor(host) {
    const h = host.replace(/^www\./, '');
    return PLATFORMS.find(p => p.hosts.some(x => h === x || h.endsWith('.' + x)));
  }
  const PLATFORM = platformFor(HOST);

  // --------------------------------------------------------------- wiring ----

  readSettings(() => {
    renderPill(enabled ? 'idle' : 'off');
    if (PLATFORM) {
      watchFeed(PLATFORM.sel, PLATFORM.extract);
      if (PLATFORM.comments) watchFeed(PLATFORM.comments.sel, PLATFORM.comments.extract);
    } else {
      watchWeb();
    }
  });
})();
