"""CLI shim: drives the Node DaiDocs engine via ``npx`` so ``daidocs setup``/``convert``
behave like ``npx daidocs``. Node 18+ required; if missing, offers to install it (via the OS
package manager, after confirmation). Uses the system Node so Claude Code hooks and the
Claude Desktop MCP server, which Claude launches itself, find it on PATH."""

import os
import platform
import shutil
import subprocess
import sys

MIN_NODE_MAJOR = 18


def _node_major():
    """Return Node's major version as an int, or None if Node is unusable."""
    node = shutil.which("node")
    if not node:
        return None
    try:
        result = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=15
        )
    except Exception:
        return None
    version = (result.stdout or "").strip().lstrip("vV")
    try:
        return int(version.split(".")[0])
    except (ValueError, IndexError):
        return None


def check_node():
    """True if Node >= MIN_NODE_MAJOR and npx are both available."""
    major = _node_major()
    return major is not None and major >= MIN_NODE_MAJOR and shutil.which("npx") is not None


def _install_plan():
    """Return (auto_command, human_label) for installing Node on this OS.

    auto_command is a list to run, or None when there is no safe automatic
    installer and we can only show guidance.
    """
    system = platform.system()
    if system == "Windows":
        if shutil.which("winget"):
            cmd = ["winget", "install", "-e", "--id", "OpenJS.NodeJS.LTS"]
            return cmd, " ".join(cmd)
        if shutil.which("choco"):
            cmd = ["choco", "install", "nodejs-lts", "-y"]
            return cmd, "choco install nodejs-lts"
        return None, "Download the LTS installer from https://nodejs.org/"
    if system == "Darwin":
        if shutil.which("brew"):
            cmd = ["brew", "install", "node"]
            return cmd, "brew install node"
        return None, "Install with Homebrew (brew install node) or from https://nodejs.org/"
    # Linux and everything else: package managers vary and need sudo, so guide
    # rather than run something without knowing the distro.
    return None, "Install Node 18+ from your package manager or https://nodejs.org/"


def _ensure_node():
    """Ensure Node is usable. If not, explain and offer to install it.

    Returns True if Node is available (now or after a successful install).
    """
    if check_node():
        return True

    auto_cmd, label = _install_plan()
    sys.stderr.write(
        "DaiDocs needs Node {min}+ and it was not found.\n"
        "The DaiDocs engine runs on Node; this command drives it, and the full\n"
        "setup (Claude Code hooks and the Claude Desktop MCP server) needs Node\n"
        "on your system.\n\n".format(min=MIN_NODE_MAJOR)
    )

    interactive = bool(getattr(sys.stdin, "isatty", lambda: False)())

    if auto_cmd and interactive:
        sys.stderr.write("Install Node now with:  {}\n".format(label))
        try:
            answer = input("Run this now? [y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            answer = ""
        if answer in ("y", "yes"):
            sys.stderr.write("\nInstalling Node, follow any prompts from the installer...\n")
            try:
                subprocess.call(auto_cmd)
            except Exception as exc:  # pragma: no cover
                sys.stderr.write("The install command could not run: {}\n".format(exc))
            if check_node():
                sys.stderr.write("Node is ready.\n\n")
                return True
            sys.stderr.write(
                "\nNode was installed but is not on this shell's PATH yet.\n"
                "Close and reopen your terminal, then run the command again.\n"
            )
            return False
        sys.stderr.write("\nInstall Node yourself, then run this again:\n  {}\n".format(label))
        return False

    # No safe auto installer, or not an interactive terminal (do not hang).
    sys.stderr.write(
        "Install Node (LTS) and run this again:\n  {}\n"
        "Verify with:  node --version\n".format(label)
    )
    return False


def main(argv=None):
    """Entry point for the ``daidocs`` console script. Returns an exit code.

    Requires Node; if it is missing, offers to install it, and exits non-zero
    if Node is still unavailable afterwards.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    if not _ensure_node():
        return 1
    npx = shutil.which("npx")
    # Tag the surface so an install driven through pip is counted as "pip",
    # not lumped into the npm bucket. The Node engine's install ping reads
    # DAIDOCS_SURFACE (lib/install_ping.js).
    env = {**os.environ, "DAIDOCS_SURFACE": "pip"}
    try:
        return subprocess.call([npx, "-y", "daidocs@latest", *args], env=env)
    except KeyboardInterrupt:  # pragma: no cover
        return 130


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
