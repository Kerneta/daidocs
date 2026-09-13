# Security policy

## Reporting a vulnerability

Email **security@kerneta.com** with the details. Please do not open a public issue for
anything that could expose someone's memory store or credentials.

Include what you did, what happened, and what you expected. A proof of concept helps. We
will acknowledge within 5 working days and tell you what we intend to do.

## What this software touches

Worth knowing when assessing risk:

- **It reads and writes files on your machine**, under `~/DaiDocs` by default, overridable
  with `DAIDOCS_STORE`, or inside a project folder's `.daidocs/store` once that folder
  is declared.
- **It edits assistant configuration files** when you run `setup.js`: Claude Desktop's
  config, `.mcp.json` in a project folder, `~/.claude/settings.json`, and
  `~/.claude/CLAUDE.md`. Every file is backed up as `*.daidocs-bak` before it is touched,
  and `--unregister` reverses the file association and the reading protocol.
- **On Windows it writes user-scope registry keys** under `HKCU\Software\Classes` for the
  `.dai` file association. On Linux it writes MIME and icon files under
  `~/.local/share`. Neither needs administrator rights, and both are removed by
  `--unregister`.
- **It makes outbound API calls** to whichever observer model you configure, sending the
  content you ask it to index, but only through an API key you set. On a Claude
  subscription no background path makes one: the assistant writes the extraction
  itself. Reading a store makes no network call at all: retrieval is code over an index.

## Keys

API keys are stored **only** in the OS user environment: `setx` on Windows, a shell
profile export on macOS and Linux. No configuration file this project writes ever contains
a key, and none is logged.

If you find a path where a key reaches a file, a log or a `.dai` document, please report it
as a vulnerability. That is a bug we care about.

## Your store is plaintext

`.dai` files are readable text by design. That is the point of the format, and it is also
the main thing to understand about its security posture: **your store is exactly as
protected as the folder it sits in.** It is not encrypted at rest by this software. If
your history is sensitive, put the folder on an encrypted volume, and think before
committing one to a repository or syncing it to a cloud drive.

The `class.sensitivity` field in a file's frontmatter is a label for retrieval and review.
It is not an access control.

## Supported versions

The latest release on `main` is the supported version. This project is newly public and
moving quickly, so please upgrade before reporting.
