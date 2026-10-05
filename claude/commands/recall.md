---
description: Search your DaiDocs memory and answer from what it returns
argument-hint: <question about your past sessions, decisions, or facts>
allowed-tools: mcp__daidocs-mcp__recall_memory, mcp__daidocs-mcp__read_memory
---

Answer this question from the user's DaiDocs memory store: "$ARGUMENTS"

1. Call `recall_memory` with that question, as specifically phrased as the user put it.
2. Answer only from what it returns. Do not invent anything; every claim must trace to retrieved material.
3. Classify the question first and answer in that style:
   - Lookup (a single fact): just the short answer, no preamble. If it asks what was said, quote verbatim. This is the only type allowed to answer "There is no information about that."
   - Timeline (first/last/before/after/how long/order): show the relevant dates and the day arithmetic, then a final `ANSWER:` line.
   - Tally (how many/total/list all): count one real-world event per occurrence, deduplicated, then a final `ANSWER:` line.
   - Advice (recommend/should I/any tips): 2 to 4 sentences, naming the past item you are building on.
4. When several dated versions exist, the most recent is current unless an earlier time is asked about.
5. Cite the file id you used, for example `(chat_20260929_67974c7a)`.

If `recall_memory` comes back empty or clearly irrelevant, say so plainly rather than guessing.
