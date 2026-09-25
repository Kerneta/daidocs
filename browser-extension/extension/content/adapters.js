// Site adapters: the only part of the extension that knows page structure.
//
// Each adapter answers five questions for one site:
//   site              short name, matches the server's SITE_CODES
//   conversationId()  stable id for the open conversation, or null on a fresh page
//   getText()         the conversation as [USER]: / [ASSISTANT]: lines
//   composer()        the input element to prefill, or null
//   newChatUrl        where a fresh conversation starts
//
// Selectors WILL rot when a site redesigns. Every adapter therefore has the
// same fallback: if the message selectors find nothing, capture main's
// innerText raw. Ugly text still converts to memory; silence loses data.
//
// No em dashes in this file, per project rule.

(function () {
  'use strict';

  const textOf = el => (el ? el.innerText || '' : '').trim();

  // Shadow-DOM piercing querySelectorAll: some sites (recent ChatGPT) render
  // messages inside open shadow roots, where a normal querySelectorAll from the
  // document finds nothing even though the text is on screen. This walks into
  // every open shadow root too.
  function deepQueryAll(selector, root, out, seen) {
    root = root || document;
    out = out || [];
    seen = seen || new Set();
    try { for (const el of root.querySelectorAll(selector)) out.push(el); } catch (_) {}
    let all;
    try { all = root.querySelectorAll('*'); } catch (_) { all = []; }
    for (const el of all) {
      if (el.shadowRoot && !seen.has(el.shadowRoot)) { seen.add(el.shadowRoot); deepQueryAll(selector, el.shadowRoot, out, seen); }
    }
    return out;
  }

  function fallbackText() {
    const main = document.querySelector('main') || document.body;
    const t = textOf(main);
    return t.length > 40 ? t : '';
  }

  // Lines from labelled message nodes. Skips empties, joins with blank lines.
  function renderMessages(nodes, roleOf) {
    const out = [];
    for (const n of nodes) {
      const body = textOf(n);
      if (!body) continue;
      out.push((roleOf(n) === 'user' ? '[USER]: ' : '[ASSISTANT]: ') + body);
    }
    return out.join('\n\n');
  }

  const ADAPTERS = {

    chatgpt: {
      site: 'chatgpt',
      newChatUrl: 'https://chatgpt.com/',
      conversationId() {
        const m = location.pathname.match(/\/c\/([\w-]+)/);
        return m ? m[1] : null;
      },
      getText() {
        // data-message-author-role is ChatGPT's message marker; pierce shadow
        // DOM because recent builds render messages in open shadow roots.
        let nodes = deepQueryAll('[data-message-author-role]');
        if (!nodes.length) nodes = deepQueryAll('[data-testid^="conversation-turn"]');
        if (nodes.length) {
          return renderMessages(nodes, n => {
            const r = n.getAttribute('data-message-author-role');
            if (r) return r === 'user' ? 'user' : 'assistant';
            // conversation-turn fallback: user turns contain a user-role child.
            return n.querySelector('[data-message-author-role="user"]') ? 'user' : 'assistant';
          });
        }
        // Last resort: the whole conversation as one blob (no per-turn roles).
        return fallbackText();
      },
      composer() {
        return document.querySelector('#prompt-textarea')
          || document.querySelector('form textarea')
          || document.querySelector('form [contenteditable="true"]');
      },
    },

    claude: {
      site: 'claude',
      newChatUrl: 'https://claude.ai/new',
      conversationId() {
        const m = location.pathname.match(/\/chat\/([\w-]+)/);
        return m ? m[1] : null;
      },
      getText() {
        // User turns carry data-testid="user-message"; Claude's replies render
        // in font-claude-* containers. Deep-query in case of shadow DOM.
        const nodes = deepQueryAll('[data-testid="user-message"], [class*="font-claude"]');
        if (nodes.length) {
          return renderMessages(nodes, n => n.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant');
        }
        return fallbackText();
      },
      composer() {
        return document.querySelector('div[contenteditable="true"].ProseMirror')
          || document.querySelector('[contenteditable="true"]');
      },
    },

    gemini: {
      site: 'gemini',
      newChatUrl: 'https://gemini.google.com/app',
      conversationId() {
        // Gemini conversation URLs look like /app/<id>; a fresh chat is just
        // /app with no id, in which case capture.js falls back to a text id.
        const m = location.pathname.match(/\/app\/([\w-]+)/);
        return m ? m[1] : null;
      },
      getText() {
        // Gemini uses Angular custom elements: user turns in <user-query> /
        // .query-text, model turns in <message-content> / .model-response-text.
        // Gather both, deep-query for shadow DOM, and interleave by DOM order.
        const marks = [];
        for (const q of deepQueryAll('user-query, .query-text, [class*="query-text"]')) {
          const t = textOf(q);
          if (t && t.length < 4000) marks.push({ el: q, role: 'user', t });
        }
        for (const a of deepQueryAll('message-content, .model-response-text, model-response, [class*="model-response"], .markdown')) {
          const t = textOf(a);
          if (t) marks.push({ el: a, role: 'assistant', t });
        }
        if (marks.length < 2) return fallbackText();
        // De-duplicate nested matches (a container and its child both matching)
        // by dropping a mark whose element contains another kept mark's element.
        const kept = marks.filter(m => !marks.some(o => o !== m && m.el.contains(o.el)));
        kept.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
        return kept.map(m => (m.role === 'user' ? '[USER]: ' : '[ASSISTANT]: ') + m.t).join('\n\n');
      },
      composer() {
        return document.querySelector('div.ql-editor[contenteditable="true"]')
          || document.querySelector('[contenteditable="true"]')
          || document.querySelector('textarea');
      },
    },
  };

  function detect() {
    const h = location.hostname;
    if (h === 'chatgpt.com' || h === 'chat.openai.com') return ADAPTERS.chatgpt;
    if (h === 'claude.ai') return ADAPTERS.claude;
    if (h === 'gemini.google.com') return ADAPTERS.gemini;
    return null;
  }

  // Prefill works for both textarea and contenteditable composers. Insert
  // only. Never submit: sending stays a human keypress, always.
  function prefill(el, text) {
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    // contenteditable (ChatGPT's and Claude's editors both listen to this)
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      return true;
    } catch (_) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    }
  }

  window.__daidocs = { detect, prefill };
})();
