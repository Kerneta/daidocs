---
description: Save a fact or note to your DaiDocs memory store (no API key needed)
argument-hint: <the fact or note to remember>
allowed-tools: mcp__daidocs-mcp__save_memory
---

Save this to the user's DaiDocs memory so it is recalled in future sessions:

"$ARGUMENTS"

Call `save_memory` with:
- `content`: the text above, kept in full.
- `type`: `note`.
- `title`: a short descriptive title you write from the content (for example "note about the staging deploy key").
- `understanding`: write the extraction yourself rather than leaving it to an observer, so the save costs no API call. Include at least `summary`, `facts` (each with a `kind` of event, attribute, preference, or plan), `topics`, and `tags`. Resolve any relative dates (today is the content date unless the note says otherwise) to absolute `YYYY-MM-DD`.

Then confirm in one line what was saved and the id it was stored under. Do not restate the full note back to the user.
