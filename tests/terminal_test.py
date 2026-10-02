from __future__ import annotations

import json
import fcntl
import os
import pty
import re
import select
import shutil
import subprocess
import tempfile
import time
import struct
import termios
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TerminalSession:
    def __init__(self, config: Path | None = None, language: str | None = "en", config_home: Path | None = None, env_overrides: dict[str, str] | None = None) -> None:
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
        env = os.environ.copy()
        env.pop("NO_COLOR", None)
        env["TERM"] = "xterm-256color"
        env.pop("ME_LANGUAGE", None)
        env.update(env_overrides or {})
        if config_home:
            env["XDG_CONFIG_HOME"] = str(config_home)
        command = [str(ROOT / "me.CLI" / "me")]
        if language:
            command += ["--language", language]
        if config:
            command += ["--config", str(config)]
        self.process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        self.output = b""

    def wait_for(self, text: str, start: int | None = None) -> None:
        if start is None:
            start = len(self.output)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if text.encode() in self.output[start:]:
                return
            if select.select([self.master], [], [], 0.05)[0]:
                try:
                    self.output += os.read(self.master, 65536)
                except OSError:
                    break
            if text.encode() in self.output[start:]:
                return
        raise AssertionError(f"missing {text!r}: {self.output[-2000:]!r}")

    def send(self, data: bytes) -> None:
        os.write(self.master, data)

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=25)
        os.close(self.master)


class TerminalTests(unittest.TestCase):
    def test_mount_loads_a_plugin_and_saves_it_for_next_launch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            config = base / "plugins.json"
            config.write_text('{"plugins":[]}')
            plugin = base / "plugin with spaces"
            plugin.mkdir()
            (plugin / "plugin.json").write_text(json.dumps({"id": "fixture", "command": ["${NODE}", "plugin.mts"]}))
            sdk = json.dumps(str(ROOT / "core" / "bridge" / "sdk" / "typescript" / "sdk.mts"))
            (plugin / "plugin.mts").write_text(f"import {{ run }} from {sdk}\nawait run(async () => {{}})\n")
            session = TerminalSession(config=config, language="zh")
            try:
                session.wait_for("Core已就绪")
                session.send(b"/mount pl\t")
                session.wait_for("/mount plugins")
                session.send(f' "{plugin}"\r'.encode())
                session.wait_for("已挂载fixture")
                saved = json.loads(config.read_text())
                self.assertEqual(saved["plugins"][0]["dir"], str(plugin))
                self.assertTrue(saved["plugins"][0]["autostart"])
                session.send(b"/status\r")
                session.wait_for("fixture - \x1b[32m运行中")
                session.send(f'/mount plugins "{plugin}"\r'.encode())
                session.wait_for("[FAILED]")
                self.assertEqual(json.loads(config.read_text()), saved)
                session.send(b"\x04")
                self.assertEqual(session.process.wait(timeout=10), 0)
            finally:
                session.close()
            session = TerminalSession(config=config, language="zh")
            try:
                session.wait_for("Core已就绪")
                session.send(b"/status fixture\r")
                session.wait_for("fixture - \x1b[32m运行中")
                session.send(b"\x04")
                self.assertEqual(session.process.wait(timeout=10), 0)
            finally:
                session.close()

    def test_first_launch_selects_chinese_and_remembers_it(self) -> None:
        with tempfile.TemporaryDirectory(prefix="me-cli-language-") as directory:
            config_home = Path(directory)
            session = TerminalSession(language=None, config_home=config_home)
            try:
                session.wait_for("Choose language")
                self.assertNotIn(b"created runtime", session.output)
                self.assertNotIn("已创建运行时".encode(), session.output)
                session.send(b"1\r")
                session.wait_for("Ctrl+D退出")
                session.send(b"\x1b[50;5u")
                session.wait_for("跟随me.init的日志")
                session.send(b"\x1b[49;5u")
                time.sleep(0.05)
                self.assertIn(b"me.init", session.output)
                self.assertIn(b"me.cli", session.output)
                self.assertIn("已启动".encode(), session.output)
                session.send(b"/debug\r")
                session.wait_for("提供服务")
                session.send(b"\x1b[F")
                session.wait_for("资源", start=0)
                session.send(b"/quit\r")
                self.assertEqual(session.process.wait(timeout=5), 0)
                preference = json.loads((config_home / "testbot" / "cli.json").read_text())
                self.assertEqual(preference["language"], "zh")
            finally:
                session.close()
            session = TerminalSession(language=None, config_home=config_home)
            try:
                session.wait_for("Ctrl+D退出")
                self.assertNotIn(b"Choose language", session.output)
                session.send(b"/quit\r")
                self.assertEqual(session.process.wait(timeout=5), 0)
            finally:
                session.close()

    def test_language_selection_can_be_cancelled_before_core_starts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="me-cli-language-") as directory:
            session = TerminalSession(language=None, config_home=Path(directory))
            try:
                session.wait_for("Choose language")
                session.send(b"\x03")
                self.assertEqual(session.process.wait(timeout=5), 0)
                self.assertNotIn(b"created runtime", session.output)
                self.assertFalse((Path(directory) / "testbot" / "cli.json").exists())
            finally:
                session.close()

    def test_dirty_ctrl_d_keeps_session_and_four_log_colors(self) -> None:
        with tempfile.TemporaryDirectory(prefix="me-cli-pty-") as directory:
            fixture = Path(directory) / "plugin.mts"
            sdk = json.dumps(str(ROOT / "core" / "bridge" / "sdk" / "typescript" / "sdk.mts"))
            fixture.write_text(f"""import {{ run }} from {sdk}
await run(async ctx => {{
  let first = true
  await ctx.defer('dirty fixture', async () => {{
    if (first) {{ first = false; throw new Error('retry needed') }}
  }})
}})
""")
            config = Path(directory) / "plugins.json"
            config.write_text(json.dumps({"plugins": [{"id": "fixture", "command": [shutil.which("node"), str(fixture)], "autostart": True}]}))
            session = TerminalSession(config)
            try:
                session.wait_for("Ctrl+D exit")
                session.send(b"\x1b[50;5u")
                session.wait_for("Following me.init logs")
                session.send(b"\x1b[49;5u")
                time.sleep(0.05)
                session.send(b"\x04")
                session.wait_for("Exit deferred until cleanup completes")
                self.assertIsNone(session.process.poll())
                session.send(b"/retryCleanup fixture\r")
                session.send(b"/debug\r")
                session.wait_for("Resources 0")
                session.send(b"/quit\r")
                self.assertEqual(session.process.wait(timeout=5), 0)
                for color in (b"\x1b[38;5;117m", b"\x1b[32m", b"\x1b[33m", b"\x1b[31m"):
                    self.assertIn(color, session.output)
                self.assertNotIn(b"readline was closed", session.output)
            finally:
                session.close()

    def test_tab_completion_and_double_ctrl_c(self) -> None:
        session = TerminalSession()
        try:
            session.wait_for("Ctrl+D exit")
            session.send(b"/sto")
            time.sleep(0.05)
            session.send(b"\t")
            time.sleep(0.05)
            session.send(b" me.init\r")
            session.send(b"/debug\r")
            session.wait_for("Resources 0")
            session.send(b"/console\r")
            session.wait_for("Ctrl+D exit")
            session.send(b"\x03")
            session.wait_for("Press Ctrl+C again")
            session.send(b"\x03")
            self.assertEqual(session.process.wait(timeout=5), 0)
            self.assertNotIn(b"Unknown command", session.output)
        finally:
            session.close()

    def test_help_remains_in_console_history(self) -> None:
        session = TerminalSession()
        try:
            session.wait_for("Ctrl+D exit")
            session.send(b"/help\r")
            session.wait_for("Show commands and shortcuts")
            session.send(b"/console\r")
            session.send(b"\x1b[50;5u")
            session.wait_for("Following me.init logs")
            session.send(b"\x1b[49;5u")
            session.wait_for("Show commands and shortcuts")
            session.send(b"/quit\r")
            self.assertEqual(session.process.wait(timeout=5), 0)
        finally:
            session.close()

    def test_failed_clear_and_drag_copy_keep_the_runtime_alive(self) -> None:
        session = TerminalSession(env_overrides={"GDK_BACKEND": "x11", "DISPLAY": ""})
        try:
            session.wait_for("Ctrl+D exit")
            session.send(b"/unknown\r")
            session.wait_for("[FAILED]")
            session.wait_for("Unknown command", start=0)
            self.assertNotIn(b"[ERROR]", session.output)
            self.assertNotIn("●".encode(), session.output)
            session.send(b"/help\r")
            session.wait_for("Show commands and shortcuts")
            rows = re.findall(rb"\x1b\[(\d+);1H(.*?)(?=\x1b\[\d+;1H|$)", session.output, re.S)
            candidates = [int(row) for row, text in rows if b"Show commands and shortcuts" in text]
            self.assertTrue(candidates)
            row = candidates[-1]
            session.send(f"\x1b[<0;3;{row}M\x1b[<32;7;{row}M\x1b[<0;7;{row}m".encode())
            session.wait_for("\x1b[7m")
            self.assertNotIn(b"\x1b]52;c;", session.output)
            start = len(session.output)
            session.send(f"\x1b[<2;7;{row}M\x1b[<2;7;{row}m".encode())
            session.wait_for("\x1b]52;c;L2hlbHA=\x07", start=start)
            session.wait_for("Copy request sent", start=start)
            session.send(b"/clear\r")
            session.wait_for("\x1b[3;1H")
            session.send(b"/status\r")
            session.wait_for("Plugins 2")
            session.send(b"/quit\r")
            self.assertEqual(session.process.wait(timeout=5), 0)
            session.wait_for("\x1b[?1002l")
        finally:
            session.close()

    def test_middle_wheel_and_slash_popup_in_a_real_terminal(self) -> None:
        with tempfile.TemporaryDirectory(prefix="me-cli-scroll-") as directory:
            fixture = Path(directory) / "plugin.mts"
            sdk = json.dumps(str(ROOT / "core" / "bridge" / "sdk" / "typescript" / "sdk.mts"))
            fixture.write_text(f"""import {{ run }} from {sdk}
await run(async ctx => {{
  for (let i = 0; i < 60; i++) {{
    console.info('history item ' + String(i).padStart(3, '0'))
    await ctx.defer('resource item ' + String(i).padStart(3, '0'), async () => {{}})
  }}
}})
""")
            config = Path(directory) / "plugins.json"
            config.write_text(json.dumps({"plugins": [{"id": "fixture", "command": [shutil.which("node"), str(fixture)], "autostart": True}]}))
            session = TerminalSession(config)
            try:
                session.wait_for("Ctrl+D exit")
                session.send(b"/re")
                session.wait_for("Retry failed resource cleanup")
                session.send(b"\x1b[B\t")
                session.wait_for("/retryCleanup ")
                session.send(b"\x15draft")
                session.send(b"\x1b[50;5u")
                session.wait_for("Following me.init logs")
                self.assertIn(b"history item 059", session.output)
                session.send(b"\x1b[<64;10;10M" * 30)
                session.wait_for("history item 000")
                session.send(b"\x1b[<65;10;10M" * 30)
                session.wait_for("history item 059")
                session.send(b"\x1b[49;5u")
                session.wait_for("Ctrl+D exit")
                session.send(b"\x1b[<64;10;10M" * 30)
                session.wait_for("history item 000")
                session.send(b"\x15/debug fixture\r")
                session.wait_for("Plugins 1")
                session.send(b"\x1b[<65;10;10M" * 60)
                session.wait_for("resource item 059")
                session.send(b"\x1b[<64;10;10M" * 60)
                session.wait_for("Plugins 1")
                session.send(b"/quit\r")
                self.assertEqual(session.process.wait(timeout=5), 0)
                self.assertNotIn(b"Unknown command", session.output)
                self.assertNotIn(b"Ctrl+1 console - Ctrl+2 logs", session.output)
                session.wait_for("\x1b[?1006l")
                self.assertIn(b"\x1b[?1006l", session.output)
            finally:
                session.close()

    def test_status_expands_errors_and_debug_shows_internal_details(self) -> None:
        with tempfile.TemporaryDirectory(prefix="me-cli-debug-") as directory:
            fixture = Path(directory) / "plugin.mts"
            sdk = json.dumps(str(ROOT / "core" / "bridge" / "sdk" / "typescript" / "sdk.mts"))
            fixture.write_text(f"""import {{ run }} from {sdk}
await run(async ctx => {{
  let reported = false
  await ctx.every('hidden timer', 150, async () => {{
    if (!reported) {{ reported = true; console.error('[ERROR] fixture diagnostic') }}
  }})
}})
""")
            config = Path(directory) / "plugins.json"
            config.write_text(json.dumps({"plugins": [{"id": "fixture", "command": [shutil.which("node"), str(fixture)], "autostart": True}]}))
            session = TerminalSession(config)
            try:
                session.wait_for("Ctrl+D exit")
                session.send(b"\x1b[51;5u")
                session.wait_for("fixture diagnostic")
                self.assertNotIn(b"generation", session.output)
                self.assertNotIn(b"hidden timer", session.output)
                start = len(session.output)
                session.send(b"/debug fixture\r")
                session.wait_for("hidden timer", start=start)
                self.assertIn(b"generation", session.output[start:])
                start = len(session.output)
                session.send(b"/status\r")
                session.wait_for("[ERROR]", start=start)
                self.assertNotIn(b"hidden timer", session.output[start:])
                session.send(b"/debug core\r")
                session.wait_for("Resources:")
                session.send(b"/quit\r")
                self.assertEqual(session.process.wait(timeout=5), 0)
            finally:
                session.close()

    def test_control_digits_preserve_draft_and_pages_receive_live_output(self) -> None:
        with tempfile.TemporaryDirectory(prefix="me-cli-pages-") as directory:
            fixture = Path(directory) / "plugin.mts"
            sdk = json.dumps(str(ROOT / "core" / "bridge" / "sdk" / "typescript" / "sdk.mts"))
            fixture.write_text(f"""import {{ run }} from {sdk}
await run(async ctx => {{
  let count = 0
  await ctx.every('live output', 150, async () => {{ console.info('live tick ' + ++count) }})
}})
""")
            config = Path(directory) / "plugins.json"
            config.write_text(json.dumps({"plugins": [{"id": "fixture", "command": [shutil.which("node"), str(fixture)], "autostart": True}]}))
            session = TerminalSession(config)
            try:
                session.wait_for("Ctrl+D exit")
                session.send(b"/sta")
                session.send(b"\x1b[50;5u")
                session.wait_for("live tick")
                session.wait_for("live tick")
                self.assertIn(b"\x1b[97mfixture", session.output)
                self.assertIn(b"\x1b[90mlive tick", session.output)
                session.send(b"\x1b[27;5;51~")
                session.wait_for("Plugins 1")
                session.send(b"\x1b[49;5u\x1b[52;5u\x1b[53;5u\x1b[54;5u")
                session.wait_for("Ctrl+D exit")
                session.send(b"tus fixture\r")
                session.wait_for("Plugins 1")
                session.send(b"/debug fixture\r")
                session.wait_for("Tasks")
                self.assertIn(b"Timers 1", session.output)
                session.send(b"\x1b[F")
                session.wait_for("[owned]")
                self.assertNotIn(b"Unknown command", session.output)
                session.send(b"/console\r")
                session.wait_for("Ctrl+D exit")
                session.send(b"/logs\r")
                session.wait_for("Following me.init logs")
                session.send(b"/quit\r")
                self.assertEqual(session.process.wait(timeout=5), 0)
                session.wait_for("\x1b[?1049l")
                self.assertIn(b"\x1b[?1049l", session.output)
                self.assertIn(b"\x1b[<u", session.output)
                self.assertIn(b"\x1b[?1000l", session.output)
                self.assertIn(b"\x1b[?1006l", session.output)
            finally:
                session.close()


if __name__ == "__main__":
    unittest.main()
