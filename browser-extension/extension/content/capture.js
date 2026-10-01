// The capture engine: counts, sends, nudges. Site-agnostic; adapters.js
// answers everything page-specific.
//
// Behavior, matching docs/PLAN-LOCAL-AND-CLOUD.md:
//   every ~4,000 new tokens  -> silently send the FULL conversation text to
//                               the local capture server (server diffs; full
//                               text makes retries and re-renders harmless)
//   at ~25,000 total tokens  -> banner offering a fresh chat, shown only
//                               after the server has confirmed capture
//   fresh start              -> open the site's new-chat page and PREFILL a
//                               primer. Never auto-send. The user presses
//                               Enter, always.
//
// No em dashes in this file, per project rule.

(function () {
  'use strict';
  if (window.top !== window) return;                 // top frame only
  const A = window.__daidocs && window.__daidocs.detect();
  if (!A) return;

  // Per-site toggle from the options page. Default on; a change applies live.
  // Also gated on consent: no capture until the user accepted the consent page.
  let siteEnabled = false;
  let consentOk = false;
  function refreshEnabled(s) {
    consentOk = !!s.consentAccepted;
    siteEnabled = consentOk && (s.chatToggles || {})[A.site] !== false;
  }
  chrome.storage.sync.get({ chatToggles: {}, consentAccepted: false }, refreshEnabled);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.chatToggles || changes.consentAccepted) {
      chrome.storage.sync.get({ chatToggles: {}, consentAccepted: false }, refreshEnabled);
    }
  });

  const SEND_EVERY_TOKENS = 4000;   // bulk trigger for long, actively growing chats
  const BANNER_AT_TOKENS = 25000;
  const CHECK_MS = 10000;
  const FIRST_SAVE_CHARS = 200;     // save a new chat as soon as it has real content
  const IDLE_SAVE_MS = 12000;       // and whenever it has been idle this long with unsent text
  const estTokens = s => Math.ceil((s || '').length / 4);

  let lastSentLen = 0;        // per conversation, reloaded on conversation change
  let lastConvId = null;
  let bannerShown = false;
  let serverDown = false;
  let lastLen = 0;            // last observed text length, to detect idle
  let lastChangeAt = 0;       // when the text last changed
  let intervalId = null;      // the tick interval, cleared if the context dies

  const stateKey = convId => `cap_${A.site}_${convId}`;

  function loadState(convId, cb) {
    chrome.storage.local.get(stateKey(convId), r => cb(r[stateKey(convId)] || { sentLen: 0 }));
  }
  function saveState(convId, st) {
    chrome.storage.local.set({ [stateKey(convId)]: st });
  }

  function setBadge(unsavedTokens) {
    const label = serverDown ? '!' : unsavedTokens >= 1000 ? Math.round(unsavedTokens / 1000) + 'k' : '';
    chrome.runtime.sendMessage({ type: 'badge', text: label }).catch(() => {});
  }

  // Announce state to the shared pill (pill.js).
  function pillState(state) {
    window.dispatchEvent(new CustomEvent('daidocs:state', { detail: { state } }));
  }

  // ------------------------------------------------------------- capture ----

  // Fallback id when the site does not put a conversation id in the URL
  // (temporary chats, changed URL schemes): derive a stable id from the first
  // part of the conversation text, but ONLY when there is a real labelled
  // conversation on the page, so we never capture a home/settings page.
  function hash8(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(16); }

  // True while this content script's extension context is still valid. After the
  // extension is reloaded/updated, the old orphaned script's chrome.* calls throw
  // "Extension context invalidated"; when that happens we stop cleanly instead of
  // throwing on every tick. A page refresh loads a fresh, valid script.
  function contextAlive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } }
  let stopped = false;
  function stopAll() {
    stopped = true;
    try { clearInterval(intervalId); } catch (_) {}
    try { observer.disconnect(); } catch (_) {}
  }

  function tick() {
    if (stopped) return;
    if (!contextAlive()) { stopAll(); return; }
    if (!siteEnabled) { setBadge(0); pillState('off'); return; }
    let convId = A.conversationId();
    if (!convId) {
      // No id in the URL. If the page still shows a real conversation (labelled
      // user/assistant turns), capture it under a text-derived id. Otherwise it
      // is a home/settings page: clear the badge and wait.
      const t = A.getText();
      // Capture when there are labelled turns, OR when there is a substantial
      // amount of conversation text (a real chat, well past a greeting screen)
      // even if per-turn roles could not be recovered.
      const labelled = t && /\[USER\]:/.test(t) && /\[ASSISTANT\]:/.test(t);
      if (t && (labelled || t.length >= 700)) {
        convId = 'live_' + hash8(t.slice(0, 400));
      } else {
        chrome.runtime.sendMessage({ type: 'badge', text: '' }).catch(() => {});
        maybePrefillPrimer();
        return;
      }
    }

    if (convId !== lastConvId) {
      lastConvId = convId;
      bannerShown = false;
      loadState(convId, st => { lastSentLen = st.sentLen || 0; });
      return; // state loads async; next tick works with it
    }

    const text = A.getText();
    if (!text) return;

    const unsent = text.length - lastSentLen;
    setBadge(estTokens(unsent));

    // A downed server shows "!" and the error pill, but recovery must not wait
    // for the next 4k tokens: probe /health each tick and clear when it is back.
    if (serverDown) {
      chrome.runtime.sendMessage({ type: 'get', path: '/health' }).then(r => {
        if (r && r.ok) { serverDown = false; setBadge(estTokens(unsent)); pillState('idle'); }
      }).catch(() => {});
    }

    // Track idle: note when the text last changed.
    const now = Date.now();
    if (text.length !== lastLen) { lastLen = text.length; lastChangeAt = now; }

    pillState(serverDown ? 'error' : 'idle');

    // Write straight away: whenever there is any new text, save it. The tick is
    // debounced by the MutationObserver (about 2.5s), so during a streaming
    // reply this fires right after each settle rather than every keystroke, and
    // the server overwrites idempotently, so frequent sends are cheap. The 4k
    // threshold is no longer a gate on saving, only the fresh-chat banner below.
    if (unsent > 0 && !serverDown) { pillState('saving'); send(convId, text, false); }

    if (estTokens(text) >= BANNER_AT_TOKENS && !bannerShown) {
      // Capture first, banner second: never suggest leaving an uncaptured chat.
      send(convId, text, true);
    }
  }

  function send(convId, text, thenBanner) {
    chrome.runtime.sendMessage({
      type: 'capture',
      payload: {
        site: A.site,
        conversationId: convId,
        title: document.title.slice(0, 200),
        url: location.href,
        text,
      },
    }).then(resp => {
      if (!resp || !resp.ok) { serverDown = true; setBadge(0); pillState('error'); return; }
      serverDown = false;
      lastSentLen = text.length;
      saveState(convId, { sentLen: text.length, at: Date.now() });
      setBadge(0);
      pillState('saved');
      if (thenBanner && !bannerShown) { bannerShown = true; showBanner(estTokens(text)); }
    }).catch(() => { serverDown = true; setBadge(0); pillState('error'); });
  }

  // -------------------------------------------------------------- banner ----

  function showBanner(totalTokens) {
    if (document.getElementById('daidocs-banner')) return;
    if (sessionStorage.getItem('daidocs_banner_dismissed_' + lastConvId)) return;

    const bar = document.createElement('div');
    bar.id = 'daidocs-banner';
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'background:#1a1a2e', 'color:#eaeaea', 'font:13px/1.4 system-ui,sans-serif',
      'padding:10px 16px', 'display:flex', 'align-items:center', 'gap:12px',
      'box-shadow:0 2px 8px rgba(0,0,0,.35)',
    ].join(';');

    const msg = document.createElement('span');
    msg.style.flex = '1';
    msg.textContent = `This chat is ~${Math.round(totalTokens / 1000)}k tokens and is captured in your DaiDocs memory. `
      + 'Long chats burn your usage limit faster and slow replies down.';

    const fresh = document.createElement('button');
    fresh.textContent = 'Start a fresh chat';
    fresh.style.cssText = 'background:#4f7cff;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit';
    fresh.onclick = () => {
      chrome.storage.local.set({
        daidocs_primer: {
          site: A.site,
          at: Date.now(),
          text: 'Continuing earlier work (the previous chat is saved in my DaiDocs memory). '
            + 'Context: ' + document.title.slice(0, 120),
        },
      }, () => { location.href = A.newChatUrl; });
    };

    const keep = document.createElement('button');
    keep.textContent = 'Keep going';
    keep.style.cssText = 'background:transparent;color:#aaa;border:1px solid #555;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit';
    keep.onclick = () => {
      sessionStorage.setItem('daidocs_banner_dismissed_' + lastConvId, '1');
      bar.remove();
    };

    bar.append(msg, fresh, keep);
    document.body.appendChild(bar);
  }

  // ----------------------------------------------------- fresh-start flow ----

  // On a fresh page (no conversation id), check for a primer left by the
  // banner click. Under 60 seconds old and same site: prefill it. Insert only.
  function maybePrefillPrimer() {
    chrome.storage.local.get('daidocs_primer', r => {
      const p = r.daidocs_primer;
      if (!p || p.site !== A.site || Date.now() - p.at > 60000) return;
      const el = A.composer();
      if (!el) return;
      chrome.storage.local.remove('daidocs_primer');
      window.__daidocs.prefill(el, p.text);
    });
  }

  // ---------------------------------------------------------------- wiring --

  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(tick, 2500);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  intervalId = setInterval(tick, CHECK_MS);
  setTimeout(tick, 3000);

  // Last-chance capture when the tab closes or navigates away: whatever is
  // unsent goes now. sendMessage from pagehide usually survives; when it does
  // not, the next visit to the conversation re-sends the full text anyway.
  function flushNow() {
    if (!siteEnabled) return;
    const text = A.getText();
    if (!text) return;
    let convId = A.conversationId();
    if (!convId) {
      const labelled = /\[USER\]:/.test(text) && /\[ASSISTANT\]:/.test(text);
      if (labelled || text.length >= 700) {
        convId = 'live_' + hash8(text.slice(0, 400));
      } else return;
    }
    if (text.length > lastSentLen) send(convId, text, false);
  }
  window.addEventListener('pagehide', flushNow);
  // Also flush when the tab is hidden (switching tabs), so a chat is captured
  // even if the tab is never fully closed.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
})();
