#!/usr/bin/env python3
"""Isolated private server and real TUI. Every prompt is rejected before admission."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

REPO = Path(__file__).resolve().parents[1]


def main():
    binary = shutil.which("opencode")
    assert binary, "OpenCode V2 is required"
    parent = "/tmp/opencode" if Path("/tmp/opencode").is_dir() else None
    with tempfile.TemporaryDirectory(prefix="slash-skills-tui-", dir=parent) as directory:
        root = Path(directory)
        config = root / "config/opencode"
        config.mkdir(parents=True)
        fixture = root / "fixture"
        fixture.mkdir()
        shutil.copy2(REPO / "tests/fixtures/guard.ts", fixture / "index.ts")
        shutil.copy2(REPO / "tests/fixtures/tui.ts", fixture / "tui.ts")
        (fixture / "package.json").write_text(json.dumps({
            "name": "slash-skills-smoke", "type": "module",
            "exports": {".": "./index.ts", "./tui": "./tui.ts"},
        }))
        skills = root / ".opencode/skills"
        for name in ["slash-smoke", "skills"]:
            target = skills / name
            target.mkdir(parents=True)
            (target / "SKILL.md").write_text(
                "---\nname: " + name + "\ndescription: Isolated slash smoke fixture\n---\nTest only.\n")
        (config / "opencode.json").write_text(json.dumps({
            "$schema": "https://opencode.ai/config.json",
            "plugins": [str(REPO), str(fixture)], "update": "disable",
        }))
        (config / "cli.json").write_text(json.dumps({
            "$schema": "https://opencode.ai/v2/cli.json", "plugins": [str(fixture)],
            "animations": False, "highlights": False, "session": {"sidebar": "hide"},
        }))
        report_path = root / "report.json"
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("OPENCODE_", "HERDR_"))
               and not k.endswith(("API_KEY", "TOKEN"))}
        env.update({"HOME": str(root), "XDG_CONFIG_HOME": str(root / "config"),
                    "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"),
                    "XDG_STATE_HOME": str(root / "state"), "TERM": "xterm-256color",
                    "SLASH_TEST_REPORT": str(report_path),
                    "SLASH_TEST_ADMISSIONS": str(root / "admissions.jsonl")})
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
        process = subprocess.Popen([binary, "--standalone", str(root)], cwd=root, env=env,
                                   stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = bytearray()
        report = {}
        typed = False
        try:
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline and process.poll() is None:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
                if report_path.exists():
                    try:
                        report = json.loads(report_path.read_text())
                    except json.JSONDecodeError:
                        continue
                    if report.get("done"):
                        break
                    if report.get("ready") and not typed:
                        time.sleep(0.5)
                        os.write(master, b"/slash-smoke")
                        typed = True
            assert report.get("done"), "Smoke test did not complete: " + output.decode(errors="replace")[-3000:]
            assert "error" not in report, report.get("error")
            assert all(report.get(k) for k in ["autocomplete", "permissions", "nativeAttachment"]), report
            print(f"PASS OpenCode {report['version']}: real slash autocomplete, deny/allow permission checks, "
                  "and native attachment at admission. No model prompts admitted.")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            os.close(master)


if __name__ == "__main__":
    main()
