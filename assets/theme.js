/**
 * The theme switch in the header.
 *
 * Three states, not two: "sistem" follows the device and is the default, and
 * the reader can pin "açık" or "koyu" on top of it. Pinning writes a
 * `data-theme` attribute on <html> -- the palette itself lives in the
 * stylesheet, which handles the system case with a media query, so nothing
 * here has to know a single colour.
 *
 * The stored choice is applied by a tiny inline script in index.html instead
 * of by this module: a module is deferred, and a deferred script paints the
 * wrong theme first and corrects it, which is exactly the flash we are here to
 * avoid. This file only owns the button.
 */

const STORAGE_KEY = "last-istanbul-quakes:theme";

/** Click order. Getting back to "sistem" has to be reachable, hence three. */
const CYCLE = ["system", "light", "dark"];

const LABELS = {
  system: "Sistem",
  light: "Açık",
  dark: "Koyu",
};

/**
 * 24x24 icons, drawn with the button's own colour. Half-filled circle for
 * "follows the system", sun and moon for the pinned states.
 */
const ICONS = {
  system: '<circle cx="12" cy="12" r="8.25"/><path d="M12 3.75a8.25 8.25 0 0 1 0 16.5Z" fill="currentColor" stroke="none"/>',
  light:
    '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>',
  dark: '<path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8Z"/>',
};

const button = document.getElementById("theme");
const icon = button?.querySelector(".theme-toggle__icon");

function storedTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return CYCLE.includes(value) ? value : "system";
  } catch {
    return "system"; // Private mode or blocked storage: the default still works.
  }
}

function apply(theme) {
  const root = document.documentElement;
  // No attribute means "whatever the system says" -- the stylesheet's media
  // query then applies on its own, with no listener to keep in sync here.
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;

  if (icon) icon.innerHTML = ICONS[theme];
  if (button) {
    button.title = `Tema: ${LABELS[theme]}`;
    button.setAttribute("aria-label", `Tema: ${LABELS[theme]}. Değiştirmek için tıklayın.`);
  }
}

let current = storedTheme();
apply(current);

button?.addEventListener("click", () => {
  current = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length];
  apply(current);
  try {
    if (current === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, current);
  } catch {
    /* not fatal: the choice just does not survive the page */
  }
});
