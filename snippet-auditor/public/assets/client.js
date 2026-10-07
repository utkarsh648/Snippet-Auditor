// Client / review viewpoint: the latest SAVED HTML in the preview, plus visual QA notes.
// No source code, no Run, no Save.
//
// Annotation flow:  idle → selecting → composing → saving → idle
//   + Add note  → click an element/area in the preview → draft marker + composer → Add note
//   Escape / Cancel returns to idle from selecting or composing.
import { $, relTime, readRoute, prefs, boot, toast, initToast, pad2 } from './utils.js';
import { createApi } from './api.js';
import { PreviewPanel } from './preview.js';
import { QAPanel } from './qa-panel.js';
import { AnnotationLayer, NoteComposer } from './annotations.js';

/* Centralized QA state (note records themselves live in the QAPanel model). */
const qaState = {
  role: 'client',
  projectId: null,
  projectName: '',
  savedHTML: '',
  updatedAt: null,

  currentScreen: null,
  currentState: null,
  selectedPointerId: null,
  selectedKey: null,

  annotationMode: 'idle',      // idle | selecting | composing | saving
  annotationPurpose: null,     // 'new' | 'retarget' | 'retarget-draft'
  draftAnnotation: null
};

const DRAFT_KEY = '__draft__';
let api, preview, qa, layer, composer, ui;

initToast();
start();

async function start() {
  const route = readRoute();
  if (!route || route.view !== 'qa' || !route.token) { boot.denied(); return; }
  qaState.projectId = route.projectId;
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

/* ---------------------------------------------------------------
   UI wiring
   --------------------------------------------------------------- */
function initUi() {
  preview = new PreviewPanel({
    emptyTitle: 'Preview is not available yet.',
    emptyText: 'The developer has not saved any HTML for this project.',
    errorText: 'This version of the prototype has an error. You can still leave notes, and refresh after the developer saves a fix.',
    statusText: (s) => {
      if (s === 'updating') return 'Loading preview…';
      if (s === 'error') return 'Error in saved version';
      if (s === 'empty') return 'Nothing saved yet';
      return 'Saved ' + relTime(qaState.updatedAt);
    },
    onShortcut: (k) => { if (k === 'save') qa.flushAll(); },
    onContextClear: () => qa.clearSelection(),
    onViewport: (v) => savePrefs({ viewport: v }),
    onRefresh: refreshAll,
    onQa: (type, data) => layer.handleQa(type, data),
    onLoaded: () => {
      if (qaState.annotationMode === 'selecting') endAnnotation();
      layer.handleLoaded();
    }
  });
  $('syncBadge').classList.add('is-saved-version');
  $('syncBadge').title = 'You are viewing the latest version the developer saved';

  layer = new AnnotationLayer({
    preview,
    host: $('viewport'),
    onPick: onTargetPicked,
    onCancel: () => endAnnotation({ fromLayer: true }),
    onMarkerClick: (key) => {
      if (key === DRAFT_KEY) { composer.notes.focus(); return; }
      qa.select(key);
      qa.scrollToCard(key);
      layer.focus(key);
    },
    onPositions: ({ screen, state, statuses }) => {
      qaState.currentScreen = screen;
      qaState.currentState = state;
      qa.setTargetStatuses(statuses, screen);
      syncContext();
    },
    onFocused: (key, status) => {
      const item = qa.items.find((i) => i.key === key);
      if (!item) return;
      if (status === 'elsewhere' || status === 'hidden') {
        const where = item.f.screenName ? `“${item.f.screenName}”` : 'another screen';
        preview.notice(`Note ${pad2(item.number)} is on ${where}. Go to that screen in the prototype to see its marker.`);
      } else if (status === 'missing') {
        preview.notice(`Note ${pad2(item.number)}: the original target wasn't found. The marker shows where it was placed.`);
      } else if (status === 'none') {
        preview.notice(`Note ${pad2(item.number)} isn't pinned to the preview yet. Use “Set target” on the note to pin it.`);
      }
    }
  });
  layer.o.onPaint = () => { if (composer.open) composer.place(layer.pointOf(DRAFT_KEY), layer.rectOf(DRAFT_KEY)); };

  composer = new NoteComposer({
    host: $('viewport'),
    onSubmit: submitDraft,
    onCancel: () => endAnnotation(),
    onChangeTarget: () => beginSelecting('retarget-draft')
  });

  qa = new QAPanel({
    list: $('ptrList'),
    editable: true,
    api,
    toast,
    onSelect: (p, { fromList }) => {
      qaState.selectedKey = p ? p.key : null;
      qaState.selectedPointerId = p ? p.id : null;
      layer.setSelected(qaState.selectedKey);
      if (p && fromList) layer.focus(p.key);
      savePrefs({ selected: qaState.selectedPointerId });
      syncContext();
    },
    onChange: () => syncStatus(),
    onItemsChange: () => pushMarkers(),
    onChangeTarget: (key) => beginSelecting('retarget', key)
  });

  $('addPtrBtn').addEventListener('click', () => {
    if (qaState.annotationMode === 'selecting') { endAnnotation(); return; }
    if (qaState.annotationMode === 'composing' || qaState.annotationMode === 'saving') { composer.notes.focus(); return; }
    beginSelecting('new');
  });

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); qa.flushAll(); return; }
    if (e.key === 'Escape' && qaState.annotationMode === 'selecting') { e.preventDefault(); endAnnotation(); }
  }, true);

  window.addEventListener('beforeunload', (e) => {
    const typed = qaState.draftAnnotation && composer.values().notes.trim();
    if (qa.hasUnsavedWork() || typed) { e.preventDefault(); e.returnValue = ''; return ''; }
  });

  setInterval(() => { preview.refreshStatus(); syncStatus(); }, 30000);
}

function savePrefs(patch) {
  Object.assign(ui, patch);
  prefs.save(`${qaState.projectId}:qa`, ui);
}

/* ---------------------------------------------------------------
   Annotation state machine
   --------------------------------------------------------------- */
function setMode(mode) {
  qaState.annotationMode = mode;
  const selecting = mode === 'selecting';
  const btn = $('addPtrBtn');
  btn.classList.toggle('is-cancel', selecting);
  $('addPtrLabel').textContent = selecting ? 'Cancel' : 'Add note';
  $('nextPtrNum').hidden = selecting;
  btn.title = selecting ? 'Stop selecting (Esc)' : 'Add a note by clicking the preview';
  syncStatus();
}

/** purpose: 'new' | 'retarget' (existing note) | 'retarget-draft' (the composer's "Change target") */
function beginSelecting(purpose, key) {
  if (!preview.live) {
    toast(preview.html && preview.html.trim() ? 'Wait for the preview to finish loading.' : 'There is no preview to annotate yet.');
    return;
  }
  if (purpose !== 'retarget-draft' && qaState.draftAnnotation) endAnnotation();
  qaState.annotationPurpose = purpose;
  if (purpose === 'retarget-draft') { composer.hide(); composer.open = false; }
  const message = purpose === 'new'
    ? 'Click an element or area in the preview to leave feedback.'
    : 'Click the new target for this note.';
  if (layer.enter({ purpose, key }, message)) setMode('selecting');
}

function onTargetPicked(target, ctx) {
  const purpose = (ctx && ctx.purpose) || qaState.annotationPurpose;
  if (purpose === 'retarget' && ctx && ctx.key) {
    qa.retarget(ctx.key, target);
    qaState.annotationPurpose = null;
    setMode('idle');
    toast('Target updated');
    return;
  }
  if (purpose === 'retarget-draft' && qaState.draftAnnotation) {
    Object.assign(qaState.draftAnnotation, target);
    composer.fill(qaState.draftAnnotation);
    openComposer();
    return;
  }
  qaState.draftAnnotation = { ...target, notes: '' };
  composer.show(qaState.draftAnnotation, qa.upcomingNumber);
  openComposer();
}

function openComposer() {
  qaState.annotationPurpose = 'new';
  setMode('composing');
  composer.box.hidden = false;
  composer.open = true;
  pushMarkers();
  composer.place(layer.pointOf(DRAFT_KEY), layer.rectOf(DRAFT_KEY));
  requestAnimationFrame(() => composer.notes.focus());
}

async function submitDraft(values) {
  const d = qaState.draftAnnotation;
  if (!d) return;
  setMode('saving');
  const payload = {
    screenName: values.screenName || d.screenName || 'Current screen',
    screenState: d.screenState || 'Default',
    targetType: d.targetType,
    targetSelector: d.targetType === 'element' ? d.targetSelector : null,
    targetLabel: values.targetLabel || d.targetLabel || null,
    anchorX: d.anchorX,
    anchorY: d.anchorY,
    viewportWidth: d.viewportWidth,
    viewportHeight: d.viewportHeight,
    notes: values.notes
  };
  try {
    const pointer = await api.createPointer(payload);
    qaState.draftAnnotation = null;
    qaState.annotationPurpose = null;
    composer.hide();
    setMode('idle');
    qa.addSaved(pointer);
    toast(`Note ${pad2(pointer.pointerNumber)} added`);
  } catch (e) {
    setMode('composing'); // keep the draft marker and the typed note; the composer offers Retry
    throw e;
  }
}

/** Leave annotation. Cancelling "Change target" from the composer returns to the composer. */
function endAnnotation({ fromLayer = false } = {}) {
  if (qaState.annotationMode === 'selecting') {
    // Let the layer stop selecting; it calls back here with fromLayer = true.
    if (!fromLayer && layer.mode === 'selecting') { layer.cancel(); return; }
    if (qaState.annotationPurpose === 'retarget-draft' && qaState.draftAnnotation) { openComposer(); return; }
  }
  qaState.draftAnnotation = null;
  qaState.annotationPurpose = null;
  composer.hide();
  setMode('idle');
  pushMarkers();
}

/* Markers = saved notes + the draft, if any. */
function pushMarkers() {
  const items = qa.annotationItems();
  const d = qaState.draftAnnotation;
  if (d) {
    items.push({
      key: DRAFT_KEY, number: qa.upcomingNumber, draft: true, screenName: d.screenName,
      targetType: d.targetType, targetSelector: d.targetSelector, anchorX: d.anchorX, anchorY: d.anchorY
    });
  }
  layer.setItems(items);
}

/* ---------------------------------------------------------------
   Data
   --------------------------------------------------------------- */
function applyProject(p, opts) {
  const changed = p.html !== qaState.savedHTML || opts.initial;
  qaState.projectName = p.name;
  qaState.savedHTML = p.html;
  qaState.updatedAt = p.updatedAt;
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
    qa.setPointers(pointers, nextPointerNumber, qaState.selectedPointerId || ui.selected);
    $('addPtrBtn').disabled = false;
  } catch (e) {
    if (qa.loaded) toast("QA notes couldn't be refreshed. " + (e.message || ''));
    else qa.setError(e.message, loadPointers);
  }
  syncStatus();
}

/* Refresh: save pending edits, then load the latest saved HTML and notes. */
let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  if (qaState.annotationMode === 'selecting') endAnnotation();
  refreshing = true;
  $('reloadBtn').disabled = true;
  try {
    await qa.flushAll();
    const p = await api.getProject();
    const changed = p.html !== qaState.savedHTML;
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

/* ---------------------------------------------------------------
   Status
   --------------------------------------------------------------- */
function syncContext() {
  if (!qa) return;
  const sel = qa.items.find((i) => i.key === qaState.selectedKey);
  preview.setContext({
    screen: qaState.currentScreen,
    selected: sel ? { number: sel.number } : null,
    count: qa.countOnScreen(qaState.currentScreen)
  });
}

function syncStatus() {
  if (!qa) return;
  const s = qa.summary();
  $('ptrCount').textContent = String(s.total);
  $('ptrCount').title = s.total + (s.total === 1 ? ' note' : ' notes');
  $('nextPtrNum').textContent = pad2(qa.upcomingNumber);

  const el = $('saveStatus');
  let state, text, title = '';
  if (s.saving || qaState.annotationMode === 'saving') { state = 'saving'; text = 'Saving…'; }
  else if (s.failed) { state = 'error'; text = s.failed === 1 ? '1 note not saved' : `${s.failed} notes not saved`; title = 'Use Retry on the note, or check your connection.'; }
  else if (s.needsName) { state = 'dirty'; text = 'Add a screen name to save'; title = 'A note saves once it has a screen name.'; }
  else if (s.pending) { state = 'dirty'; text = 'Unsaved changes'; }
  else { state = 'saved'; text = s.total ? 'All feedback saved' : 'No feedback yet'; }
  el.dataset.state = state;
  $('saveStatusText').textContent = text;
  el.title = title;
  syncContext();
}
