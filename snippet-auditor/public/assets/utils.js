// Small shared helpers. No framework.

export const $ = (id) => document.getElementById(id);
export const pad2 = (n) => (n < 10 ? '0' + n : String(n));
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const RUN_KBD = isMac ? '⌘↵' : 'Ctrl ↵';
export const SAVE_KBD = isMac ? '⌘S' : 'Ctrl+S';

export function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (new Date().toDateString() === d.toDateString()) return 'at ' + t;
  return 'on ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t;
}

export const byteLength = (s) => new Blob([s]).size;

/** Reads /project/:id/(dev|qa)?token=… */
export function readRoute() {
  const m = location.pathname.match(/^\/project\/([^/]+)\/(dev|qa)\/?$/);
  if (!m) return null;
  return {
    projectId: decodeURIComponent(m[1]),
    view: m[2],
    token: new URLSearchParams(location.search).get('token') || ''
  };
}

/** Non-sensitive UI preferences only (viewport, panel, selected pointer). Never tokens. */
export const prefs = {
  load(key) { try { return JSON.parse(localStorage.getItem('sa:ui:' + key) || '{}'); } catch { return {}; } },
  save(key, value) { try { localStorage.setItem('sa:ui:' + key, JSON.stringify(value)); } catch { /* ignore */ } }
};

/** Full-page loading / denied / error screen shown before the app renders. */
export const boot = {
  loading(text = 'Loading project…') { show('loading', text, '', null); },
  denied() {
    show('denied', 'Access denied', 'This project link is invalid or has expired. Ask the project owner for a new link.', null);
  },
  failed(message, retry) {
    show('failed', 'Connection failed', message || 'Check your connection and try again.', retry);
  },
  done() { $('boot').hidden = true; $('app').hidden = false; }
};
function show(state, title, text, retry) {
  $('app').hidden = true;
  const el = $('boot');
  el.hidden = false;
  el.dataset.state = state;
  $('bootTitle').textContent = title;
  $('bootText').textContent = text;
  $('bootText').hidden = !text;
  const btn = $('bootRetry');
  btn.hidden = !retry;
  btn.onclick = retry || null;
  document.title = title + ' · Snippet Auditor';
}

/** Toast with an optional action button. */
let toastTimer = 0, toastHandler = null;
export function toast(msg, action) {
  const t = $('toast'), btn = $('toastAction');
  $('toastText').textContent = msg;
  toastHandler = action ? action.onClick : null;
  btn.hidden = !action;
  if (action) btn.textContent = action.label;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('is-on'); toastHandler = null; }, action ? 7000 : 2600);
}
export function initToast() {
  $('toastAction').addEventListener('click', () => {
    const h = toastHandler; toastHandler = null;
    $('toast').classList.remove('is-on');
    if (h) h();
  });
}
