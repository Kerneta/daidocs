# Getting started with DaiDocs Memory Capture

Turn what you read into memory you own. This is a browser extension plus a small
local program that saves the pages and chats you choose to plain files on your own
computer, so any AI can recall them later. It is local, private, and encrypted if
you want it to be.

Setup takes about five minutes. No em dashes are used in this guide, per project rule.

## What it is

- **Stays on your machine.** This version keeps your data on your computer, and the developer never receives it. A separate cloud plan for collaboration may come later, opt-in and with its own add-on.
- **You choose what it saves.** Off by default, and it never captures banking,
  health, webmail, password managers, or what you type into a page.
- **Plain files you can open.** Readable text, optionally sealed in an encrypted vault.

## Before you start

- **Node.js** installed (the free LTS from https://nodejs.org). Check with `node --version`.
- This project folder on your computer. Every command below runs from it.
- A Chromium browser (Chrome or Edge) or Firefox.

## Step 1: Start the capture server

A small local program that writes the files. It must be running for anything to save.

**Easiest (double-click):** open the `launcher` folder and double-click
`start-daidocs.bat`. A window opens, you see it load, then you can minimise it. Keep
that window open: closing it stops capture until you launch it again.

**Terminal:** run this from the DaiDocs **program folder**, the one that contains
`capture_server.mjs`. This is not the same as your memory folder where captures
are saved (they have similar names). No `npm install` is needed, so either works:

```bash
node capture_server.mjs
```

```bash
npm run capture
```

To store your memory in a folder of your choice, set it first (Windows):

```bat
set DAIDOCS_STORE=C:\Users\you\Documents\Memory
npm run capture
```

On macOS or Linux:

```bash
DAIDOCS_STORE="$HOME/Documents/Memory" npm run capture
```

## Step 2: Load the extension in your browser

One-time. It stays until you remove it.

**Chrome or Edge:** open `edge://extensions` (or `chrome://extensions`), turn on
**Developer mode**, click **Load unpacked**, and pick the `extension` folder (the one
with `manifest.json` inside).

**Firefox:** open `about:debugging`, click **This Firefox**, then **Load Temporary
Add-on**, and pick `extension/manifest.json`. Temporary add-ons clear when Firefox
closes, so reload it next start.

After any reload of the extension, refresh open tabs (F5) so the fresh version runs.

## Step 3: Accept the one-time consent

Nothing is captured until you agree. A consent page opens on install. Read it, tick
the box, and click **Accept**. If you missed it, the on-page pill shows "tap to
accept", click it and accept.

## Step 4: Turn on encryption (optional but recommended)

Locks your captured files behind a password. Click the pill's gear, open
**Encryption**, type a password (8 or more characters) and click **Turn on
encryption**. From then on captures are encrypted, and you read them back with that
password. The password is never stored, so keep it safe.

You can also set the vault up from the terminal:

```bash
node vault.mjs init --password "your password here"
```

## Step 5: Use it

Capture is off per site by default. On a supported site the pill sits top-left. Click
it, or its gear, to turn capture on for that site. When it is saving it shows
"capture on".

Works out of the box on your AI chats (**ChatGPT, Claude, Gemini**) and your **X**
timeline. For other websites, open the gear, enable **All websites**, and grant the
one-time permission.

## Step 6: Read your memory back

Captured chats land in per-site folders in your store, for example `chat_chatgpt` and
`chat_gemini`. If you turned on encryption, open the gear and click **Open vault
reader**, enter your password, and browse the decrypted files. Nothing is written to
disk unencrypted, and locking clears the view.

## Terminal reference

Everything you can do without the buttons, run from the project folder.

```bash
# start the capture server (keep it running)
npm run capture

# set up the encrypted vault once (pick a strong password)
node vault.mjs init --password "your password here"

# see what is in the vault (counts only, no content)
node vault.mjs status

# read the vault out to plain files, then lock it again
node vault.mjs unlock --password "your password here"
node vault.mjs lock
```

## If something is not saving

- **The pill says "server offline".** The capture server is not running. Start it
  (Step 1). The pill turns green once it is up.
- **You reloaded the extension and it stopped.** Refresh the open tabs (F5).
  Reloading the extension orphans the old script on already-open pages, and a refresh
  loads the fresh one.
- **Nothing appears in the folder.** Check the pill is green and shows capture on for
  that site, that you accepted consent, and that the server window is still open. Chat
  files appear in `chat_<site>` inside your store.
- **Your antivirus warns about the launcher.** The launcher is a plain script that
  runs Node. Some antivirus tools are cautious about background helpers, so allow it
  once. It does not connect to the internet.

## What it never captures

What you type (form fields, drafts, passwords), and sensitive sites: banking,
payments, webmail, health, government, and password managers are on a built-in
never-capture list that cannot be overridden. Card numbers and national IDs are
scrubbed before anything is stored. It is for personal use only. See
[PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md) for the full detail.
