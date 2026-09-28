import { getSetting } from './db.js';

export async function applyTheme() {
  const theme = await getSetting('theme', 'system');
  const invert = await getSetting('invertInk', true);
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.classList.toggle('invert-ink', !!invert);
}
