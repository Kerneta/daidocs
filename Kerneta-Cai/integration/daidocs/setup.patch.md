# Option B patch: offer the code tier during `node setup.js`

Two edits to `setup.js` in the daidocs repo, plus the new file `lib/code_tier.js`
(in `integration/daidocs/lib/code_tier.js`, copy it to the repo's `lib/`). The edits
are minimal on purpose: all logic lives in the module.

## 1. Add the require

Find this line near the top (the other `lib/` requires):

```js
const S = require('./lib/stores');
```

Add immediately after it:

```js
const CODE = require('./lib/code_tier');
```

## 2. Call it near the end, while the prompt is still open

Find the existing convert prompt in the final async block:

```js
  const convertNow = ASK && (await ask('\nConvert existing chat history into memory now? [Y/n] ')).toLowerCase() !== 'n';
```

Insert, on the line **before** it:

```js
  // Option B: offer the Kerneta-Cai code tier (.cai) in the same flow. Never blocks
  // or breaks setup; prints a one-liner in silent mode, offers to install in --ask.
  try { await CODE.offerCodeTier({ here: HERE, cwd: process.cwd(), ask, log, ASK }); } catch (_) {}
```

`ask`, `log`, `ASK`, `HERE` are already defined in that scope, and the prompt is
still open (it is closed by `closeAsk()` a few lines later). The `try/catch` matches
the install-ping discipline: the code tier is a bonus, never a failure point.

## 3. What the user sees

- Default (`npx daidocs setup`, no `--ask`): after the docs+history install, a line:
  `Code memory (.cai) available. To add it: py -3 -m pip install "<repo>/Kerneta-Cai" && kerneta setup . --corpus .`
- `npx daidocs setup --ask`: an offer; on yes, it pip-installs the local `Kerneta-Cai`
  package and runs `kerneta setup`, wiring the store + skill + auto-refresh hook.
- No Python, or Python < 3.10: a line telling them what to install first. Setup always
  finishes cleanly regardless.

This does not add anything to the npm `files` whitelist, so `npm install daidocs`
is unchanged. The code tier ships only in the git repo under `Kerneta-Cai/`.
