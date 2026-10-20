// `next.config.js` hashes `THEME_SCRIPT` into the CSP, so it stays plain
// JavaScript and the script is a literal: its text is the hash input.

export const NEXT_THEME_STORAGE_KEY = 'theme';

/** @type {import('next-themes').Attribute[]} */
export const NEXT_THEME_ATTRIBUTES = ['class', 'data-theme'];

export const SNAPSHOT_STORAGE_KEY = 'theme-vars';

// Does before first paint what next-themes' own script would, with the
// provider's props, then applies the saved theme variables. The mode resolves
// the way next-themes does (default `system`).
export const THEME_SCRIPT = `(function () {
  try {
    var root = document.documentElement;
    var theme = localStorage.getItem(${JSON.stringify(NEXT_THEME_STORAGE_KEY)});
    var mode =
      theme === 'light' || theme === 'dark'
        ? theme
        : matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    ${JSON.stringify(NEXT_THEME_ATTRIBUTES)}.forEach(function (attribute) {
      if (attribute === 'class') root.classList.add(mode);
      else root.setAttribute(attribute, mode);
    });
    root.style.colorScheme = mode;
    var raw = localStorage.getItem(${JSON.stringify(SNAPSHOT_STORAGE_KEY)});
    if (!raw) return;
    var snapshot = JSON.parse(raw);
    var vars = Object.assign({}, snapshot.root, snapshot[mode]);
    for (var entry of Object.entries(vars))
      root.style.setProperty(entry[0], entry[1]);
  } catch (error) {}
})();`;
