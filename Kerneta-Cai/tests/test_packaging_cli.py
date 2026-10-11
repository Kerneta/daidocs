"""Regression for the installed `kerneta` distribution (issues #70 and #71).

#70: the wheel shipped without kerneta_engine, so doctor/build failed after pip install.
#71: `update`/`watch` failed to import cai_ts_extract because main() ran the engine
     script without the engine directory on sys.path.

Builds an sdist and wheels from a copy of the source, installs the wheel into a fresh venv
(network needed for the tree-sitter grammars) and drives the console script from outside the
source tree with PYTHONPATH/PYTHONHOME removed and user site-packages disabled. Requires the
`build` package in the interpreter running the tests:

  python -m pip install build
  python -m unittest discover -s Kerneta-Cai/tests -v
"""

import glob
import os
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
import zipfile

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE_FILES = ("__init__.py", "cai_ts_extract.py", "cai_update.py")
TIMEOUT = 600

CORE = "def alpha():\n    return 1\n"
MAIN = "from core import alpha\n\n\ndef run():\n    return alpha()\n"


def _env():
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME")}
    env.update(PYTHONNOUSERSITE="1", PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1")
    return env


def _run(cmd, cwd, timeout=TIMEOUT):
    p = subprocess.run(cmd, cwd=cwd, env=_env(), capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise AssertionError("{} exited {}\n{}\n{}".format(cmd, p.returncode, p.stdout, p.stderr))
    return p.stdout


def _store_text(store):
    out = []
    for path in sorted(glob.glob(os.path.join(store, "**", "*.cai"), recursive=True)):
        with open(path, encoding="utf-8") as f:
            out.append(f.read())
    return "\n".join(out)


class InstalledKernetaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="kerneta-pkg-")
        tree = os.path.join(cls.tmp, "src")
        os.makedirs(tree)
        for name in ("pyproject.toml", "README.md", "kerneta_cli.py"):
            shutil.copy(os.path.join(SRC, name), tree)
        shutil.copytree(os.path.join(SRC, "engine"), os.path.join(tree, "engine"),
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        # direct wheel, and sdist -> wheel (what pip does when only an sdist is published)
        cls.direct = os.path.join(cls.tmp, "direct")
        cls.via_sdist = os.path.join(cls.tmp, "via-sdist")
        _run([sys.executable, "-m", "build", "--wheel", "--outdir", cls.direct, tree], cls.tmp)
        _run([sys.executable, "-m", "build", "--outdir", cls.via_sdist, tree], cls.tmp)

        venv = os.path.join(cls.tmp, "venv")
        _run([sys.executable, "-m", "venv", venv], cls.tmp)
        bindir = os.path.join(venv, "Scripts" if os.name == "nt" else "bin")
        cls.python = os.path.join(bindir, "python")
        cls.kerneta = os.path.join(bindir, "kerneta")
        wheel = glob.glob(os.path.join(cls.direct, "*.whl"))[0]
        _run([cls.python, "-m", "pip", "install", "--disable-pip-version-check", wheel], cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _corpus(self, name):
        corpus = os.path.join(self.tmp, name, "corpus")
        os.makedirs(corpus)
        for fname, text in (("core.py", CORE), ("main.py", MAIN)):
            with open(os.path.join(corpus, fname), "w", encoding="utf-8") as f:
                f.write(text)
        return corpus, os.path.join(self.tmp, name, "store")

    def _edit_core(self, corpus):
        with open(os.path.join(corpus, "core.py"), "a", encoding="utf-8") as f:
            f.write("\n\ndef gamma_added():\n    return alpha() + 1\n")

    def test_distributions_ship_engine(self):
        for outdir in (self.direct, self.via_sdist):
            whl = glob.glob(os.path.join(outdir, "*.whl"))
            self.assertEqual(len(whl), 1, outdir)
            names = set(zipfile.ZipFile(whl[0]).namelist())
            self.assertIn("kerneta_cli.py", names)
            for f in ENGINE_FILES:
                self.assertIn("kerneta_engine/" + f, names, whl[0])
        sdist = glob.glob(os.path.join(self.via_sdist, "*.tar.gz"))[0]
        members = {m.split("/", 1)[1] for m in tarfile.open(sdist).getnames() if "/" in m}
        for f in ENGINE_FILES:
            self.assertIn("engine/" + f, members)

    def test_installed_doctor(self):
        out = _run([self.kerneta, "doctor"], self.tmp)
        self.assertIn("grammars    : OK", out)
        self.assertIn("status      : ready", out)
        engine = out.split("engine      :", 1)[1].splitlines()[0].strip()
        self.assertTrue(engine.startswith(os.path.join(self.tmp, "venv")), engine)
        self.assertEqual(os.path.basename(engine), "kerneta_engine")

    def test_installed_build_then_update(self):
        corpus, store = self._corpus("update")
        out = _run([self.kerneta, "build", corpus, store], self.tmp)
        self.assertIn("built 2 .cai files", out)
        self.assertIn("alpha", _store_text(store))
        self.assertNotIn("gamma_added", _store_text(store))

        _run([self.kerneta, "update", corpus, store], self.tmp)  # seeds the sha index
        self._edit_core(corpus)
        out = _run([self.kerneta, "update", corpus, store], self.tmp)
        self.assertIn("rebuilt: +0 added, ~1 changed, -0 removed", out)
        self.assertIn("~ core", out)
        self.assertIn("gamma_added", _store_text(store))
        self.assertIn("up to date (2 files", _run([self.kerneta, "update", corpus, store], self.tmp))

    def test_installed_watch(self):
        corpus, store = self._corpus("watch")
        log_path = os.path.join(self.tmp, "watch.log")
        posix = os.name != "nt"
        # a runner launched as a background job inherits SIGINT ignored; restore it so the
        # child gets Python's KeyboardInterrupt (ctrl-c) handling
        reset = (lambda: signal.signal(signal.SIGINT, signal.SIG_DFL)) if posix else None
        with open(log_path, "w") as log:
            proc = subprocess.Popen([self.kerneta, "watch", corpus, store, "0.2"], cwd=self.tmp,
                                    env=_env(), stdout=log, stderr=subprocess.STDOUT,
                                    preexec_fn=reset)
        try:
            self._wait_for(lambda: "rebuilt:" in self._read(log_path), proc, log_path)
            self._edit_core(corpus)
            self._wait_for(lambda: "~ core" in self._read(log_path)
                           and "gamma_added" in _store_text(store), proc, log_path)
        finally:
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT if posix else signal.SIGTERM)
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=15)
        if posix:
            self.assertEqual(proc.returncode, 0, self._read(log_path))
            self.assertIn("stopped", self._read(log_path))

    @staticmethod
    def _read(path):
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()

    def _wait_for(self, cond, proc, log_path, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if cond():
                return
            if proc.poll() is not None:
                self.fail("watch exited {}:\n{}".format(proc.returncode, self._read(log_path)))
            time.sleep(0.1)
        self.fail("watch timed out:\n" + self._read(log_path))

    def test_source_cli_update(self):
        # The source checkout path: block the installed package so _engine_dir() falls back to
        # engine/ next to kerneta_cli.py; the venv only supplies the grammars.
        corpus, store = self._corpus("source")
        cli = os.path.join(SRC, "kerneta_cli.py")
        driver = ("import runpy, sys; sys.modules['kerneta_engine'] = None; "
                  "sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')")
        out = _run([self.python, "-c", driver, cli, "update", corpus, store], self.tmp)
        self.assertIn("rebuilt: +2 added", out)
        self.assertIn("alpha", _store_text(store))
        out = _run([self.python, "-c", driver, cli, "doctor"], self.tmp)
        self.assertIn("engine      : " + os.path.join(SRC, "engine"), out)


if __name__ == "__main__":
    unittest.main()
