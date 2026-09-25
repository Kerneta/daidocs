# DaiDocs Memory Capture (browser extension)

Turn what you read into memory you own. This folder holds the browser extension
and its small local companion (the capture server), which save the pages and
chats you choose to plain files on your own computer, so any AI can recall them
later. Local, private, and encrypted if you want.

No em dashes are used in this project, per the repo rule.

## What is in here

- `extension/` the browser extension itself (pure browser JavaScript: content
  scripts, service worker, options, consent, and privacy pages).
- `capture_server.mjs` the local companion that writes the captured files. It
  listens on `127.0.0.1` only and never sends anything off your machine.
- `vault.mjs` the encrypted-vault command-line tool.
- `lib/` the handful of modules the companion needs (token counting, secret
  redaction, session markers, versioning, the encryption vault, and the store
  registry). Bundled here so this folder runs on its own.
- `tools/dashboard/build_dashboard.mjs` builds the memory-map dashboard the
  extension can open.
- `launcher/` a double-click launcher for the capture server (Windows).
- `docs/getting-started.html` a designed install and usage guide for the website.
- `GETTING-STARTED.md`, `PRIVACY.md`, `TERMS.md`, `ACCEPTABLE-USE.md`,
  `COMPLIANCE-CHECKLIST.md` the user and legal documents.

# Quick Demo on X

https://github.com/user-attachments/assets/1c203cd1-9776-4e37-8936-cb4cb740e0d5

https://x.com/AminRigi_/status/2103517647404929119

## Quick start

1. Start the capture server from this folder (no `npm install` needed):

   ```bash
   node capture_server.mjs
   ```

   or double-click `launcher/start-daidocs.bat`.

2. Load the extension: open `edge://extensions` or `chrome://extensions`, turn on
   Developer mode, click Load unpacked, and pick the `extension/` folder.

3. Accept the one-time consent, then use the on-page pill to turn capture on for
   the sites you want.

Full step-by-step instructions are in [GETTING-STARTED.md](GETTING-STARTED.md).

## Privacy

Capture is off by default, never touches sensitive sites (banking, health,
webmail, password managers), never captures what you type, and scrubs card
numbers and national IDs before anything is stored. It is for personal use only.
See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md).

## Licence

Governed by the repository `LICENSE` at the repo root.
