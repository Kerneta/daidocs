# Quickstart

Five minutes, no prior knowledge assumed. If you only read one file in this repo, read
this one.

There are **two** steps people need, and the second one is the one everybody skips:

1. **Connect** the store, so your assistant can reach your memory.
2. **Activate reading**, so it reads that memory the efficient way.

Doing step 1 without step 2 works, but it reads whole files instead of the three zooms:
an order of magnitude more tokens **for no accuracy gain**. Both steps are below.

---

## Step 0. Get it on your machine

You need **Node 18 or newer**. Check with `node --version`. If that errors, install Node
from nodejs.org first.

The fastest way is one command, which fetches the tool and configures everything:

```bash
npx daidocs setup
```

**Prefer the source and the benchmark artifacts?** Clone it and run setup from the folder
instead. This is also the version to use if you want to reproduce the numbers:

```bash
git clone https://github.com/Kerneta/daidocs daidocs-app
cd daidocs-app
node setup.js
```

Each line is its own command. `setup.js` installs the dependencies on its first run
and then does step 1 below. `npm run setup` is the same thing, but on Windows
**use `node setup.js`**: PowerShell will not run npm at all until its execution
policy is changed, and node is not affected. Do not join the lines with `&&`
either: Windows PowerShell 5.1 treats that as a parse error.

## Step 1. Connect

That last command ran this for you:

```bash
node setup.js
```

It asks nothing. It finds what you have and configures all of it, backing up every file it
touches, and it is safe to run again later. Everything it switched on can be switched back:

```bash
node setup.js --status
```

lists what is on with the command that changes each one, and `node setup.js --restore` puts
the machine back exactly as it was. If you would rather decide each one as you go,
`node setup.js --ask` brings the questions back.

**Using an MCP client other than Claude?** One command each:

```bash
node setup.js --client codex
```

`cursor`, `windsurf`, `cline`, `continue` and `zed` work the same way, `--client list` shows
them with the file each one keeps its config in, and
`node setup.js --client generic --config <file>` handles anything not on the list. Nothing
here needs a config edited by hand.

**On a Claude subscription you need no key.** In Claude Code and Claude Desktop
the assistant that just read the conversation writes the extraction itself, so
saving is free and nothing is billed. Reading is local code over an index, and
on a subscription it shows the whole file index rather than a ranked shortlist,
and says so. Setup asks which model to use once, and that choice applies
everywhere afterwards.

**With an API key instead**, converting a conversation is one small model call,
about $0.003 with `gpt-4.1-mini`, and reading gains a ranked shortlist from a
single cached `text-embedding-3-small` call.

```bash
# Windows
setx OPENAI_API_KEY "sk-..."

# macOS / Linux
export OPENAI_API_KEY="sk-..."
```

`setx` writes the variable for **future** terminals, not the one you are in, so open a
new terminal before the next step or nothing will see the key.

## Step 1b. Bring in the history you already have

Setup does not do this on its own: it can run for a while, and with an API key it costs
money. But if you have been using Claude Code for months, this is what makes the store
useful today rather than a week from now:

```bash
node daidocs.js convert
```

It finds your Claude Code sessions, anything the hook captured but has not converted, or
a folder of exports you point it at. It shows what it found, asks which ones you want,
and quotes the worst-case cost before any paid call. On a Claude subscription that cost
is nothing. Each session lands in the folder it came from.

**Check it worked:**

```bash
npm run selftest
```

Every line should end PASS.

## Step 2. Activate reading

This is the step that gets skipped. Pick your row.

### If you use Claude Code

```bash
node setup.js --instructions
```

Done. It writes the reading protocol into `~/.claude/CLAUDE.md`, so every Claude Code
session on this machine reads stores correctly from now on. Nothing to remember, nothing
to paste. Undo it any time with `node setup.js --unregister`.

### If you use Claude Desktop

Settings, then Profile, then paste this in:

```
When I reference past work or preferences not in this conversation, call
recall_memory before answering, and read stores in three zooms: manifest first,
then a file's Understanding block, then specific segments only if needed.
```

### If you use claude.ai, ChatGPT, Gemini or a local model in a browser

1. Open [`prompts/READER-PROMPT.txt`](prompts/READER-PROMPT.txt).
2. Copy the whole thing.
3. Paste it as the first message of a new chat.
4. Then paste or attach your `_index/manifest.jsonl` (find it inside `~/DaiDocs/_index/`).
5. Ask your question.

When the assistant asks for a specific segment, give it that segment only. Do not paste
whole files to save a round trip: the round trip is the point.

### If you want it permanent in a browser assistant

Same prompt, but put it in the persistent instructions instead of pasting each time.

- **claude.ai**: new Project, paste into Project instructions, attach your manifest as
  project knowledge.
- **ChatGPT**: new Custom GPT, paste into Instructions, attach the manifest as Knowledge.
- **Gemini**: new Gem, paste into Instructions.

Re-attach the manifest when you add files. It is the only part that goes stale.

### If you are writing your own code against an API

Use `prompts/READER-PROMPT.txt` as the `system` prompt. Answer length caps that measured
best: lookup 220, advice 350, timeline 400, tally 400. Longer is worse, not better:
a raised budget invites hedging, and a hedged answer serves nobody.

---

## Step 3. Use it

Talk normally.

- *"save this chat to memory"*
- *"what did we decide about the deploy pipeline?"*
- *"what do you remember about my Valletta trip?"*

With the Claude Code hook installed, every session saves itself: every 4,000 new
tokens as you work, and again when it ends. Close the terminal early and the
unconverted part is kept in `_unconverted/` in the folder's store and read in at
the start of the next session there, verbatim, so it is usable before it is
converted. There is nothing to remember to do.

Your files live in `~/DaiDocs`, or inside the project folder once you declare
one. To declare it, type **make this folder a project** in a session there. Open the folder. Read them in Notepad. That is the product.

---

## Seeing what you have

```bash
npm run dashboard
```

Run it in the install folder, the one holding `package.json`. It writes
`daidocs-dashboard.html` beside `package.json` and opens it in whichever browser
you use by default. `--no-open` prints the path instead. Inside: every
store with its size, every memory with its date and what it is connected to, the
sessions captured but not yet converted grouped by which project they came from,
and the project folders themselves as a tree. Clicking a memory opens it in full,
including the verbatim original the extraction was made from.

The page is built, not served. Everything it shows is read from your files and
embedded in the one file, so it works offline and needs no process running. That
also means it is a snapshot: rebuild it when you want current numbers.

It is built from YOUR store, so it contains your memories, your transcripts and
your folder paths. Treat a built page the way you would treat the store itself,
and do not put one in a repository. That is why the release ships the builder and
never a built page.

---

## Did it work?

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm.ps1 cannot be loaded because running scripts is disabled on this system` | PowerShell's default execution policy blocks npm's own script. It blocks every npm command, not just this one | Use `node setup.js`, which is not affected. To let npm run at all: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (no admin needed) |
| `destination path 'daidocs' already exists and is not an empty directory` | You are cloning from your home folder, and `daidocs` there is your memory store: `DaiDocs` and `daidocs` are one folder on Windows and macOS | Clone with a name of its own, `git clone <url> daidocs-app`. Do not delete the existing folder: it holds your memories |
| `could not create work tree dir 'daidocs': Permission denied` | You are in `C:\\Users`, which Windows does not let you write to | Clone inside your own folder, for example `C:\\Users\\<you>\\Documents` |
| Setup did something you did not want | It configures everything by default | `node setup.js --status` names the command that turns each one off; `--restore` undoes the lot |
| Your other MCP client cannot see the tools | It was not configured, or it is not one setup detects | `node setup.js --client <name>`, or `--client generic --config <that client's config file>` |
| `The token '&&' is not a valid statement separator in this version` | Windows PowerShell 5.1, which has no `&&` | Run each command on its own line, or use `npm run setup` |
| Claude says it has no memory tools | Server not registered, or the app was not restarted | `node setup.js --desktop`, then fully quit and reopen the app |
| Claude Code never offers the tools | `.mcp.json` is in a different folder, or the server was not approved | `node setup.js --code --project /path/to/repo`, then approve `daidocs-mcp` when the session starts |
| Answers are right but slow and expensive | Step 2 was skipped, so it is reading whole files | `node setup.js --instructions` |
| Counting questions come out wrong | It is counting from prose instead of the event table | Step 2 again. That rule is in the protocol |
| Recall does not know about a recent session | It is not converted yet. Recall shows it under "Not yet converted" and answers from it, and the next session in that folder starts with it | Say "convert my pending sessions", free on a subscription; or `npm run catch-up` with a key |
| It answers "I do not have information about that" too often | Step 2 was skipped, so abstention is not scoped | `node setup.js --instructions` |
| Your API bill is far higher than expected | You are calling the engine directly, and it does not configure prompt caching | Add `cache_control` to your own calls. Through MCP in Claude Code or Desktop the host does this for you |

Nothing lost either way: sessions are captured verbatim even with no key set, and
`npm run catch-up` indexes them later.

## Changed your mind?

```bash
node setup.js --restore
```

Puts every file setup touched back exactly as it was, including your `CLAUDE.md` and your
Claude Desktop config, and deletes the ones it created from nothing. Your store is not
touched: your memory stays in `~/DaiDocs` whether or not the tooling is installed. That is
the point of plain files.

---

## What to read next

| You want | Read |
|---|---|
| The full reading guide, per surface | [`docs/READ-DAIDOCS.md`](docs/READ-DAIDOCS.md) |
| What a `.dai` file actually is | [`spec/DAIDOCS-STANDARD.md`](spec/DAIDOCS-STANDARD.md) |
| To use `.dai` in any chat window, no install | [`prompts/READER-PROMPT.txt`](prompts/READER-PROMPT.txt) |
| To reproduce our benchmark numbers | [`docs/REPLICATION.md`](docs/REPLICATION.md) |

---

## Everything else

This page is the short version. [`docs/GUIDE.md`](docs/GUIDE.md) is the full
reference: every command and what it is for, the six tools your assistant gets,
the seven folder types and when to use each, what happens to a session that is
too short to convert, how to convert the ones you already have, confidential
folders, backups, and what to check when something is wrong.
