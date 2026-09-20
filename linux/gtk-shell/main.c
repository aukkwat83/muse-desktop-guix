/*
 * Muse Desktop native shell — GTK4 + WebKitGTK 6
 * No Chrome/Firefox. Same role as macOS WKWebView shell.
 *
 * Build (via guix shell):
 *   guix shell -m linux/gtk-shell/manifest.scm gcc-toolchain pkg-config -- \
 *     bash linux/gtk-shell/build.sh
 */
#include <gtk/gtk.h>
#include <gdk/gdkkeysyms.h>
#include <glib/gstdio.h>
#include <adwaita.h>
#include <webkit/webkit.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>

static char *g_base_url = NULL;
static char *g_root = NULL;
static WebKitWebView *g_view = NULL;
static GtkLabel *g_status = NULL;
static guint g_meter_src = 0;

/* R50 — SVG/image card drag-out bridge (dormant until the renderer arms it).
 * Neither the mac shell nor the renderer implements card drag yet, so nothing
 * posts `cardDrag` today and diagrams fall back to the in-page ↓ SVG / ↓ PNG
 * buttons. The bridge is registered anyway so a future renderer port only has
 * to post the real bytes over the `cardDrag` script message: we stash them as
 * a temp file and hand that *file* to GTK's drag machinery instead of letting
 * WebKit export a bare link. */
static GFile *g_armed_file = NULL;
static GdkTexture *g_armed_thumb = NULL;

static char *env_or(const char *k, const char *def)
{
  const char *v = getenv(k);
  return g_strdup(v && *v ? v : def);
}

static gboolean host_ok(void)
{
  /* light check: TCP connect is enough; full HTTP done by WebView */
  char *port = env_or("MUSE_DESKTOP_PORT", "3850");
  char *host = env_or("MUSE_DESKTOP_HOST", "127.0.0.1");
  char *cmd = g_strdup_printf(
      "curl -fsS --max-time 1 http://%s:%s/api/state >/dev/null 2>&1", host, port);
  int rc = system(cmd);
  g_free(cmd);
  g_free(port);
  g_free(host);
  return rc == 0;
}

static char *state_dir_path(void)
{
  char *state = env_or("XDG_STATE_HOME", NULL);
  char *dir;
  if (state)
    dir = g_build_filename(state, "muse-desktop", NULL);
  else
    dir = g_build_filename(g_get_home_dir(), ".local", "state", "muse-desktop", NULL);
  g_mkdir_with_parents(dir, 0755);
  g_free(state);
  return dir;
}

/* Start the node host and record its pid. Does NOT wait — callers on the GTK main
 * loop must poll host_ok() from a timeout instead of blocking the UI. */
static pid_t spawn_host(void)
{
  if (!g_root)
    return -1;
  char *state_dir = state_dir_path();
  char *log = g_build_filename(state_dir, "host.log", NULL);
  char *pidf = g_build_filename(state_dir, "host.pid", NULL);
  char *server = g_build_filename(g_root, "src", "server", "index.js", NULL);

  pid_t pid = fork();
  if (pid == 0) {
    int fd = open(log, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd >= 0) {
      dup2(fd, 1);
      dup2(fd, 2);
      close(fd);
    }
    setenv("NO_OPEN", "1", 1);
    setenv("MUSE_DESKTOP_KEEP_ON_EXIT", "1", 1);
    if (chdir(g_root) != 0)
      _exit(127);
    execlp("node", "node", server, (char *)NULL);
    _exit(127);
  }
  if (pid > 0) {
    FILE *f = fopen(pidf, "w");
    if (f) {
      fprintf(f, "%d\n", (int)pid);
      fclose(f);
    }
    fprintf(stderr, "[native-shell] started host pid=%d\n", (int)pid);
  }
  g_free(state_dir);
  g_free(log);
  g_free(pidf);
  g_free(server);
  return pid;
}

/* Startup path only — blocking here is fine, there is no window yet. */
static void ensure_host(void)
{
  if (host_ok())
    return;
  if (spawn_host() > 0) {
    for (int i = 0; i < 80; i++) {
      if (host_ok())
        break;
      g_usleep(250000);
    }
  }
}

/* R39 — cache-ignoring reload.
 * A plain webkit_web_view_reload() revalidates but still serves the disk-cached
 * bundle, so a renderer edit (even with a ?v= bump) can stay invisible — the same
 * trap the macOS shell hit. Purge the HTTP cache first, then reload bypassing it.
 * Only DISK_CACHE|MEMORY_CACHE are cleared: cookies and localStorage (the theme
 * choice) survive, matching BrowserModel.reload() on macOS. */
static void on_cache_cleared(GObject *src, GAsyncResult *res, gpointer user_data)
{
  (void)user_data;
  webkit_website_data_manager_clear_finish(WEBKIT_WEBSITE_DATA_MANAGER(src), res, NULL);
  if (g_view)
    webkit_web_view_reload_bypass_cache(g_view);
}

static void reload_ignoring_cache(void)
{
  if (!g_view)
    return;
  WebKitNetworkSession *session = webkit_web_view_get_network_session(g_view);
  WebKitWebsiteDataManager *dm =
      session ? webkit_network_session_get_website_data_manager(session) : NULL;
  if (!dm) {
    webkit_web_view_reload_bypass_cache(g_view);
    return;
  }
  webkit_website_data_manager_clear(
      dm, WEBKIT_WEBSITE_DATA_DISK_CACHE | WEBKIT_WEBSITE_DATA_MEMORY_CACHE,
      0, NULL, on_cache_cleared, NULL);
}

static void on_reload(GtkButton *btn, gpointer user_data)
{
  (void)btn;
  (void)user_data;
  reload_ignoring_cache();
}

/* Ctrl+R / Ctrl+Shift+R / F5 — the frozen shell had no keyboard reload at all,
 * which is why "reload" appeared not to update. Runs in the CAPTURE phase so the
 * web view cannot swallow the accelerator first. */
static gboolean on_reload_shortcut(GtkWidget *widget, GVariant *args, gpointer user_data)
{
  (void)widget;
  (void)args;
  (void)user_data;
  reload_ignoring_cache();
  return TRUE;
}

/* R58-guix — restart the node host from the shell.
 *
 * The reload button above is renderer-only. Every server-side pickup needs the node
 * process itself replaced, and until now the only way on this platform was dropping
 * to a terminal — so pressing Ctrl+R after a merge repainted the new bundle against
 * the OLD server and read as a pass. macOS never had that hole
 * (`HostSupervisor.restart()` behind a toolbar button in MuseDesktopShellApp.swift);
 * this is its port.
 *
 * Same order as the Swift one: graceful `POST /api/host/shutdown {killAgents:false}`
 * (warm agents survive) → verified SIGTERM only if HTTP never lands → wait for the
 * port to free → start → wait healthy → cache-ignoring reload.
 *
 * Driven by a 500 ms timeout rather than a worker thread: fork() from a GTK worker
 * thread is a deadlock risk, and each tick is one `curl --max-time 1` — the same
 * shape the memory meter already runs on this loop.
 */
typedef enum { RESTART_IDLE, RESTART_WAIT_DOWN, RESTART_WAIT_UP } RestartPhase;
static GtkWidget *g_restart_btn = NULL;
static RestartPhase g_restart_phase = RESTART_IDLE;
static int g_restart_ticks = 0;

static gboolean request_shutdown_graceful(void)
{
  char *port = env_or("MUSE_DESKTOP_PORT", "3850");
  char *host = env_or("MUSE_DESKTOP_HOST", "127.0.0.1");
  char *cmd = g_strdup_printf(
      "curl -fsS --max-time 3 -X POST -H 'content-type: application/json' "
      "-d '{\"killAgents\":false}' http://%s:%s/api/host/shutdown >/dev/null 2>&1",
      host, port);
  int rc = system(cmd);
  g_free(cmd);
  g_free(port);
  g_free(host);
  return rc == 0;
}

/* Fallback when HTTP is unreachable. Signals the recorded pid only after /proc
 * confirms it is really our host — a recycled pid must never be killed. */
static void stop_host_verified(void)
{
  char *state_dir = state_dir_path();
  char *pidf = g_build_filename(state_dir, "host.pid", NULL);
  char *txt = NULL;
  if (g_file_get_contents(pidf, &txt, NULL, NULL) && txt) {
    int pid = atoi(txt);
    if (pid > 1) {
      char *proc = g_strdup_printf("/proc/%d/cmdline", pid);
      char *cmdline = NULL;
      gsize len = 0;
      if (g_file_get_contents(proc, &cmdline, &len, NULL) && cmdline) {
        for (gsize i = 0; i + 1 < len; i++)
          if (cmdline[i] == '\0')
            cmdline[i] = ' ';
        if (strstr(cmdline, "src/server/index.js")) {
          fprintf(stderr, "[native-shell] host did not answer HTTP — SIGTERM pid=%d\n", pid);
          kill((pid_t)pid, SIGTERM);
        }
        g_free(cmdline);
      }
      g_free(proc);
    }
    g_free(txt);
  }
  g_free(pidf);
  g_free(state_dir);
}

static void restart_finish(const char *msg)
{
  g_restart_phase = RESTART_IDLE;
  g_restart_ticks = 0;
  if (g_restart_btn)
    gtk_widget_set_sensitive(g_restart_btn, TRUE);
  if (msg)
    fprintf(stderr, "[native-shell] %s\n", msg);
}

static gboolean restart_tick(gpointer user_data)
{
  (void)user_data;
  g_restart_ticks++;

  if (g_restart_phase == RESTART_WAIT_DOWN) {
    if (!host_ok()) {
      char *state_dir = state_dir_path();
      char *pidf = g_build_filename(state_dir, "host.pid", NULL);
      g_unlink(pidf);
      g_free(pidf);
      g_free(state_dir);
      spawn_host();
      g_restart_phase = RESTART_WAIT_UP;
      g_restart_ticks = 0;
      if (g_status)
        gtk_label_set_text(g_status, "starting host…");
      return G_SOURCE_CONTINUE;
    }
    if (g_restart_ticks == 12) /* ~6s and still up: HTTP shutdown never landed */
      stop_host_verified();
    if (g_restart_ticks > 40) {
      if (g_status)
        gtk_label_set_text(g_status, "restart failed");
      restart_finish("host restart: old host would not stop");
      return G_SOURCE_REMOVE;
    }
    return G_SOURCE_CONTINUE;
  }

  /* RESTART_WAIT_UP */
  if (host_ok()) {
    reload_ignoring_cache();
    restart_finish("host restarted → renderer reloaded (cache ignored)");
    return G_SOURCE_REMOVE;
  }
  if (g_restart_ticks > 120) {
    if (g_status)
      gtk_label_set_text(g_status, "host down — see host.log");
    restart_finish("host restart: new host did not come up");
    return G_SOURCE_REMOVE;
  }
  return G_SOURCE_CONTINUE;
}

/* Exposed as the `app.restart-host` GAction rather than a bare click handler: the
 * header-bar button is a GtkActionable pointing at it, so menus/accels/AT-SPI and
 * `gdbus … org.gtk.Actions.Activate restart-host` all drive the same production path. */
static void on_restart_host(GSimpleAction *action, GVariant *param, gpointer user_data)
{
  (void)action;
  (void)param;
  (void)user_data;
  if (g_restart_phase != RESTART_IDLE)
    return;
  if (g_restart_btn)
    gtk_widget_set_sensitive(g_restart_btn, FALSE);
  if (g_status)
    gtk_label_set_text(g_status, "restarting host…");
  fprintf(stderr, "[native-shell] host restart requested\n");
  if (!request_shutdown_graceful())
    stop_host_verified();
  g_restart_phase = RESTART_WAIT_DOWN;
  g_restart_ticks = 0;
  g_timeout_add(500, restart_tick, NULL);
}

static gboolean on_decide_policy(WebKitWebView *web_view,
                                WebKitPolicyDecision *decision,
                                WebKitPolicyDecisionType type,
                                gpointer user_data)
{
  (void)web_view;
  (void)user_data;
  if (type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION)
    return FALSE;
  WebKitNavigationPolicyDecision *nd = WEBKIT_NAVIGATION_POLICY_DECISION(decision);
  WebKitNavigationAction *act = webkit_navigation_policy_decision_get_navigation_action(nd);
  WebKitURIRequest *req = webkit_navigation_action_get_request(act);
  const char *uri = webkit_uri_request_get_uri(req);
  if (!uri)
    return FALSE;
  if (g_str_has_prefix(uri, g_base_url) ||
      g_str_has_prefix(uri, "about:") ||
      g_str_has_prefix(uri, "blob:") ||
      g_str_has_prefix(uri, "data:"))
    return FALSE;
  /* external */
  char *cmd = g_strdup_printf("xdg-open '%s' >/dev/null 2>&1 &", uri);
  system(cmd);
  g_free(cmd);
  webkit_policy_decision_ignore(decision);
  return TRUE;
}

/* ---------------------------------------------------------------- card drag */

/* Keep the declared type: the whole point of R50 is that an SVG card drops as
 * vector, so never rasterize into the file itself (the PNG thumb is separate). */
static const char *card_drag_ext_for_mime(const char *mime)
{
  char *m = g_ascii_strdown(mime ? mime : "", -1);
  const char *ext = "bin";
  if (strstr(m, "svg"))
    ext = "svg";
  else if (strstr(m, "png"))
    ext = "png";
  else if (strstr(m, "jpeg") || strstr(m, "jpg"))
    ext = "jpg";
  else if (strstr(m, "gif"))
    ext = "gif";
  else if (strstr(m, "webp"))
    ext = "webp";
  else if (strstr(m, "pdf"))
    ext = "pdf";
  g_free(m);
  return ext;
}

static char *jsc_prop_string(JSCValue *obj, const char *name)
{
  if (!obj || !jsc_value_is_object(obj))
    return NULL;
  JSCValue *v = jsc_value_object_get_property(obj, name);
  char *s = NULL;
  if (v && jsc_value_is_string(v))
    s = jsc_value_to_string(v);
  if (v)
    g_object_unref(v);
  return s;
}

static void card_drag_disarm(void)
{
  g_clear_object(&g_armed_file);
  g_clear_object(&g_armed_thumb);
}

/* `cardDrag` payload shape a future renderer sender must post:
 * { name, fileMime, fileBase64, thumbBase64 } (base64 strings). */
static void on_card_drag(WebKitUserContentManager *ucm, JSCValue *value, gpointer user_data)
{
  (void)ucm;
  (void)user_data;

  char *name = jsc_prop_string(value, "name");
  char *mime = jsc_prop_string(value, "fileMime");
  char *file_b64 = jsc_prop_string(value, "fileBase64");
  char *thumb_b64 = jsc_prop_string(value, "thumbBase64");

  card_drag_disarm();

  if (!file_b64 || !*file_b64)
    goto out;

  gsize len = 0;
  guchar *bytes = g_base64_decode(file_b64, &len);
  if (!bytes || len == 0) {
    g_free(bytes);
    goto out;
  }

  /* $TMPDIR/muse-desktop-drags/<name>.<ext> — dedicated temp dir (0700).
   * g_get_tmp_dir() honours TMPDIR, so this stays inside the user's temp. */
  char *dir = g_build_filename(g_get_tmp_dir(), "muse-desktop-drags", NULL);
  g_mkdir_with_parents(dir, 0700);

  char *safe = g_strdup((name && *name) ? name : "graphic");
  g_strdelimit(safe, "/\\:", '-'); /* flat filename only — no traversal */
  char *base = g_strdup_printf("%s.%s", safe, card_drag_ext_for_mime(mime));
  char *path = g_build_filename(dir, base, NULL);

  GError *err = NULL;
  if (g_file_set_contents(path, (const char *)bytes, (gssize)len, &err)) {
    g_armed_file = g_file_new_for_path(path);
  } else {
    fprintf(stderr, "[card-drag] write failed: %s\n", err ? err->message : "?");
    g_clear_error(&err);
  }

  /* Drag icon. Optional: a missing/undecodable thumb just means GTK draws its
   * default drag cursor — the file payload is unaffected. */
  if (g_armed_file && thumb_b64 && *thumb_b64) {
    gsize tlen = 0;
    guchar *tbytes = g_base64_decode(thumb_b64, &tlen);
    if (tbytes && tlen > 0) {
      GBytes *gb = g_bytes_new_take(tbytes, tlen);
      g_armed_thumb = gdk_texture_new_from_bytes(gb, NULL);
      g_bytes_unref(gb);
    } else {
      g_free(tbytes);
    }
  }

  if (g_armed_file)
    fprintf(stderr, "[card-drag] armed %s (%zu bytes)\n", path, (size_t)len);

  g_free(bytes);
  g_free(dir);
  g_free(safe);
  g_free(base);
  g_free(path);

out:
  g_free(name);
  g_free(mime);
  g_free(file_b64);
  g_free(thumb_b64);
}

/* Runs in GTK_PHASE_CAPTURE, i.e. before WebKitGTK's own DnD. Returning NULL
 * when not armed leaves ordinary drags (text selection, scrolling, the session
 * list) untouched — the intercept must be a strict no-op unless a card armed it. */
static GdkContentProvider *on_drag_prepare(GtkDragSource *src, double x, double y,
                                           gpointer user_data)
{
  (void)src;
  (void)x;
  (void)y;
  (void)user_data;
  if (!g_armed_file)
    return NULL;

  /* Offer both shapes: GdkFileList is what GTK apps and Nautilus prefer, while
   * text/uri-list is the freedesktop lingua franca that Inkscape/GIMP/Qt read.
   * Advertising both keeps the drop a *file* wherever it lands. */
  /* GdkFileList is a boxed type with no public unref — new_typed() copies it into
   * the GValue, so we hand ours back with g_boxed_free. */
  GdkFileList *fl = gdk_file_list_new_from_array(&g_armed_file, 1);
  GdkContentProvider *as_files = gdk_content_provider_new_typed(GDK_TYPE_FILE_LIST, fl);
  g_boxed_free(GDK_TYPE_FILE_LIST, fl);

  char *uri = g_file_get_uri(g_armed_file);
  char *uri_list = g_strconcat(uri, "\r\n", NULL);
  GBytes *ub = g_bytes_new_take(uri_list, strlen(uri_list));
  GdkContentProvider *as_uris = gdk_content_provider_new_for_bytes("text/uri-list", ub);
  g_bytes_unref(ub);
  g_free(uri);

  GdkContentProvider *both[] = { as_files, as_uris };
  GdkContentProvider *provider = gdk_content_provider_new_union(both, 2);
  g_object_unref(as_files);
  g_object_unref(as_uris);
  return provider;
}

static void on_drag_begin(GtkDragSource *src, GdkDrag *drag, gpointer user_data)
{
  (void)drag;
  (void)user_data;
  if (!g_armed_thumb)
    return;
  int w = gdk_texture_get_width(g_armed_thumb);
  int h = gdk_texture_get_height(g_armed_thumb);
  gtk_drag_source_set_icon(src, GDK_PAINTABLE(g_armed_thumb), w / 2, h / 2);
}

static void on_drag_end(GtkDragSource *src, GdkDrag *drag, gboolean delete_data,
                        gpointer user_data)
{
  (void)src;
  (void)drag;
  (void)delete_data;
  (void)user_data;
  card_drag_disarm();
}

static gboolean poll_memory(gpointer user_data)
{
  (void)user_data;
  if (!g_status)
    return G_SOURCE_CONTINUE;
  /* Leave the label alone while a restart owns it, or the meter overwrites the
   * only progress signal the user gets. */
  if (g_restart_phase != RESTART_IDLE)
    return G_SOURCE_CONTINUE;
  char *port = env_or("MUSE_DESKTOP_PORT", "3850");
  char *host = env_or("MUSE_DESKTOP_HOST", "127.0.0.1");
  char *tmp = g_strdup_printf("/tmp/muse-mem-%d.json", (int)getpid());
  char *cmd = g_strdup_printf(
      "curl -fsS --max-time 2 'http://%s:%s/api/memory' -o '%s' 2>/dev/null",
      host, port, tmp);
  int rc = system(cmd);
  g_free(cmd);
  if (rc == 0) {
    gchar *contents = NULL;
    if (g_file_get_contents(tmp, &contents, NULL, NULL) && contents) {
      /* tiny parse for freeMB / maxHotAgents / pressure — best-effort */
      const char *p = strstr(contents, "\"freeMB\":");
      const char *h = strstr(contents, "\"maxHotAgents\":");
      int free_mb = 0, max_h = 0;
      if (p)
        free_mb = atoi(p + 9);
      if (h)
        max_h = atoi(h + 15);
      char buf[128];
      if (free_mb >= 1024)
        snprintf(buf, sizeof buf, "Hot ?/%d · Free %.1fG · WebKitGTK", max_h,
                 free_mb / 1024.0);
      else
        snprintf(buf, sizeof buf, "Hot ?/%d · Free %dM · WebKitGTK", max_h, free_mb);
      gtk_label_set_text(g_status, buf);
      g_free(contents);
    }
  } else {
    gtk_label_set_text(g_status, "host?");
  }
  unlink(tmp);
  g_free(tmp);
  g_free(port);
  g_free(host);
  return G_SOURCE_CONTINUE;
}

static void on_activate(GtkApplication *app, gpointer user_data)
{
  (void)user_data;
  AdwApplicationWindow *win = ADW_APPLICATION_WINDOW(adw_application_window_new(app));
  gtk_window_set_title(GTK_WINDOW(win), "Muse Desktop");
  gtk_window_set_default_size(GTK_WINDOW(win), 1280, 860);

  GtkWidget *header = adw_header_bar_new();
  GtkWidget *title = adw_window_title_new("Muse Desktop", "native · WebKitGTK (not a browser)");
  adw_header_bar_set_title_widget(ADW_HEADER_BAR(header), title);

  GtkWidget *reload = gtk_button_new_from_icon_name("view-refresh-symbolic");
  gtk_widget_set_tooltip_text(reload, "Reload UI (Ctrl+R) — ignores cache · renderer only");
  g_signal_connect(reload, "clicked", G_CALLBACK(on_reload), NULL);
  adw_header_bar_pack_start(ADW_HEADER_BAR(header), reload);

  /* R58-guix — the mac shell's "รีสตาร์ท host" menu button equivalent. */
  GSimpleAction *restart_act = g_simple_action_new("restart-host", NULL);
  g_signal_connect(restart_act, "activate", G_CALLBACK(on_restart_host), NULL);
  g_action_map_add_action(G_ACTION_MAP(app), G_ACTION(restart_act));
  g_object_unref(restart_act);

  g_restart_btn = gtk_button_new_from_icon_name("system-reboot-symbolic");
  gtk_widget_set_tooltip_text(
      g_restart_btn,
      "Restart host (node server) — needed after a server-side pickup; Reload alone "
      "repaints the renderer against the old host");
  gtk_actionable_set_action_name(GTK_ACTIONABLE(g_restart_btn), "app.restart-host");
  adw_header_bar_pack_start(ADW_HEADER_BAR(header), g_restart_btn);

  g_status = GTK_LABEL(gtk_label_new("…"));
  gtk_widget_add_css_class(GTK_WIDGET(g_status), "dim-label");
  gtk_widget_set_margin_end(GTK_WIDGET(g_status), 8);
  adw_header_bar_pack_end(ADW_HEADER_BAR(header), GTK_WIDGET(g_status));

  /* WebView */
  WebKitNetworkSession *session = NULL;
  char *state = env_or("XDG_STATE_HOME", NULL);
  char *state_dir;
  if (state)
    state_dir = g_build_filename(state, "muse-desktop", NULL);
  else
    state_dir = g_build_filename(g_get_home_dir(), ".local", "state", "muse-desktop", NULL);
  char *data_dir = g_build_filename(state_dir, "webkit-data", NULL);
  char *cache_dir = g_build_filename(state_dir, "webkit-cache", NULL);
  g_mkdir_with_parents(data_dir, 0755);
  g_mkdir_with_parents(cache_dir, 0755);
  session = webkit_network_session_new(data_dir, cache_dir);

  /* The JS↔native bridge. Registering `cardDrag` is what makes
   * window.webkit.messageHandlers.cardDrag exist, which is the exact thing
   * nativeCardDragSupported() feature-detects — so the renderer arms itself with
   * no Linux-specific change. WebKitGTK 6.0 takes a JS world name (NULL = main). */
  WebKitUserContentManager *ucm = webkit_user_content_manager_new();
  gboolean bridge_ok =
      webkit_user_content_manager_register_script_message_handler(ucm, "cardDrag", NULL);
  g_signal_connect(ucm, "script-message-received::cardDrag",
                   G_CALLBACK(on_card_drag), NULL);
  /* Logged so QC can confirm the bridge from host.log alone: without it the
   * renderer silently falls back to the ↓ download button and the drag is a link. */
  fprintf(stderr, "[native-shell] cardDrag bridge %s\n",
          bridge_ok ? "registered" : "FAILED to register");

  g_view = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW,
                                        "network-session", session,
                                        "user-content-manager", ucm,
                                        NULL));
  WebKitSettings *settings = webkit_web_view_get_settings(g_view);
  webkit_settings_set_enable_javascript(settings, TRUE);
  webkit_settings_set_enable_webgl(settings, TRUE);
  /* R58-guix — parity with ContentView.swift, which sets developerExtrasEnabled +
   * isInspectable on mac. Without it there is no Web Inspector inside the native
   * window, so renderer-side behaviour (a permission card's DOM,
   * pending-interaction state, console errors) can only be checked by abandoning
   * the shell for a browser —
   * the exact dependency this shell exists to remove. Right-click → Inspect Element.
   * Console forwarding stays opt-in so host.log does not fill with page noise. */
  webkit_settings_set_enable_developer_extras(settings, TRUE);
  {
    char *dev = env_or("MUSE_DESKTOP_DEVTOOLS", "0");
    if (*dev && g_strcmp0(dev, "0") != 0 && g_strcmp0(dev, "false") != 0) {
      webkit_settings_set_enable_write_console_messages_to_stdout(settings, TRUE);
      fprintf(stderr, "[native-shell] devtools: console → stderr\n");
    }
    g_free(dev);
  }
  g_signal_connect(g_view, "decide-policy", G_CALLBACK(on_decide_policy), NULL);
  webkit_web_view_load_uri(g_view, g_base_url);

  /* R50 — the native half of the card drag. CAPTURE so we get the gesture before
   * WebKitGTK, which would otherwise export the image as a *link*. on_drag_prepare
   * returns NULL unless a card armed us, so every other drag behaves as before. */
  GtkDragSource *drag_src = gtk_drag_source_new();
  gtk_drag_source_set_actions(drag_src, GDK_ACTION_COPY);
  gtk_event_controller_set_propagation_phase(GTK_EVENT_CONTROLLER(drag_src),
                                            GTK_PHASE_CAPTURE);
  g_signal_connect(drag_src, "prepare", G_CALLBACK(on_drag_prepare), NULL);
  g_signal_connect(drag_src, "drag-begin", G_CALLBACK(on_drag_begin), NULL);
  g_signal_connect(drag_src, "drag-end", G_CALLBACK(on_drag_end), NULL);
  gtk_widget_add_controller(GTK_WIDGET(g_view), GTK_EVENT_CONTROLLER(drag_src));

  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  gtk_box_append(GTK_BOX(box), header);
  gtk_widget_set_vexpand(GTK_WIDGET(g_view), TRUE);
  gtk_box_append(GTK_BOX(box), GTK_WIDGET(g_view));
  adw_application_window_set_content(win, box);

  /* R39 — Ctrl+R / Ctrl+Shift+R / F5. CAPTURE so the web view cannot eat them. */
  GtkEventController *keys = gtk_shortcut_controller_new();
  gtk_event_controller_set_propagation_phase(keys, GTK_PHASE_CAPTURE);
  GtkShortcutTrigger *reload_trigger = gtk_alternative_trigger_new(
      gtk_keyval_trigger_new(GDK_KEY_r, GDK_CONTROL_MASK),
      gtk_alternative_trigger_new(
          gtk_keyval_trigger_new(GDK_KEY_R, GDK_CONTROL_MASK | GDK_SHIFT_MASK),
          gtk_keyval_trigger_new(GDK_KEY_F5, 0)));
  gtk_shortcut_controller_add_shortcut(
      GTK_SHORTCUT_CONTROLLER(keys),
      gtk_shortcut_new(reload_trigger,
                       gtk_callback_action_new(on_reload_shortcut, NULL, NULL)));
  gtk_widget_add_controller(GTK_WIDGET(win), keys);

  gtk_window_present(GTK_WINDOW(win));
  g_meter_src = g_timeout_add_seconds(8, poll_memory, NULL);
  poll_memory(NULL);

  fprintf(stderr, "[native-shell] presented WebKitGTK → %s\n", g_base_url);

  g_free(state);
  g_free(state_dir);
  g_free(data_dir);
  g_free(cache_dir);
}

int main(int argc, char **argv)
{
  g_root = env_or("MUSE_DESKTOP_ROOT", ".");
  char *port = env_or("MUSE_DESKTOP_PORT", "3850");
  char *host = env_or("MUSE_DESKTOP_HOST", "127.0.0.1");
  g_base_url = g_strdup_printf("http://%s:%s/", host, port);

  ensure_host();

  adw_init();
  AdwApplication *app = adw_application_new("com.aukkwat83.MuseDesktop", G_APPLICATION_DEFAULT_FLAGS);
  g_signal_connect(app, "activate", G_CALLBACK(on_activate), NULL);
  int status = g_application_run(G_APPLICATION(app), argc, argv);
  g_object_unref(app);

  g_free(g_base_url);
  g_free(g_root);
  g_free(port);
  g_free(host);
  return status;
}
