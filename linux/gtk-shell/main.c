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
#ifdef GDK_WINDOWING_X11
#include <gdk/x11/gdkx.h>
#endif
#include <dlfcn.h>
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
static GApplication *g_app = NULL;
static WebKitWebView *g_view = NULL;
static GtkLabel *g_status = NULL;
static guint g_meter_src = 0;
/* Banner-tap routing: the page is ready only after its load finishes, and
 * a tap can arrive before that (cold-start activation) or mid-reload. The
 * latest tap waits here until flush_pending_route() can deliver it — taps
 * are never dropped, and a reload re-flushes instead of losing the route. */
static gboolean g_page_ready = FALSE;
static char *g_route_chat = NULL;
static char *g_route_ix = NULL;
/* Renderer hydration handshake: the page posts {op:'ready'} after boot
 * (chats/pendings/transcript loaded) and {op:'routed'} per applied tap.
 * The queue clears ONLY on a matching receipt — never on a timer. */
static gboolean g_boot_ready = FALSE;

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

/* ------------------------------------------------------------- notify */
/* Question banners with click routing (1.1.33). The renderer posts
 * structured payloads — { op:'show', id, title, body, chatId, ixId } and
 * { op:'withdraw', id } — over window.webkit.messageHandlers.museNotify.
 * The shell shows a GNotification whose default action is the typed
 * app.open-question (ss) GAction: a banner tap presents this window and
 * routes the renderer to the exact chat + question form. Same notification
 * id from every window, so multi-window duplicates collapse to ONE banner
 * (the dedupe is the id, not a lock). No shell interpolation anywhere —
 * ids ride as GVariant strings, never through a command line. */

static void muse_show_question(const char *notif_id, const char *title,
                               const char *body, const char *chat_id,
                               const char *ix_id);

/* The bridge only serves our own page: a foreign URI in the view (user
 * pasted a link into the web view somehow) must not be able to banner. */
static gboolean muse_notify_same_origin(void)
{
  if (!g_view || !g_base_url)
    return FALSE;
  const char *uri = webkit_web_view_get_uri(g_view);
  return uri && g_str_has_prefix(uri, g_base_url);
}

static void on_routing_eval_done(GObject *object, GAsyncResult *result,
                                 gpointer user_data)
{
  (void)user_data;
  GError *error = NULL;
  JSCValue *value = webkit_web_view_evaluate_javascript_finish(
      WEBKIT_WEB_VIEW(object), result, &error);
  if (error != NULL) {
    g_printerr("[notify] routing eval failed: %s\n", error->message);
    g_clear_error(&error);
  }
  if (value != NULL)
    g_object_unref(value);
}

/* JSON string escaping for ids evaluated into the page: quotes,
 * backslashes and C0 controls escaped, every other byte (incl. UTF-8)
 * passed through verbatim. g_strescape is WRONG here — its octal escapes
 * (\001) are not valid JS string escapes and corrupt non-ASCII ids. */
static char *js_string_escape(const char *s)
{
  GString *out = g_string_new(NULL);
  for (const unsigned char *p = (const unsigned char *)(s ? s : ""); *p; p++) {
    switch (*p) {
    case '"': g_string_append(out, "\\\""); break;
    case '\\': g_string_append(out, "\\\\"); break;
    case '\b': g_string_append(out, "\\b"); break;
    case '\f': g_string_append(out, "\\f"); break;
    case '\n': g_string_append(out, "\\n"); break;
    case '\r': g_string_append(out, "\\r"); break;
    case '\t': g_string_append(out, "\\t"); break;
    default:
      if (*p < 0x20)
        g_string_append_printf(out, "\\u%04x", *p);
      else
        g_string_append_c(out, (char)*p);
      break;
    }
  }
  return g_string_free(out, FALSE);
}

/* Present our window (the web view's native toplevel). */
static void muse_present_window(void)
{
  if (!g_view)
    return;
  GtkNative *native = gtk_widget_get_native(GTK_WIDGET(g_view));
  if (native && GTK_IS_WINDOW(native))
    gtk_window_present(GTK_WINDOW(native));
}

/* Queue one banner-tap route (latest wins) and deliver when the page can
 * take it: view exists, load finished, HYDRATED (the page posts {op:'ready'}
 * after its chats/pendings/transcript load — load-finished alone is NOT
 * renderer-ready: the route hook exists before hydration, and a tap applied
 * mid-hydration finds no chats and loses the route), same origin. Anything
 * less keeps the route queued — a tap is never dropped, including
 * cold-start taps that arrive before the first page exists at all. */
static void queue_question_route(const char *chat_id, const char *ix_id)
{
  g_free(g_route_chat);
  g_free(g_route_ix);
  g_route_chat = g_strdup(chat_id ? chat_id : "");
  g_route_ix = g_strdup(ix_id ? ix_id : "");
  fprintf(stderr, "[notify] route queued chat=%.32s ix=%.32s\n",
          g_route_chat, g_route_ix);
}

static void clear_question_route(void)
{
  g_free(g_route_chat);
  g_free(g_route_ix);
  g_route_chat = NULL;
  g_route_ix = NULL;
}

static void flush_pending_route(void)
{
  if (!g_route_chat || !g_route_ix)
    return; /* nothing queued */
  if (!g_view || !g_page_ready || !g_boot_ready)
    return; /* the ready post (or reload) flushes */
  if (!muse_notify_same_origin()) {
    fprintf(stderr, "[notify] route held: page is not the host UI\n");
    return; /* foreign page — keep queued, never eval into it */
  }
  char *chat_esc = js_string_escape(g_route_chat);
  char *ix_esc = js_string_escape(g_route_ix);
  char *script = g_strdup_printf(
      "window.__museQuestionRoute && window.__museQuestionRoute(\"%s\",\"%s\")",
      chat_esc, ix_esc);
  webkit_web_view_evaluate_javascript(g_view, script, -1, NULL, NULL, NULL,
                                      on_routing_eval_done, NULL);
  fprintf(stderr, "[notify] route sent to chat=%.32s ix=%.32s (receipt pending)\n",
          g_route_chat, g_route_ix);
  g_free(chat_esc);
  g_free(ix_esc);
  g_free(script);
  /* The queue clears ONLY on the page's {op:'routed'} receipt (or a newer
   * tap replacing it) — clearing on eval loses cold/reload taps whose
   * hook ran before hydration. A reload re-sends; duplicates are
   * harmless (the hook is idempotent, latest wins both sides). */
}

/* No timeout fallback here by design: a slow current renderer is NOT
 * legacy, and clearing the queue without a receipt pretends a tap was
 * applied when it may never have run. The route is retained across slow
 * hydration, failure and reload; every load-finished and ready post
 * re-flushes (bounded by page events, never a rapid poll). */
static void on_webview_load_changed(WebKitWebView *view, WebKitLoadEvent event,
                                    gpointer user_data)
{
  (void)view;
  (void)user_data;
  if (event == WEBKIT_LOAD_FINISHED) {
    g_page_ready = TRUE;
    flush_pending_route();
  } else if (event == WEBKIT_LOAD_STARTED) {
    /* A reload re-boots the page: hydration (and the ready post) comes
     * again — the retained route re-flushes then. The QUEUE survives. */
    g_page_ready = FALSE;
    g_boot_ready = FALSE;
  }
}

static void on_shell_window_destroy(GtkWidget *widget, gpointer user_data)
{
  (void)widget;
  (void)user_data;
  /* The window (and its web view) is gone but the app lives on: drop the
   * dangling view so the next tap activates a fresh window instead of
   * evaluating into freed memory. The route queue survives. */
  g_view = NULL;
  g_page_ready = FALSE;
  g_boot_ready = FALSE;
  g_status = NULL;
}

/* ---- Zombie-window recovery (2026-10-08 incident) ----
 * The compositor (or any foreign X client) can destroy our toplevel out from
 * under GTK: GDK logs "GdkSurface unexpectedly destroyed" and NO widget
 * signal fires — no unmap, no hide, no destroy. The GtkWindow object stays in
 * the application's window list (so the process lives on), still reporting
 * visible=1 mapped=1 with a non-NULL surface — a probe proved every public
 * API agrees the zombie is healthy. The only detector is asking the X server
 * whether the xid still exists. Wayland has no such external-destroy path
 * (killing the client kills our connection, not one surface), so there the
 * window is trusted as before. */
struct x11_err_evt {
  int type;
  void *display;
  unsigned long resourceid;
  unsigned long serial;
  unsigned char error_code;
  unsigned char request_code;
  unsigned char minor_code;
};

static unsigned long g_x11_err_xid = 0;
static unsigned int g_x11_err_code = 0;

static int x11_probe_error(void *dpy, void *ev)
{
  (void)dpy;
  struct x11_err_evt *e = (struct x11_err_evt *)ev;
  g_x11_err_code = e->error_code;
  g_x11_err_xid = e->resourceid;
  return 0;
}

/* TRUE when the window can actually be presented. Conservative by design:
 * anything we cannot judge (not X11, libX11 unresolvable, never shown)
 * returns TRUE — worst case is the old behaviour, never destroying a window
 * we could have presented. Main-loop only (Activates run there). */
static gboolean shell_window_usable(GtkWindow *win)
{
#ifdef GDK_WINDOWING_X11
  GdkDisplay *gdpy = gdk_display_get_default();
  if (gdpy != NULL && GDK_IS_X11_DISPLAY(gdpy)) {
    GdkSurface *s = gtk_native_get_surface(GTK_NATIVE(win));
    if (s == NULL)
      return TRUE; /* never shown — trust the build path */
    /* libX11 via dlopen: no new link dep (build.sh links gtk/adwaita/webkit
     * only), absolute system path first so a shifted store cannot break it. */
    static void *x11 = NULL;
    static int inited = 0;
    static int (*XGetWindowAttributes_fn)(void *, unsigned long, void *) = NULL;
    static int (*XSync_fn)(void *, int) = NULL;
    static void *(*XSetErrorHandler_fn)(void *) = NULL;
    if (!inited) {
      inited = 1;
      const char *paths[] = {
        "/run/current-system/profile/lib/libX11.so.6",
        "/usr/lib/libX11.so.6",
        "/usr/lib64/libX11.so.6",
        "libX11.so.6",
        NULL,
      };
      for (int i = 0; paths[i] != NULL && x11 == NULL; i++)
        x11 = dlopen(paths[i], RTLD_NOW | RTLD_LOCAL);
      if (x11 != NULL) {
        XGetWindowAttributes_fn = dlsym(x11, "XGetWindowAttributes");
        XSync_fn = dlsym(x11, "XSync");
        XSetErrorHandler_fn = dlsym(x11, "XSetErrorHandler");
      }
    }
    if (x11 != NULL && XGetWindowAttributes_fn != NULL && XSync_fn != NULL &&
        XSetErrorHandler_fn != NULL) {
      /* Deprecated but irreplaceable: nothing else hands out the Display* /
       * xid a server round-trip needs. Narrowly suppressed, not -Wno. */
G_GNUC_BEGIN_IGNORE_DEPRECATIONS
      void *dpy = gdk_x11_display_get_xdisplay(gdpy);
      unsigned long xid = (unsigned long)gdk_x11_surface_get_xid(s);
G_GNUC_END_IGNORE_DEPRECATIONS
      /* XGetWindowAttributes fills sizeof(XWindowAttributes) (~136 bytes on
       * LP64, ABI-stable); only success vs BadWindow matters here. */
      char attrs[512];
      memset(attrs, 0, sizeof(attrs));
      g_x11_err_code = 0;
      g_x11_err_xid = 0;
      void *old = XSetErrorHandler_fn(x11_probe_error);
      XGetWindowAttributes_fn(dpy, xid, attrs);
      XSync_fn(dpy, 0);
      XSetErrorHandler_fn(old);
      /* BadWindow(3) for OUR xid means the server has no such window. Any
       * other error is somebody else's in-flight request — ignore it. */
      if (g_x11_err_code == 3 && g_x11_err_xid == xid)
        return FALSE;
    }
  }
#else
  (void)win;
#endif
  return TRUE;
}

/* Banner-tap twin of the on_activate check: a zombie view's native window
 * presents nowhere, so taps must route through activation (which rebuilds)
 * instead of presenting dead pixels. */
static gboolean shell_view_usable(void)
{
  if (!g_view)
    return FALSE;
  GtkNative *native = gtk_widget_get_native(GTK_WIDGET(g_view));
  if (native == NULL || !GTK_IS_WINDOW(native))
    return FALSE;
  return shell_window_usable(GTK_WINDOW(native));
}

/* Banner tap → window up, then route the renderer. The ids come from the
 * GAction's typed (ss) parameter (set at show time). When no window
 * exists (closed, or a cold D-Bus activation racing startup), activate
 * the app to CREATE one — presenting alone would route nowhere. */
static void on_open_question_action(GSimpleAction *action, GVariant *parameter,
                                    gpointer user_data)
{
  (void)action;
  (void)user_data;
  char *chat_id = NULL;
  char *ix_id = NULL;
  if (parameter != NULL)
    g_variant_get(parameter, "(ss)", &chat_id, &ix_id);
  if ((!g_view || !shell_view_usable()) && g_app)
    g_application_activate(g_app);
  muse_present_window();
  queue_question_route(chat_id, ix_id);
  flush_pending_route();
  g_free(chat_id);
  g_free(ix_id);
}

static void on_muse_notify(WebKitUserContentManager *ucm, JSCValue *value,
                           gpointer user_data)
{
  (void)ucm;
  (void)user_data;
  if (g_app == NULL)
    return;
  if (!muse_notify_same_origin()) {
    fprintf(stderr, "[notify] ignored: page is not the host UI\n");
    return;
  }
  char *op = jsc_prop_string(value, "op");
  char *nid = jsc_prop_string(value, "id");
  if (!op || !*op)
    goto out;
  /* Hydration handshake: the page is ready for queued tap routes. */
  if (g_strcmp0(op, "ready") == 0) {
    g_boot_ready = TRUE;
    fprintf(stderr, "[notify] renderer hydrated — flushing routes\n");
    flush_pending_route();
    goto out;
  }
  /* Positive application receipt: clear ONLY the matching queued route. */
  if (g_strcmp0(op, "routed") == 0) {
    char *rchat = jsc_prop_string(value, "chatId");
    char *rix = jsc_prop_string(value, "ixId");
    if (g_route_chat && g_route_ix && rchat && rix &&
        g_strcmp0(rchat, g_route_chat) == 0 &&
        g_strcmp0(rix, g_route_ix) == 0) {
      fprintf(stderr, "[notify] route receipt chat=%.32s ix=%.32s\n", rchat, rix);
      clear_question_route();
    } else {
      fprintf(stderr, "[notify] stray route receipt (queue replaced) — kept\n");
    }
    g_free(rchat);
    g_free(rix);
    goto out;
  }
  if (!nid || !*nid)
    goto out;
  if (g_strcmp0(op, "withdraw") == 0) {
    /* Same derived id as the show path, or the banner lingers. */
    char *withdraw_id = g_strdup_printf("muse-q-%.128s", nid);
    g_application_withdraw_notification(g_app, withdraw_id);
    fprintf(stderr, "[notify] withdraw %s\n", withdraw_id);
    g_free(withdraw_id);
    goto out;
  }
  if (g_strcmp0(op, "show") != 0)
    goto out;
  {
    char *title = jsc_prop_string(value, "title");
    char *body = jsc_prop_string(value, "body");
    char *chat_id = jsc_prop_string(value, "chatId");
    char *ix_id = jsc_prop_string(value, "ixId");
    if (!title || !*title || !body || !*body || !chat_id || !ix_id) {
      fprintf(stderr, "[notify] show ignored: incomplete payload\n");
      g_free(title);
      g_free(body);
      g_free(chat_id);
      g_free(ix_id);
      goto out;
    }
    char *notif_id = g_strdup_printf("muse-q-%.128s", nid);
    muse_show_question(notif_id, title, body, chat_id, ix_id);
    g_free(notif_id);
    g_free(title);
    g_free(body);
    g_free(chat_id);
    g_free(ix_id);
  }
out:
  g_free(op);
  g_free(nid);
}

/* One banner for one question, whichever side asked: the renderer bridge
 * and the host D-Bus action share this show path AND the notification id
 * scheme (muse-q-<key>), so a host banner and a renderer banner for one
 * question replace each other instead of stacking. */
static void muse_show_question(const char *notif_id, const char *title,
                               const char *body, const char *chat_id,
                               const char *ix_id)
{
  if (!g_app || !notif_id || !title || !body || !chat_id || !ix_id)
    return;
  GNotification *n = g_notification_new(title);
  g_notification_set_body(n, body);
  g_notification_set_default_action_and_target(n, "app.open-question",
                                               "(ss)", chat_id, ix_id);
  g_application_send_notification(g_app, notif_id, n);
  fprintf(stderr, "[notify] show %s chat=%.32s ix=%.32s\n", notif_id,
          chat_id, ix_id);
  g_object_unref(n);
}

/* Host-origin banners arrive over D-Bus from ANY local caller, so the key
 * is validated here even though the host sanitizes it: flat filename
 * characters only, no leading dot, no dot-dot run. */
static gboolean muse_notify_key_valid(const char *key)
{
  if (!key || !*key || strlen(key) > 128)
    return FALSE;
  if (key[0] == '.' || strstr(key, ".."))
    return FALSE;
  for (const char *p = key; *p; p++) {
    if (!g_ascii_isalnum(*p) && *p != '_' && *p != '-' && *p != '.')
      return FALSE;
  }
  return TRUE;
}

static char *muse_notify_file_for_key(const char *key)
{
  return g_build_filename(g_get_user_runtime_dir(), "muse-desktop",
                          g_strdup_printf("notify-%s.json", key), NULL);
}

/* Host-origin show/withdraw over D-Bus: app.notify-question (op, key).
 * The banner text travels as a JSON file (UTF-8 safe — only the
 * sanitized key crosses the GVariant text format); the file is parsed
 * with JavaScriptCore, the same engine that produced the bridge values,
 * so no new parser dependency and no escaping round-trip can corrupt
 * non-ASCII text. Withdraw also unlinks the file (best-effort). */
static void on_notify_question_action(GSimpleAction *action, GVariant *parameter,
                                      gpointer user_data)
{
  (void)action;
  (void)user_data;
  if (g_app == NULL)
    return;
  char *op = NULL;
  char *key = NULL;
  if (parameter != NULL)
    g_variant_get(parameter, "(ss)", &op, &key);
  if (!op || !muse_notify_key_valid(key)) {
    fprintf(stderr, "[notify] host action ignored: bad op/key\n");
    goto out;
  }
  char *notif_id = g_strdup_printf("muse-q-%.128s", key);
  if (g_strcmp0(op, "withdraw") == 0) {
    g_application_withdraw_notification(g_app, notif_id);
    char *path = muse_notify_file_for_key(key);
    g_unlink(path);
    fprintf(stderr, "[notify] withdraw %s (host)\n", notif_id);
    g_free(path);
    g_free(notif_id);
    goto out;
  }
  if (g_strcmp0(op, "show") != 0) {
    g_free(notif_id);
    goto out;
  }
  {
    char *path = muse_notify_file_for_key(key);
    char *contents = NULL;
    GError *err = NULL;
    if (!g_file_get_contents(path, &contents, NULL, &err) || !contents) {
      fprintf(stderr, "[notify] host show %s: no payload file: %s\n",
              notif_id, err ? err->message : "?");
      g_clear_error(&err);
      g_free(path);
      g_free(notif_id);
      goto out;
    }
    /* Host-written JSON is a valid JS expression in parens — no escaping
     * layer between the file bytes and the parsed strings. */
    JSCContext *ctx = jsc_context_new();
    char *expr = g_strdup_printf("(%s)", contents);
    JSCValue *obj = jsc_context_evaluate(ctx, expr, -1);
    /* Borrowed, context-owned — never unref. */
    JSCException *exc = jsc_context_get_exception(ctx);
    if (exc != NULL) {
      fprintf(stderr, "[notify] host show %s: payload does not parse\n", notif_id);
    } else if (obj != NULL && jsc_value_is_object(obj)) {
      char *title = jsc_prop_string(obj, "title");
      char *body = jsc_prop_string(obj, "body");
      char *chat_id = jsc_prop_string(obj, "chatId");
      char *ix_id = jsc_prop_string(obj, "ixId");
      if (!title || !*title || !body || !*body || !chat_id || !ix_id)
        fprintf(stderr, "[notify] host show %s ignored: incomplete payload\n", notif_id);
      else
        muse_show_question(notif_id, title, body, chat_id, ix_id);
      g_free(title);
      g_free(body);
      g_free(chat_id);
      g_free(ix_id);
    } else {
      fprintf(stderr, "[notify] host show %s: payload is not an object\n", notif_id);
    }
    if (obj != NULL)
      g_object_unref(obj);
    g_object_unref(ctx);
    g_free(expr);
    g_free(contents);
    g_free(path);
    g_free(notif_id);
  }
out:
  g_free(op);
  g_free(key);
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

/* Actions live on the APPLICATION, registered once at startup — never
 * per-window. Registering in on_activate re-added every action on each
 * launch/activation AND built a second window; a banner tap that
 * cold-starts the app must find the actions before any window exists. */
static void on_startup(GtkApplication *app, gpointer user_data)
{
  (void)user_data;
  g_app = G_APPLICATION(app);

  /* R58-guix — the mac shell's "รีสตาร์ท host" menu button equivalent. */
  GSimpleAction *restart_act = g_simple_action_new("restart-host", NULL);
  g_signal_connect(restart_act, "activate", G_CALLBACK(on_restart_host), NULL);
  g_action_map_add_action(G_ACTION_MAP(app), G_ACTION(restart_act));
  g_object_unref(restart_act);

  /* Question banners (1.1.33): the typed click target for GNotifications
   * — (chatId, ixId), routed into the renderer by on_open_question_action
   * (queued until the page is ready). */
  GSimpleAction *open_q_act =
      g_simple_action_new("open-question", G_VARIANT_TYPE("(ss)"));
  g_signal_connect(open_q_act, "activate", G_CALLBACK(on_open_question_action),
                   NULL);
  g_action_map_add_action(G_ACTION_MAP(app), G_ACTION(open_q_act));
  g_object_unref(open_q_act);

  /* Host-origin banners: the node host activates (op, key) over D-Bus so
   * a closed renderer loses no alerts. Same notification ids as the
   * renderer bridge — one question, one banner, whichever side shows it. */
  GSimpleAction *notify_q_act =
      g_simple_action_new("notify-question", G_VARIANT_TYPE("(ss)"));
  g_signal_connect(notify_q_act, "activate",
                   G_CALLBACK(on_notify_question_action), NULL);
  g_action_map_add_action(G_ACTION_MAP(app), G_ACTION(notify_q_act));
  g_object_unref(notify_q_act);

  fprintf(stderr, "[native-shell] actions registered: restart-host, open-question, notify-question\n");
}

static void on_activate(GtkApplication *app, gpointer user_data)
{
  (void)user_data;
  /* Single window: a second activation (launcher, banner tap, gdbus)
   * presents the existing window instead of building a duplicate. */
  GtkWindow *existing = gtk_application_get_active_window(app);
  if (existing != NULL) {
    if (shell_window_usable(existing)) {
      gtk_window_present(existing);
      flush_pending_route();
      return;
    }
    /* Zombie (see shell_window_usable): drop it so the build below makes a
     * fresh window instead of presenting a dead one forever. */
    fprintf(stderr, "[native-shell] existing window is gone at the X server — rebuilding\n");
    gtk_window_destroy(existing);
  }
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

  /* Question banners (1.1.33): window.webkit.messageHandlers.museNotify —
   * show/withdraw structured payloads, same-origin guarded. Without it the
   * renderer falls back to Web Notification (browsers) and always keeps
   * the in-app inbox + transcript card. */
  gboolean notify_ok =
      webkit_user_content_manager_register_script_message_handler(ucm, "museNotify", NULL);
  g_signal_connect(ucm, "script-message-received::museNotify",
                   G_CALLBACK(on_muse_notify), NULL);
  fprintf(stderr, "[native-shell] museNotify bridge %s\n",
          notify_ok ? "registered" : "FAILED to register");

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
  /* Banner-tap routes queue until the page finishes loading (cold-start
   * taps land before any page exists; reloads re-arm the gate). */
  g_signal_connect(g_view, "load-changed", G_CALLBACK(on_webview_load_changed), NULL);
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
  /* Closing the window must not leave g_view dangling: the app lives on
   * (D-Bus activatable) and the next tap builds a fresh window. */
  g_signal_connect(win, "destroy", G_CALLBACK(on_shell_window_destroy), NULL);

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
  /* Rebuilds must not stack a second meter: the first source keeps firing
   * against the recreated status label. */
  if (g_meter_src == 0)
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
  /* Test/dev override so an e2e instance can own its own bus name beside the
   * live app (production default unchanged — an invalid id falls back). */
  char *app_id = env_or("MUSE_DESKTOP_APP_ID", "com.aukkwat83.MuseDesktop");
  if (!g_application_id_is_valid(app_id)) {
    fprintf(stderr, "[native-shell] invalid MUSE_DESKTOP_APP_ID '%s' — using default\n", app_id);
    g_free(app_id);
    app_id = g_strdup("com.aukkwat83.MuseDesktop");
  }
  AdwApplication *app = adw_application_new(app_id, G_APPLICATION_DEFAULT_FLAGS);
  g_free(app_id);
  g_signal_connect(app, "startup", G_CALLBACK(on_startup), NULL);
  g_signal_connect(app, "activate", G_CALLBACK(on_activate), NULL);
  int status = g_application_run(G_APPLICATION(app), argc, argv);
  g_object_unref(app);

  g_free(g_base_url);
  g_free(g_root);
  g_free(port);
  g_free(host);
  return status;
}
