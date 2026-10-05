// QA pointer list.
//   editable: true  → client view: add / edit / delete, autosaved to the API
//   editable: false → developer view: read-only review of the same pointers
// Pointer numbers come from the server and are never renumbered.
// All user text is rendered with textContent / input values, never innerHTML.
import { pad2 } from './utils.js';

const AUTOSAVE_MS = 700;
const LIMITS = { screenName: 150, notes: 5000 };
const TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.6 6.5v4.5M9.4 6.5v4.5"/></svg>';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class QAPanel {
  /**
   * @param {object} o
   * @param {HTMLElement} o.list        container for cards
   * @param {boolean}     o.editable
   * @param {object}      [o.api]       { createPointer, updatePointer, deletePointer } (editable only)
   * @param {Function}    [o.onSelect]  (pointer|null) => void   pointer: { id, number, screenName }
   * @param {Function}    [o.onChange]  (summary) => void
   * @param {Function}    [o.toast]
   */
  constructor(o) {
    this.o = o;
    this.items = [];
    this.selectedKey = null;
    this.nextNumber = 1;
    this.seq = 0;
    this.loaded = false;
  }

  /* ---------- Public API ---------- */

  setLoading() {
    this.o.list.replaceChildren(this._message('Loading QA notes…', ''));
  }

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

  /**
   * Replace the list with server data. Local edits that have not been
   * saved yet (drafts, pending or failed saves) are kept, so a refresh
   * never silently discards feedback.
   */
  setPointers(pointers, nextPointerNumber, preferredSelectedId) {
    const local = new Map(this.items.filter((i) => i.id).map((i) => [i.id, i]));
    const next = [];
    for (const p of pointers) {
      const existing = local.get(p.id);
      if (existing && this._hasLocalChanges(existing)) {
        next.push(existing);
      } else {
        const item = existing || this._newItem();
        item.id = p.id;
        item.number = p.pointerNumber;
        item.screenName = p.screenName;
        item.notes = p.notes;
        item.saved = { screenName: p.screenName, notes: p.notes };
        item.status = 'idle';
        next.push(item);
      }
      local.delete(p.id);
    }
    // Pointers deleted elsewhere: keep only if this browser still has unsaved edits for them.
    for (const item of local.values()) if (this._hasLocalChanges(item)) next.push(item);
    for (const item of this.items) if (!item.id) next.push(item); // local drafts
    next.sort((a, b) => a.number - b.number);
    this.items = next;

    const maxLocal = this.items.reduce((m, i) => Math.max(m, i.number), 0);
    this.nextNumber = Math.max(nextPointerNumber || 1, maxLocal + 1);
    this.loaded = true;

    const keepKey = this.selectedKey && this.items.some((i) => i.key === this.selectedKey) ? this.selectedKey : null;
    const wanted = preferredSelectedId && this.items.find((i) => i.id === preferredSelectedId);
    this.selectedKey = keepKey || (wanted ? wanted.key : null);
    this._render();
    this._emitSelect();
    this._emitChange();
  }

  /** Add a local draft pointer (editable mode). It is saved once it has a screen name. */
  add() {
    if (!this.o.editable) return;
    const item = this._newItem();
    item.number = this.nextNumber++;
    item.status = 'draft';
    this.items.push(item);
    this.selectedKey = item.key;
    this._render();
    this._emitSelect();
    this._emitChange();
    const refs = item.refs;
    if (refs) {
      refs.card.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      refs.name.focus();
    }
  }

  select(key) {
    if (this.selectedKey === key) return;
    this.selectedKey = key;
    this._paintSelection();
    this._emitSelect();
  }

  clearSelection() { this.select(null); }

  get count() { return this.items.length; }

  /** Number the next pointer is expected to get (the server confirms it on save). */
  get upcomingNumber() { return this.nextNumber; }

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

  /** Save everything that is waiting for its debounce. */
  flushAll() {
    return Promise.all(this.items.filter((i) => i.timer || i.status === 'error').map((i) => this._flush(i)));
  }

  retryFailed() {
    return Promise.all(this.items.filter((i) => i.status === 'error').map((i) => this._flush(i)));
  }

  /* ---------- Internals ---------- */

  _newItem() {
    return {
      key: 'p' + (++this.seq), id: null, number: 0, screenName: '', notes: '',
      saved: { screenName: '', notes: '' }, status: 'idle', timer: 0, inflight: null, again: false,
      confirming: false, deleting: false, error: '', refs: null
    };
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

  _emitSelect() {
    if (!this.o.onSelect) return;
    const i = this.items.find((x) => x.key === this.selectedKey);
    this.o.onSelect(i ? { id: i.id, number: i.number, screenName: i.screenName } : null);
  }

  _emitChange() { if (this.o.onChange) this.o.onChange(this.summary()); }

  _render() {
    const list = this.o.list;
    list.replaceChildren();
    if (!this.items.length) {
      list.appendChild(this.o.editable
        ? this._message('No QA notes yet.', 'Add a pointer to leave feedback on the preview.')
        : this._message('No QA notes yet.', 'Feedback added through the review link shows up here. Use Refresh to check for new notes.'));
      return;
    }
    for (const item of this.items) list.appendChild(this.o.editable ? this._editableCard(item) : this._readonlyCard(item));
    list.querySelectorAll('.ptr-notes').forEach(autosize);
    this._paintSelection();
  }

  _paintSelection() {
    for (const i of this.items) {
      if (!i.refs) continue;
      const on = i.key === this.selectedKey;
      i.refs.card.classList.toggle('is-selected', on);
      i.refs.card.setAttribute('aria-current', on ? 'true' : 'false');
    }
  }

  _head(item) {
    const head = el('div', 'ptr-head');
    const num = el('span', 'ptr-num', pad2(item.number));
    head.append(num, el('span', 'ptr-kind', 'Screen'));
    return { head, num };
  }

  _readonlyCard(item) {
    const card = el('article', 'ptr is-readonly');
    card.tabIndex = 0;
    card.setAttribute('aria-label', 'Pointer ' + pad2(item.number) + ': ' + (item.screenName || 'Untitled screen'));
    const { head, num } = this._head(item);
    const name = el('p', 'ptr-text-name', item.screenName || 'Untitled screen');
    if (!item.screenName) name.classList.add('is-muted');
    const notes = el('p', 'ptr-text-notes', item.notes || 'No notes');
    if (!item.notes) notes.classList.add('is-muted');
    card.append(head, el('span', 'ptr-label', 'Screen name'), name, el('span', 'ptr-label', 'Notes'), notes);
    card.addEventListener('click', () => this.select(item.key));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(this.selectedKey === item.key ? null : item.key); }
    });
    item.refs = { card, num };
    return card;
  }

  _editableCard(item) {
    const card = el('article', 'ptr');
    card.setAttribute('aria-label', 'Pointer ' + pad2(item.number));
    const { head, num } = this._head(item);

    const status = el('span', 'ptr-status');
    status.setAttribute('role', 'status');
    const del = el('button', 'ptr-del');
    del.type = 'button';
    del.innerHTML = TRASH; // static icon markup only
    head.append(status, del);

    const nameId = 'ptr-name-' + item.key, notesId = 'ptr-notes-' + item.key;
    const nameLabel = el('label', 'ptr-label', 'Screen name'); nameLabel.htmlFor = nameId;
    const name = el('input', 'ptr-field ptr-name');
    Object.assign(name, { id: nameId, type: 'text', autocomplete: 'off', maxLength: LIMITS.screenName, placeholder: 'e.g. Onboarding / Household', value: item.screenName });
    const notesLabel = el('label', 'ptr-label', 'Notes'); notesLabel.htmlFor = notesId;
    const notes = el('textarea', 'ptr-field ptr-notes');
    Object.assign(notes, { id: notesId, rows: 2, maxLength: LIMITS.notes, placeholder: 'Add feedback for this screen…', value: item.notes });

    const confirm = el('div', 'ptr-confirm');
    confirm.hidden = true;
    confirm.setAttribute('role', 'alertdialog');
    confirm.setAttribute('aria-label', 'Delete pointer ' + pad2(item.number));
    const cText = el('p');
    cText.append(el('strong', null, 'Delete this pointer?'), document.createTextNode(' This feedback will be removed permanently.'));
    const cActions = el('div', 'ptr-confirm-actions');
    const cancel = el('button', 'btn-ghost', 'Cancel'); cancel.type = 'button';
    const really = el('button', 'btn-danger', 'Delete'); really.type = 'button';
    cActions.append(cancel, really);
    confirm.append(cText, cActions);

    name.addEventListener('input', () => { item.screenName = name.value; this._changed(item); this._emitSelect(); });
    notes.addEventListener('input', () => { autosize(notes); item.notes = notes.value; this._changed(item); });
    name.addEventListener('blur', () => { if (item.timer) this._flush(item); });
    notes.addEventListener('blur', () => { if (item.timer) this._flush(item); });
    card.addEventListener('focusin', () => this.select(item.key));
    card.addEventListener('mousedown', () => this.select(item.key));
    status.addEventListener('click', (e) => { if (e.target.closest('.ptr-retry')) this._flush(item); });

    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.inflight) return;
      if (!item.id && !item.screenName.trim() && !item.notes.trim()) { this._removeLocal(item); return; }
      item.confirming = true; this._paint(item); really.focus();
    });
    cancel.addEventListener('click', () => { item.confirming = false; this._paint(item); del.focus(); });
    really.addEventListener('click', () => this._delete(item));
    confirm.addEventListener('keydown', (e) => { if (e.key === 'Escape') { item.confirming = false; this._paint(item); del.focus(); } });

    card.append(head, nameLabel, name, notesLabel, notes, confirm);
    item.refs = { card, num, status, del, name, notes, confirm, really, cancel };
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
    if (!item.id) return !!(item.screenName.trim() || item.notes.trim());
    return item.screenName !== item.saved.screenName || item.notes !== item.saved.notes;
  }

  _flush(item) {
    clearTimeout(item.timer);
    item.timer = 0;
    if (item.removed) return Promise.resolve();
    if (item.inflight) { item.again = true; return item.inflight; }
    if (!this._isDirty(item)) {
      item.status = item.id ? 'idle' : 'draft';
      this._paint(item); this._emitChange();
      return Promise.resolve();
    }
    if (!item.screenName.trim()) {
      item.status = 'needs-name';
      this._paint(item); this._emitChange();
      return Promise.resolve();
    }

    const sent = { screenName: item.screenName, notes: item.notes };
    item.status = 'saving';
    this._paint(item); this._emitChange();

    item.inflight = (async () => {
      try {
        const p = item.id
          ? await this.o.api.updatePointer(item.id, sent)
          : await this.o.api.createPointer(sent);
        item.id = p.id;
        item.number = p.pointerNumber;
        item.saved = sent;
        this.nextNumber = Math.max(this.nextNumber, p.pointerNumber + 1);
        item.status = this._isDirty(item) ? 'pending' : 'saved';
        item.error = '';
      } catch (e) {
        item.status = 'error';
        item.error = e && e.status === 404 ? 'This pointer was deleted somewhere else.' : (e && e.message) || 'Feedback could not be saved.';
      } finally {
        item.inflight = null;
        this._paint(item);
        this._emitChange();
        if (item.key === this.selectedKey) this._emitSelect();
        if (item.again || (item.status === 'pending' && !item.timer)) { item.again = false; this._flush(item); }
        if (item.status === 'saved') {
          clearTimeout(item.fade);
          item.fade = setTimeout(() => { if (item.status === 'saved') { item.status = 'idle'; this._paint(item); } }, 2500);
        }
      }
    })();
    return item.inflight;
  }

  async _delete(item) {
    clearTimeout(item.timer); item.timer = 0;
    if (!item.id) { this._removeLocal(item); return; }
    item.deleting = true; this._paint(item);
    try {
      await this.o.api.deletePointer(item.id);
      this._removeLocal(item);
      if (this.o.toast) this.o.toast('Pointer ' + pad2(item.number) + ' deleted');
    } catch (e) {
      item.deleting = false;
      if (e && e.status === 404) { this._removeLocal(item); return; } // already gone
      this._paint(item);
      if (this.o.toast) this.o.toast('Pointer could not be deleted. ' + ((e && e.message) || 'Try again.'));
    }
  }

  _removeLocal(item) {
    item.removed = true;
    clearTimeout(item.timer);
    this.items = this.items.filter((i) => i !== item);
    if (this.selectedKey === item.key) { this.selectedKey = null; this._emitSelect(); }
    this._render();
    this._emitChange();
  }

  _paint(item) {
    const r = item.refs;
    if (!r || !r.status) { if (r && r.num) r.num.textContent = pad2(item.number); return; }
    r.num.textContent = pad2(item.number);
    r.num.title = item.id ? '' : 'Number is confirmed when this pointer is saved';
    r.num.classList.toggle('is-draft', !item.id);
    r.card.setAttribute('aria-label', 'Pointer ' + pad2(item.number));
    r.del.title = 'Delete pointer ' + pad2(item.number);
    r.del.setAttribute('aria-label', 'Delete pointer ' + pad2(item.number));
    r.del.disabled = !!item.inflight || item.deleting;

    const s = r.status;
    s.replaceChildren();
    s.className = 'ptr-status';
    const label = {
      pending: 'Unsaved', saving: 'Saving…', saved: 'Saved',
      'needs-name': 'Add a screen name to save', error: 'Not saved', draft: 'Not saved yet'
    }[item.status];
    if (item.status === 'draft' && !item.screenName && !item.notes) {
      // A fresh empty pointer: nothing to say yet.
    } else if (label) {
      s.textContent = label;
      s.classList.add('is-' + item.status);
      if (item.status === 'error') {
        s.title = item.error;
        const retry = el('button', 'ptr-retry', 'Retry');
        retry.type = 'button';
        s.append(' ', retry);
      } else {
        s.title = '';
      }
    }

    r.confirm.hidden = !item.confirming;
    r.really.disabled = r.cancel.disabled = item.deleting;
    r.really.textContent = item.deleting ? 'Deleting…' : 'Delete';
  }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}
