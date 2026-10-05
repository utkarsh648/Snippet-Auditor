// Client / review viewpoint: the latest SAVED HTML in the preview, plus QA notes
// that autosave to the API. No source code, no Run, no Save.
import { $, relTime, readRoute, prefs, boot, toast, initToast, pad2 } from './utils.js';
import { createApi } from './api.js';
import { PreviewPanel } from './preview.js';
import { QAPanel } from './qa-panel.js';

const state = {
  projectId: null,
  role: 'client',
  projectName: '',
  savedHTML: '',
  updatedAt: null,
  selectedPointerId: null
};

let api, preview, qa, ui;

initToast();
start();

async function start() {
  const route = readRoute();
  if (!route || route.view !== 'qa' || !route.token) { boot.denied(); return; }
  state.projectId = route.projectId;
  api = createApi(route.projectId, route.token);

  boot.loading();
  let access;
  try {
    access = await api.access();
  } catch (e) {
    if (e.status === 0 || e.status >= 500) boot.failed(e.status === 0 ? null : 'The server could not load this project. Try again in a moment.', start);
    else boot.denied();
    return;
  }
  if (access.role !== 'client') {
    location.replace(`/project/${encodeURIComponent(route.projectId)}/dev${location.search}`);
    return;
  }

  ui = prefs.load(`${access.project.id}:qa`);
  initUi();
  boot.done();
  applyProject(access.project, { initial: true });
  preview.setViewport(ui.viewport || 'desktop');
  preview.setAddress(access.project.id);
  loadPointers();
}

function initUi() {
  preview = new PreviewPanel({
    emptyTitle: 'Preview is not available yet.',
    emptyText: 'The developer has not saved any HTML for this project.',
    errorText: 'This version of the prototype has an error. You can still leave notes, and refresh after the developer saves a fix.',
    statusText: (s) => {
      if (s === 'updating') return 'Loading…';
      if (s === 'error') return 'Error in saved version';
      if (s === 'empty') return 'Nothing saved yet';
      return 'Saved ' + relTime(state.updatedAt);
    },
    onShortcut: (k) => { if (k === 'save') qa.flushAll(); },
    onContextClear: () => qa.clearSelection(),
    onViewport: (v) => savePrefs({ viewport: v }),
    onRefresh: refreshAll
  });
  $('syncBadge').classList.add('is-saved-version');
  $('syncBadge').title = 'You are viewing the latest version the developer saved';

  qa = new QAPanel({
    list: $('ptrList'),
    editable: true,
    api,
    toast,
    onSelect: (p) => {
      preview.setContext(p);
      state.selectedPointerId = p ? p.id : null;
      if (!p || p.id) savePrefs({ selected: state.selectedPointerId });
    },
    onChange: () => syncStatus()
  });

  $('addPtrBtn').addEventListener('click', () => { qa.add(); syncStatus(); });

  // Cmd/Ctrl+S saves pending notes instead of opening the browser's "Save page" dialog.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      qa.flushAll();
    }
  }, true);

  window.addEventListener('beforeunload', (e) => {
    if (qa.hasUnsavedWork()) { e.preventDefault(); e.returnValue = ''; return ''; }
  });

  setInterval(() => { preview.refreshStatus(); syncStatus(); }, 30000);
}

function savePrefs(patch) {
  Object.assign(ui, patch);
  prefs.save(`${state.projectId}:qa`, ui);
}

function applyProject(p, opts) {
  const changed = p.html !== state.savedHTML || opts.initial;
  state.projectName = p.name;
  state.savedHTML = p.html;
  state.updatedAt = p.updatedAt;
  $('titleText').textContent = p.name;
  $('titleText').title = p.name;
  document.title = p.name + ' · Review · Snippet Auditor';
  if (changed) preview.render(p.html, opts);
  else preview.refreshStatus();
}

async function loadPointers() {
  if (!qa.loaded) qa.setLoading();
  try {
    const { pointers, nextPointerNumber } = await api.listPointers();
    qa.setPointers(pointers, nextPointerNumber, state.selectedPointerId || ui.selected);
    $('addPtrBtn').disabled = false;
  } catch (e) {
    if (qa.loaded) toast('QA notes could not be refreshed. ' + (e.message || ''));
    else qa.setError(e.message, loadPointers);
  }
  syncStatus();
}

/* Refresh: save pending notes, then load the latest saved HTML and QA notes. */
let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  $('reloadBtn').disabled = true;
  try {
    await qa.flushAll();
    const p = await api.getProject();
    const changed = p.html !== state.savedHTML;
    applyProject(p, {});
    if (!changed) preview.reload();
    await loadPointers();
    toast(changed ? 'Loaded the latest saved version' : 'You are viewing the latest saved version');
  } catch (e) {
    toast(e.status === 401 ? 'This review link no longer works.' : 'Connection failed. Check your connection and try again.');
  } finally {
    refreshing = false;
    $('reloadBtn').disabled = false;
  }
}

function syncStatus() {
  if (!qa) return;
  const s = qa.summary();
  $('ptrCount').textContent = String(s.total);
  $('ptrCount').title = s.total + (s.total === 1 ? ' pointer' : ' pointers');
  $('nextPtrNum').textContent = pad2(qa.upcomingNumber);

  const el = $('saveStatus');
  let state_, text, title = '';
  if (s.saving) { state_ = 'saving'; text = 'Saving…'; }
  else if (s.failed) { state_ = 'error'; text = s.failed === 1 ? '1 note not saved' : `${s.failed} notes not saved`; title = 'Use Retry on the note, or check your connection.'; }
  else if (s.needsName) { state_ = 'dirty'; text = 'Add a screen name to save'; title = 'Notes save once their pointer has a screen name.'; }
  else if (s.pending) { state_ = 'dirty'; text = 'Unsaved changes'; }
  else { state_ = 'saved'; text = s.total ? 'All feedback saved' : 'No feedback yet'; }
  el.dataset.state = state_;
  $('saveStatusText').textContent = text;
  el.title = title;
}
