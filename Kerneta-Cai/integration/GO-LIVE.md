# Kerneta-Cai -> daidocs repo: supervised go-live runbook

Everything here changes the **live** product repo (and the website), so it is meant to be
run with you present, not unattended. Each step is reversible up to the push. Prepared by
the overnight session; the code tier itself is built, tested (49 assertions) and committed
in the standalone `kerneta` repo. Paths assume the Windows layout under `Desktop/Browser`.

Package name: distribution `kerneta-cai`, import package `kerneta_engine`, console command
`kerneta`, repo subdirectory `Kerneta-Cai/`.

## 0. Preconditions
- The daidocs clone `added7-launched-updated-live` is the locked master. Unlock it first.
- Use a Python 3.10 to 3.13 interpreter for testing (3.14 has no tree-sitter wheels yet).
  The known-good one here is `_archive-cai-pre-v5/kerneta-cai/.venv/Scripts/python.exe`.

## 1. Unlock the daidocs clone and sync
```
cd C:/Users/LENOVO/Desktop/Browser/added7-launched-updated-live
npm run unlock
git fetch origin
git switch -c feat/kerneta-cai-v5.1.1 origin/main   # work on a branch, not main
```

## 2. Fold the code tier in as Kerneta-Cai/
Copy the standalone repo's contents (not its .git) into a subdirectory:
```
mkdir Kerneta-Cai
cp -r ../kerneta/engine ../kerneta/bench ../kerneta/corpus \
      ../kerneta/pyproject.toml ../kerneta/requirements.txt \
      ../kerneta/kerneta_cli.py ../kerneta/README.md ../kerneta/CHANGELOG.md \
      ../kerneta/VERSION ../kerneta/FUTURE-TASKS.md ../kerneta/.gitignore Kerneta-Cai/
```
Do NOT copy `../kerneta/.git`, `store-*/`, `.cai-store/`, `*.egg-info/`, `.claude/`.

## 3. Apply Option B to the Node installer
- Copy `../kerneta/integration/daidocs/lib/code_tier.js` to `lib/code_tier.js`.
- Apply the two edits in `../kerneta/integration/daidocs/setup.patch.md` to `setup.js`.

## 4. Keep it out of the npm package
`package.json` uses a `files` whitelist, so `Kerneta-Cai/` ships to npm automatically-
excluded. Confirm `Kerneta-Cai` and `lib/code_tier.js` are not accidentally added to the
whitelist (code_tier.js lives in `lib/`, which IS whitelisted - that is fine and wanted,
it is a tiny Node file; the Python tree under `Kerneta-Cai/` is what must stay out, and it
is, because the whitelist names specific paths).

## 5. Full test (Python code tier)
```
PY=../_archive-cai-pre-v5/kerneta-cai/.venv/Scripts/python.exe
cd Kerneta-Cai
"$PY" bench/test_combined.py    # 14
"$PY" bench/test_history.py     # 17
"$PY" bench/test_setup.py       # 11
"$PY" bench/test_recursive.py   # 7
cd ..
```
Then the installed-package path (proves `pip install` + the `kerneta` command):
```
"$PY" -m pip install -e ./Kerneta-Cai
"$PY" -m kerneta_cli doctor      # expect: grammars OK, status ready
```
Then the Node Option B wrapper in dry form:
```
node -e "require('./lib/code_tier').offerCodeTier({here:process.cwd(),cwd:process.cwd(),log:console.log,ask:async()=>'n',ASK:false})"
```

## 6. Run the daidocs verify suite (must stay green)
```
npm run check
npm run verify
```
If either fails, stop and investigate before committing - the launched product must not
regress.

## 7. Commit (author Amin Rigi, NO Claude attribution)
```
git add Kerneta-Cai lib/code_tier.js setup.js
git commit -m "Add Kerneta-Cai code tier (V5.1.1) and offer it from setup"
git log -1 --format=%B | grep -iE "co-authored|generated with|noreply@anthropic" && echo "ATTRIBUTION - fix before push" || echo "clean"
```

## 8. Push, open PR, merge when happy
```
git push -u origin feat/kerneta-cai-v5.1.1
# open a PR to main; merge after review and CI.
```
Tag after merge:
```
git switch main && git pull && git tag kerneta-cai-v5.1.1 && git push --tags
```

## 9. Website (manual, IONOS)
Apply `../kerneta/integration/website/COPY.md` to `daidocs-site-live/index.html`
(and any served staging mirror), then deploy per `DEPLOY-IONOS.md`.

## 10. Optional: publish the Python package to PyPI
So the website's `pip install kerneta-cai` works for everyone:
```
cd Kerneta-Cai && "$PY" -m build && "$PY" -m twine upload dist/*
```
Until then the install is `pip install "git+https://github.com/Kerneta/daidocs#subdirectory=Kerneta-Cai"`.

## 11. Re-lock
```
cd .. && npm run lock
```
