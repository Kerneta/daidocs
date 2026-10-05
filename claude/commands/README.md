# DaiDocs slash commands for Claude Code

These are the source copies of the DaiDocs Claude Code slash commands. `node
setup.js` installs them into `~/.claude/commands/` (so they work in every
project), and a project-scoped install (`node setup.js --project-scope`) also
copies them into `<repo>/.claude/commands/` so they travel with the repo.

| Command | What it does |
| --- | --- |
| `/recall <question>` | Searches your `.dai` memory with `recall_memory` and answers from it, following the reading protocol. |
| `/remember <fact>` | Saves a fact or note with `save_memory`, writing the extraction itself so it needs no API key. |

They are thin prompt templates over the `daidocs-mcp` tools, so the MCP server
must be registered (it is, after a normal `node setup.js`). `$ARGUMENTS` is
whatever you type after the command name.

To install or remove them without the rest of setup:

```
node setup.js --commands      # install just the slash commands
node setup.js --restore       # remove everything setup added, these included
```

Editing a command here and re-running `node setup.js --commands` updates the
installed copy. Any file you already had at the same path is backed up as
`<name>.md.daidocs-bak` first, and `--restore` puts it back.
