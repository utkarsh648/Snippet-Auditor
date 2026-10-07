// QA note list (internally "pointers").
//   editable: true  → client view: edit / delete / change target, autosaved to the API
//   editable: false → developer view: read-only review of the same notes
// New notes are created through the preview annotation flow and inserted here with addSaved().
// Numbers come from the server and are never renumbered.
// All user text is rendered with textContent / input values, never innerHTML.
import { pad2 } from './utils.js';

const AUTOSAVE_MS = 700;
const LIMITS = { screenName: 150, targetLabel: 150, notes: 5000 };
const FIELDS = ['screenName', 'screenState', 'targetType', 'targetSelector', 'targetLabel', 'anchorX', 'anchorY', 'viewportWidth', 'viewportHeight', 'notes'];
const TYPE_LABEL = { element: 'Element', area: 'Area', screen: 'Screen' };
const TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.6 6.5v4.5M9.4 6.5v4.5"/></svg>';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function pick(src) {
  const o = {};
  for (const k of FIELDS) o[k] = src[k] === undefined ? null : src[k];
  if (!o.screenState) o.screenState = 'Default';
  if (!o.targetType) o.targetType = 'screen';
  if (o.notes == null) o.notes = '';
  if (o.screenName == null) o.screenName = '';
  return o;
}

export class QAPanel {
  /**
   * @param {object} o
   * @param {HTMLElement} o.list
   * @param {boolean}     o.editable
   * @param {object}      [o.api]            { updatePointer, deletePointer }
   * @param {Function}    [o.onSelect]       (note|null, { fromList }) => void
   * @param {Function}    [o.onChange]       (summary) => void
   * @param {Function}    [o.onItemsChange]  () => void   (markers need refreshing)
   * @param {Function}    [o.onChangeTarget] (key) => void
   * @param {Function}    [o.toast]
   */
  constructor(o) {
    this.o = o;
    this.items = [];
    this.selectedKey = null;
    this.nextNumber = 1;
    this.seq = 0;
    this.loaded = false;
    this.statuses = new Map();
    this.currentScreen = null;
  }

  /* ---------- Public API ---------- */

  setLoading() { this.o.list.replaceChildren(this._message('Loading QA notes…', '')); }

  setError(message, retry) {
    const box = this._message('QA notes could not be loaded.', message || 'Check your connection and try again.');
    if (retry) {
      const b = el('button', 'btn-sm', 'Try again');
      b.type = 'button';
      b.addEventListener('click', retry);
      box.appendChild(b);
    }
    this.o.list.replaceChildren(box);
  }

  /** Replace with server data, keeping any local unsaved edits. */
  setPointers(pointers, nextPointerNumber, preferredSelectedId) {
    const local = new Map(this.items.map((i) => [i.id, i]));
    const next = [];
    for (const p of pointers) {
      const existing = local.get(p.id);
      if (existing && this._hasLocalChanges(existing)) next.push(existing);
      else {
        const item = existing || this._newItem();
        this._applyServer(item, p);
        item.status = 'idle';
        next.push(item);
      }
      local.delete(p.id);
    }
    for (const item of local.values()) if (this._hasLocalChanges(item)) next.push(item);
    next.sort((a, b) => a.number - b.number);
    this.items = next;
    this.nextNumber = Math.max(nextPointerNumber || 1, this.items.reduce((m, i) => Math.max(m, i.number + 1), 1));
    this.loaded = true;

    const keep = this.selectedKey && this.items.some((i) => i.key === this.selectedKey) ? this.selectedKey : null;
    const wanted = preferredSelectedId && this.items.find((i) => i.id === preferredSelectedId);
    this.selectedKey = keep || (wanted ? wanted.key : null);
    this._render();
    this._emitSelect(false);
    this._emitChange();
    this._emitItems();
  }

  /** Insert a note that was just created through the annotation flow. */
  addSaved(pointer) {
    const item = this._newItem();
    this._applyServer(item, pointer);
    item.status = 'saved';
    this.items.push(item);
    this.items.sort((a, b) => a.number - b.number);
    this.nextNumber = Math.max(this.nextNumber, pointer.pointerNumber + 1);
    this.selectedKey = item.key;
    this._render();
    this._fadeSaved(item);
    this._emitSelect(false);
    this._emitChange();
    this._emitItems();
    if (item.refs) item.refs.card.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    return item.key;
  }

  /** "Change target": new anchor/selector/label, same note text and number. */
  retarget(key, target) {
    const item = this.items.find((i) => i.key === key);
    if (!item) return;
    for (const k of ['screenName', 'screenState', 'targetType', 'targetSelector', 'targetLabel', 'anchorX', 'anchorY', 'viewportWidth', 'viewportHeight']) {
      if (target[k] !== undefined) item.f[k] = target[k];
    }
    this.statuses.delete(key);
    if (item.refs && item.refs.name) {
      item.refs.name.value = item.f.screenName;
      item.refs.target.value = item.f.targetLabel || '';
      item.refs.target.placeholder = placeholderFor(item.f.targetType);
      item.refs.kind.textContent = TYPE_LABEL[item.f.targetType];
      this._paintState(item);
    }
    this._changed(item);
    this._emitItems();
    this._emitSelect(false);
  }

  select(key, { fromList = false } = {}) {
    if (this.selectedKey === key) { if (fromList) this._emitSelect(true); return; }
    this.selectedKey = key;
    this._paintSelection();
    this._emitSelect(fromList);
  }

  clearSelection() { this.select(null); }

  scrollToCard(key) {
    const item = this.items.find((i) => i.key === key);
    if (item && item.refs) item.refs.card.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
  }

  /** Statuses from the preview: found | hidden | missing | elsewhere | anchor | none */
  setTargetStatuses(statuses, screen) {
    this.statuses = statuses;
    this.currentScreen = screen;
    for (const i of this.items) this._paintTargetStatus(i);
  }

  /** Items for the annotation overlay. */
  annotationItems() {
    return this.items.map((i) => ({
      key: i.key, number: i.number, screenName: i.f.screenName,
      targetType: i.f.targetType, targetSelector: i.f.targetSelector,
      anchorX: i.f.anchorX, anchorY: i.f.anchorY
    }));
  }

  get count() { return this.items.length; }
  get upcomingNumber() { return this.nextNumber; }

  countOnScreen(screen) {
    return screen ? this.items.filter((i) => i.f.screenName === screen).length : 0;
  }

  summary() {
    const s = { saving: 0, failed: 0, needsName: 0, pending: 0, total: this.items.length };
    for (const i of this.items) {
      if (i.status === 'saving' || i.inflight) s.saving++;
      else if (i.status === 'error') s.failed++;
      else if (i.status === 'needs-name') s.needsName++;
      else if (i.status === 'pending') s.pending++;
    }
    return s;
  }

  hasUnsavedWork() {
    const s = this.summary();
    return s.saving + s.failed + s.needsName + s.pending > 0;
  }

  flushAll() {
    return Promise.all(this.items.filter((i) => i.timer || i.status === 'error').map((i) => this._flush(i)));
  }

  /* ---------- Internals ---------- */

  _newItem() {
    return {
      key: 'p' + (++this.seq), id: null, number: 0,
      f: pick({}), saved: pick({}),
      status: 'idle', timer: 0, inflight: null, again: false,
      confirming: false, deleting: false, error: '', refs: null
    };
  }

  _applyServer(item, p) {
    item.id = p.id;
    item.number = p.pointerNumber;
    item.f = pick(p);
    item.saved = pick(p);
  }

  _hasLocalChanges(i) {
    return !!(i.inflight || i.timer || ['pending', 'saving', 'error', 'needs-name'].includes(i.status));
  }

  _message(title, text) {
    const box = el('div', 'ptr-empty');
    box.appendChild(el('strong', null, title));
    if (text) box.appendChild(el('p', null, text));
    return box;
  }

  _emitSelect(fromList) {
    if (!this.o.onSelect) return;
    const i = this.items.find((x) => x.key === this.selectedKey);
    this.o.onSelect(i ? { key: i.key, id: i.id, number: i.number, screenName: i.f.screenName } : null, { fromList });
  }
  _emitChange() { if (this.o.onChange) this.o.onChange(this.summary()); }
  _emitItems() { if (this.o.onItemsChange) this.o.onItemsChange(); }

  _render() {
    const list = this.o.list;
    list.replaceChildren();
    if (!this.items.length) {
      list.appendChild(this.o.editable
        ? this._message('No QA notes yet.', 'Click “Add note”, then click the part of the preview you want to comment on.')
        : this._message('No QA notes yet.', 'Feedback added through the review link shows up here. Use Refresh to check for new notes.'));
      return;
    }
    for (const item of this.items) list.appendChild(this.o.editable ? this._editableCard(item) : this._readonlyCard(item));
    list.querySelectorAll('.ptr-notes').forEach(autosize);
    this._paintSelection();
    for (const i of this.items) this._paintTargetStatus(i);
  }

  _paintSelection() {
    for (const i of this.items) {
      if (!i.refs) continue;
      const on = i.key === this.selectedKey;
      i.refs.card.classList.toggle('is-selected', on);
      i.refs.card.setAttribute('aria-current', on ? 'true' : 'false');
    }
  }

  _paintTargetStatus(item) {
    const r = item.refs;
    if (!r || !r.warn) return;
    const st = this.statuses.get(item.key);
    const missing = st === 'missing';
    r.warn.hidden = !missing;
    r.warn.textContent = missing ? 'Target may have changed. Showing the saved position instead.' : '';
  }

  _paintState(item) {
    const r = item.refs;
    if (!r || !r.state) return;
    const s = item.f.screenState;
    r.state.hidden = !s || s === 'Default';
    r.state.textContent = s || '';
  }

  _head(item) {
    const head = el('div', 'ptr-head');
    const num = el('span', 'ptr-num', pad2(item.number));
    const kind = el('span', 'ptr-kind', TYPE_LABEL[item.f.targetType] || 'Screen');
    head.append(num, kind);
    return { head, num, kind };
  }

  _labelRow(text, stateEl, action) {
    const row = el('div', 'ptr-label-row');
    row.append(el('span', 'ptr-label', text));
    if (stateEl) row.append(stateEl);
    if (action) row.append(action);
    return row;
  }

  _bindSelect(card, item) {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button, input, textarea')) return;
      this.select(item.key, { fromList: true });
    });
  }

  _readonlyCard(item) {
    const card = el('article', 'ptr is-readonly');
    card.tabIndex = 0;
    card.setAttribute('aria-label', 'Note ' + pad2(item.number) + ': ' + (item.f.screenName || 'Untitled screen'));
    const { head, num, kind } = this._head(item);
    const state = el('span', 'ptr-state');
    const name = el('p', 'ptr-text-name', item.f.screenName || 'Untitled screen');
    const target = el('p', 'ptr-text-target', item.f.targetLabel || (item.f.targetType === 'screen' ? 'Entire screen' : 'Selected area'));
    const notes = el('p', 'ptr-text-notes', item.f.notes || 'No notes');
    if (!item.f.notes) notes.classList.add('is-muted');
    const warn = el('p', 'ptr-warn'); warn.hidden = true;
    card.append(head, this._labelRow('Screen', state), name, this._labelRow('Target'), target, this._labelRow('Notes'), notes, warn);
    this._bindSelect(card, item);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(item.key, { fromList: true }); }
    });
    item.refs = { card, num, kind, state, warn };
    this._paintState(item);
    return card;
  }

  _editableCard(item) {
    const card = el('article', 'ptr');
    card.setAttribute('aria-label', 'Note ' + pad2(item.number));
    const { head, num, kind } = this._head(item);
    const status = el('span', 'ptr-status');
    status.setAttribute('role', 'status');
    const del = el('button', 'ptr-del');
    del.type = 'button';
    del.innerHTML = TRASH; // static icon markup only
    head.append(status, del);

    const nameId = 'ptr-name-' + item.key, targetId = 'ptr-target-' + item.key, notesId = 'ptr-notes-' + item.key;
    const state = el('span', 'ptr-state');
    const nameLabelRow = this._labelRow('Screen', state);
    nameLabelRow.querySelector('.ptr-label').replaceWith(Object.assign(el('label', 'ptr-label', 'Screen'), { htmlFor: nameId }));
    const name = el('input', 'ptr-field ptr-name');
    Object.assign(name, { id: nameId, type: 'text', autocomplete: 'off', maxLength: LIMITS.screenName, placeholder: 'Screen name', value: item.f.screenName });

    const change = el('button', 'qc-link', item.f.targetType === 'screen' && item.f.anchorX == null ? 'Set target' : 'Change target');
    change.type = 'button';
    const targetLabelRow = this._labelRow('Target', null, change);
    targetLabelRow.querySelector('.ptr-label').replaceWith(Object.assign(el('label', 'ptr-label', 'Target'), { htmlFor: targetId }));
    const target = el('input', 'ptr-field ptr-target');
    Object.assign(target, { id: targetId, type: 'text', autocomplete: 'off', maxLength: LIMITS.targetLabel, placeholder: placeholderFor(item.f.targetType), value: item.f.targetLabel || '' });

    const notesLabel = el('label', 'ptr-label', 'Notes'); notesLabel.htmlFor = notesId;
    const notes = el('textarea', 'ptr-field ptr-notes');
    Object.assign(notes, { id: notesId, rows: 2, maxLength: LIMITS.notes, placeholder: 'Add feedback for this screen…', value: item.f.notes });
    const warn = el('p', 'ptr-warn'); warn.hidden = true;

    const confirm = el('div', 'ptr-confirm');
    confirm.hidden = true;
    confirm.setAttribute('role', 'alertdialog');
    confirm.setAttribute('aria-label', 'Delete note ' + pad2(item.number));
    const cText = el('p');
    cText.append(el('strong', null, 'Delete this note?'), document.createTextNode(' This feedback will be removed permanently.'));
    const cActions = el('div', 'ptr-confirm-actions');
    const cancel = el('button', 'btn-ghost', 'Cancel'); cancel.type = 'button';
    const really = el('button', 'btn-danger', 'Delete'); really.type = 'button';
    cActions.append(cancel, really);
    confirm.append(cText, cActions);

    name.addEventListener('input', () => { item.f.screenName = name.value; this._changed(item); this._emitItems(); this._emitSelect(false); });
    target.addEventListener('input', () => { item.f.targetLabel = target.value; this._changed(item); });
    notes.addEventListener('input', () => { autosize(notes); item.f.notes = notes.value; this._changed(item); });
    for (const f of [name, target, notes]) {
      f.addEventListener('blur', () => { if (item.timer) this._flush(item); });
      f.addEventListener('focus', () => this.select(item.key, { fromList: false }));
    }
    this._bindSelect(card, item);
    change.addEventListener('click', (e) => { e.stopPropagation(); this.select(item.key); if (this.o.onChangeTarget) this.o.onChangeTarget(item.key); });
    status.addEventListener('click', (e) => { if (e.target.closest('.ptr-retry')) this._flush(item); });

    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.inflight) return;
      item.confirming = true; this._paint(item); really.focus();
    });
    cancel.addEventListener('click', () => { item.confirming = false; this._paint(item); del.focus(); });
    really.addEventListener('click', () => this._delete(item));
    confirm.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); item.confirming = false; this._paint(item); del.focus(); } });

    card.append(head, nameLabelRow, name, targetLabelRow, target, notesLabel, notes, warn, confirm);
    item.refs = { card, num, kind, status, del, name, target, change, notes, state, warn, confirm, really, cancel };
    this._paintState(item);
    this._paint(item);
    return card;
  }

  _changed(item) {
    item.status = 'pending';
    clearTimeout(item.timer);
    item.timer = setTimeout(() => this._flush(item), AUTOSAVE_MS);
    this._paint(item);
    this._emitChange();
  }

  _isDirty(item) {
    return FIELDS.some((k) => item.f[k] !== item.saved[k]);
  }

  _flush(item) {
    clearTimeout(item.timer);
    item.timer = 0;
    if (item.removed) return Promise.resolve();
    if (item.inflight) { item.again = true; return item.inflight; }
    if (!this._isDirty(item)) {
      item.status = 'idle';
      this._paint(item); this._emitChange();
      return Promise.resolve();
    }
    if (!item.f.screenName.trim()) {
      item.status = 'needs-name';
      this._paint(item); this._emitChange();
      return Promise.resolve();
    }

    const sent = { ...item.f };
    const patch = {};
    for (const k of FIELDS) if (sent[k] !== item.saved[k]) patch[k] = sent[k];
    // Anchors and target type/selector travel together so the server can validate them.
    if ('anchorX' in patch || 'anchorY' in patch) { patch.anchorX = sent.anchorX; patch.anchorY = sent.anchorY; }
    if ('targetSelector' in patch || 'targetType' in patch) { patch.targetType = sent.targetType; patch.targetSelector = sent.targetSelector; }

    item.status = 'saving';
    this._paint(item); this._emitChange();

    item.inflight = (async () => {
      try {
        const p = await this.o.api.updatePointer(item.id, patch);
        item.number = p.pointerNumber;
        item.saved = sent;
        item.status = this._isDirty(item) ? 'pending' : 'saved';
        item.error = '';
      } catch (e) {
        item.status = 'error';
        item.error = e && e.status === 404 ? 'This note was deleted somewhere else.' : (e && e.message) || 'Feedback could not be saved.';
      } finally {
        item.inflight = null;
        this._paint(item);
        this._emitChange();
        if (item.again || (item.status === 'pending' && !item.timer)) { item.again = false; this._flush(item); }
        if (item.status === 'saved') this._fadeSaved(item);
      }
    })();
    return item.inflight;
  }

  _fadeSaved(item) {
    this._paint(item);
    clearTimeout(item.fade);
    item.fade = setTimeout(() => { if (item.status === 'saved') { item.status = 'idle'; this._paint(item); } }, 2500);
  }

  async _delete(item) {
    clearTimeout(item.timer); item.timer = 0;
    item.deleting = true; this._paint(item);
    try {
      await this.o.api.deletePointer(item.id);
      this._removeLocal(item);
      if (this.o.toast) this.o.toast('Note ' + pad2(item.number) + ' deleted');
    } catch (e) {
      item.deleting = false;
      if (e && e.status === 404) { this._removeLocal(item); return; }
      this._paint(item);
      if (this.o.toast) this.o.toast("Couldn't delete this note. " + ((e && e.message) || 'Try again.'));
    }
  }

  _removeLocal(item) {
    item.removed = true;
    clearTimeout(item.timer);
    this.items = this.items.filter((i) => i !== item);
    if (this.selectedKey === item.key) { this.selectedKey = null; this._emitSelect(false); }
    this._render();
    this._emitChange();
    this._emitItems();
  }

  _paint(item) {
    const r = item.refs;
    if (!r) return;
    r.num.textContent = pad2(item.number);
    if (r.kind) r.kind.textContent = TYPE_LABEL[item.f.targetType] || 'Screen';
    if (!r.status) return;
    r.card.setAttribute('aria-label', 'Note ' + pad2(item.number));
    r.del.title = 'Delete note ' + pad2(item.number);
    r.del.setAttribute('aria-label', 'Delete note ' + pad2(item.number));
    r.del.disabled = !!item.inflight || item.deleting;
    if (r.change) r.change.textContent = item.f.targetType === 'screen' && item.f.anchorX == null ? 'Set target' : 'Change target';

    const s = r.status;
    s.replaceChildren();
    s.className = 'ptr-status';
    const label = { pending: 'Unsaved', saving: 'Saving…', saved: 'Saved', 'needs-name': 'Add a screen name to save', error: 'Not saved' }[item.status];
    if (label) {
      s.textContent = label;
      s.classList.add('is-' + item.status);
      if (item.status === 'error') {
        s.title = item.error;
        const retry = el('button', 'ptr-retry', 'Retry');
        retry.type = 'button';
        s.append(' ', retry);
      } else s.title = '';
    }
    r.confirm.hidden = !item.confirming;
    r.really.disabled = r.cancel.disabled = item.deleting;
    r.really.textContent = item.deleting ? 'Deleting…' : 'Delete';
  }
}

function placeholderFor(type) {
  return type === 'screen' ? 'Entire screen' : type === 'area' ? 'Selected area' : 'What is this?';
}
function reduced() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}
