# DaiDocs capture server launcher

The capture server must be running for the extension to save anything. This
folder gives you an on-demand way to start it: press start, watch it load, then
minimise the window. Closing the window stops capture (the extension's Server
section will then say "Not running" until you launch it again).

No em dashes, per project rule.

## Use it

- Double-click `start-daidocs.bat`. It runs Node directly (plain cmd, no
  PowerShell and no execution-policy bypass, so it has the lowest antivirus-flag
  profile). You see it load; when the server prints its "on http" line, minimise
  the window. Closing it stops capture.
- `start-daidocs.ps1` is an OPTIONAL nicer version with more troubleshooting and a
  health check. Run it only if you want it: right-click -> Run with PowerShell.
  Note: PowerShell may need its execution policy set, and antivirus tools are
  more suspicious of PowerShell scripts, so the plain .bat is the default.

If the server cannot start, the window prints the likely problem and fix (Node
missing, port in use, dependency missing).

## Make it one click from your desktop

Right-click `start-daidocs.bat` -> Send to -> Desktop (create shortcut). Now a
double-click of that shortcut starts capture whenever you want it.

## One-click FROM the extension (needs a one-time setup)

The extension has a Server section with a "Try to launch" button. A browser
extension is not allowed to start a program by itself, so that button only works
after you install the native-messaging helper once (it lets the browser launch
this server on request). That helper is not installed yet; until it is, use the
`.bat` above. See the TODO "one-click launch via native messaging" item.

## Port

Default 41100. To use another port, set `DAIDOCS_CAPTURE_PORT` before launching
and set the same port in the extension Options.
