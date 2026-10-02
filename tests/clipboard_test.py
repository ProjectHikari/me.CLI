from __future__ import annotations

import json
import os
import select
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.environ.get("ME_CLI_CLIPBOARD_LIVE") == "1", "requires an active desktop clipboard")
class ClipboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        os.environ["GDK_BACKEND"] = "x11"
        import gi
        gi.require_version("Gtk", "4.0")
        gi.require_version("Gdk", "4.0")
        from gi.repository import Gdk, GLib, GObject, Gtk
        Gtk.init()
        cls.Gdk, cls.GLib, cls.GObject = Gdk, GLib, GObject
        display = Gdk.Display.get_default()
        if display is None:
            raise unittest.SkipTest("X11 display unavailable")
        cls.clipboard = display.get_clipboard()

    def read(self, texture: bool = False) -> object:
        loop = self.GLib.MainLoop()
        values = []

        def done(source: object, result: object, *_args: object) -> None:
            try:
                values.append(self.clipboard.read_texture_finish(result) if texture else self.clipboard.read_text_finish(result))
            except Exception as error:
                values.append(error)
            loop.quit()

        timeout = self.GLib.timeout_add(2000, lambda: (loop.quit(), False)[1])
        read = self.clipboard.read_texture_async if texture else self.clipboard.read_text_async
        read(None, done, None)
        loop.run()
        if not values:
            raise TimeoutError("clipboard read timed out")
        self.GLib.source_remove(timeout)
        return values[0]

    def restore(self, original: object) -> None:
        provider = None
        if original is not None:
            value = self.GObject.Value(str if isinstance(original, str) else self.Gdk.Texture)
            if isinstance(original, str):
                value.set_string(original)
            else:
                value.set_object(original)
            provider = self.Gdk.ContentProvider.new_for_value(value)
        self.clipboard.set_content(provider)
        loop = self.GLib.MainLoop()
        finished = False

        def done(*_args: object) -> None:
            nonlocal finished
            finished = True
            loop.quit()

        timeout = self.GLib.timeout_add(1000, lambda: (loop.quit(), False)[1])
        self.clipboard.store_async(self.GLib.PRIORITY_DEFAULT, None, done, None)
        loop.run()
        if finished:
            self.GLib.source_remove(timeout)

    def test_native_delivery_is_readable_by_another_process(self) -> None:
        original = self.read()
        if isinstance(original, Exception):
            original = self.read(texture=True)
            if isinstance(original, Exception):
                if self.clipboard.get_formats().get_mime_types():
                    self.skipTest("existing clipboard cannot be preserved")
                original = None
        script = """import readline from 'node:readline'
import { Clipboard } from './me.CLI/src/clipboard.mts'
const clipboard = new Clipboard(() => {})
try {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    console.log(JSON.stringify({ status: await clipboard.copy(JSON.parse(line)) }))
  }
} finally { clipboard.close() }
"""
        env = {**os.environ, "GDK_BACKEND": "wayland"}
        for key in ("SSH_TTY", "SSH_CONNECTION", "TMUX"):
            env.pop(key, None)
        child = subprocess.Popen(["node", "--input-type=module", "-e", script], cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            for text in ("me.CLI clipboard test", "中文复制\n第二行", "me.CLI second copy"):
                child.stdin.write(json.dumps(text) + "\n")
                child.stdin.flush()
                self.assertTrue(select.select([child.stdout], [], [], 3)[0], "copy timed out")
                self.assertEqual(json.loads(child.stdout.readline()), {"status": "confirmed"})
                self.assertEqual(self.read(), text)
            child.stdin.close()
            self.assertEqual(child.wait(timeout=3), 0)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=3)
            child.stdout.close()
            child.stderr.close()
            self.restore(original)


if __name__ == "__main__":
    unittest.main()
