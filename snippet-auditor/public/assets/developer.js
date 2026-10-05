// Developer viewpoint: edit HTML, Run (local preview only), Save (persists to the API),
// and review QA notes read-only.
import { $, relTime, readRoute, prefs, boot, toast, initToast, byteLength, RUN_KBD, SAVE_KBD } from './utils.js';
import { createApi } from './api.js';
import { HtmlEditor } from './editor.js';
import { PreviewPanel } from './preview.js';
import { QAPanel } from './qa-panel.js';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const desktopMq = window.matchMedia('(min-width: 1024px)');

const state = {
  projectId: null,
  role: 'developer',
  projectName: '',     // what the title field holds
  savedName: '',
  currentHTML: '',
  savedHTML: '',
  previewHTML: null,   // what Run last rendered
  updatedAt: null,     // server version the editor is based on
  saving: false,
  saveError: null,     // null | { kind: 'error' | 'conflict', message }
  mode: 'code',
  selectedPointerId: null
};

let api, editor, preview, qa, ui;

initToast();
start();

/* ---------------------------------------------------------------
   Boot: read link → validate token server-side → render viewpoint
   --------------------------------------------------------------- */
async function start() {
  const route = readRoute();
  if (!route || route.view !== 'dev' || !route.token) { boot.denied(); return; }
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
  // The token decides the role. A review link opened on /dev goes to the review view.
  if (access.role !== 'developer') {
    location.replace(`/project/${encodeURIComponent(route.projectId)}/qa${location.search}`);
    return;
  }

  const p = access.project;
  state.projectName = state.savedName = p.name;
  state.currentHTML = state.savedHTML = p.html;
  state.updatedAt = p.updatedAt;
  ui = prefs.load(`${p.id}:dev`);

  initUi();
  boot.done();
  editor.setValue(p.html);
  $('titleInput').value = p.name;
  sizeTitle();
  setMode(ui.mode === 'qa' ? 'qa' : 'code');
  preview.setViewport(ui.viewport || 'desktop');
  preview.setAddress(p.id);
  runHtml(p.html, { initial: true });
  sync();
  loadPointers();
}

/* ---------------------------------------------------------------
   UI wiring
   --------------------------------------------------------------- */
function initUi() {
  $('runKbd').textContent = RUN_KBD;

  editor = new HtmlEditor($('editor'), {
    onChange: (html) => { state.currentHTML = html; clearSaveError(); sync(); },
    onCursor: (ln, col) => { $('cursorPos').textContent = `Ln ${ln}, Col ${col}`; }
  });

  preview = new PreviewPanel({
    emptyTitle: 'No HTML saved yet.',
    emptyText: 'Add HTML in the editor and click Run.',
    errorText: 'Check the HTML and try again.',
    onGoToLine: (line, col) => { setMode('code'); editor.goTo(line, col); },
    onShortcut: (k) => (k === 'run' ? run() : save()),
    onContextClear: () => qa.clearSelection(),
    onViewport: (v) => savePrefs({ viewport: v }),
    onState: () => sync()
  });

  qa = new QAPanel({
    list: $('ptrList'),
    editable: false,
    onSelect: (p) => {
      preview.setContext(p);
      state.selectedPointerId = p ? p.id : null;
      savePrefs({ selected: state.selectedPointerId });
    }
  });

  $('runBtn').addEventListener('click', run);
  $('saveBtn').addEventListener('click', () => save());
  $('qaRefresh').addEventListener('click', loadPointers);
  $('revertBtn').addEventListener('click', onRevert);

  // Mode tabs
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = state.mode === 'code' ? 'qa' : 'code';
      setMode(next);
      $(next === 'code' ? 'tabCode' : 'tabQa').focus();
    });
  });

  // Title
  const title = $('titleInput');
  let titleAtFocus = '';
  title.addEventListener('focus', () => { titleAtFocus = title.value; });
  title.addEventListener('input', () => { state.projectName = title.value; clearSaveError(); sizeTitle(); sync(); });
  title.addEventListener('blur', commitTitle);
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    else if (e.key === 'Escape') { title.value = titleAtFocus; state.projectName = titleAtFocus; title.blur(); }
  });
  $('titleEditBtn').addEventListener('click', () => { title.focus(); title.select(); });

  // Shortcuts
  window.addEventListener('keydown', (e) => {
    if (!desktopMq.matches || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === 'Enter') { e.preventDefault(); if (document.activeElement === title) commitTitle(); run(); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); save(); }
  }, true);

  window.addEventListener('beforeunload', (e) => {
    if (isDirty() || state.saving) { e.preventDefault(); e.returnValue = ''; return ''; }
  });

  setInterval(() => { preview.refreshStatus(); sync(); }, 30000);
}

function savePrefs(patch) {
  Object.assign(ui, patch);
  prefs.save(`${state.projectId}:dev`, ui);
}

function setMode(mode) {
  state.mode = mode === 'qa' ? 'qa' : 'code';
  const isCode = state.mode === 'code';
  $('codeMode').hidden = !isCode;
  $('qaMode').hidden = isCode;
  for (const [id, on] of [['tabCode', isCode], ['tabQa', !isCode]]) {
    $(id).setAttribute('aria-selected', String(on));
    $(id).tabIndex = on ? 0 : -1;
  }
  savePrefs({ mode: state.mode });
}

function sizeTitle() {
  const input = $('titleInput'), m = $('titleMeasure');
  m.textContent = input.value || input.placeholder;
  input.style.width = Math.min(440, m.offsetWidth + 20) + 'px';
}

function commitTitle() {
  const input = $('titleInput');
  if (!input.value.trim()) input.value = state.savedName; // a project name can't be empty
  state.projectName = input.value.trim();
  sizeTitle();
  sync();
}

/* ---------------------------------------------------------------
   State helpers
   --------------------------------------------------------------- */
const displayName = () => (state.projectName || '').trim() || state.savedName;
const htmlDirty = () => state.currentHTML !== state.savedHTML;
const nameDirty = () => displayName() !== state.savedName;
const isDirty = () => htmlDirty() || nameDirty();

function clearSaveError() {
  if (state.saveError) state.saveError = null;
}

/* ---------------------------------------------------------------
   Run: local preview only. Never writes to the API.
   --------------------------------------------------------------- */
function runHtml(html, opts) {
  state.previewHTML = html;
  preview.render(html, opts);
  sync();
}

function run() {
  const html = editor.getValue();
  if (!html.trim()) {
    toast('Add some HTML to the editor before running.');
    runHtml(html);
    return;
  }
  runHtml(html);
}

/* ---------------------------------------------------------------
   Save: persists name + HTML. One request at a time.
   --------------------------------------------------------------- */
async function save(force = false) {
  if (state.saving) return;
  commitTitle();
  if (!isDirty() && !force) { state.saveError = null; sync(); toast('Everything is saved'); return; }

  const sent = { name: displayName(), html: state.currentHTML };
  if (byteLength(sent.html) > MAX_HTML_BYTES) {
    state.saveError = { kind: 'error', message: 'HTML is too large to save. The limit is 2 MB.' };
    sync();
    return;
  }

  state.saving = true;
  state.saveError = null;
  sync();
  try {
    const p = await api.updateProject({ ...sent, baseUpdatedAt: force ? undefined : state.updatedAt });
    state.savedHTML = sent.html;
    state.savedName = p.name;
    state.updatedAt = p.updatedAt;
    if (displayName() === p.name) $('titleInput').value = state.projectName = p.name;
  } catch (e) {
    if (e.status === 409) {
      state.saveError = { kind: 'conflict', message: 'A newer version was saved from another window or browser.' };
      toast('A newer version of this project was saved somewhere else.', { label: 'Overwrite it', onClick: () => save(true) });
    } else if (e.status === 401) {
      state.saveError = { kind: 'error', message: 'This developer link no longer works. Your changes are still in the editor; copy them before leaving.' };
    } else {
      state.saveError = { kind: 'error', message: e.message || 'Try again.' };
    }
  } finally {
    state.saving = false;
    sync();
  }
}

/* Revert the HTML to the last saved version (two-step confirm). */
let revertTimer = 0;
function onRevert() {
  const btn = $('revertBtn');
  if (!btn.classList.contains('is-armed')) {
    btn.classList.add('is-armed');
    btn.textContent = 'Discard HTML changes?';
    clearTimeout(revertTimer);
    revertTimer = setTimeout(disarmRevert, 3500);
    return;
  }
  disarmRevert();
  editor.setValue(state.savedHTML);
  state.currentHTML = state.savedHTML;
  sync();
  toast('Restored the last saved HTML');
}
function disarmRevert() {
  const btn = $('revertBtn');
  clearTimeout(revertTimer);
  btn.classList.remove('is-armed');
  btn.textContent = 'Revert';
}

/* ---------------------------------------------------------------
   QA notes (read-only here)
   --------------------------------------------------------------- */
let loadingPointers = false;
async function loadPointers() {
  if (loadingPointers) return;
  loadingPointers = true;
  const btn = $('qaRefresh');
  btn.disabled = true;
  if (!qa.loaded) qa.setLoading();
  try {
    const { pointers, nextPointerNumber } = await api.listPointers();
    qa.setPointers(pointers, nextPointerNumber, state.selectedPointerId || ui.selected);
    $('qaTabCount').textContent = String(pointers.length);
  } catch (e) {
    if (qa.loaded) toast('QA notes could not be refreshed. ' + (e.message || ''));
    else qa.setError(e.message, loadPointers);
  } finally {
    loadingPointers = false;
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------
   Render status
   --------------------------------------------------------------- */
function sync() {
  if (!preview) return;
  const dirty = isDirty();
  const err = state.saveError;

  const ss = $('saveStatus');
  let status, text;
  if (state.saving) { status = 'saving'; text = 'Saving…'; }
  else if (err) { status = 'error'; text = err.kind === 'conflict' ? 'Not saved: newer version exists' : 'Changes could not be saved'; }
  else if (dirty) { status = 'dirty'; text = 'Unsaved changes'; }
  else { status = 'saved'; text = 'Saved ' + relTime(state.updatedAt); }
  ss.dataset.state = status;
  $('saveStatusText').textContent = text;
  const parts = [];
  if (htmlDirty()) parts.push('HTML');
  if (nameDirty()) parts.push('project title');
  ss.title = err ? err.message : dirty ? 'Unsaved: ' + parts.join(', ') : 'Last saved ' + relTime(state.updatedAt);

  const btn = $('saveBtn');
  const canSave = !state.saving && (dirty || !!err);
  btn.disabled = !canSave;
  btn.classList.toggle('is-saved', !dirty && !state.saving && !err);
  btn.classList.toggle('is-error', !!err);
  $('saveLabel').textContent = state.saving ? 'Saving…' : err ? 'Try again' : dirty ? 'Save' : 'Saved';
  $('saveIcon').innerHTML = !dirty && !state.saving && !err
    ? '<path d="M3.5 8.4l2.9 2.9 6.1-6.6" stroke-linecap="round"/>'
    : '<path d="M2.5 3.5a1 1 0 0 1 1-1h7.3l2.7 2.7v7.3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M5 2.5v3h5v-3M5 13.5V9.5h6v4"/>';
  btn.title = canSave ? `Save the title and HTML (${SAVE_KBD})` : 'Everything is saved';

  $('codeDot').hidden = !dirty;
  $('dirtyDot').hidden = !htmlDirty();
  const rv = $('revertBtn');
  rv.disabled = !htmlDirty();
  if (rv.disabled) disarmRevert();

  // "Changes not run" when the editor is ahead of the preview.
  const stale = state.previewHTML !== null && state.previewHTML !== state.currentHTML;
  const badge = $('syncBadge'), st = $('syncText');
  badge.classList.toggle('is-stale', stale);
  st.replaceChildren();
  const label = document.createElement('span');
  label.className = 'sync-label';
  label.textContent = stale ? 'Changes not run ' : 'Preview updated';
  st.append(label);
  if (stale) { const k = document.createElement('kbd'); k.textContent = RUN_KBD; st.append(k); }
  badge.title = stale ? 'The editor has changes that are not in the preview yet' : 'The preview matches the editor';

  document.title = displayName() + ' · Snippet Auditor';
}
