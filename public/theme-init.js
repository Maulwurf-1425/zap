// Runs before first paint (loaded synchronously in <head>): applies the saved
// theme, font size, density and language so the window never flashes the
// wrong look. The source of truth is the settings table; src/lib/theme.ts
// mirrors it here.
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
  var size = Number(prefs.fontSize);
  if (size >= 14 && size <= 18) {
    root.style.setProperty("--chat-font-size", size + "px");
    root.style.setProperty("--chat-line-height", Math.round(size * 1.625) + "px");
  }
})();
