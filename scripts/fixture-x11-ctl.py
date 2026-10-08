#!/usr/bin/env python3
"""X11 window control for the GTK-shell zombie e2e (scripts/e2e-shell-zombie.mjs).

Pure-stdlib ctypes against libX11 — no pygobject, no x11-utils (this box
has neither on PATH). Commands:

  probe
      Exit 0 when an X display answers and libX11 loads, else exit 2
      (the e2e SKIPS there — headless/CI without X).
  wait --pid PID [--title SUB] [--not-xid XID] [--timeout SEC]
      Poll root toplevels for a viewable window owned by PID (optionally
      matching a title substring, optionally excluding one XID); print its
      decimal XID and exit 0. Exit 1 on timeout.
  destroy --xid XID
      XDestroyWindow + sync — simulates the compositor/foreign-client surface
      kill from the 2026-10-08 incident ("GdkSurface unexpectedly destroyed").
      Exit 0 (idempotent: an already-gone window is success).
  state --xid XID
      Print viewable|unmapped|gone for one window. Exit 0 always (gone is
      data, not an error).

Ownership is matched by _NET_WM_PID, never by title alone — the developer's
real app window carries the same title and must never be touched.
"""

import ctypes
import os
import sys
import time

# X.h constants (stable ABI, not worth querying).
IsUnmapped = 0
IsViewable = 2
BadWindow = 3
XA_CARDINAL = 6  # predefined atom id


def load_x11():
    candidates = [
        "/run/current-system/profile/lib/libX11.so.6",
        "/usr/lib/libX11.so.6",
        "/usr/lib64/libX11.so.6",
        "/lib/x86_64-linux-gnu/libX11.so.6",
        "libX11.so.6",
    ]
    last = None
    for cand in candidates:
        try:
            if cand.startswith("/") and not os.path.exists(cand):
                continue
            return ctypes.CDLL(cand)
        except OSError as exc:  # noqa: PERF203 - tiny candidate list
            last = exc
    raise OSError(f"libX11 not usable: {last}")


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int),
        ("y", ctypes.c_int),
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("border_width", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("visual", ctypes.c_void_p),
        ("root", ctypes.c_ulong),
        ("c_class", ctypes.c_int),
        ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int),
        ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong),
        ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int),
        ("colormap", ctypes.c_ulong),
        ("map_installed", ctypes.c_int),
        ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long),
        ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int),
        ("screen", ctypes.c_void_p),
    ]


class X11:
    """Minimal libX11 binding with a process-wide swallowing error handler.

    Windows can vanish mid-enumeration (the test kills one on purpose) —
    without the handler the default X error path prints and EXITS this
    short-lived process. Errors are recorded so `state` can report them.
    """

    def __init__(self):
        self.lib = load_x11()
        lib = self.lib
        lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        lib.XOpenDisplay.restype = ctypes.c_void_p
        lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
        lib.XCloseDisplay.restype = ctypes.c_int
        lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        lib.XDefaultRootWindow.restype = ctypes.c_ulong
        lib.XQueryTree.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
            ctypes.POINTER(ctypes.c_uint),
        ]
        lib.XQueryTree.restype = ctypes.c_int
        lib.XFree.argtypes = [ctypes.c_void_p]
        lib.XFree.restype = ctypes.c_int
        lib.XFetchName.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_char_p),
        ]
        lib.XFetchName.restype = ctypes.c_int
        lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        lib.XInternAtom.restype = ctypes.c_ulong
        lib.XGetWindowProperty.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_ulong,
            ctypes.c_long,
            ctypes.c_long,
            ctypes.c_int,
            ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        lib.XGetWindowProperty.restype = ctypes.c_int
        lib.XGetWindowAttributes.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(XWindowAttributes),
        ]
        lib.XGetWindowAttributes.restype = ctypes.c_int
        lib.XDestroyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        lib.XDestroyWindow.restype = ctypes.c_int
        lib.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.XSync.restype = ctypes.c_int
        lib.XSetErrorHandler.argtypes = [ctypes.c_void_p]
        lib.XSetErrorHandler.restype = ctypes.c_void_p

        self.errors = []
        handler_t = ctypes.CFUNCTYPE(
            ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p
        )

        class XErrorEvent(ctypes.Structure):
            _fields_ = [
                ("type", ctypes.c_int),
                ("display", ctypes.c_void_p),
                ("resourceid", ctypes.c_ulong),
                ("serial", ctypes.c_ulong),
                ("error_code", ctypes.c_ubyte),
                ("request_code", ctypes.c_ubyte),
                ("minor_code", ctypes.c_ubyte),
            ]

        def on_error(dpy, ev):
            err = ctypes.cast(ev, ctypes.POINTER(XErrorEvent)).contents
            self.errors.append((err.error_code, err.resourceid))
            return 0

        self._handler = handler_t(on_error)  # keep alive: Xlib holds the pointer
        lib.XSetErrorHandler(self._handler)

        self.dpy = lib.XOpenDisplay(None)
        if not self.dpy:
            raise OSError("XOpenDisplay failed (no DISPLAY?)")
        self.root = lib.XDefaultRootWindow(self.dpy)
        self.net_wm_pid = lib.XInternAtom(self.dpy, b"_NET_WM_PID", 0)

    def close(self):
        if self.dpy:
            self.lib.XCloseDisplay(self.dpy)
            self.dpy = None

    def children(self):
        lib = self.lib
        root_ret = ctypes.c_ulong()
        parent_ret = ctypes.c_ulong()
        kids = ctypes.POINTER(ctypes.c_ulong)()
        n = ctypes.c_uint()
        if not lib.XQueryTree(
            self.dpy, self.root, ctypes.byref(root_ret),
            ctypes.byref(parent_ret), ctypes.byref(kids), ctypes.byref(n),
        ):
            return []
        out = [kids[i] for i in range(n.value)]
        if kids:
            lib.XFree(kids)
        return out

    def title(self, xid):
        name = ctypes.c_char_p()
        if self.lib.XFetchName(self.dpy, xid, ctypes.byref(name)) and name.value:
            text = name.value.decode("utf-8", errors="replace")
            self.lib.XFree(name)
            return text
        return ""

    def pid(self, xid):
        lib = self.lib
        actual_type = ctypes.c_ulong()
        actual_fmt = ctypes.c_int()
        nitems = ctypes.c_ulong()
        after = ctypes.c_ulong()
        prop = ctypes.c_void_p()
        rc = lib.XGetWindowProperty(
            self.dpy, xid, self.net_wm_pid, 0, 1, 0, XA_CARDINAL,
            ctypes.byref(actual_type), ctypes.byref(actual_fmt),
            ctypes.byref(nitems), ctypes.byref(after), ctypes.byref(prop),
        )
        if rc == 0 and prop and nitems.value >= 1:
            val = ctypes.cast(prop, ctypes.POINTER(ctypes.c_long))[0]
            lib.XFree(prop)
            return int(val)
        if prop:
            lib.XFree(prop)
        return None

    def map_state(self, xid):
        self.errors.clear()
        attrs = XWindowAttributes()
        self.lib.XGetWindowAttributes(self.dpy, xid, ctypes.byref(attrs))
        self.lib.XSync(self.dpy, 0)
        for code, rid in self.errors:
            if rid == xid and code == BadWindow:
                return None  # gone
        return attrs.map_state

    def destroy(self, xid):
        self.lib.XDestroyWindow(self.dpy, xid)
        self.lib.XSync(self.dpy, 0)


def cmd_probe():
    try:
        x = X11()
    except OSError as exc:
        print(f"no X11: {exc}", file=sys.stderr)
        return 2
    x.close()
    print("x11-ok")
    return 0


def cmd_wait(argv):
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--title", default=None)
    ap.add_argument("--not-xid", default=None)
    ap.add_argument("--timeout", type=float, default=30.0)
    args = ap.parse_args(argv)
    excluded = int(args.not_xid, 0) if args.not_xid else None
    try:
        x = X11()
    except OSError as exc:
        print(f"no X11: {exc}", file=sys.stderr)
        return 2
    try:
        deadline = time.time() + args.timeout
        while time.time() < deadline:
            for xid in x.children():
                if excluded is not None and xid == excluded:
                    continue
                if x.pid(xid) != args.pid:
                    continue
                if args.title and args.title not in x.title(xid):
                    continue
                if x.map_state(xid) != IsViewable:
                    continue
                print(xid)
                return 0
            time.sleep(0.1)
        print("timeout: no matching viewable window", file=sys.stderr)
        return 1
    finally:
        x.close()


def cmd_destroy(argv):
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--xid", required=True)
    args = ap.parse_args(argv)
    try:
        x = X11()
    except OSError as exc:
        print(f"no X11: {exc}", file=sys.stderr)
        return 2
    try:
        x.destroy(int(args.xid, 0))
        return 0
    finally:
        x.close()


def cmd_state(argv):
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--xid", required=True)
    args = ap.parse_args(argv)
    try:
        x = X11()
    except OSError as exc:
        print(f"no X11: {exc}", file=sys.stderr)
        return 2
    try:
        st = x.map_state(int(args.xid, 0))
        if st is None:
            print("gone")
        elif st == IsViewable:
            print("viewable")
        else:
            print("unmapped")
        return 0
    finally:
        x.close()


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "probe":
        return cmd_probe()
    if cmd == "wait":
        return cmd_wait(rest)
    if cmd == "destroy":
        return cmd_destroy(rest)
    if cmd == "state":
        return cmd_state(rest)
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
