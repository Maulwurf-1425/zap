// Runs before first paint (loaded synchronously in <head>): applies the saved
// theme, colors, typography, density and language so the window never
// flashes the wrong look. The source of truth is the settings table;
// src/lib/theme.ts mirrors it here, including the computed CSS variables.
(function () {
  var root = document.documentElement;
  var prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem("zap.appearance") || "{}") || {};
  } catch (e) {
    prefs = {};
  }
  var mode = prefs.theme === "light" || prefs.theme === "system" ? prefs.theme : "dark";
  var resolved =
    mode === "system" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : mode;
  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-density", prefs.density === "compact" ? "compact" : "comfortable");
  root.lang = prefs.language === "de" ? "de" : "en";
  var vars = prefs.vars && prefs.vars[resolved];
  if (vars && typeof vars === "object") {
    for (var name in vars) {
      if (name.indexOf("--") === 0 && typeof vars[name] === "string") root.style.setProperty(name, vars[name]);
    }
  }
})();
