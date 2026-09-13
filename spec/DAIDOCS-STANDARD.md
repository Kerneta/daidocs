# The `.dai` format

**Version 4.4 · Apache-2.0 · normative**

A `.dai` file is a plain-text document holding one source of memory: a conversation, a
note, a transcript. It is UTF-8, readable in any editor, greppable, diffable, and
committable to git.

This document describes exactly what the reference engine in this repository writes and
reads. Where any prose here disagrees with `lib/methods/daidocs-v44n`, **the engine is
authoritative and this document is the bug**. Please open an issue.

---

## 1. The store

```
store/
  chat_20260720_e0546121.dai      one file per source
  doc_20260518_1b4f0e98.dai
  _index/
    manifest.jsonl                one line per file: the retrieval surface
    facts.jsonl                   dated atomic facts
    events.jsonl                  countable occurrences
    profile.jsonl                 stated preferences
  _raw/
    chat_20260720_e0546121        the original, byte-exact, never rewritten
```

A writer may keep a sibling `_unconverted/` folder for text it has captured but
not yet turned into a `.dai`, so a reader can use it before conversion. That is
working state, not part of the format: nothing in it is indexed, and it is empty
whenever conversion is up to date.

Two properties define the format:

**Everything derived is rebuildable.** `_index/` is a projection of the `.dai` files, and
the `.dai` files are anchored to `_raw/`. Delete the index and it can be regenerated.
Nothing is discarded at write time, which is why a better reader improves answers about
history that was written years earlier.

**No query path requires a database or a server.** Retrieval is code over plain files,
with one declared external dependency: the reference reader calls an embedding API to
rank what the answering model sees, caches the vectors on disk, and degrades to lexical
selection with a visible warning when the API is unavailable. The format itself needs
nothing but file reads.

### 1.1 File identity

```
<type>_<YYYYMMDD>_<hash8>.dai
```

`type` is the source kind (`chat`, `doc`), `YYYYMMDD` is the capture date, and `hash8` is
the first 8 hex characters of a hash of the source id. The same id is used as the
filename, the `id` frontmatter field, and the `_raw/` filename.

### 1.2 File extension and media type

The extension is **`.dai`**.

The media type is `text/vnd.dai`, which `setup.js` registers with Windows
and with the freedesktop MIME database on Linux. **It is not yet registered with IANA**,
and the registration draft is prepared: see [`docs/IANA-REGISTRATION.md`](../docs/IANA-REGISTRATION.md)
for the filing text and the reasoning. Treat the string as provisional until that lands,
and do not hard-code it anywhere you cannot cheaply change.

A `.dai` file is a subtype of plain text. Any reader that does not recognise the type at
all should treat it as `text/plain` and will still see legible content.

---

## 2. Anatomy of a `.dai` file

Three zones, always in this order: frontmatter, `# Understanding`, `# Content`.

```
---
daidocs: "4.4"
id: "chat_20260720_e0546121"
type: "chat"
title: "Valletta trip planning chat"
lang: "en"
source: {"app": "daidocs", "native_id": "sess-4471"}
span: null
messages: 12
class: {"category": "general", "priority": "normal", "actionable": false, "sensitivity": "public", "confidence": 0.9}
summary: "User booked a summer trip to Valletta staying at Casa do Rio."
tags: ["x.travel"]
raw: "_raw/chat_20260720_e0546121"
extracted_by: "daidocs-v44n"
---

# Understanding
```json
{ ... }
```

# Content

## [seg 1/3]
USER: I booked Valletta for July.
...
```

### 2.1 Frontmatter

YAML between `---` fences. Values are JSON-escaped, so a title containing a quote or a
colon is safe.

| field | type | meaning |
|---|---|---|
| `daidocs` | string | **format version.** `"4.4"` |
| `id` | string | the file's identity, matches the filename |
| `type` | string | source kind: `chat`, `doc` |
| `title` | string | human label |
| `lang` | string | ISO language code |
| `source` | object | `{"app": string, "native_id": string}`: where it came from |
| `span` | null or object | time span covered, when known |
| `messages` | number | segment count in `# Content` |
| `class` | object | `category`, `priority`, `actionable`, `sensitivity`, `confidence` |
| `summary` | string | one sentence |
| `tags` | array | 2 to 5 controlled tags |
| `raw` | string | path to the byte-exact original |
| `extracted_by` | string | which engine produced this file |

**`daidocs` is metadata, not a gate.** The engine does not branch on it and will read a
file whose version differs. It exists so tooling and humans can tell what produced a file.

### 2.2 `# Understanding`

A fenced ```json block. This is the zone retrieval reads, and it is why answering a
question does not require re-reading the source.

| key | type | meaning |
|---|---|---|
| `entities` | object | `{"people":[], "orgs":[], "dates":[], "amounts":[], "places":[]}` |
| `actions` | array | actions taken |
| `facts` | array | 4 to 10 objects, up to 14 when durable facts would otherwise be crowded out, see below |
| `events` | array | countable occurrences, see below |
| `preferences` | array | explicitly stated preferences or constraints |
| `tags` | array | 2 to 5, from the store's controlled vocabulary |
| `decisions` | array | decisions reached |
| `topics` | array | 4 to 8 lowercase strings |
| `summary` | string | one sentence, at most 40 words |
| `sentiment` | string | one word |
| `open_questions` | array | unresolved threads |

**A fact:**

```json
{"fact": "Passport expires 2027-03-14", "date": "2026-07-20", "kind": "attribute"}
```

`kind` is one of `event`, `attribute`, `preference`, `plan`. Relative dates are resolved
against the source date at extraction time, and `date` is `null` when no date can be
established. A `plan` is an intention, and is never evidence that something happened.

**An event** is one row per countable real-world occurrence:

```json
{"date": "2026-07-20", "cat": "trip", "what": "flew to Valletta"}
```

`cat` comes from a closed vocabulary:

`appointment`, `purchase`, `trip`, `meal_out`, `workout`, `entertainment`, `social`,
`errand`, `incident`, `other`

Events are what counting questions read. Discussing or asking about something is **not**
an event: a conversation topic is not an occurrence.

### 2.3 `# Content`

The cleaned source, split into numbered segments so a reader can load part of a file.

```
# Content

## [seg 1/3]
USER: I booked Valletta for July.
ASSISTANT: Noted.

## [seg 2/3]
...
```

**The segment header is strict.** The parser is:

```js
/## \[seg \d+\/\d+\]\n([\s\S]*?)(?=\n## \[seg |\n*$)/g
```

Three consequences that will bite anyone hand-authoring a file:

1. The keyword is **`seg`**, not `msg`.
2. A **newline must immediately follow the closing bracket**. `## [seg 1/3] Alice - 10:02`
   does not match, and the segment is silently dropped.
3. Numbering is `n/N`, both integers.

A file whose headers do not match parses to **zero segments**. Nothing errors: the
frontmatter and Understanding zone still load, but no verbatim excerpt is ever retrievable
from that file. If you generate `.dai` files with your own tooling, assert that the
segment count you wrote is the count that parses back.

---

## 3. The index

Every file in `_index/` is JSONL, one object per line, appended as files are ingested.

### `manifest.jsonl`

One line per `.dai` file. This is the first thing retrieval reads, and often the only
thing.

```json
{"id":"chat_20260720_e0546121","path":"chat_20260720_e0546121.dai","type":"chat","title":"Valletta trip planning chat","date":"2026-07-20","summary":"...","topics":["travel","valletta"],"entities":["Valletta","Casa do Rio"],"attrs":[],"tags":["x.travel"]}
```

### `facts.jsonl`

Dated atomic facts across the whole store, which is what temporal questions read.

```json
{"date":"2026-07-20","dated":true,"fact":"Passport expires 2027-03-14","kind":"attribute","entities":["passport"]}
```

`fact` is truncated to 200 characters. `dated` distinguishes a real date from an inferred
one.

### `events.jsonl`

One row per countable occurrence, the counting surface.

```json
{"date":"2026-07-20","cat":"trip","what":"flew to Valletta"}
```

### `profile.jsonl`

Stated preferences, dated.

```json
{"date":"2026-07-20","preferences":["prefers aisle seats","avoids early flights"]}
```

---

## 4. Reading a store

The protocol is measured, not stylistic. Reading whole files instead of the three zooms
costs an order of magnitude more tokens **for no accuracy gain**.

**Read in three zooms and stop at the shallowest one that answers the question.**

1. **`_index/manifest.jsonl`.** Always start here. Pick the one to three files that match.
2. **That file's frontmatter and `# Understanding` block.** Most questions are fully
   answered at this zoom.
3. **Specific `## [seg n/N]` blocks, by number.** Only for exact wording or a detail the
   Understanding omits. Never read a whole `# Content` zone.

**Classify the question first, then answer in that type's style.** Misrouting between
types is the single largest source of wrong answers.

The four names below are **lookup**, **tally**, **timeline** and **advice**, and those are
the exact strings the engine's `classify()` returns. They name the reading strategy,
not any dataset's question taxonomy: a deliberate choice, so that nobody can mistake
the engine's routing vocabulary for a benchmark's metadata.

- **Lookup** (one fact): the short answer only, no preamble. If the question asks what was
  *said*, quote verbatim from `# Content`. This is the only type permitted to answer that
  the information is not present.
- **Timeline** (first, last, before, after, how long, order): load `facts.jsonl`, show the
  dates and the day arithmetic visibly, then a final `ANSWER:` line. Terse temporal answers
  produce arithmetic errors.
- **Tally** (how many, total, list all): count from `events.jsonl`, one row per real
  occurrence, deduplicated. Exclude rows that merely record discussion of a topic.
  Cross-check against excerpts, then `ANSWER:`.
- **Advice** (recommend, should I, any tips): load `profile.jsonl`, answer in two to
  four sentences, name the past item you are building on, and suggest something new rather
  than echoing back what the user already said. Never decline this type.

Always: never invent; the most recent dated version is current unless an earlier time is
asked about; "previous" means one step before current.

The full guide is [`docs/READ-DAIDOCS.md`](../docs/READ-DAIDOCS.md), and the same rules
ship as a paste-anywhere prompt in [`prompts/READER-PROMPT.txt`](../prompts/READER-PROMPT.txt).

---

## 5. Writing a store

One metered model call per source document produces the Understanding zone. Everything
else is deterministic code. Retrieval afterwards spends **zero** model tokens.

The reference implementation is `lib/methods/daidocs-v44n`. To produce files another
implementation can read, you must:

- write the three zones in order, with the exact segment header form in §2.3
- emit the Understanding keys in §2.2, with `cat` drawn from the closed event vocabulary
- append a `manifest.jsonl` line per file, since a file with no manifest line is invisible
  to retrieval
- preserve the original under `_raw/`

`ingestSignature` in the engine identifies the shape of what ingest writes. Any change to
what is written must bump it, or tooling will reuse stores in the previous shape.

---

## 6. Conformance

A conforming **reader** loads the three zones, tolerates unknown frontmatter fields and
unknown Understanding keys, and does not fail on a `daidocs` version it does not
recognise.

A conforming **writer** produces the zones in order, matching segment headers, and a
manifest line per file.

The format is deliberately small. If you can implement it in an afternoon in your language
of choice, that is the intended difficulty, and an independent implementation is the most
valuable contribution this project can receive.

---

## 7. Licence

The specification and the reference implementation are **Apache-2.0**, including a patent
grant. Contributions are taken under DCO sign-off with no CLA, which means the maintainers
do not hold the rights to relicense your work. That is deliberate.
