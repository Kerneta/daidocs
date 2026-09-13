# IANA media type registration

**Status: drafted, not yet submitted.** Verified against IANA's live registry on
2026-08-07: the `text/*` registry contains no subtype with `dai` anywhere in it, so
`text/vnd.dai` is free. No submission has been made and no review clock has started.

Submit at <https://www.iana.org/form/media-types>. The vendor tree (`vnd.`) needs no
standards action and no fee, only expert review. Expect a few weeks.

**Why it matters.** Per-OS icon registration only ever affects machines where our
installer ran. A registered media type is the one genuinely universal step: it is what
every downstream implementer, OS packager, editor plugin and web server cites, and the
Linux MIME declaration already shipped in `setup.js` refers to this exact string.

---

## The string: `text/vnd.dai` (decided)

Verified free on 2026-08-07: the `text/*` registry contains no subtype with `dai` anywhere
in it. The only `vnd.d*` entries are `vnd.debian.copyright`, `vnd.DMClientScript` and
`vnd.dvb.subtitle`.

Why this one, over the alternatives considered:

| candidate | verdict |
|---|---|
| `application/vnd.daidocs+text` | rejected. `+text` is **not** on IANA's registered structured-suffix list, so a reviewer would query it |
| `application/vnd.daidocs` | rejected. Loses the signal that the payload is human-readable text |
| `text/vnd.daidocs` | rejected. Names the implementation rather than the format |
| `text/dai` | **unavailable.** An unfaceted name sits in the standards tree, see note 4 |
| **`text/vnd.dai`** | **chosen** |

Three reasons:

1. **A media type names the format, not the implementation.** The format is `.dai`;
   DaiDocs is the reference implementation that writes it. `text/vnd.dai` beside a file
   called `notes.dai` needs no explanation.
2. **The `text/` top level is load-bearing.** It makes a browser or mail client render a
   `.dai` file as readable text instead of offering an opaque download, which is this
   project's central claim. It also matches what the Linux declaration already asserts
   with `sub-class-of text/plain`.
3. **It avoids the suffix objection entirely**, with nothing contested to defend.

The string is live in `setup.js` (the Windows `Content Type` value and the Linux MIME
XML), from which the Linux icon filename `text-vnd.dai.svg` is derived, and in the Windows
registry of every machine where setup has run. Machines registered under the previous
string pick up the new value on the next `node setup.js --icon`; the stale icon file under
`~/.local/share/icons/` on Linux is harmless and can be deleted by hand.

---

## Form fields

**Type name:** text

**Subtype name:** vnd.dai

**Required parameters:** none

**Optional parameters:** none

**Encoding considerations:**
Text. Files are UTF-8 encoded and line-oriented. The format is 8-bit clean and safe for
transports that handle UTF-8; base64 encoding is unnecessary but harmless.

**Security considerations:**
A `.dai` document is inert data and is not executable. It contains no scripting, macro or
external reference mechanism, and a conforming reader performs no network access while
parsing.

Two risks belong to the content rather than the format. First, documents are produced by
summarising a user's conversations or files, so a document may contain personal or
confidential material, and it should be given the same protection as the source it was
derived from. Second, the `# Understanding` zone holds text extracted by a language model,
so a reader that passes that text to another model should treat it as untrusted input and
not as instructions. The `# Content` zone preserves the cleaned original, which allows a
reader to verify any extracted claim against the source rather than trusting the
extraction.

Implementations should apply ordinary limits on document size and parse depth. The JSON
zone is a single object and is not self-referential, so cyclic-structure attacks do not
apply.

**Interoperability considerations:**
The format is plain UTF-8 text with three ordered zones, so a reader that understands only
part of a document can still read the rest, and an unaware reader sees legible text rather
than a binary blob. Documents are versioned by the `daidocs` key in the YAML header,
allowing readers to identify the format revision a document was written against. The
reference implementation treats that key as informational and does not reject documents on
it.

**Published specification:**
[`spec/DAIDOCS-STANDARD.md`](../spec/DAIDOCS-STANDARD.md) in the public repository at
<https://github.com/Kerneta/daidocs>, and <https://daidocs.com>.

**Applications which use this media type:**
DaiDocs (Kerneta), and any client reading a `.dai` store through the Model Context
Protocol, including Claude Desktop and Claude Code.

**Fragment identifier considerations:** none

**Additional information:**
- Deprecated alias names: none
- Magic number(s): none. Documents begin with a YAML front-matter delimiter `---`, which
  is indicative but not a reliable magic number.
- File extension(s): **.dai**
- Macintosh file type code(s): none
- Object Identifiers: none

**Person and email address to contact for further information:**
Kerneta, hello@kerneta.com

**Intended usage:** COMMON

**Restrictions on usage:** none

**Author:** Kerneta

**Change controller:** Kerneta

---

## Checklist before submitting

1. **The string is settled:** `text/vnd.dai`. Re-confirm it is still unregistered
   immediately before filing, since the registry moves.
2. **The published-specification URL must resolve at submission time.** This is now
   satisfied: `spec/DAIDOCS-STANDARD.md` is in the public repository and is a stable
   permalink. Confirm the repository is public before filing.
3. **Consistency check when the string is final:** it appears in `setup.js` (the Windows
   `Content Type` value and the Linux MIME XML), in the Linux icon filename, and in this
   document. All must match.
4. **The vendor tree is the right tree, and an unfaceted name is not available.** A name
   with no prefix, such as `text/dai`, sits in the **standards tree**, and RFC 6838 §3.1
   requires those to be "approved directly by the IESG" or registered by "a recognized
   standards-related organization", with the proposal "published as an RFC". That is a
   standards process measured in months, not a form, and a new single-vendor format would
   be directed to the vendor tree anyway.

   The vendor tree needs none of that: RFC 6838 §3.2 allows registration "by anyone who
   needs to interchange files associated with some product", submitted straight to IANA
   under Expert Review.

   `text/dai` is the name to want eventually. RFC 6838 does not describe a migration path
   from the vendor tree to the standards tree, so assume the registered vendor name is
   permanent, and that an unfaceted name would mean a fresh standards-track registration
   once `.dai` has independent implementations and adoption to justify one.
