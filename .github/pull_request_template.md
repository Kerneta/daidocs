### What this changes

### Why

### Checklist

- [ ] Commits are signed off (`git commit -s`). No CLA, DCO only. See `CONTRIBUTING.md`.
- [ ] `npm run verify` and `npm run check` pass, free and offline
- [ ] No `.dai` store, key or `*.daidocs-bak` file is included (`git status` checked)

### If this touches the reader, the ingest prompt or the shipped prompts

Reader changes routinely look correct and measure worse, so numbers are required here.

- Question set used:
- Score before:
- Score after:
- Actor, observer and judge models:

If you changed `prompts/READER-PROMPT.txt` or `prompts/CLAUDE-MD-BLOCK.md`, note that each
line traces to a measured change. Say which measurement supports the edit.
