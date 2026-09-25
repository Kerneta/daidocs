# DaiDocs Memory Capture extension

Captures your ChatGPT, Claude, and Perplexity conversations into your local
DaiDocs memory store, automatically, every ~4,000 tokens. Everything stays on
your machine: the extension talks only to a localhost server, which writes the
same files the DaiDocs hooks write. No account, no cloud, no API key.

## Setup (two steps)

**1. Start the capture server** in the DaiDocs folder:

```bash
npm run capture
```

Leave it running. It listens on `http://127.0.0.1:41100` and writes captures
to your store (`~/DaiDocs`, or `DAIDOCS_STORE` if set). To require a token,
set `DAIDOCS_CAPTURE_TOKEN` before starting and enter the same token in the
extension's options.

**2. Load the extension** (Chrome, Edge, Brave):

1. Open `chrome://extensions`
2. Turn on "Developer mode" (top right)
3. Click "Load unpacked" and pick this `extension/` folder

That is all. Open a chat on chatgpt.com, claude.ai, or perplexity.ai and use
it normally.

## What you will see

- **Badge counter** on the extension icon: unsaved tokens in the active chat
  (roughly). It resets each time a capture lands. A red `!` means the capture
  server is not running; start it and the next check resumes, nothing is lost
  in between because the chat stays in the site's own history.
- **A banner at ~25k tokens** offering to start a fresh chat. Your chat is
  already captured by then. "Start a fresh chat" opens the site's new-chat
  page with a short primer prefilled; you press Enter yourself. The extension
  never sends a message on your behalf.

## Where captures go, and how they become memory

Captures land in your store as raw, unconverted transcripts:

- `_raw/cc_bx_*.txt` (the full text) and `_unconverted/` + `_pending/` markers

They convert to searchable memory the same way any captured session does:

- your next Claude Code session offers to convert the backlog for free, or
- `node daidocs.js convert` / `npm run catch-up` with an observer key.

API keys pasted into a chat are redacted before anything touches disk.

## Known limits (v0.1)

- Selectors follow each site's current DOM. If a site redesigns, the adapter
  falls back to capturing the page's raw main text until updated: uglier, but
  nothing is lost. Adapters live in `content/adapters.js`.
- Chrome-family browsers only for now.
- Group/shared conversations and edited-message branches capture as rendered.
