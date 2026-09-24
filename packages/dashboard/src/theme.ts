/**
 * Theme persistence and toggling, mirroring jcnr-triage's
 * static/dashboard.js pattern (same key semantics, same default) so both
 * dashboards remember/independently apply a light/dark preference the same
 * way. Ariadne uses `data-theme` on <html> (React has no server-rendered
 * class to match jcnr-triage's `data-bs-theme`, but the behavior is
 * identical: default light, toggle persisted in localStorage).
 */
const THEME_KEY = 'triage-theme';

export type Theme = 'light' | 'dark';

export function getStoredTheme(): Theme {
  const stored = window.localStorage.getItem(THEME_KEY);
  return stored === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function setStoredTheme(theme: Theme): void {
  window.localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

export function initTheme(): Theme {
  const theme = getStoredTheme();
  applyTheme(theme);
  return theme;
}

export function toggleTheme(current: Theme): Theme {
  const next: Theme = current === 'dark' ? 'light' : 'dark';
  setStoredTheme(next);
  return next;
}
