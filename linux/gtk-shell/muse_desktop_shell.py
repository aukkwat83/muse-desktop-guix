#!/usr/bin/env python3
"""
Muse Desktop — native GNOME shell (GTK4 + WebKitGTK).

Independent of Chrome/Firefox/Chromium. Loads the local Node host UI in an
embedded WebView (same idea as macOS Swift + WKWebView).

  ./scripts/native-launch.sh open
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("WebKit", "6.0")

from gi.repository import Adw, Gio, GLib, Gtk, WebKit  # noqa: E402

PORT = int(os.environ.get("MUSE_DESKTOP_PORT", "3850"))
HOST = os.environ.get("MUSE_DESKTOP_HOST", "127.0.0.1")
BASE = f"http://{HOST}:{PORT}/"
STATE = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "muse-desktop"
ROOT = Path(os.environ.get("MUSE_DESKTOP_ROOT", Path(__file__).resolve().parents[2]))
APP_ID = "com.aukkwat83.MuseDesktop"
TITLE = "Muse Desktop"


def http_ok(path: str = "api/state", timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(f"{BASE}{path}", timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


def fetch_json(path: str, timeout: float = 2.0):
    try:
        with urllib.request.urlopen(f"{BASE}{path}", timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def ensure_host(timeout: float = 40.0) -> bool:
    if http_ok():
        return True
    STATE.mkdir(parents=True, exist_ok=True)
    log = STATE / "host.log"
    pid_file = STATE / "host.pid"
    env = os.environ.copy()
    env["NO_OPEN"] = "1"
    env["MUSE_DESKTOP_KEEP_ON_EXIT"] = "1"
    env["PATH"] = ":".join(
        [
            str(Path.home() / ".local/bin"),
            str(Path.home() / ".guix-profile/bin"),
            "/run/current-system/profile/bin",
            env.get("PATH", ""),
        ]
    )
    server = ROOT / "src/server/index.js"
    if not server.is_file():
        print(f"[native-shell] missing {server}", file=sys.stderr)
        return False
    with open(log, "ab") as lf:
        proc = subprocess.Popen(
            ["node", str(server)],
            cwd=str(ROOT),
            env=env,
            stdout=lf,
            stderr=lf,
            start_new_session=True,
        )
    pid_file.write_text(str(proc.pid))
    print(f"[native-shell] started host pid={proc.pid}")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if http_ok():
            return True
        time.sleep(0.25)
    print("[native-shell] host failed — see", log, file=sys.stderr)
    return False


class MuseDesktopApp(Gtk.Application):
    """Native shell. Uses do_activate (vfunc) — Gio.Application signal connect is broken
    on some PyGObject overrides under Guix."""

    def __init__(self):
        # Avoid kwargs application_id (unsupported on this GI)
        super().__init__()
        self.set_application_id(APP_ID)
        self._win = None
        self._view = None
        self._status = None
        self._meter_id = 0

    def do_activate(self):
        if self._win is not None:
            self._win.present()
            return

        # Avoid GObject kwargs (broken on this PyGObject) — setters only
        self._win = Adw.ApplicationWindow()
        self._win.set_application(self)
        self._win.set_title(TITLE)
        self._win.set_default_size(1280, 860)

        header = Adw.HeaderBar()
        title = Adw.WindowTitle()
        title.set_title(TITLE)
        title.set_subtitle("native · WebKitGTK (not a browser)")
        header.set_title_widget(title)

        reload_btn = Gtk.Button()
        reload_btn.set_icon_name("view-refresh-symbolic")
        reload_btn.set_tooltip_text("Reload UI")
        reload_btn.connect("clicked", self._on_reload)
        header.pack_start(reload_btn)

        self._status = Gtk.Label()
        self._status.set_label("…")
        self._status.add_css_class("dim-label")
        self._status.set_margin_end(8)
        header.pack_end(self._status)

        self._view = self._build_webview()
        self._view.set_vexpand(True)
        self._view.set_hexpand(True)

        box = Gtk.Box()
        box.set_orientation(Gtk.Orientation.VERTICAL)
        box.append(header)
        box.append(self._view)
        self._win.set_content(box)
        self._win.connect("close-request", self._on_close)
        self._win.present()

        self._meter_id = GLib.timeout_add_seconds(8, self._poll_memory)
        GLib.idle_add(self._poll_memory)
        print("[native-shell] window presented — engine=WebKitGTK host=", BASE)

    def _on_reload(self, *_a):
        if self._view:
            self._view.reload()

    def _build_webview(self) -> WebKit.WebView:
        data_dir = STATE / "webkit-data"
        cache_dir = STATE / "webkit-cache"
        data_dir.mkdir(parents=True, exist_ok=True)
        cache_dir.mkdir(parents=True, exist_ok=True)

        network = None
        try:
            network = WebKit.NetworkSession.new(str(data_dir), str(cache_dir))
        except Exception as e:
            print("[native-shell] NetworkSession.new:", e, file=sys.stderr)
            try:
                network = WebKit.NetworkSession.get_default()
            except Exception:
                network = None

        if network is not None:
            try:
                view = WebKit.WebView(network_session=network)
            except TypeError:
                view = WebKit.WebView()
        else:
            view = WebKit.WebView()

        settings = view.get_settings()
        settings.set_enable_javascript(True)
        try:
            settings.set_enable_webgl(True)
        except Exception:
            pass
        if os.environ.get("MUSE_DESKTOP_WEBKIT_DEBUG") == "1":
            settings.set_enable_developer_extras(True)
        try:
            settings.set_hardware_acceleration_policy(
                WebKit.HardwareAccelerationPolicy.ALWAYS
            )
        except Exception:
            pass

        view.connect("decide-policy", self._on_decide_policy)
        view.load_uri(BASE)
        return view

    def _on_decide_policy(self, _view, decision, decision_type):
        if decision_type != WebKit.PolicyDecisionType.NAVIGATION_ACTION:
            return False
        try:
            nav = decision.get_navigation_action()
            req = nav.get_request()
            uri = req.get_uri() if req else ""
        except Exception:
            return False
        if not uri:
            return False
        local_prefixes = (
            BASE,
            f"http://{HOST}:{PORT}",
            f"http://127.0.0.1:{PORT}",
            "about:",
            "blob:",
            "data:",
        )
        if any(uri.startswith(p) for p in local_prefixes):
            return False
        try:
            Gio.AppInfo.launch_default_for_uri(uri, None)
        except Exception as e:
            print("[native-shell] external link:", e, file=sys.stderr)
        decision.ignore()
        return True

    def _poll_memory(self):
        data = fetch_json("api/memory")
        if not self._status:
            return True
        if not data:
            self._status.set_text("host?")
            return True
        counts = data.get("counts") or {}
        hot = counts.get("hot", 0)
        running = counts.get("running", 0)
        max_h = data.get("maxHotAgents", "?")
        free = data.get("freeMB") or 0
        free_s = f"{free / 1024:.1f}G" if free >= 1024 else f"{free}M"
        pressure = data.get("pressure") or "ok"
        text = f"Hot {hot}/{max_h} · Running {running} · Free {free_s}"
        self._status.set_text(text)
        self._status.set_tooltip_text(
            f"pressure={pressure} · native WebKitGTK · host kept on close"
        )
        return True

    def _on_close(self, *_a):
        print("[native-shell] window close — host kept (KEEP_ON_EXIT)")
        if self._meter_id:
            GLib.source_remove(self._meter_id)
            self._meter_id = 0
        return False


def main() -> int:
    if not ensure_host():
        print("[native-shell] continuing without healthy host", file=sys.stderr)

    Adw.init()
    app = MuseDesktopApp()

    def _sig(*_a):
        app.quit()

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    return app.run(None)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print("[native-shell] fatal:", e, file=sys.stderr)
        import traceback

        traceback.print_exc()
        print(
            "Deps: guix shell -m linux/gtk-shell/manifest.scm -- python3 "
            "linux/gtk-shell/muse_desktop_shell.py",
            file=sys.stderr,
        )
        raise SystemExit(1)
