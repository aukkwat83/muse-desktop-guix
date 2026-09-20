;; Guix profile for the native GNOME shell (GTK4 + WebKitGTK + Adwaita).
;;
;;   guix shell -m linux/gtk-shell/manifest.scm -- python3 linux/gtk-shell/muse_desktop_shell.py
;;
(specifications->manifest
 (list
  ;; runtime UI
  "gtk"
  "libadwaita"
  "webkitgtk"
  "glib"
  "gdk-pixbuf"
  "shared-mime-info"
  "adwaita-icon-theme"
  "curl" ; host health + memory meter
  ;; build
  "gcc-toolchain"
  "pkg-config"
  "gobject-introspection"
  ;; optional Python prototype (signals broken on some GI combos — C shell preferred)
  "python"
  "python-pygobject"))
