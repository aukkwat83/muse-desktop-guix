# Deploy Muse Desktop to a Guix System host

Written for an **agent** landing on a fresh machine. Every step has a command and an
expected result — if the check does not match, stop and read the failure table (§9)
instead of improvising.

This repo (`muse-desktop-guix`) carries both platforms on one branch: `macos/` is the
Swift shell, `linux/` is the GTK shell. There is no branch-per-platform rule to follow.

---

## 0. Orientation — answer these before touching anything

### 0.1 Am I actually on Guix System?

```bash
uname -s                      # Linux
ps -p 1 -o comm=              # shepherd   ← Guix System. `systemd` = foreign distro
command -v guix               # must exist
```

- `shepherd` → this document applies.
- `systemd` + `guix` present → you are on **Guix-the-package-manager on a foreign
  distro**. Most of this still works, but `linux/systemd/muse-desktop-host.service`
  becomes usable and `/run/current-system/profile` does not exist — adjust PATH
  expectations in §1.
- no `guix` → wrong document.

### 0.2 Which version?

```bash
git tag -l 'v*-guix-*' --sort=-v:refname | head -3
git describe --tags        # expect v1.1.0-guix-parity (or newer)
```

Guix tags are `vX.Y.Z-guix-<slug>`. Never `git push --tags/--all/--force`.

---

## 1. Host packages

Muse Desktop shells out to real binaries. Check what is present:

```bash
for b in node npm curl git guix zenity rsvg-convert xdg-open muse; do
  printf '%-14s ' "$b"; command -v "$b" || echo MISSING
done
```

| Binary | Needed for | If MISSING |
|--------|-----------|------------|
| `node` **≥ 20** | the whole host process (`package.json` engines) | `guix install node` — but read the version warning below |
| `npm` | dependency install | ships with `node` |
| `curl` | host health probe, memory meter, the shell's restart action | `guix install curl` |
| `git` | clone / tag | `guix install git` |
| `guix` | builds the GTK shell env | n/a — you are not on Guix |
| `zenity` | **attach-file picker**. Without it the ＋ attach button reports the miss | `guix install zenity` |
| `rsvg-convert` | diagram → PNG export, and the app icon during desktop install | `guix install librsvg` (ImageMagick `convert` is the fallback) |
| `xdg-open` | opening external links from the shell, "reveal in folder" | `guix install xdg-utils` |
| `muse` | the agent itself (`muse serve` children) | §4 |

> **Node version warning.** `guix install node` on current channels may resolve to a
> newer major whose ABI has no `better-sqlite3` prebuild guarantee — §3 tells you how to
> detect that and what to do. If you take a newer Node, say so in the host's QC record so
> a later reader can attribute any difference.

Guix System usually provides `zenity` / `rsvg-convert` from
`/run/current-system/profile/bin` (system-wide) and `node` / `curl` / `git` from
`~/.guix-profile/bin` (user profile). The launchers prepend both plus
`~/.local/bin` to `PATH`, so you do **not** need them in the login
shell — but the checks above must pass in *some* profile on that PATH.

---

## 2. Clone and select the version

```bash
git clone https://github.com/aukkwat83/muse-desktop-guix.git ~/muse-desktop-guix
cd ~/muse-desktop-guix
git checkout v1.1.0-guix-parity        # ← detached HEAD is correct for a deploy
```

To work on the port (not just run it), track `main` instead and keep QC records
(they are per host × tag, so filenames never collide).

---

## 3. Node dependencies

```bash
cd ~/muse-desktop-guix
npm install
```

Expected: completes without a compiler. `better-sqlite3` normally installs a
**prebuilt** `.node` (prebuild-install downloads it), which is why no `gcc` is needed
on a healthy run.

Verify it actually loads under *this* Node — a mismatched ABI is the classic silent
killer:

```bash
node -p "process.versions.modules"
node -e "require('better-sqlite3'); console.log('sqlite ok')"        # sqlite ok
```

If `npm install` falls back to building from source (no prebuild for this
Node/arch, or no network for the prebuild), it needs a toolchain — run the install
inside a `guix shell` instead:

```bash
guix shell gcc-toolchain python -- npm install
```

---

## 4. muse CLI — per host, never copied

The desktop spawns **`muse serve`** children; the CLI is not bundled.

```bash
muse --version
which muse            # expect ~/.local/bin/muse (on the launchers' PATH)
```

If absent, install the Muse CLI the normal way and put it on PATH
(`~/.local/bin` is already on every launcher's PATH).

Then authenticate **on the new host** — `muse login` is a device-code flow in a
real terminal:

```bash
muse login
```

> **Do not copy credentials from another machine.** Log in on the new host.

`MUSE_DESKTOP_MODEL` / `MUSE_DESKTOP_EFFORT` default the model + reasoning effort
the host pushes each session (`session/setModel` / `session/setReasoningEffort`).

---

## 5. Build the native GTK shell

The binary is **gitignored** — every host builds its own. It links against that
machine's `/gnu/store` paths, so **never copy `muse-desktop-shell` between hosts.**

```bash
cd ~/muse-desktop-guix
guix shell -m linux/gtk-shell/manifest.scm -- bash linux/gtk-shell/build.sh
```

Expected tail:

```
[build] ok → /home/<user>/muse-desktop-guix/linux/gtk-shell/muse-desktop-shell
```

First run downloads the manifest (~105 MB, GTK4 + libadwaita + WebKitGTK) — that is a
one-time cost of the *build*, not of launching. Then:

```bash
npm run test:guix-shell     # expect 16/16 passed
npm run test:guix           # expect 18/18 passed
```

The shell guard also fails when the binary is older than `main.c`, which is the
"my change did nothing" failure mode.

> `scripts/native-launch.sh` auto-builds the shell if the binary is missing, so you
> *can* skip this step — but then the first launch appears to hang for minutes with no
> output. Build explicitly.

---

## 6. First launch + the two Guix guardrails

```bash
cd ~/muse-desktop-guix
time ./bin/muse-desktop
```

Expected: a **GTK window in ~1–2 s** and in the log:

```
[native-launch] launching prebuilt binary (instant)…
[native-shell] cardDrag bridge registered
[native-shell] presented WebKitGTK → http://127.0.0.1:3850/
```

**If it takes >121 s with no output, stop.** That is the known regression where the
launcher re-realizes `linux/gtk-shell/manifest.scm` on every start. Check:

```bash
grep -c MUSE_DESKTOP_FORCE_GUIX_SHELL scripts/native-launch.sh   # must be > 0
npm run test:guix-shell                                          # covers it
```

macOS cannot break this loudly, because mac never executes this path.
`npm run test:guix-shell` automates the guard; run it after **every** merge that
touches the launchers.

Sanity checks once the window is up:

```bash
curl -s http://127.0.0.1:3850/api/version          # version + host info
curl -s http://127.0.0.1:3850/api/state | head -c 200
```

Header bar should show **two** buttons — 🔄 Reload (renderer only) and ↻ Restart host
(node process). See `GUIX.md` for when to use which. Headless equivalent:

```bash
gdbus call --session --dest com.aukkwat83.MuseDesktop \
  --object-path /com/aukkwat83/MuseDesktop \
  --method org.gtk.Actions.Activate restart-host '[]' '{}'
```

Stop the host with `./scripts/deploy.sh --stop`.

---

## 7. Desktop entry (optional)

```bash
./scripts/install-desktop.sh
```

Writes `~/.local/share/applications/muse-desktop.desktop` (+ a copy on `~/Desktop`)
with absolute paths to *this* checkout, and rasterises the icon with `rsvg-convert`
when available. Re-run it if you move the checkout.

---

## 8. Register the host

### 8.1 QC record (required before tagging)

There is no automated `qc` script in this repo — QC is the suite plus live checks:

```bash
npm test              # all suites incl. guix-shell + guix-platform + e2e mock agent
npm run test:msp      # probe the real `muse serve` (needs the §4 login)
```

Then write `docs/qc/records/<UTC>-<host>-<tag>.md`: launch time, both guix suites,
`test:all`, the §6 guardrail grep, restart-host both ways (host up / host down),
attach picker via zenity, diagram ↓ PNG export.

### 8.2 Commit (dev host only)

```bash
git add docs/qc && git commit -m "docs(qc): <host> v1.1.0-guix-parity PASS (<sha>)"
git push origin main    # explicit refspec, always
```

Never `git push --tags` / `--all` / `--force`.

---

## 9. Failure table

| Symptom | Cause | Fix |
|---------|-------|-----|
| Launch hangs >121 s, no output | `native-launch.sh` lost its prebuilt fast path / `FORCE_GUIX_SHELL` guard | `npm run test:guix-shell`; restore the guard, then rebuild |
| `[native-launch] guix required for GTK/WebKit env` | `guix` not on PATH | you are not on a Guix host, or PATH is broken |
| `[native-launch] node not on PATH` | node not in any profile on the launcher's PATH | `guix install node curl` then re-login or source the profile. Host on `:3850` can still be up while the UI launcher exits 1 |
| `native shell not built` then `Open manually: http://…` even though `linux/gtk-shell/muse-desktop-shell` exists | launcher computed `ROOT` from a **symlink** (`~/.local/bin/muse-desktop`) so ROOT became `~/.local` | `bin/muse-desktop` follows symlinks (HAZ-10). Work around: run `~/muse-desktop-guix/bin/muse-desktop` not only the PATH symlink |
| Status `host?` / endless host respawn | `curl` missing (`host_ok` always false) and/or `MUSE_DESKTOP_ROOT` unset | `guix install curl`; launch only via `bin/muse-desktop` / `native-launch.sh` |
| Window opens, but blank / stale UI | WebKit served a cached bundle | 🔄 Reload or `Ctrl+R` / `Ctrl+Shift+R` / `F5` (cache-ignoring) |
| New server behaviour missing after a merge | Reload is **renderer-only** | ↻ Restart host, or `./scripts/deploy.sh --stop` + `--start` |
| `Error: NODE_MODULE_VERSION mismatch` | `better-sqlite3` built for another Node | `npm rebuild better-sqlite3`, or reinstall inside `guix shell gcc-toolchain python` |
| Attach ＋ button reports no dialog | `zenity` missing | `guix install zenity` |
| Diagram PNG export fails | `rsvg-convert` and `convert` both missing | `guix install librsvg` |
| External links do nothing | `xdg-open` missing | `guix install xdg-utils` |
| Turns fail with `not logged in` | `muse login` never ran on this host | §4 — device-code flow in a real terminal |
| Thai tone marks look cut off | Sarabun raised marks vs a clipped line box | see the Thai section of `GUIX.md` — pad the clip box |
| `systemctl --user enable muse-desktop-host` fails | Guix System uses **Shepherd**, not systemd | expected — see `GUIX.md`; the host already survives UI close via `MUSE_DESKTOP_KEEP_ON_EXIT=1` |

---

## 10. What is per-host and what is repo state

| Path | Copy to a new host? |
|------|---------------------|
| `~/muse-desktop-guix` (the checkout) | **No** — clone fresh (§2) |
| `linux/gtk-shell/muse-desktop-shell` | **No** — gitignored, links to this machine's `/gnu/store`; rebuild (§5) |
| `node_modules/` | **No** — native `better-sqlite3`; run `npm install` |
| muse credentials | **No** — log in on the new host (§4) |
| `~/.local/state/muse-desktop/` (sessions, FTS db, logs) | **No** unless you deliberately want to migrate chat history; it is machine-local state |
| `docs/qc/records/`, `docs/releases/` | Comes with the clone — never hand-copy |

---

## 11. Ongoing: pulling new work on the Guix host

```bash
git pull
npm run test:guix-shell               # launcher + shell contracts
npm run test:guix                     # platform contracts
npm test                              # full suite incl. e2e
./scripts/deploy.sh --stop && ./scripts/deploy.sh --start   # server-side pickups need the process replaced
```

After any `main.c` change, rebuild before relaunching:

```bash
guix shell -m linux/gtk-shell/manifest.scm -- bash linux/gtk-shell/build.sh
```
