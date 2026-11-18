// Theme handling: a stored choice wins; without one the operating system decides.
// The choice lives in a cookie (shared across ports and origins of the same host)
// and in localStorage (survives a cleared cookie jar), both written on every toggle.
// The cookie is read first, so a preview served from another port matches the app.
// The inline script in each page's <head> reads both stores before the first paint,
// so this module must not change the key/name or the value format ('light' | 'dark').
export const THEME_KEY = 'j2050-theme';
export const THEME_COOKIE = THEME_KEY;

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // one year

const media = window.matchMedia('(prefers-color-scheme: dark)');
const initialTheme = storedTheme();
let explicit = initialTheme !== null;

function readCookie(name) {
  for (const part of document.cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function writeCookie(name, value) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  try {
    document.cookie =
      `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  } catch {
    // Cookies unavailable: localStorage alone carries the choice.
  }
}

export function storedTheme() {
  // The cookie wins: it is the copy shared across ports and origins, and every
  // toggle writes both stores, so a disagreeing localStorage is the stale one.
  let value = readCookie(THEME_COOKIE);
  if (value !== 'light' && value !== 'dark') {
    try {
      value = localStorage.getItem(THEME_KEY);
    } catch {
      // Storage unavailable (private mode): the cookie already decided.
    }
  }
  return value === 'dark' || value === 'light' ? value : null;
}

// Keep the per-origin copy aligned with the shared one.
if (explicit) {
  try {
    localStorage.setItem(THEME_KEY, initialTheme);
  } catch {
    // Storage unavailable: the inline script keeps reading the cookie.
  }
}

export function systemTheme() {
  return media.matches ? 'dark' : 'light';
}

export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function syncButton(button) {
  const dark = currentTheme() === 'dark';
  button.setAttribute('aria-pressed', String(dark));
  button.setAttribute('aria-label', 'Dark mode');
  button.title = 'Dark mode';
  button.textContent = dark ? 'Light' : 'Dark';
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('[data-theme-toggle]').forEach(syncButton);
}

export function setTheme(theme) {
  explicit = true;
  stopFollowingSystem();
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable: the cookie carries the choice.
  }
  writeCookie(THEME_COOKIE, theme);
  applyTheme(theme);
}

export function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

// Adds the toggle to a container; safe to call twice for the same container.
export function mountThemeToggle(container = document.body, { floating = false } = {}) {
  if (container.querySelector('[data-theme-toggle]')) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = floating ? 'theme-toggle floating' : 'theme-toggle';
  button.dataset.themeToggle = '';
  button.addEventListener('click', toggleTheme);
  container.appendChild(button);
  syncButton(button);
  return button;
}

// Keep following the OS while the user has no explicit preference.
const onSystemChange = () => {
  if (!explicit) applyTheme(systemTheme());
};
function stopFollowingSystem() {
  if (media.removeEventListener) media.removeEventListener('change', onSystemChange);
  else if (media.removeListener) media.removeListener(onSystemChange);
}
if (!explicit) {
  if (media.addEventListener) media.addEventListener('change', onSystemChange);
  else if (media.addListener) media.addListener(onSystemChange);
}

// Standalone pages (login, registration, password reset) have no shared header.
if (document.body.classList.contains('login-page')) {
  mountThemeToggle(document.body, { floating: true });
}
