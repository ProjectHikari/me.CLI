from __future__ import annotations

import json
import os
import sys


def main() -> None:
    # 无窗口的Wayland客户端拿不到输入serial，不能据本地set_content判断写入成功
    os.environ["GDK_BACKEND"] = "x11"
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("Gdk", "4.0")
    from gi.repository import Gdk, GLib, GObject, Gtk

    Gtk.init()
    display = Gdk.Display.get_default()
    if display is None:
        raise RuntimeError("display unavailable")
    clipboard = display.get_clipboard()
    observer = Gdk.Display.open(os.environ.get("DISPLAY", ""))
    if observer is None:
        raise RuntimeError("clipboard verification unavailable")
    observed = observer.get_clipboard()
    loop = GLib.MainLoop()

    def finish(*_args: object) -> None:
        loop.quit()

    def receive(_source: object, condition: int) -> bool:
        line = sys.stdin.readline()
        if not line:
            # 交给剪贴板管理器后再退出，避免关闭CLI时丢失已复制内容
            clipboard.store_async(GLib.PRIORITY_DEFAULT, None, finish, None)
            GLib.timeout_add(1000, lambda: (loop.quit(), False)[1])
            return False
        request = json.loads(line)
        text = request["text"]
        if not isinstance(text, str) or len(text.encode("utf-8")) > 100_000:
            raise ValueError("invalid clipboard text")
        value = GObject.Value()
        value.init(str)
        value.set_string(text)
        if not clipboard.set_content(Gdk.ContentProvider.new_for_value(value)):
            print(json.dumps({"id": request["id"], "error": "clipboard unavailable"}), flush=True)
            return True
        complete = False

        def reply(error: str | None = None) -> None:
            nonlocal complete
            if complete:
                return
            complete = True
            response = {"id": request["id"]}
            if error:
                response["error"] = error
            print(json.dumps(response), flush=True)

        def verify(source: object, result: object, *_args: object) -> None:
            if complete:
                return
            GLib.source_remove(timeout)
            try:
                actual = observed.read_text_finish(result)
                reply(None if actual == text else "clipboard verification failed")
            except Exception:
                reply("clipboard verification failed")

        timeout = GLib.timeout_add(800, lambda: (reply("clipboard verification timed out"), False)[1])
        observed.read_text_async(None, verify, None)
        return True

    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, receive)
    print('{"ready":true}', flush=True)
    loop.run()


if __name__ == "__main__":
    main()
