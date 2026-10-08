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

import ctypes
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
APP_ID = os.environ.get("MUSE_DESKTOP_APP_ID", "com.aukkwat83.MuseDesktop")
TITLE = "Muse Desktop"


def _x11_own_window_alive() -> bool:
    """C-shell parity for the 2026-10-08 zombie: is any toplevel with our PID
    (and title) still known to the X server? Pure ctypes, no GdkX11
    introspection gamble. Anything unjudgeable (no display, no libX11)
    returns True — worst case is the old trust-present behaviour."""
    if not os.environ.get("DISPLAY"):
        return True
    for cand in (
        "/run/current-system/profile/lib/libX11.so.6",
        "/usr/lib/libX11.so.6",
        "/usr/lib64/libX11.so.6",
        "libX11.so.6",
    ):
        try:
            if cand.startswith("/") and not os.path.exists(cand):
                continue
            lib = ctypes.CDLL(cand)
            break
        except OSError:
            continue
    else:
        return True
    try:
        lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        lib.XOpenDisplay.restype = ctypes.c_void_p
        lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        lib.XDefaultRootWindow.restype = ctypes.c_ulong
        lib.XQueryTree.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
            ctypes.POINTER(ctypes.c_uint),
        ]
        lib.XQueryTree.restype = ctypes.c_int
        lib.XFree.argtypes = [ctypes.c_void_p]
        lib.XFree.restype = ctypes.c_int
        lib.XFetchName.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)
        ]
        lib.XFetchName.restype = ctypes.c_int
        lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        lib.XInternAtom.restype = ctypes.c_ulong
        lib.XGetWindowProperty.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
            ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        lib.XGetWindowProperty.restype = ctypes.c_int
        lib.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.XSync.restype = ctypes.c_int
        lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
        lib.XCloseDisplay.restype = ctypes.c_int
        lib.XSetErrorHandler.argtypes = [ctypes.c_void_p]
        lib.XSetErrorHandler.restype = ctypes.c_void_p
        swallow = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)(
            lambda dpy, ev: 0
        )
        lib.XSetErrorHandler(swallow)
        dpy = lib.XOpenDisplay(None)
        if not dpy:
            return True
        try:
            root = lib.XDefaultRootWindow(dpy)
            pid_atom = lib.XInternAtom(dpy, b"_NET_WM_PID", 0)
            root_ret, parent_ret = ctypes.c_ulong(), ctypes.c_ulong()
            kids, n = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
            if not lib.XQueryTree(dpy, root, ctypes.byref(root_ret),
                                  ctypes.byref(parent_ret), ctypes.byref(kids),
                                  ctypes.byref(n)):
                return True
            try:
                me = os.getpid()
                for i in range(n.value):
                    xid = kids[i]
                    actual_t, actual_f = ctypes.c_ulong(), ctypes.c_int()
                    nitems, after = ctypes.c_ulong(), ctypes.c_ulong()
                    prop = ctypes.c_void_p()
                    if lib.XGetWindowProperty(
                        dpy, xid, pid_atom, 0, 1, 0, 6,  # noqa: PLR2004 - XA_CARDINAL
                        ctypes.byref(actual_t), ctypes.byref(actual_f),
                        ctypes.byref(nitems), ctypes.byref(after),
                        ctypes.byref(prop),
                    ):
                        continue
                    wpid = None
                    if prop and nitems.value >= 1:
                        wpid = ctypes.cast(prop, ctypes.POINTER(ctypes.c_long))[0]
                        lib.XFree(prop)
                    if wpid != me:
                        continue
                    name = ctypes.c_char_p()
                    title = ""
                    if lib.XFetchName(dpy, xid, ctypes.byref(name)) and name.value:
                        title = name.value.decode("utf-8", errors="replace")
                        lib.XFree(name)
                    if TITLE in title:
                        return True  # a live toplevel of ours exists (any map state)
                lib.XSync(dpy, 0)
                return False
            finally:
                if kids:
                    lib.XFree(kids)
        finally:
            lib.XCloseDisplay(dpy)
    except Exception:
        return True


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
        # Banner-tap route queue (C shell parity): taps queue until the
        # page is HYDRATED (ready post after boot fetches — load-finished
        # alone is not renderer-ready) and clear only on the page's
        # routed receipt. Cold-start taps are never dropped.
        self._page_ready = False
        self._boot_ready = False
        self._route = None

    def do_startup(self):
        Gtk.Application.do_startup(self)
        # Actions live on the APPLICATION, registered once at startup —
        # a banner tap that cold-starts the app finds them before any
        # window exists. Same contract as the C shell's GActions.
        try:
            open_q = Gio.SimpleAction.new(
                "open-question", GLib.VariantType.new("(ss)")
            )
            open_q.connect("activate", self._on_open_question)
            self.add_action(open_q)
            notify_q = Gio.SimpleAction.new(
                "notify-question", GLib.VariantType.new("(ss)")
            )
            notify_q.connect("activate", self._on_notify_question)
            self.add_action(notify_q)
        except Exception as exc:
            print(f"[notify] actions unavailable: {exc}", flush=True)
        else:
            print(
                "[native-shell] actions registered:"
                " open-question, notify-question",
                flush=True,
            )

    def do_activate(self):
        if self._win is not None:
            if _x11_own_window_alive():
                self._win.present()
                self._flush_route()
                return
            # Zombie (C shell parity, 2026-10-08): the surface died outside
            # GTK with no signal — drop the dead window so the build below
            # makes a fresh one instead of presenting it forever.
            print(
                "[native-shell] existing window is gone at the X server"
                " — rebuilding",
                flush=True,
            )
            self._win.destroy()
            self._win = None
            self._view = None
            self._status = None
            self._page_ready = False
            self._boot_ready = False

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

        # Rebuilds must not stack a second meter (C shell parity).
        if not self._meter_id:
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
        # Banner-tap routes queue until the page finishes loading.
        view.connect("load-changed", self._on_load_changed)
        try:
            ucm = view.get_user_content_manager()
            # WebKit 6.0 takes a JS world name (None = main), like the C shell.
            ucm.register_script_message_handler("museNotify", None)
            ucm.connect(
                "script-message-received::museNotify", self._on_muse_notify
            )
            print("[native-shell] museNotify bridge registered", flush=True)
        except Exception as exc:
            print(f"[native-shell] museNotify bridge FAILED: {exc}", flush=True)
        view.load_uri(BASE)
        return view

    # ------------------------------------------------------- notifications
    # Same contract as the C shell: structured show/withdraw payloads,
    # same-origin guarded, GNotification default action app.open-question.

    def _notify_same_origin(self) -> bool:
        try:
            uri = self._view.get_uri() if self._view else ""
        except Exception:
            return False
        return bool(uri) and uri.startswith(BASE)

    @staticmethod
    def _js_prop(value, name: str):
        try:
            prop = value.object_get_property(name)
        except Exception:
            return None
        try:
            return prop.to_string() if prop and prop.is_string() else None
        except Exception:
            return None

    def _on_muse_notify(self, _ucm, value):
        if not self._notify_same_origin():
            print("[notify] ignored: page is not the host UI", flush=True)
            return
        op = self._js_prop(value, "op")
        if not op:
            return
        if op == "ready":
            # Hydration handshake (C parity): the page finished boot.
            self._boot_ready = True
            print("[notify] renderer hydrated — flushing routes", flush=True)
            self._flush_route()
            return
        if op == "routed":
            # Positive application receipt: clear ONLY the matching route.
            chat_id = self._js_prop(value, "chatId") or ""
            ix_id = self._js_prop(value, "ixId") or ""
            if self._route == (chat_id, ix_id):
                print(f"[notify] route receipt chat={chat_id[:32]}", flush=True)
                self._route = None
            else:
                print("[notify] stray route receipt (queue replaced) — kept", flush=True)
            return
        nid = self._js_prop(value, "id")
        if not nid:
            return
        notif_id = f"muse-q-{nid[:128]}"
        if op == "withdraw":
            self.withdraw_notification(notif_id)
            print(f"[notify] withdraw {notif_id}", flush=True)
            return
        if op != "show":
            return
        title = self._js_prop(value, "title")
        body = self._js_prop(value, "body")
        chat_id = self._js_prop(value, "chatId")
        ix_id = self._js_prop(value, "ixId")
        if not title or not body or not chat_id or not ix_id:
            print("[notify] show ignored: incomplete payload", flush=True)
            return
        self._show_question(notif_id, title, body, chat_id, ix_id)

    def _on_load_changed(self, _view, event):
        if event == WebKit.LoadEvent.FINISHED:
            self._page_ready = True
            self._flush_route()
        elif event == WebKit.LoadEvent.STARTED:
            # A reload re-boots the page: the ready post comes again and
            # the retained route re-flushes then. The QUEUE survives.
            self._page_ready = False
            self._boot_ready = False

    def _flush_route(self):
        if not self._route or self._view is None or not self._page_ready:
            return  # the ready post (or reload) flushes
        if not self._boot_ready:
            return  # hook exists before hydration — wait for the ready post
        if not self._notify_same_origin():
            print("[notify] route held: page is not the host UI", flush=True)
            return  # foreign page — keep queued, never eval into it
        chat_id, ix_id = self._route
        # json.dumps is the escaper: UTF-8 passes through, quotes and
        # controls come out as valid JS string escapes.
        payload = json.dumps([chat_id or "", ix_id or ""])
        script = (
            "(function(ids){ var f = window.__museQuestionRoute;"
            " if (f) f(ids[0], ids[1]); })"
            f"({payload})"
        )
        try:
            # WebKit 6.0 async eval, same call the C shell makes.
            # Fire-and-forget with a finish callback so failures surface.
            self._view.evaluate_javascript(
                script, -1, None, None, None, self._on_routing_done, None
            )
        except Exception as exc:
            print(f"[notify] routing eval failed: {exc}", flush=True)
            return
        # Retained until the page's routed receipt (C parity): clearing
        # on eval loses cold/reload taps applied before hydration.
        print(f"[notify] route sent to chat={chat_id[:32]} (receipt pending)", flush=True)

    def _on_open_question(self, _action, parameter):
        try:
            chat_id, ix_id = parameter.unpack()
        except Exception:
            chat_id, ix_id = "", ""
        if self._view is None:
            self.activate()  # no window (closed/cold) — create one
        if self._win is not None:
            self._win.present()
        # Queue (latest wins) and deliver when the page can take it —
        # a tap is never dropped, including cold-start taps.
        self._route = (chat_id or "", ix_id or "")
        self._flush_route()

    @staticmethod
    def _notify_key_valid(key) -> bool:
        if not key or len(key) > 128 or key.startswith(".") or ".." in key:
            return False
        return all(c.isalnum() or c in "_-." for c in key)

    def _show_question(self, notif_id, title, body, chat_id, ix_id):
        try:
            note = Gio.Notification.new(title)
            note.set_body(body)
            note.set_default_action_and_target_value(
                "app.open-question",
                GLib.Variant("(ss)", (chat_id, ix_id)),
            )
            # Same id replaces: host banners, renderer banners, replays
            # and second windows never stack.
            self.send_notification(notif_id, note)
            print(f"[notify] show {notif_id} chat={chat_id[:32]}", flush=True)
        except Exception as exc:
            print(f"[notify] show failed: {exc}", flush=True)

    def _on_notify_question(self, _action, parameter):
        # Host-origin show/withdraw over D-Bus: the node host activates
        # (op, key) so a closed renderer loses no alerts. Banner text
        # travels as a JSON file (UTF-8 safe); only the sanitized key
        # crosses the GVariant text format. C shell parity.
        try:
            op, key = parameter.unpack()
        except Exception:
            print("[notify] host action ignored: bad parameter", flush=True)
            return
        if not op or not self._notify_key_valid(key):
            print("[notify] host action ignored: bad op/key", flush=True)
            return
        runtime = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp"))
        path = runtime / "muse-desktop" / f"notify-{key}.json"
        notif_id = f"muse-q-{key[:128]}"
        if op == "withdraw":
            self.withdraw_notification(notif_id)
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass
            print(f"[notify] withdraw {notif_id} (host)", flush=True)
            return
        if op != "show":
            return
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"[notify] host show {notif_id}: no payload: {exc}", flush=True)
            return
        title = payload.get("title")
        body = payload.get("body")
        chat_id = payload.get("chatId")
        ix_id = payload.get("ixId")
        if not title or not body or not chat_id or not ix_id:
            print(f"[notify] host show {notif_id} ignored: incomplete", flush=True)
            return
        self._show_question(notif_id, title, body, chat_id, ix_id)

    def _on_routing_done(self, view, result, _user_data):
        try:
            view.evaluate_javascript_finish(result)
        except Exception as exc:
            print(f"[notify] routing eval failed: {exc}", flush=True)

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
        # The window is destroyed but the app lives on (D-Bus activatable):
        # drop every widget reference so the next tap activates a FRESH
        # window instead of presenting freed memory. The route queue
        # survives. (Returning False lets the close proceed.)
        self._win = None
        self._view = None
        self._status = None
        self._page_ready = False
        self._boot_ready = False
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
