# Website rewrite copy (daidocs-site-live), for the unified code + docs + history story

Target: `daidocs-site-live/index.html` (the daidocs.com source; deploys to IONOS).
These are drop-in copy blocks keyed to the current anchors. Deploy is manual (IONOS),
so this is paste-and-publish, to be done with you present.

## 1. Hero headline (line ~127)

Current:
```html
<h1 class="reveal">Your AI's memory, <span class="grad-text">as files you own</span>.</h1>
```
Rewrite to carry all three tiers:
```html
<h1 class="reveal">One memory for your AI: <span class="grad-text">code, docs and history</span>, as files you own.</h1>
```

## 2. Install block (lines ~130 to ~134)

Keep the one-line default, and make the two-tier model explicit in the note.

Default command stays:
```html
<pre><code><span class="p">$</span> npx daidocs setup</code></pre>
```
Replace the install-note with:
```html
<p class="install-note reveal">Node 18+. One command sets up document and session memory: it detects Claude Desktop, Claude Code, Cursor, Windsurf, Codex, Cline, Continue and Zed, configures them, installs the session hooks and the reading protocol, and backs up every file it touches. On a Claude subscription there is no API key and nothing to pay. Want <b>code memory</b> too (a plain-text code graph the agent queries instead of re-reading files)? Add the code tier with Python: <code>pip install kerneta-cai</code> then <code>kerneta setup . --corpus .</code>, or just answer yes when <code>npx daidocs setup --ask</code> offers it. <a href="docs.html#install">Full install guide</a></p>
```

## 3. New section: "Code, docs and history, one router"

Add a short section after the hero (before the format section at `#s-top`'s sibling).
Copy:

> **Three kinds of memory, one system that knows which to use.**
> DaiDocs remembers your **documents** and your **past sessions** as plain `.dai` files.
> The Kerneta-Cai code tier adds a deterministic `.cai` **code graph** (10 languages).
> One router answers across all three: ask "what calls this function" and it reads the
> code graph; ask "what did we decide last week" and it reads your history; ask "which
> spec covers this" and it crosses code to docs. Every tier is plain text you own, no
> vector database, and the code tier refreshes itself after every edit.

## 4. Why two installs (honest note for the docs/install page)

> DaiDocs (documents + history) installs with `npx daidocs setup` because it runs on
> Node. The code tier is Python (it uses tree-sitter), so it installs with
> `pip install kerneta-cai`. Different languages, one repo, one router. `npx daidocs
> setup --ask` can run both for you in a single flow.

## 5. Changelog / what's new line

> v5.1.1: code memory joins documents and history under one router. Recursive indexing,
> cross-package call resolution, and auto-use + auto-refresh in Claude Code.

## Notes
- `pip install kerneta-cai` assumes a PyPI publish of the package named `kerneta-cai`.
  Until then, use `pip install "git+https://github.com/Kerneta/daidocs#subdirectory=Kerneta-Cai"`.
- Do the same edits on any staging mirror (`daidocs-site`, `daidocs-site-4185`) that is
  actually served, then deploy per DEPLOY-IONOS.md.
