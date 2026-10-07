// Visual QA overlay. Sits above the preview iframe (inside Snippet Auditor's DOM,
// never inside the prototype). Draws numbered markers, the hover highlight while
// annotating, the selected-target outline, and hosts the note composer.
//
// It talks to the sandboxed preview only through PreviewPanel.post() and the
// qa:* messages the in-frame bridge sends back (see preview.js).
import { pad2 } from './utils.js';

const MARKER = 24;          // px, marker diameter
const COLLIDE = 20;         // px, markers closer than this get nudged apart

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class AnnotationLayer {
  /**
   * @param {object} o
   * @param {import('./preview.js').PreviewPanel} o.preview
   * @param {HTMLElement} o.host               the preview viewport element
   * @param {(target, ctx) => void} [o.onPick]
   * @param {(ctx) => void} [o.onCancel]
   * @param {(key) => void} [o.onMarkerClick]
   * @param {(info) => void} [o.onPositions]  { screen, state, statuses: Map<key,status> }
   * @param {(key, status) => void} [o.onFocused]
   */
  constructor(o) {
    this.o = o;
    this.items = [];            // [{ key, number, targetType, targetSelector, anchorX, anchorY, screenName, draft? }]
    this.positions = new Map(); // key → { status, x, y, rect }
    this.selectedKey = null;
    this.visible = true;
    this.mode = 'idle';         // 'idle' | 'selecting'
    this.ctx = null;
    this.screen = null;
    this.state = null;

    const root = el('div', 'qa-layer');
    root.setAttribute('aria-hidden', 'false');
    this.selBox = el('div', 'qa-sel');
    this.hoverBox = el('div', 'qa-hover');
    this.hoverLabel = el('span', 'qa-hover-label');
    this.hoverBox.append(this.hoverLabel);
    this.markers = el('div', 'qa-markers');
    this.banner = el('div', 'qa-banner');
    this.banner.setAttribute('role', 'status');
    const bannerText = el('span', null, 'Click an element or area in the preview to leave feedback.');
    const esc = el('kbd', null, 'Esc');
    const cancel = el('button', 'qa-banner-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.cancel());
    this.banner.append(bannerText, esc, cancel);
    this.bannerText = bannerText;
    root.append(this.selBox, this.hoverBox, this.markers, this.banner);
    this.root = root;
    this.selBox.hidden = this.hoverBox.hidden = this.banner.hidden = true;
    o.host.appendChild(root);

    if (window.ResizeObserver) new ResizeObserver(() => this._paint()).observe(o.host);
  }

  /* ---------- wiring from PreviewPanel ---------- */

  handleQa(type, data) {
    if (type === 'qa:positions') {
      this.screen = data.screen;
      this.state = data.state;
      this.positions = new Map((data.items || []).map((p) => [p.key, p]));
      this._paint();
      if (this.o.onPositions) this.o.onPositions({ screen: data.screen, state: data.state, statuses: this.statuses() });
    } else if (type === 'qa:hover') {
      this._paintHover(data);
    } else if (type === 'qa:pick') {
      const ctx = this.ctx;
      this._setMode('idle');
      if (this.o.onPick) this.o.onPick(data, ctx);
    } else if (type === 'qa:cancel') {
      this.cancel();
    } else if (type === 'qa:focused') {
      if (this.o.onFocused) this.o.onFocused(data.key, data.status, data.screen);
    }
  }

  /** The preview (re)loaded: re-send everything the new frame needs. */
  handleLoaded() {
    this.positions = new Map();
    if (this.mode === 'selecting') this._setMode('idle', { silent: true });
    this._sync();
    this._paint();
  }

  /* ---------- public API ---------- */

  setItems(items) {
    this.items = items;
    this._sync();
    this._paint();
  }

  setSelected(key) {
    this.selectedKey = key;
    this._paint();
  }

  setVisible(on) {
    this.visible = !!on;
    this.root.hidden = !this.visible;
    if (!on && this.mode !== 'idle') this.cancel();
  }

  /** Annotation mode: the next click in the preview picks a target, then the mode ends. */
  enter(ctx, message) {
    if (!this.o.preview.live) return false;
    this.ctx = ctx || {};
    this.bannerText.textContent = message || 'Click an element or area in the preview to leave feedback.';
    this._setMode('selecting');
    return true;
  }

  cancel() {
    if (this.mode === 'idle') return;
    const ctx = this.ctx;
    this._setMode('idle');
    if (this.o.onCancel) this.o.onCancel(ctx);
  }

  focus(key) {
    const item = this.items.find((i) => i.key === key);
    if (!item) return;
    this.o.preview.post('qa:focus', this._wire(item));
    this._pulse(key);
  }

  statuses() {
    const out = new Map();
    for (const [k, p] of this.positions) out.set(k, p.status);
    return out;
  }

  /** Current target rectangle of an item (elements only), for the composer. */
  rectOf(key) {
    const p = this.positions.get(key);
    return p && p.rect ? p.rect : null;
  }

  /** Current point of a marker in viewport px, for the composer. */
  pointOf(key) {
    const p = this.positions.get(key);
    if (!p || typeof p.x !== 'number') return null;
    return this._clampPoint(p.x, p.y);
  }

  /* ---------- internals ---------- */

  _wire(i) {
    return {
      key: i.key, targetType: i.targetType, targetSelector: i.targetSelector,
      anchorX: i.anchorX, anchorY: i.anchorY, screenName: i.screenName
    };
  }

  _sync() {
    this.o.preview.post('qa:track', { items: this.items.map((i) => this._wire(i)) });
    if (this.mode === 'selecting') this.o.preview.post('qa:mode', { on: true });
  }

  _setMode(mode, { silent } = {}) {
    this.mode = mode;
    const on = mode === 'selecting';
    if (!silent) this.o.preview.post('qa:mode', { on });
    this.banner.hidden = !on;
    this.o.host.classList.toggle('is-annotating', on);
    if (!on) { this._paintHover(null); this.ctx = null; }
  }

  _clampPoint(x, y) {
    const w = this.o.host.clientWidth, h = this.o.host.clientHeight;
    return { x: Math.min(w - MARKER / 2 - 2, Math.max(MARKER / 2 + 2, x)), y: Math.min(h - MARKER / 2 - 2, Math.max(MARKER / 2 + 2, y)) };
  }

  _paintHover(data) {
    const box = this.hoverBox;
    if (!data || this.mode !== 'selecting') { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle('is-screen', data.type === 'screen');
    if (data.type === 'screen' || !data.rect) {
      Object.assign(box.style, { left: '3px', top: '3px', width: 'calc(100% - 6px)', height: 'calc(100% - 6px)' });
    } else {
      const r = data.rect;
      Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    }
    this.hoverLabel.textContent = data.label || '';
    this.hoverLabel.classList.toggle('is-below', !!data.rect && data.rect.y < 26);
  }

  _paint() {
    const w = this.o.host.clientWidth, h = this.o.host.clientHeight;
    const frag = document.createDocumentFragment();
    const placed = [];
    const ordered = [...this.items].sort((a, b) => (a.draft ? 1 : 0) - (b.draft ? 1 : 0) || a.number - b.number);
    for (const item of ordered) {
      const p = this.positions.get(item.key);
      if (!p || typeof p.x !== 'number') continue;
      if (p.y < -MARKER || p.y > h + MARKER || p.x < -MARKER || p.x > w + MARKER) continue; // scrolled away
      let { x, y } = this._clampPoint(p.x, p.y);
      // Simple collision nudge: shift right until clear (bounded).
      for (let n = 0; n < 6 && placed.some((q) => Math.abs(q.x - x) < COLLIDE && Math.abs(q.y - y) < COLLIDE); n++) x += COLLIDE + 2;
      placed.push({ x, y });
      const m = el('button', 'qa-marker', pad2(item.number));
      m.type = 'button';
      m.style.left = x + 'px';
      m.style.top = y + 'px';
      m.dataset.key = item.key;
      if (item.key === this.selectedKey) m.classList.add('is-selected');
      if (item.draft) m.classList.add('is-draft');
      if (p.status === 'missing') { m.classList.add('is-warn'); m.title = `Note ${pad2(item.number)}: target may have changed`; }
      else m.title = `Note ${pad2(item.number)}`;
      m.setAttribute('aria-label', m.title);
      m.addEventListener('click', (e) => { e.stopPropagation(); if (this.o.onMarkerClick) this.o.onMarkerClick(item.key); });
      frag.append(m);
    }
    this.markers.replaceChildren(frag);

    const sel = this.selectedKey && this.positions.get(this.selectedKey);
    if (sel && sel.status === 'found' && sel.rect && this.mode !== 'selecting') {
      const r = sel.rect;
      this.selBox.hidden = false;
      Object.assign(this.selBox.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    } else {
      this.selBox.hidden = true;
    }
    if (this.o.onPaint) this.o.onPaint();
  }

  _pulse(key) {
    requestAnimationFrame(() => {
      const m = this.markers.querySelector(`.qa-marker[data-key="${CSS.escape(key)}"]`);
      if (!m) return;
      m.classList.remove('is-pulse');
      void m.offsetWidth;
      m.classList.add('is-pulse');
    });
  }
}

/* =========================================================
   Composer: shown next to the draft marker after a target is picked.
   ========================================================= */
export class NoteComposer {
  /**
   * @param {object} o
   * @param {HTMLElement} o.host
   * @param {(values) => Promise<void>} o.onSubmit
   * @param {() => void} o.onCancel
   * @param {() => void} o.onChangeTarget
   */
  constructor(o) {
    this.o = o;
    this.open = false;
    this.saving = false;

    const box = el('div', 'qa-composer');
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'New QA note');

    const head = el('div', 'qc-head');
    this.num = el('span', 'ptr-num is-draft', '01');
    head.append(this.num, el('span', 'ptr-kind', 'New note'));

    // Screen (auto-detected, editable)
    const screenRow = el('div', 'qc-row');
    const screenTop = el('div', 'qc-row-top');
    screenTop.append(el('span', 'ptr-label', 'Screen'));
    this.screenEdit = el('button', 'qc-link', 'Edit');
    this.screenEdit.type = 'button';
    screenTop.append(this.screenEdit);
    this.screenValue = el('p', 'qc-value');
    this.screenInput = el('input', 'ptr-field');
    Object.assign(this.screenInput, { type: 'text', maxLength: 150, hidden: true, placeholder: 'Screen name' });
    this.screenInput.setAttribute('aria-label', 'Screen name');
    screenRow.append(screenTop, this.screenValue, this.screenInput);

    // Target (auto-detected label, editable, re-pickable)
    const targetRow = el('div', 'qc-row');
    const targetTop = el('div', 'qc-row-top');
    targetTop.append(el('span', 'ptr-label', 'Target'));
    this.targetEdit = el('button', 'qc-link', 'Edit');
    this.targetEdit.type = 'button';
    this.targetChange = el('button', 'qc-link', 'Change target');
    this.targetChange.type = 'button';
    targetTop.append(this.targetEdit, this.targetChange);
    this.targetValue = el('p', 'qc-value');
    this.targetInput = el('input', 'ptr-field');
    Object.assign(this.targetInput, { type: 'text', maxLength: 150, hidden: true, placeholder: 'What is this?' });
    this.targetInput.setAttribute('aria-label', 'Target label');
    targetRow.append(targetTop, this.targetValue, this.targetInput);

    const notesLabel = el('label', 'ptr-label', 'Notes');
    this.notes = el('textarea', 'ptr-field ptr-notes');
    Object.assign(this.notes, { rows: 3, maxLength: 5000, placeholder: 'Type your feedback…', id: 'qcNotes' });
    notesLabel.htmlFor = 'qcNotes';

    this.error = el('p', 'qc-error');
    this.error.hidden = true;
    this.hint = el('p', 'qc-hint');
    this.hint.hidden = true;

    const actions = el('div', 'qc-actions');
    this.cancelBtn = el('button', 'btn-ghost', 'Cancel');
    this.cancelBtn.type = 'button';
    this.submitBtn = el('button', 'btn-primary-sm', 'Add note');
    this.submitBtn.type = 'button';
    actions.append(this.cancelBtn, this.submitBtn);

    box.append(head, screenRow, targetRow, notesLabel, this.notes, this.hint, this.error, actions);
    this.box = box;
    o.host.appendChild(box);

    const toggle = (input, value) => {
      const editing = input.hidden;
      input.hidden = !editing;
      value.hidden = editing;
      if (editing) { input.focus(); input.select(); }
    };
    this.screenEdit.addEventListener('click', () => toggle(this.screenInput, this.screenValue));
    this.targetEdit.addEventListener('click', () => toggle(this.targetInput, this.targetValue));
    this.targetChange.addEventListener('click', () => this.o.onChangeTarget());
    this.screenInput.addEventListener('input', () => { this.screenValue.textContent = this.screenInput.value || '—'; });
    this.targetInput.addEventListener('input', () => { this.targetValue.textContent = this.targetInput.value || '—'; });
    this.notes.addEventListener('input', () => { this.hint.hidden = true; autosize(this.notes); });
    this.cancelBtn.addEventListener('click', () => this.requestCancel());
    this.submitBtn.addEventListener('click', () => this.submit());
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.requestCancel(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); this.submit(); }
    });
  }

  show(draft, number) {
    this.open = true;
    this.saving = false;
    this.escArmed = false;
    this.num.textContent = pad2(number);
    this.num.title = 'Number is confirmed when the note is saved';
    this.fill(draft);
    this.notes.value = draft.notes || '';
    this.error.hidden = true;
    this.hint.hidden = true;
    this.submitBtn.textContent = 'Add note';
    this._busy(false);
    this.box.hidden = false;
    autosize(this.notes);
    requestAnimationFrame(() => this.notes.focus());
  }

  /** Update screen/target after "Change target", keeping the typed note. */
  fill(draft) {
    const state = draft.screenState && draft.screenState !== 'Default' ? ` · ${draft.screenState}` : '';
    this.screenValue.textContent = (draft.screenName || 'Current screen') + state;
    this.screenInput.value = draft.screenName || '';
    this.targetValue.textContent = draft.targetLabel || (draft.targetType === 'screen' ? 'Entire screen' : 'Selected area');
    this.targetInput.value = draft.targetLabel || '';
    this.screenInput.hidden = this.targetInput.hidden = true;
    this.screenValue.hidden = this.targetValue.hidden = false;
  }

  hide() {
    this.open = false;
    this.box.hidden = true;
  }

  values() {
    return {
      screenName: this.screenInput.value.trim(),
      targetLabel: this.targetInput.value.trim(),
      notes: this.notes.value
    };
  }

  /**
   * Place next to the marker without covering the target:
   * right of the marker → below the target → above the target → left of the marker.
   */
  place(point, rect) {
    if (!this.open) return;
    const host = this.o.host, w = host.clientWidth, h = host.clientHeight, gap = 14;
    const bw = this.box.offsetWidth || 300, bh = this.box.offsetHeight || 320;
    const p = point || { x: w / 2, y: 60 };
    const r = rect || { x: p.x, y: p.y, w: 0, h: 0 };
    const clampX = (x) => Math.max(8, Math.min(x, w - bw - 8));
    const clampY = (y) => Math.max(8, Math.min(y, h - bh - 8));
    let left, top;
    if (p.x + gap + bw <= w - 8) { left = p.x + gap; top = clampY(p.y - 24); }
    else if (r.y + r.h + gap + bh <= h - 8) { left = clampX(p.x - bw); top = r.y + r.h + gap; }
    else if (r.y - gap - bh >= 8) { left = clampX(p.x - bw); top = r.y - gap - bh; }
    else { left = clampX(p.x - bw - gap); top = clampY(p.y - 24); }
    this.box.style.left = left + 'px';
    this.box.style.top = top + 'px';
  }

  requestCancel() {
    if (this.saving) return;
    // Never silently discard typed feedback: ask once.
    if (this.notes.value.trim() && !this.escArmed) {
      this.escArmed = true;
      this.hint.textContent = 'Discard this note? Press Esc or Cancel again to discard.';
      this.hint.hidden = false;
      return;
    }
    this.o.onCancel();
  }

  async submit() {
    if (this.saving) return;
    const v = this.values();
    if (!v.notes.trim()) {
      this.hint.textContent = 'Write your feedback before adding the note.';
      this.hint.hidden = false;
      this.notes.focus();
      return;
    }
    this.saving = true;
    this._busy(true);
    this.error.hidden = true;
    try {
      await this.o.onSubmit(v);
    } catch (e) {
      this.saving = false;
      this._busy(false);
      this.error.textContent = "Couldn't save this note. " + ((e && e.message) || 'Try again.');
      this.error.hidden = false;
      this.submitBtn.textContent = 'Retry';
    }
  }

  _busy(on) {
    this.submitBtn.disabled = this.cancelBtn.disabled = this.targetChange.disabled = on;
    if (on) this.submitBtn.textContent = 'Saving…';
  }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(220, ta.scrollHeight + 2) + 'px';
}
