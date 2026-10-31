"""Exercise real Git with hostile .gitmodules and the production environment."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import re
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
policy = (ROOT / "library/src/ci/CheckoutPolicy.groovy").read_text()
body = policy.split("static List<String> environment()", 1)[1]
production = dict(re.findall(r"'([A-Z0-9_]+)=([^']*)'", body))
assert production and production["GIT_CONFIG_VALUE_1"] == "false"


class Receiver(BaseHTTPRequestHandler):
    count = 0

    def do_GET(self):
        type(self).count += 1
        self.send_error(403)

    def log_message(self, *_args):
        pass


with tempfile.TemporaryDirectory(prefix=".checkout-probe-", dir=ROOT / "tests") as temp:
    parent = Path(temp)
    source = parent / "source"
    source.mkdir()
    env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")

    def git(*args, cwd=source, extra=None, check=True):
        result = subprocess.run(
            ["git", "-c", "user.name=CI", "-c", "user.email=ci@example.invalid",
             "-c", "core.hooksPath=/dev/null", *args],
            cwd=cwd, env=dict(env, **(extra or {})), text=True, capture_output=True,
        )
        if check and result.returncode:
            raise AssertionError((result.returncode, result.stderr))
        return result

    server = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        git("init", "--quiet")
        (source / ".gitmodules").write_text(
            '[submodule "module"]\n path = module\n url = http://127.0.0.1:%d/stolen.git\n'
            % server.server_port
        )
        (source / ".gitattributes").write_text("value filter=probe\n")
        (source / "value").write_text("source\n")
        git("add", ".")
        git("update-index", "--add", "--cacheinfo", "160000," + "1" * 40 + ",module")
        git("commit", "--quiet", "-m", "source fixture")
        marker = parent / "smudge-executed"
        hostile = parent / "hostile-gitconfig"
        hostile.write_text('[submodule]\n recurse = true\n[filter "probe"]\n'
                           ' smudge = touch %s; cat\n' % marker)
        unsafe, safe = parent / "unsafe", parent / "safe"
        for target in (unsafe, safe):
            git("clone", "--quiet", "--no-checkout", str(source), str(target), cwd=parent)
        git("checkout", "--force", "HEAD", cwd=unsafe, extra={"GIT_CONFIG_GLOBAL": str(hostile)})
        assert marker.exists(), "hostile global filter fixture did not execute"
        attack = git("submodule", "update", "--init", "--recursive", cwd=unsafe, check=False)
        assert attack.returncode != 0 and Receiver.count > 0, "submodule receiver fixture was not reached"
        print("REPRO: unguarded submodule update exit=%d, HTTP requests=%d" % (attack.returncode, Receiver.count))
        print(attack.stderr.strip())
        marker.unlink()
        before = Receiver.count
        git("checkout", "--force", "HEAD", cwd=safe,
            extra=dict({"GIT_CONFIG_GLOBAL": str(hostile)}, **production))
        assert not marker.exists(), "production environment allowed a configured smudge filter"
        assert Receiver.count == before, "production checkout contacted the submodule receiver"
        assert (safe / ".gitmodules").is_file()
        print("PASS: production checkout environment made zero submodule requests and ran no hostile smudge filter")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
