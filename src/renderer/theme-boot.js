// Applies the saved theme before first paint.
//
// Loaded as a blocking classic script in <head>: app.js is a module and
// therefore deferred, so setting the theme there means one frame of the
// default dark palette flashing past on every launch — very visible when the
// saved theme is Claude Light.
//
// Kept dependency-free and duplicated (rather than imported) for that reason:
// the whole point is to run before anything else does.
(function () {
  var STORAGE_KEY = 'muse-desktop.theme';
  var THEMES = ['moonlight', 'daylight', 'claude-light', 'claude-dark'];

  // Missing and unknown prefs both mean Auto. Recording 'moonlight' for a
  // fresh install (the old fallback) painted per-OS once but then ticked
  // Moonlight in the switcher and silenced the OS-flip listener, which only
  // fires while the pref is 'auto'. Unknown values left by older builds get
  // the same migration, like grok-desktop's platform-boot readPref().
  function normalize(pref) {
    return pref === 'auto' || THEMES.indexOf(pref) >= 0 ? pref : 'auto';
  }

  function resolve(pref) {
    var p = normalize(pref);
    if (p === 'auto') {
      // Auto pairs with the warm themes, matching grok-desktop: a system in
      // dark mode gets Claude Dark, not the cool moonlight palette.
      var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      return dark ? 'claude-dark' : 'claude-light';
    }
    return p;
  }

  var pref;
  try {
    pref = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    pref = null;
  }
  pref = normalize(pref);
  // Persist the normalized value so app.js and the next boot read the same
  // pref — this is also what migrates a stale or unknown stored value.
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch (err) {
    /* private mode — the theme just will not persist */
  }
  document.documentElement.dataset.theme = resolve(pref);
  document.documentElement.dataset.themePref = pref;

  // Exposed so app.js can reuse the same resolution rule for the switcher.
  window.__museTheme = { STORAGE_KEY: STORAGE_KEY, THEMES: THEMES, normalize: normalize, resolve: resolve };
})();
