// Shared on-page UI for every supported site (chat sites and browse sites):
// the status pill (top-left, bright green when on and saving) and a gear that
// opens a settings dropdown: capture on/off, encryption on/off with a password,
// and a storage-folder browser. The capture scripts (browse.js, capture.js) do
// the actual capturing and announce their state via window 'daidocs:state'
// CustomEvents; this file only renders and drives settings.
//
// Filesystem work happens in the local server (the extension cannot read the
// disk); this talks to it through the background worker: {type:'get'|'post'}.
//
// No em dashes in this file, per project rule.

(function () {
  'use strict';
  if (window.top !== window) return;
  if (window.__daidocsPill) return;               // once per page
  window.__daidocsPill = true;

  // --------------------------------------------------------- site identity ----
  function siteInfo() {
    const h = location.hostname.replace(/^www\./, '');
    if (h === 'chatgpt.com' || h === 'chat.openai.com') return { kind: 'chat', sub: 'chatgpt', label: 'ChatGPT' };
    if (h === 'claude.ai') return { kind: 'chat', sub: 'claude', label: 'Claude' };
    if (h === 'gemini.google.com') return { kind: 'chat', sub: 'gemini', label: 'Gemini' };
    if (h === 'x.com' || h === 'twitter.com' || h === 'mobile.twitter.com') return { kind: 'x', sub: 'x', label: 'X' };
    return { kind: 'web', sub: 'web:' + h, label: h };
  }
  const SITE = siteInfo();

  let consentAccepted = true;
  function readEnabled(cb) {
    chrome.storage.sync.get({ chatToggles: {}, browseToggles: {}, allWebsites: false, excludedHosts: [], consentAccepted: false }, s => {
      consentAccepted = !!s.consentAccepted;
      if (!consentAccepted) { cb(false); return; }
      // Sensitive sites (default list or user list) are never captured. Chat
      // sites are exempt from the browse exclusion list by design.
      const EXCL = window.__daidocsExclusions;
      const host = location.hostname.replace(/^www\./, '').toLowerCase();
      const excluded = SITE.kind !== 'chat' && (
        (EXCL && EXCL.isDefaultExcluded(location.hostname)) ||
        (s.excludedHosts || []).map(x => x.toLowerCase()).includes(host));
      if (excluded) { cb(false); return; }
      let on;
      if (SITE.kind === 'chat') on = s.chatToggles[SITE.sub] !== false;          // default on
      else if (SITE.kind === 'x') on = !!s.browseToggles.x;                       // default off
      else {
        // The site's own toggle always wins; allWebsites is only the default
        // for sites the user has never toggled.
        const t = s.browseToggles[SITE.sub];
        on = t !== undefined ? !!t : !!s.allWebsites;
      }
      cb(on);
    });
  }
  function writeEnabled(on) {
    if (SITE.kind === 'chat') {
      chrome.storage.sync.get({ chatToggles: {} }, s => {
        const t = s.chatToggles; t[SITE.sub] = on; chrome.storage.sync.set({ chatToggles: t });
      });
    } else {
      chrome.storage.sync.get({ browseToggles: {} }, s => {
        const t = s.browseToggles; t[SITE.sub] = on; chrome.storage.sync.set({ browseToggles: t });
      });
    }
  }

  // ------------------------------------------------------------- messaging ----
  const bg = (type, extra) => chrome.runtime.sendMessage(Object.assign({ type }, extra || {})).catch(() => ({ ok: false }));

  // ------------------------------------------------------------------ pill ----
  // 2030 Kerneta look: a glassy teal capsule with a living "memory creature"
  // that wriggles while saving and curls up asleep when capture is off.
  // Palette from the Kerneta mark: accent #2fe0a8, deep grounds #06303d/#021a22.
  let enabled = false;
  let pill, face, label, panel, savedTimer, lastState = 'off';
  const CREATURES = ['🐛', '🐛', '🐌', '🐞', '🦎', '🐝', '🐙', '🐱', '🦊'];
  let indicator = { style: 'creature', creature: '🐛' };   // worm by default
  chrome.storage.sync.get({ indicator: null }, s => { if (s.indicator) { indicator = s.indicator; if (pill) { rebuildFace(); render(lastState); } } });

  function css(el, s) { el.style.cssText = s; }

  function ensureStyle() {
    if (document.getElementById('daidocs-css')) return;
    const style = document.createElement('style');
    style.id = 'daidocs-css';
    style.textContent =
      '@keyframes daidocs-pulse{0%{opacity:1}50%{opacity:.35}100%{opacity:1}}'
      + '@keyframes daidocs-wriggle{0%{transform:rotate(-16deg) translateY(0)}25%{transform:rotate(12deg) translateY(-2px)}50%{transform:rotate(-10deg) translateY(0)}75%{transform:rotate(14deg) translateY(-2px)}100%{transform:rotate(-16deg) translateY(0)}}'
      + '@keyframes daidocs-breathe{0%{transform:scale(1)}50%{transform:scale(1.12)}100%{transform:scale(1)}}'
      + '@keyframes daidocs-hop{0%{transform:translateY(0)}30%{transform:translateY(-6px)}60%{transform:translateY(0)}}'
      + '@keyframes daidocs-glow{0%,100%{box-shadow:0 0 0 1px rgba(47,224,168,.25),0 6px 22px rgba(47,224,168,.18)}50%{box-shadow:0 0 0 1px rgba(47,224,168,.5),0 8px 30px rgba(47,224,168,.38)}}'
      // Animated gradient-border button, matching the daidocs.com install box: a
      // conic-gradient ring (teal + blue arcs) masked to the border, rotated by
      // animating a custom angle property.
      + '@property --daidocs-angle{syntax:"<angle>";inherits:false;initial-value:0deg}'
      + '@keyframes daidocs-spin{to{--daidocs-angle:360deg}}'
      + '.daidocs-glowbtn{position:relative;overflow:hidden}'
      + '.daidocs-glowbtn::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1.5px;'
      + 'background:conic-gradient(from var(--daidocs-angle),rgba(0,0,0,0) 0deg,#2fe0a8 43deg,rgba(0,0,0,0) 108deg,rgba(0,0,0,0) 198deg,#38bdf8 245deg,rgba(0,0,0,0) 306deg);'
      + '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;'
      + 'mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;'
      + 'animation:daidocs-spin 6s linear infinite;pointer-events:none}'
      + '@media (prefers-reduced-motion:reduce){.daidocs-glowbtn::before{animation:none}}';
    document.documentElement.append(style);
  }

  function rebuildFace() {
    face.textContent = '';
    face.style.animation = 'none';
    if (indicator.style === 'creature') {
      face.textContent = indicator.creature || '🐛';
      face.style.fontSize = '17px';
      face.style.width = 'auto'; face.style.height = 'auto'; face.style.background = 'none'; face.style.borderRadius = '0';
    } else {
      face.style.fontSize = '0';
      face.style.width = '9px'; face.style.height = '9px'; face.style.borderRadius = '50%';
    }
  }

  function build() {
    ensureStyle();
    pill = document.createElement('div');
    pill.id = 'daidocs-pill';
    css(pill, 'position:fixed;top:12px;left:12px;z-index:2147483647;display:flex;align-items:center;gap:9px;'
      + "font:12px/1 'Segoe UI',system-ui,sans-serif;padding:8px 12px 8px 13px;border-radius:14px;user-select:none;"
      + 'color:#c2ffe8;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);'
      + 'background:linear-gradient(135deg,rgba(6,48,61,.92),rgba(2,26,34,.92));'
      + 'border:1px solid rgba(47,224,168,.28);box-shadow:0 6px 22px rgba(0,0,0,.4);transition:border-color .25s,box-shadow .25s;');
    face = document.createElement('span');
    css(face, 'display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;line-height:1;transition:transform .2s;');
    label = document.createElement('span');
    label.style.cursor = 'pointer';
    label.style.letterSpacing = '.2px';
    label.title = 'DaiDocs: click to toggle capture for this site';
    label.onclick = () => { if (!consentAccepted) { bg('open_consent'); return; } writeEnabled(!enabled); };
    const gear = document.createElement('span');
    gear.textContent = '⚙';
    css(gear, 'cursor:pointer;font-size:14px;line-height:1;opacity:.7;padding-left:3px;transition:opacity .2s');
    gear.onmouseenter = () => gear.style.opacity = '1'; gear.onmouseleave = () => gear.style.opacity = '.7';
    gear.title = 'DaiDocs settings';
    gear.onclick = e => { e.stopPropagation(); togglePanel(); };
    pill.append(face, label, gear);
    rebuildFace();
    document.documentElement.append(pill);
  }

  let errMsg = null;
  function render(state) {
    if (!pill) build();
    lastState = state;
    const isCreature = indicator.style === 'creature';
    face.style.animation = 'none';
    pill.style.animation = 'none';
    // void reflow so re-applying the same animation restarts it
    void face.offsetWidth;

    if (state === 'consent') {
      pill.style.borderColor = 'rgba(224,180,58,.5)';
      pill.style.background = 'linear-gradient(135deg,rgba(58,46,20,.92),rgba(34,26,10,.92))';
      label.style.color = '#ffe6a8';
      if (isCreature) { face.style.filter = 'none'; } else { face.style.background = '#e0b43a'; }
      label.textContent = 'tap to accept';
    } else if (state === 'off') {
      pill.style.borderColor = 'rgba(120,140,150,.25)';
      pill.style.background = 'linear-gradient(135deg,rgba(20,26,30,.9),rgba(12,16,20,.9))';
      label.style.color = '#8fa3ad';
      if (isCreature) { face.textContent = (indicator.creature || '🐛'); face.style.filter = 'grayscale(1) opacity(.65)'; label.textContent = 'asleep 💤'; }
      else { face.style.filter = 'none'; face.style.background = '#5a6b72'; label.textContent = 'Not saving'; }
    } else {
      pill.style.background = 'linear-gradient(135deg,rgba(6,48,61,.92),rgba(2,26,34,.92))';
      face.style.filter = 'none';
      if (state === 'saving') {
        pill.style.borderColor = 'rgba(47,224,168,.5)'; pill.style.animation = 'daidocs-glow 1.4s infinite'; label.style.color = '#a8ffe0';
        if (isCreature) face.style.animation = 'daidocs-wriggle .5s linear infinite';
        else { face.style.background = '#2fe0a8'; face.style.animation = 'daidocs-pulse 1s infinite'; }
        label.textContent = 'saving…';
      } else if (state === 'saved') {
        pill.style.borderColor = 'rgba(47,224,168,.45)'; label.style.color = '#a8ffe0';
        if (isCreature) face.style.animation = 'daidocs-hop .5s ease'; else face.style.background = '#2fe0a8';
        label.textContent = 'saved ✓';
        clearTimeout(savedTimer); savedTimer = setTimeout(() => render(enabled ? 'idle' : 'off'), 1500);
      } else if (state === 'error') {
        pill.style.borderColor = 'rgba(224,108,58,.5)';
        pill.style.background = 'linear-gradient(135deg,rgba(58,28,20,.92),rgba(34,16,10,.92))';
        label.style.color = '#ffc9b3';
        if (isCreature) { face.style.filter = 'grayscale(.4)'; } else { face.style.background = '#e06c3a'; }
        label.textContent = errMsg || 'not saved: server offline';
      } else { // idle, enabled
        pill.style.borderColor = 'rgba(47,224,168,.3)'; label.style.color = '#c2ffe8';
        if (isCreature) face.style.animation = 'daidocs-breathe 3s ease-in-out infinite';
        else face.style.background = '#2fe0a8';
        label.textContent = 'capture on';
      }
    }
  }

  // Capture scripts announce state; reflect it (unless we are showing 'off').
  window.addEventListener('daidocs:state', e => {
    const st = e.detail && e.detail.state;
    errMsg = (e.detail && e.detail.msg) || null;
    if (!enabled && st !== 'off') return;         // stay off visually when disabled
    render(st);
  });

  // ------------------------------------------------------------- settings ----
  function togglePanel() { if (panel) closePanel(); else openPanel(); }
  function closePanel() { if (panel) { panel.remove(); panel = null; } }

  function openPanel() {
    panel = document.createElement('div');
    css(panel, 'position:fixed;top:46px;left:12px;z-index:2147483647;width:320px;max-height:78vh;overflow:auto;'
      + 'background:#1b1b24;color:#e8e8ee;font:13px/1.45 system-ui,sans-serif;border-radius:12px;'
      + 'box-shadow:0 8px 30px rgba(0,0,0,.5);padding:14px 16px;');
    const ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
    panel.innerHTML = '<div style="font-weight:700;font-size:14px;margin-bottom:6px">DaiDocs settings '
      + '<span style="font-weight:400;color:#8a8a98;font-size:12px">v' + ver + '</span></div>'
      + '<div style="color:#8a8a98;font-size:12px;margin-bottom:6px">Everything is controlled here. Tap a heading to open it.</div>';

    // Always-visible primary action: open the memory dashboard / vault reader.
    const dash = glowBtn('Open dashboard');
    dash.style.width = '100%'; dash.style.boxSizing = 'border-box'; dash.style.textAlign = 'center';
    dash.title = 'Opens the memory dashboard and vault reader (needs the capture server running)';
    dash.onclick = () => bg('open_dashboard');
    panel.append(dash);

    const EXCL = window.__daidocsExclusions;
    const defaultExcluded = EXCL ? EXCL.isDefaultExcluded(location.hostname) : false;

    // Collapsible sections, all in this one dropdown. The two the user needs
    // most (this site, and whether the server is running) start open; the rest
    // sit under their own headings and open on tap, so nothing lives on a
    // separate page.
    panel.append(section('This site', box => renderCapture(box, defaultExcluded), true));
    panel.append(hr(), section('Server', box => renderServer(box), true));
    panel.append(hr(), section('Encryption', box => renderEncryption(box), false));
    panel.append(hr(), section('Storage folder', box => renderFolders(box), false));
    panel.append(hr(), section('Indicator', box => renderIndicator(box), false));
    panel.append(hr(), section('More settings', box => renderMore(box), false));

    document.documentElement.append(panel);
  }

  function saveIndicator(next) {
    indicator = Object.assign({}, indicator, next);
    chrome.storage.sync.set({ indicator }, () => { rebuildFace(); render(lastState); });
  }
  function renderIndicator(box) {
    box.innerHTML = '';
    box.append(note('How the on-page badge looks. A creature wriggles while saving and sleeps when off; basic is just words.'));
    const row = document.createElement('div'); css(row, 'display:flex;gap:6px;margin:6px 0');
    const bBasic = btn('Basic'); const bCreature = btn('Creature');
    const mark = b => { b.style.borderColor = '#2fe0a8'; b.style.color = '#a8ffe0'; };
    (indicator.style === 'creature' ? bCreature : bBasic) && mark(indicator.style === 'creature' ? bCreature : bBasic);
    bBasic.onclick = () => { saveIndicator({ style: 'basic' }); renderIndicator(box); };
    bCreature.onclick = () => { saveIndicator({ style: 'creature' }); renderIndicator(box); };
    row.append(bBasic, bCreature); box.append(row);
    if (indicator.style === 'creature') {
      box.append(note('Pick your creature:'));
      const grid = document.createElement('div'); css(grid, 'display:flex;flex-wrap:wrap;gap:6px');
      const uniq = Array.from(new Set(CREATURES));
      for (const c of uniq) {
        const b = document.createElement('button');
        b.textContent = c;
        css(b, 'font-size:20px;line-height:1;padding:6px 8px;border-radius:10px;cursor:pointer;background:#0d2a2f;'
          + 'border:1px solid ' + (indicator.creature === c ? '#2fe0a8' : '#2a3a3f') + ';');
        b.onclick = () => { saveIndicator({ creature: c }); renderIndicator(box); };
        grid.append(b);
      }
      box.append(grid);
    }
  }

  function hr() { const d = document.createElement('div'); css(d, 'height:1px;background:#33333f;margin:12px 0'); return d; }
  function sectionTitle(t) { const d = document.createElement('div'); d.textContent = t; css(d, 'font-weight:600;margin-bottom:6px'); return d; }
  function btn(t) { const b = document.createElement('button'); b.textContent = t; css(b, 'font:inherit;padding:5px 10px;border-radius:7px;border:1px solid #444;background:#2a2a36;color:#e8e8ee;cursor:pointer;margin:2px 4px 2px 0'); return b; }
  // A button with the animated gradient-border (the daidocs.com install-box look).
  // No own border: the spinning conic-gradient ring is the border. Dark inner fill
  // so the ring reads clearly.
  function glowBtn(t) {
    const b = document.createElement('button'); b.textContent = t; b.className = 'daidocs-glowbtn';
    css(b, 'font:inherit;font-weight:600;padding:9px 16px;border-radius:10px;border:0;background:#0b262b;color:#c2ffe8;cursor:pointer;margin:8px 0 4px;letter-spacing:.2px');
    return b;
  }
  function note(t) { const d = document.createElement('div'); d.textContent = t; css(d, 'color:#9a9aa8;font-size:12px;margin:4px 0'); return d; }

  // A collapsible section: a clickable header with a chevron and a body that
  // renders the first time it is opened. This folds every setting into the one
  // pill dropdown, so there is no separate options page to go hunting through.
  function section(title, renderInto, opened) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    css(head, 'display:flex;align-items:center;justify-content:space-between;cursor:pointer;'
      + 'font-weight:600;padding:9px 0;user-select:none');
    const tt = document.createElement('span'); tt.textContent = title;
    const chev = document.createElement('span'); chev.textContent = opened ? '▾' : '▸';
    css(chev, 'color:#8a8a98;font-size:11px;margin-left:8px');
    head.append(tt, chev);
    const body = document.createElement('div');
    body.hidden = !opened;
    let built = false;
    const buildBody = () => { if (!built) { built = true; renderInto(body); } };
    if (opened) buildBody();
    head.onclick = () => {
      const show = body.hidden;
      body.hidden = !show;
      chev.textContent = show ? '▾' : '▸';
      if (show) buildBody();
    };
    wrap.append(head, body);
    return wrap;
  }

  // A copyable command row: the command in a code box with a Copy button.
  function cmdRow(text) {
    const row = document.createElement('div'); css(row, 'display:flex;align-items:center;gap:6px;margin:4px 0');
    const c = document.createElement('code'); c.textContent = text;
    css(c, 'flex:1;background:#0d2a2f;color:#a8ffe0;padding:6px 8px;border-radius:6px;font:12px/1.3 ui-monospace,monospace;user-select:all;overflow-x:auto;white-space:nowrap');
    const b = btn('Copy'); b.style.margin = '0';
    b.onclick = () => {
      const done = () => { b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy', 1200); };
      try { navigator.clipboard.writeText(text).then(done).catch(() => { const r = document.createRange(); r.selectNode(c); const s = getSelection(); s.removeAllRanges(); s.addRange(r); done(); }); }
      catch (_) {}
    };
    row.append(c, b); return row;
  }

  // The two ways to start the capture server by hand, spelled out step by step.
  function buildLaunchHelp(box) {
    box.append(note('Important: start it from the DaiDocs PROGRAM folder (the one that contains capture_server.mjs), not the memory folder where your captures are saved. They are different folders with similar names.'));
    box.append(sectionTitle('Option 1: double-click (easiest, no folder to find)'));
    box.append(note('If you have a "Start DaiDocs Capture" shortcut on your Desktop, double-click that. Otherwise open the launcher folder and double-click start-daidocs.bat. Either one finds the program folder for you, so it always works. A window opens, you watch it load, then minimise it. Keep it open: closing it stops capture.'));
    box.append(hr());
    box.append(sectionTitle('Option 2: start it from a terminal'));
    box.append(note('1. Open a terminal (Command Prompt or PowerShell on Windows; Terminal on Mac or Linux).'));
    const step2 = note('2. Go to the DaiDocs program folder (the one holding capture_server.mjs), for example:');
    box.append(step2);
    const cdRow = cmdRow('cd path\\to\\daidocs-program-folder');
    box.append(cdRow);
    box.append(note('3. Start the capture server (no npm install needed):'));
    box.append(cmdRow('node capture_server.mjs'));
    box.append(note('Or the same thing via npm:'));
    box.append(cmdRow('npm run capture'));
    box.append(note('Keep the terminal open. The pill turns green here as soon as the server is up.'));

    // If the server has run before, it told us its real folder: fill in the
    // exact cd command instead of the placeholder, so the user can copy it.
    try {
      chrome.storage.local.get({ daidocsDir: null }, s => {
        if (s.daidocsDir) {
          step2.textContent = '2. Go to your DaiDocs program folder (remembered from the last time the server ran):';
          cdRow.replaceWith(cmdRow('cd "' + s.daidocsDir + '"'));
        }
      });
    } catch (_) {}
  }

  // A simple labelled on/off row.
  function toggleRow(text, checked, onChange) {
    const row = document.createElement('label');
    css(row, 'display:flex;align-items:center;gap:8px;margin:8px 0;cursor:pointer');
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = !!checked;
    chk.onchange = () => onChange(chk.checked);
    row.append(chk, document.createTextNode(text));
    return row;
  }

  function renderCapture(box, defaultExcluded) {
    box.innerHTML = '';
    const host = location.hostname.replace(/^www\./, '');
    if (defaultExcluded) {
      box.append(note('This looks like a sensitive site (banking, health, webmail or similar). It is never captured, and this cannot be overridden.'));
      return;
    }
    chrome.storage.sync.get({ excludedHosts: [] }, s => {
      const userExcluded = (s.excludedHosts || []).map(x => x.toLowerCase()).includes(host.toLowerCase());
      if (userExcluded) {
        box.append(note('You marked ' + host + ' as never-capture.'));
        const un = btn('Allow capture on ' + host);
        un.onclick = () => {
          const list = (s.excludedHosts || []).filter(x => x.toLowerCase() !== host.toLowerCase());
          chrome.storage.sync.set({ excludedHosts: list }, () => renderCapture(box, false));
        };
        box.append(un);
        return;
      }
      const capRow = document.createElement('label');
      css(capRow, 'display:flex;align-items:center;gap:8px;margin:10px 0;cursor:pointer');
      const capChk = document.createElement('input'); capChk.type = 'checkbox'; capChk.checked = enabled;
      capChk.onchange = () => writeEnabled(capChk.checked);
      capRow.append(capChk, document.createTextNode('Capture on ' + SITE.label));
      box.append(capRow);
      const never = btn('Never capture ' + host);
      never.onclick = () => {
        const list = Array.from(new Set([...(s.excludedHosts || []), host]));
        chrome.storage.sync.set({ excludedHosts: list }, () => renderCapture(box, false));
      };
      box.append(never);

      // Save the current site's settings (capture state + current store) as a
      // remembered per-site rule, applied automatically on every future visit.
      const save = btn('Store settings for this site');
      save.onclick = async () => {
        const cfg = await bg('get', { path: '/config' });
        chrome.storage.sync.get({ siteSettings: {} }, ss2 => {
          const m = ss2.siteSettings || {};
          m[host] = { capture: capChk.checked, store: (cfg && cfg.store) || null };
          chrome.storage.sync.set({ siteSettings: m }, () => { save.textContent = 'Saved for ' + host; setTimeout(() => save.textContent = 'Store settings for this site', 1500); });
        });
      };
      box.append(save);

      const manage = btn('Manage websites ›');
      manage.onclick = () => { closePanel(); openManagePanel(); };
      box.append(manage);
    });
  }

  // Manage-websites view: a distinct panel with an "add website" form and the
  // list of remembered per-site rules, each removable.
  function openManagePanel() {
    panel = document.createElement('div');
    css(panel, 'position:fixed;top:46px;left:12px;z-index:2147483647;width:340px;max-height:80vh;overflow:auto;'
      + 'background:#1b1b24;color:#e8e8ee;font:13px/1.45 system-ui,sans-serif;border-radius:12px;'
      + 'box-shadow:0 8px 30px rgba(0,0,0,.5);padding:14px 16px;');
    const head = document.createElement('div');
    head.innerHTML = '<span style="font-weight:700;font-size:14px">Manage websites</span>';
    const back = btn('‹ Back'); back.style.marginLeft = '8px';
    back.onclick = () => { closePanel(); openPanel(); };
    head.append(back);
    panel.append(head);

    panel.append(hr(), sectionTitle('Add a website'));
    const hostIn = document.createElement('input'); hostIn.placeholder = 'host, e.g. reddit.com';
    const storeIn = document.createElement('input'); storeIn.placeholder = 'store folder (optional, blank = default)';
    for (const el of [hostIn, storeIn]) css(el, 'width:100%;box-sizing:border-box;padding:6px 8px;font:inherit;margin:3px 0;border-radius:6px;border:1px solid #444;background:#111;color:#eee');
    const capWrap = document.createElement('label'); css(capWrap, 'display:flex;align-items:center;gap:8px;margin:4px 0');
    const capIn = document.createElement('input'); capIn.type = 'checkbox'; capIn.checked = true;
    capWrap.append(capIn, document.createTextNode('Capture this site'));
    const addBtn = btn('Add website');
    addBtn.onclick = () => {
      const h = (hostIn.value || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
      if (!h) { hostIn.style.borderColor = '#e06c3a'; return; }
      chrome.storage.sync.get({ siteSettings: {} }, ss => {
        const m = ss.siteSettings || {};
        m[h] = { capture: capIn.checked, store: (storeIn.value || '').trim() || null };
        chrome.storage.sync.set({ siteSettings: m }, () => { hostIn.value = ''; storeIn.value = ''; renderSiteList(listBox); });
      });
    };
    panel.append(hostIn, storeIn, capWrap, addBtn);

    panel.append(hr(), sectionTitle('Saved website settings'));
    const listBox = document.createElement('div'); panel.append(listBox); renderSiteList(listBox);
    document.documentElement.append(panel);
  }

  function renderSiteList(box) {
    box.innerHTML = '';
    chrome.storage.sync.get({ siteSettings: {} }, s => {
      const m = s.siteSettings || {};
      const hosts = Object.keys(m).sort();
      if (!hosts.length) { box.append(note('No saved website settings yet.')); return; }
      for (const h of hosts) {
        const row = document.createElement('div');
        css(row, 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #26262f');
        const info = document.createElement('div'); css(info, 'flex:1;min-width:0');
        info.innerHTML = '<div style="font-weight:600">' + h + '</div><div style="color:#9a9aa8;font-size:12px">'
          + (m[h].capture === false ? 'capture off' : 'capture on') + (m[h].store ? ' | ' + m[h].store : ' | default store') + '</div>';
        const rm = btn('Remove'); rm.style.margin = '0';
        rm.onclick = () => { const n = Object.assign({}, m); delete n[h]; chrome.storage.sync.set({ siteSettings: n }, () => renderSiteList(box)); };
        row.append(info, rm);
        box.append(row);
      }
    });
  }

  function renderAllWebsites(box) {
    box.innerHTML = '';
    chrome.storage.sync.get({ allWebsites: false }, s => {
      if (s.allWebsites) {
        box.append(note('All websites: ON. Every site is captured (each can be toggled from its own pill).'));
        const off = btn('Turn off all-websites');
        off.onclick = () => chrome.storage.sync.set({ allWebsites: false }, () => renderAllWebsites(box));
        box.append(off);
      } else {
        box.append(note('Websites beyond X and the chat sites are not captured yet. Enabling all-websites needs a one-time browser permission, granted on the settings page.'));
        const open = btn('Enable website capture (opens settings)');
        open.onclick = () => bg('open_options');
        box.append(open);
      }
    });
  }

  // Everything that used to be on the separate options page, folded into the
  // pill: per-site chat toggles you can flip from anywhere, the X toggle,
  // all-websites, saved-site management, the show-pill switch, and the advanced
  // port/token. The one thing that must stay on the options page is granting the
  // all-sites browser permission, which a content script is not allowed to do.
  function renderMore(box) {
    box.innerHTML = '';

    box.append(sectionTitle('AI chat sites and X'));
    const togBox = document.createElement('div'); box.append(togBox);
    togBox.append(note('Turn capture on or off for these, from any page.'));
    chrome.storage.sync.get({ chatToggles: {}, browseToggles: {} }, s => {
      const chats = [['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini']];
      for (const [key, lab] of chats) {
        togBox.append(toggleRow(lab + ' conversations', s.chatToggles[key] !== false, on => {
          chrome.storage.sync.get({ chatToggles: {} }, c => { const t = c.chatToggles || {}; t[key] = on; chrome.storage.sync.set({ chatToggles: t }); });
        }));
      }
      togBox.append(toggleRow('X / Twitter timeline', !!s.browseToggles.x, on => {
        chrome.storage.sync.get({ browseToggles: {} }, c => { const t = c.browseToggles || {}; t.x = on; chrome.storage.sync.set({ browseToggles: t }); });
      }));
    });

    box.append(hr(), sectionTitle('All websites'));
    const webBox = document.createElement('div'); box.append(webBox); renderAllWebsites(webBox);
    const manage = btn('Manage saved sites ›');
    manage.onclick = () => { closePanel(); openManagePanel(); };
    box.append(manage);

    box.append(hr(), sectionTitle('Pill'));
    const pillBox = document.createElement('div'); box.append(pillBox);
    chrome.storage.sync.get({ showPill: true }, s => {
      pillBox.append(toggleRow('Show the save pill on pages', s.showPill !== false, on => {
        chrome.storage.sync.set({ showPill: on });
        if (!on) pillBox.append(note('The pill hides on other pages now. To bring it back, open the extension options from your browser toolbar and turn it on.'));
      }));
    });

    box.append(hr(), sectionTitle('Advanced'));
    const advBox = document.createElement('div'); box.append(advBox);
    advBox.append(note('Capture server port and optional token. Change these only if you run the server on a non-default port.'));
    chrome.storage.sync.get({ port: 41100, token: '' }, s => {
      const portIn = document.createElement('input'); portIn.type = 'number'; portIn.value = s.port; portIn.placeholder = 'port (default 41100)';
      const tokIn = document.createElement('input'); tokIn.type = 'text'; tokIn.value = s.token; tokIn.placeholder = 'token (optional)';
      for (const el of [portIn, tokIn]) css(el, 'width:100%;box-sizing:border-box;padding:6px 8px;font:inherit;margin:3px 0;border-radius:6px;border:1px solid #444;background:#111;color:#eee');
      const saveB = btn('Save');
      saveB.onclick = () => {
        const port = parseInt(portIn.value, 10) || 41100;
        chrome.storage.sync.set({ port, token: (tokIn.value || '').trim() }, () => { saveB.textContent = 'Saved'; setTimeout(() => saveB.textContent = 'Save', 1200); });
      };
      advBox.append(portIn, tokIn, saveB);
    });
  }

  async function renderServer(box) {
    box.textContent = 'Checking server...';
    const h = await bg('get', { path: '/health' });
    box.innerHTML = '';
    if (h && h.ok) {
      // Remember where DaiDocs lives, so we can show the exact folder to launch
      // from next time the server is down.
      if (h.dir) { try { chrome.storage.local.set({ daidocsDir: h.dir, daidocsLauncher: h.launcher || null }); } catch (_) {} }
      const row = document.createElement('div');
      css(row, 'display:flex;align-items:center;gap:8px;margin:4px 0');
      const dotEl = document.createElement('span'); css(dotEl, 'width:9px;height:9px;border-radius:50%;background:#22c55e;display:inline-block');
      row.append(dotEl, document.createTextNode('Running. Capture can save.'));
      box.append(row);
      return;
    }
    // Offline: the extension cannot start a program itself (browser security),
    // so tell the user exactly how to launch it. A one-click launch needs the
    // native-messaging helper (see the launcher/ folder and TODO).
    const row = document.createElement('div');
    css(row, 'display:flex;align-items:center;gap:8px;margin:4px 0');
    const dotEl = document.createElement('span'); css(dotEl, 'width:9px;height:9px;border-radius:50%;background:#e06c3a;display:inline-block');
    row.append(dotEl, document.createTextNode('Not running. Capture is paused.'));
    box.append(row);
    box.append(note('First try the one-click launch. If it is not set up yet, the two ways to start it by hand appear below.'));

    // A single status line, REPLACED on each attempt (never stacked), plus a
    // detailed help section that stays hidden until it is actually needed.
    const status = document.createElement('div');
    css(status, 'color:#9a9aa8;font-size:12px;margin:6px 0 0');
    const help = document.createElement('div'); help.hidden = true; css(help, 'margin-top:10px');
    buildLaunchHelp(help);

    const tryBtn = btn('Try one-click launch');
    const howBtn = btn('How to start it');
    howBtn.onclick = () => { help.hidden = !help.hidden; howBtn.textContent = help.hidden ? 'How to start it' : 'Hide instructions'; };
    tryBtn.onclick = async () => {
      tryBtn.disabled = true; tryBtn.textContent = 'Trying...';
      status.textContent = '';
      const r = await bg('launch_server');
      if (r && r.ok) { renderServer(box); return; }
      tryBtn.disabled = false; tryBtn.textContent = 'Try one-click launch';
      status.textContent = r && r.needsSetup
        ? 'One-click launch needs a small one-time helper that is not installed yet. Start it by hand with one of the methods below.'
        : 'Could not launch automatically. Start it by hand with one of the methods below.';
      // Reveal the step-by-step instructions once the one-click path has failed.
      help.hidden = false; howBtn.textContent = 'Hide instructions';
    };
    box.append(tryBtn, howBtn, status, help);
  }

  async function renderEncryption(box) {
    box.textContent = 'Checking...';
    const [st, cfg] = await Promise.all([bg('vault_status'), bg('get', { path: '/config' })]);
    box.innerHTML = '';
    if (!st || !st.ok) { box.append(note('Capture server not reachable. Start it (npm run capture).')); return; }
    const s = await new Promise(r => chrome.storage.sync.get({ encrypt: false }, r));
    const settingOn = !!s.encrypt;
    const on = settingOn && st.initialized;

    // Mismatch: encryption is switched on, but the CURRENT store folder has no
    // vault (e.g. the store was moved). Captures are refused until this is
    // resolved, so offer both ways out clearly.
    if (settingOn && !st.initialized) {
      box.append(note('Encryption is ON, but this storage folder has no vault yet, so nothing is being saved. Either set a password to create a vault here, or turn encryption off to save as plain text.'));
      const pw = document.createElement('input'); pw.type = 'password'; pw.placeholder = 'new vault password (8+ chars)';
      css(pw, 'width:100%;box-sizing:border-box;padding:6px 8px;font:inherit;margin:4px 0;border-radius:6px;border:1px solid #444;background:#111;color:#eee');
      const create = btn('Create vault here');
      create.onclick = async () => {
        if ((pw.value || '').length < 8) { pw.style.borderColor = '#e06c3a'; return; }
        create.disabled = true; create.textContent = 'Working...';
        const r = await bg('post', { path: '/vault/init', body: { password: pw.value } });
        if (!r || !r.ok) { create.disabled = false; create.textContent = 'Create vault here'; box.append(note('Could not create vault: ' + (r && r.error || 'error'))); return; }
        renderEncryption(box);
      };
      const off = btn('Turn off encryption');
      off.onclick = () => chrome.storage.sync.set({ encrypt: false }, () => renderEncryption(box));
      box.append(pw, create, off);
      return;
    }

    box.append(note('Status: ' + (on ? 'ON (browsing and chats are encrypted)' : 'OFF (stored as plain text)')));

    if (!on) {
      box.append(note(st.initialized
        ? 'Vault exists. Enter its password to turn encryption on.'
        : 'Set a password (8+ chars) to create the encrypted vault.'));
      const pw = document.createElement('input'); pw.type = 'password'; pw.placeholder = 'vault password';
      css(pw, 'width:100%;box-sizing:border-box;padding:6px 8px;font:inherit;margin:4px 0;border-radius:6px;border:1px solid #444;background:#111;color:#eee');
      const go = btn('Turn on encryption');
      go.onclick = async () => {
        if ((pw.value || '').length < 8) { pw.style.borderColor = '#e06c3a'; return; }
        go.disabled = true; go.textContent = 'Working...';
        const r = st.initialized
          ? await bg('post', { path: '/vault/verify', body: { password: pw.value } })
          : await bg('post', { path: '/vault/init', body: { password: pw.value } });
        const good = st.initialized ? (r && r.ok && r.valid) : (r && r.ok);
        if (!good) { go.disabled = false; go.textContent = 'Turn on encryption'; pw.style.borderColor = '#e06c3a'; box.append(note(st.initialized ? 'Wrong password.' : ('Could not create vault: ' + (r && r.error || 'error')))); return; }
        chrome.storage.sync.set({ encrypt: true }, () => renderEncryption(box));
      };
      box.append(pw, go);
    } else {
      box.append(note('Turning off means new captures are stored as plain text. Anything already in the vault stays encrypted.'));
      const off = btn('Turn off encryption');
      off.onclick = () => chrome.storage.sync.set({ encrypt: false }, () => renderEncryption(box));
      box.append(off);
    }
    // Vault access lives in the memory-map dashboard: a lock-badged store with
    // inline unlock. Opening the dashboard is the way in.
    if (st.initialized) {
      box.append(note('Your vault files are encrypted. Use the "Open dashboard" button at the top, click your store, then the Encrypted vault tile, and enter your password to read them.'));
    }
  }

  async function renderFolders(box, atPath) {
    box.textContent = 'Loading...';
    const cfg = await bg('get', { path: '/config' });
    if (!cfg || !cfg.ok) { box.textContent = ''; box.append(note('Capture server not reachable.')); return; }
    const listing = await bg('get', { path: '/fs/list' + (atPath ? ('?path=' + encodeURIComponent(atPath)) : '') });
    box.innerHTML = '';
    box.append(note('Current store: ' + cfg.store));
    if (cfg.envLocked) { box.append(note('Locked by DAIDOCS_STORE env var; cannot change here.')); return; }
    if (!listing || !listing.ok) { box.append(note('Cannot read that folder.')); return; }

    box.append(note('Browsing: ' + listing.path));
    const list = document.createElement('div');
    css(list, 'max-height:150px;overflow:auto;border:1px solid #33333f;border-radius:8px;margin:6px 0');
    if (listing.parent) {
      const up = rowItem('.. (up one level)'); up.onclick = () => renderFolders(box, listing.parent); list.append(up);
    }
    for (const name of listing.dirs) {
      const it = rowItem('📁 ' + name);
      it.onclick = () => renderFolders(box, (listing.path.endsWith('\\') || listing.path.endsWith('/')) ? listing.path + name : listing.path + '\\' + name);
      list.append(it);
    }
    if (!listing.dirs.length && !listing.parent) list.append(rowItem('(no subfolders)'));
    box.append(list);

    const useBtn = btn('Use this folder');
    useBtn.onclick = async () => {
      useBtn.disabled = true; useBtn.textContent = 'Setting...';
      const r = await bg('post', { path: '/config/store', body: { path: listing.path } });
      if (r && r.ok) {
        // If encryption is on, the new folder needs its own vault. Ask the user
        // whether to keep encryption on (make a vault here) or turn it off.
        const [vst, s2] = await Promise.all([bg('vault_status'), new Promise(res => chrome.storage.sync.get({ encrypt: false }, res))]);
        if (s2.encrypt && vst && vst.ok && !vst.initialized) {
          box.innerHTML = '';
          box.append(note('Store changed to ' + (r.store || listing.path) + '. Encryption is on, but this folder has no vault. Keep encryption on for this folder?'));
          const pw = document.createElement('input'); pw.type = 'password'; pw.placeholder = 'password for the new vault (8+ chars)';
          css(pw, 'width:100%;box-sizing:border-box;padding:6px 8px;font:inherit;margin:4px 0;border-radius:6px;border:1px solid #444;background:#111;color:#eee');
          const keep = btn('Keep on (create vault here)');
          keep.onclick = async () => {
            if ((pw.value || '').length < 8) { pw.style.borderColor = '#e06c3a'; return; }
            const ir = await bg('post', { path: '/vault/init', body: { password: pw.value } });
            if (ir && ir.ok) renderFolders(box, listing.path); else box.append(note('Could not create vault: ' + (ir && ir.error || 'error')));
          };
          const turnOff = btn('Turn encryption off');
          turnOff.onclick = () => chrome.storage.sync.set({ encrypt: false }, () => renderFolders(box, listing.path));
          box.append(pw, keep, turnOff);
          return;
        }
        await renderFolders(box, listing.path);
        // Green-tick confirmation of the new store folder.
        const ok = document.createElement('div');
        css(ok, 'display:flex;align-items:center;gap:8px;margin:8px 0;padding:8px 10px;border-radius:8px;background:#0c3a1e;color:#c9f7d6;font-weight:600');
        const tick = document.createElement('span'); tick.textContent = '✓';
        css(tick, 'display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#22c55e;color:#06240f;font-size:12px;flex:0 0 auto');
        const msg = document.createElement('span'); msg.textContent = 'New folder selected: ' + (r.store || listing.path);
        ok.append(tick, msg);
        box.prepend(ok);
      } else {
        useBtn.disabled = false; useBtn.textContent = 'Use this folder';
        box.append(note('Failed: ' + (r && r.error || 'error')));
      }
    };
    const newBtn = btn('New folder');
    newBtn.onclick = () => {
      const nm = document.createElement('input'); nm.placeholder = 'new folder name';
      css(nm, 'padding:5px 8px;font:inherit;border-radius:6px;border:1px solid #444;background:#111;color:#eee;margin:2px 4px 2px 0');
      const make = btn('Create');
      make.onclick = async () => {
        const r = await bg('post', { path: '/fs/mkdir', body: { path: listing.path, name: nm.value } });
        if (r && r.ok) renderFolders(box, listing.path); else box.append(note('Failed: ' + (r && r.error || 'error')));
      };
      box.append(nm, make);
    };
    box.append(useBtn, newBtn);
  }
  function rowItem(t) { const d = document.createElement('div'); d.textContent = t; css(d, 'padding:6px 10px;cursor:pointer;border-bottom:1px solid #26262f'); d.onmouseenter = () => d.style.background = '#2a2a36'; d.onmouseleave = () => d.style.background = ''; return d; }

  // ---------------------------------------------------------------- start ----
  function refresh() { readEnabled(on => { enabled = on; render(on ? 'idle' : (consentAccepted ? 'off' : 'consent')); }); }
  let hidden = false;
  chrome.storage.sync.get({ showPill: true }, s0 => {
    hidden = s0.showPill === false;         // the pill can be switched off entirely
    if (!hidden) refresh();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'sync') return;
    // Show-pill toggled from the More section (or the options page): hide or
    // show the pill live, so the switch has an immediate effect.
    if (c.showPill) {
      hidden = c.showPill.newValue === false;
      if (hidden) { closePanel(); if (pill) { pill.remove(); pill = null; } return; }
      if (!pill) { refresh(); return; }
    }
    if (hidden) return;
    if (c.chatToggles || c.browseToggles || c.allWebsites || c.excludedHosts || c.consentAccepted) refresh();
  });
})();
