// Preview: renders project HTML in a sandboxed iframe (no allow-same-origin),
// so prototype code can never reach the Snippet Auditor page, its token or its API.
// Shared by the developer and client viewpoints.
import { $, relTime } from "./utils.js";

/* =========================================================
   PreviewRenderer — isolated, reusable preview service.
   Renders HTML in a sandboxed iframe (no allow-same-origin),
   so prototype code cannot reach the parent application.
   Reusable later by the QA / client portal.
   ========================================================= */

/* Runs inside the preview iframe. Kept free of line comments
   and newline-dependent syntax so it can be inlined on one line
   (which keeps error line numbers aligned with the editor). */
function previewBridge(cfg) {
  var token = cfg.token;
  function send(type, data) { try { parent.postMessage({ __sa: token, type: type, data: data }, '*'); } catch (e) {} }
  function memStore() {
    var d = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
      setItem: function (k, v) { d[k] = String(v); },
      removeItem: function (k) { delete d[k]; },
      clear: function () { d = {}; },
      key: function (i) { return Object.keys(d)[i] || null; },
      get length() { return Object.keys(d).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (n) {
    var ok = false;
    try { ok = !!window[n]; } catch (e) { ok = false; }
    if (!ok) { try { Object.defineProperty(window, n, { value: memStore(), configurable: true }); } catch (e) {} }
  });
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) { send('resource', { url: t.currentSrc || t.src || t.href || '', tag: String(t.tagName).toLowerCase() }); return; }
    send('error', { message: e.message || 'Script error', line: e.lineno || 0, col: e.colno || 0 });
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    send('error', { message: 'Unhandled promise rejection: ' + (r && r.message ? r.message : String(r)) });
  });
  document.addEventListener('securitypolicyviolation', function (e) {
    send('blocked', { url: e.blockedURI || '', directive: e.effectiveDirective || e.violatedDirective || '' });
  });
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
      e.preventDefault();
      send('shortcut', { key: e.key === 'Enter' ? 'run' : 'save' });
    }
  }, true);
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var h = a.getAttribute('href') || '';
    if (h.charAt(0) === '#' || /^javascript:/i.test(h)) return;
    if ((a.getAttribute('target') || '').toLowerCase() === '_blank') return;
    e.preventDefault();
    send('notice', { text: 'Link to ' + h + ' was not followed. Links that leave the page are disabled in the preview.' });
  });
  window.addEventListener('submit', function (e) {
    if (!e.defaultPrevented) {
      e.preventDefault();
      send('notice', { text: 'Form submitted. Forms without a script handler are not sent anywhere from the preview.' });
    }
  });
  var st = 0;
  window.addEventListener('scroll', function () {
    clearTimeout(st);
    st = setTimeout(function () { send('scroll', { x: window.scrollX, y: window.scrollY }); }, 120);
  }, { passive: true });
  window.addEventListener('load', function () {
    if (cfg.scroll && (cfg.scroll.x || cfg.scroll.y)) { try { window.scrollTo(cfg.scroll.x, cfg.scroll.y); } catch (e) {} }
    send('loaded', {});
  });
}

function PreviewRenderer(host, handlers) {
  this.host = host;
  this.h = handlers || {};
  this.current = null;
  this.pending = null;
  this.lastHtml = null;
  this.scroll = { x: 0, y: 0 };
  var self = this;
  window.addEventListener('message', function (e) { self._onMessage(e); });
}
PreviewRenderer.SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-downloads';
PreviewRenderer.compose = function (html, cfg) {
  var src = previewBridge.toString().replace(/\n\s*/g, ' ');
  var payload = JSON.stringify(cfg).replace(/</g, '\\u003c');
  var tag = '<scr' + 'ipt>(' + src + ')(' + payload + ');</scr' + 'ipt>';
  var m = /<head\b[^>]*>/i.exec(html) || /<html\b[^>]*>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
  if (m) { var at = m.index + m[0].length; return html.slice(0, at) + tag + html.slice(at); }
  return tag + html;
};
PreviewRenderer.prototype.render = function (html, opts) {
  opts = opts || {};
  var self = this;
  if (this.pending) { this.pending.frame.remove(); this.pending = null; }
  var buf = new Uint32Array(4); crypto.getRandomValues(buf);
  var token = Array.prototype.map.call(buf, function (n) { return n.toString(36); }).join('');
  var frame = document.createElement('iframe');
  frame.setAttribute('sandbox', PreviewRenderer.SANDBOX);
  frame.setAttribute('title', 'Rendered prototype');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.className = 'pv-frame is-loading';
  var p = { frame: frame, token: token, issues: [], keys: {}, loaded: false, initial: !!opts.initial };
  this.pending = p;
  this.lastHtml = html;
  frame.addEventListener('load', function () { setTimeout(function () { self._finish(p); }, 60); });
  try {
    frame.srcdoc = PreviewRenderer.compose(html, { token: token, scroll: this.scroll });
  } catch (err) {
    frame.srcdoc = '';
    this._addIssue(p, { kind: 'error', message: 'The preview could not be prepared: ' + (err && err.message ? err.message : String(err)) });
  }
  this.host.appendChild(frame);
  this._emitState('updating', p);
  clearTimeout(this._guard);
  this._guard = setTimeout(function () { self._finish(p); }, 8000);
};
PreviewRenderer.prototype.reload = function () { if (this.lastHtml != null) this.render(this.lastHtml); };
PreviewRenderer.prototype._finish = function (p) {
  if (p.loaded || this.pending !== p) return;
  p.loaded = true;
  if (this.current && this.current.frame !== p.frame) this.current.frame.remove();
  this.current = p; this.pending = null;
  p.frame.classList.remove('is-loading');
  var hasErr = p.issues.some(function (i) { return i.kind === 'error'; });
  this._emitState(hasErr ? 'error' : (p.initial ? 'ready' : 'updated'), p);
  this._emitIssues(p);
};
PreviewRenderer.prototype._onMessage = function (e) {
  var d = e.data;
  if (!d || typeof d !== 'object' || typeof d.__sa !== 'string') return;
  var p = null;
  [this.pending, this.current].forEach(function (x) { if (!p && x && x.token === d.__sa && e.source === x.frame.contentWindow) p = x; });
  if (!p) return;
  var data = d.data || {}, self = this;
  switch (d.type) {
    case 'loaded': setTimeout(function () { self._finish(p); }, 20); break;
    case 'error':
      this._addIssue(p, { kind: 'error', message: String(data.message || 'Script error').slice(0, 600), line: +data.line || 0, col: +data.col || 0 });
      break;
    case 'resource':
      if (data.url) this._addIssue(p, { kind: 'warning', key: 'res:' + data.url, message: "Couldn't load " + (data.tag || 'resource') + ': ' + String(data.url).slice(0, 300) });
      break;
    case 'blocked':
      if (data.url && !/^(inline|eval)$/.test(data.url)) this._addIssue(p, { kind: 'warning', key: 'res:' + data.url, override: true, message: "Blocked by the preview's security policy: " + String(data.url).slice(0, 300) });
      break;
    case 'notice': if (this.h.onNotice) this.h.onNotice(String(data.text || '').slice(0, 300)); break;
    case 'scroll': if (p === this.current) this.scroll = { x: +data.x || 0, y: +data.y || 0 }; break;
    case 'shortcut': if (this.h.onShortcut) this.h.onShortcut(data.key === 'run' ? 'run' : 'save'); break;
  }
};
PreviewRenderer.prototype._addIssue = function (p, issue) {
  var key = issue.key || (issue.kind + '|' + issue.message + '|' + (issue.line || 0) + '|' + (issue.col || 0));
  var ex = p.keys[key];
  if (ex) {
    if (issue.override) ex.message = issue.message; else ex.count++;
  } else {
    issue.count = 1;
    issue.phase = p.loaded ? 'runtime' : 'load';
    p.keys[key] = issue;
    p.issues.push(issue);
  }
  if (p.loaded && p === this.current) {
    if (issue.kind === 'error') this._emitState('error', p);
    this._emitIssues(p);
  }
};
PreviewRenderer.prototype._emitState = function (state, p) { if (this.h.onState) this.h.onState(state, p); };
PreviewRenderer.prototype._emitIssues = function (p) { if (this.h.onIssues) this.h.onIssues(p.issues.slice()); };


/* =========================================================
   PreviewPanel — binds the renderer to the shared preview markup
   (status, context pill, viewport switch, error overlay/tray, empty state).
   ========================================================= */
var DEVICES = { desktop: null, tablet: 768, mobile: 390 };

export class PreviewPanel {
  constructor(opts) {
    this.opts = Object.assign({
      emptyTitle: 'Preview is not available yet.',
      emptyText: '',
      errorText: 'There is an error in the current HTML or script.',
      statusText: null,          // (state, at) => string, to customise labels
      onShortcut: null,
      onGoToLine: null,          // developer only
      onContextClear: null,
      onViewport: null
    }, opts || {});
    this.state = 'ready';
    this.at = null;
    this.issues = [];
    this.overlayDismissed = false;
    this.trayDismissedAt = -1;
    this.html = null;
    var self = this;

    this.renderer = new PreviewRenderer($('frameHost'), {
      onState: function (state) { self._onState(state); },
      onIssues: function (issues) { self.issues = issues; self._renderIssues(); },
      onNotice: function (msg) { self.notice(msg); },
      onShortcut: function (k) { if (self.opts.onShortcut) self.opts.onShortcut(k); }
    });

    document.querySelectorAll('[data-viewport]').forEach(function (b) {
      b.addEventListener('click', function () { self.setViewport(b.dataset.viewport); });
    });
    $('reloadBtn').addEventListener('click', function () { if (self.opts.onRefresh) self.opts.onRefresh(); else self.reload(); });
    $('focusBtn').addEventListener('click', function () {
      var on = this.getAttribute('aria-pressed') !== 'true';
      this.setAttribute('aria-pressed', String(on));
      $('pvCanvas').classList.toggle('is-focus', on);
    });
    $('ctxClear').addEventListener('click', function () { if (self.opts.onContextClear) self.opts.onContextClear(); });
    $('ovDetailsBtn').addEventListener('click', function () {
      var list = $('ovList'), open = list.hidden;
      list.hidden = !open;
      this.setAttribute('aria-expanded', String(open));
      this.textContent = open ? 'Hide error' : 'View error';
    });
    $('ovDismissBtn').addEventListener('click', function () { self.overlayDismissed = true; self._renderIssues(); });
    $('trayToggle').addEventListener('click', function () {
      var list = $('trayList'), open = list.hidden;
      list.hidden = !open;
      this.setAttribute('aria-expanded', String(open));
      this.textContent = open ? 'Hide' : 'Details';
    });
    $('trayClose').addEventListener('click', function () { self.trayDismissedAt = self.issues.length; self._renderIssues(); });
    $('ovText').textContent = this.opts.errorText;
  }

  /** Render HTML. Empty HTML shows the empty state instead of a blank frame. */
  render(html, opts) {
    this.html = html;
    var empty = !html || !html.trim();
    $('pvEmpty').hidden = !empty;
    if (empty) {
      $('pvEmptyTitle').textContent = this.opts.emptyTitle;
      $('pvEmptyText').textContent = this.opts.emptyText;
      $('pvEmptyText').hidden = !this.opts.emptyText;
      this.issues = []; this._renderIssues();
      this.renderer.lastHtml = html;
      if (this.renderer.current) { this.renderer.current.frame.remove(); this.renderer.current = null; }
      this._onState('empty');
      return;
    }
    this.renderer.render(html, opts);
  }
  reload() { if (this.html != null) this.render(this.html); }

  setViewport(v) {
    if (!(v in DEVICES)) v = 'desktop';
    this.viewport = v;
    var w = DEVICES[v], browser = $('browser');
    browser.classList.toggle('is-device', !!w);
    browser.classList.toggle('is-mobile', v === 'mobile');
    browser.style.width = w ? (w + 2) + 'px' : '';
    document.querySelectorAll('[data-viewport]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.viewport === v));
    });
    if (this.opts.onViewport) this.opts.onViewport(v);
  }

  /** pointer: { number, screenName } or null */
  setContext(pointer) {
    var pill = $('ctxPill'), text = $('ctxText');
    pill.classList.toggle('is-plain', !pointer);
    $('ctxClear').hidden = !pointer;
    var n = pointer ? String(pointer.number).padStart(2, '0') : '';
    text.textContent = pointer ? 'Current: ' + ((pointer.screenName || '').trim() || 'Untitled screen') + ' (' + n + ')' : 'Preview';
    pill.title = text.textContent;
  }

  setAddress(path) { $('urlText').textContent = 'localhost:3000/prototype/' + path; }

  notice(msg) {
    var n = $('pvNotice');
    n.textContent = msg; n.hidden = false;
    clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(function () { n.hidden = true; }, 3800);
  }

  refreshStatus() { this._paintStatus(); }

  _onState(state) {
    this.state = state;
    if (state === 'updated' || state === 'ready') this.at = new Date().toISOString();
    if (state === 'updating') {
      this.overlayDismissed = false; this.trayDismissedAt = -1;
      $('ovList').hidden = true; $('ovDetailsBtn').setAttribute('aria-expanded', 'false'); $('ovDetailsBtn').textContent = 'View error';
      $('trayList').hidden = true; $('trayToggle').setAttribute('aria-expanded', 'false'); $('trayToggle').textContent = 'Details';
    }
    if (state !== 'empty') $('pvEmpty').hidden = true;
    this._paintStatus();
    if (this.opts.onState) this.opts.onState(state);
  }

  _paintStatus() {
    var s = this.state, label;
    if (this.opts.statusText) label = this.opts.statusText(s, this.at);
    if (label == null) {
      label = s === 'updating' ? 'Updating…' : s === 'updated' ? 'Preview updated ' + relTime(this.at)
        : s === 'error' ? 'Error' : s === 'empty' ? 'Empty' : 'Ready';
    }
    $('pvStatus').dataset.state = s === 'empty' ? 'ready' : s;
    $('pvStatusText').textContent = label;
  }

  _issueItems(ul, issues) {
    var self = this;
    ul.replaceChildren();
    issues.forEach(function (it) {
      var li = document.createElement('li');
      if (it.kind === 'warning') li.className = 'is-warning';
      var msg = document.createElement('span');
      msg.className = 'msg';
      msg.textContent = it.message;
      if (it.count > 1) { var c = document.createElement('span'); c.className = 'count'; c.textContent = '  ×' + it.count; msg.appendChild(c); }
      li.appendChild(msg);
      if (it.line && self.opts.onGoToLine) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'loc';
        b.textContent = 'Line ' + it.line + (it.col ? ', Col ' + it.col : '');
        b.title = 'Go to this line in the editor';
        b.addEventListener('click', function () { self.opts.onGoToLine(it.line, it.col); });
        li.appendChild(b);
      } else if (it.line) {
        var loc = document.createElement('span');
        loc.className = 'count';
        loc.textContent = 'Line ' + it.line;
        li.appendChild(loc);
      }
      ul.appendChild(li);
    });
  }

  _renderIssues() {
    var issues = this.issues;
    var errors = issues.filter(function (i) { return i.kind === 'error'; });
    var warns = issues.length - errors.length;
    var loadFailed = errors.some(function (i) { return i.phase === 'load'; });
    var showOverlay = loadFailed && !this.overlayDismissed;
    $('pvOverlay').hidden = !showOverlay;
    this._issueItems($('ovList'), issues);
    var showTray = issues.length > 0 && !showOverlay && this.trayDismissedAt !== issues.length;
    $('pvTray').hidden = !showTray;
    $('pvTray').classList.toggle('is-warn-only', errors.length === 0);
    var parts = [];
    if (errors.length) parts.push(errors.length + (errors.length === 1 ? ' error' : ' errors'));
    if (warns) parts.push(warns + (warns === 1 ? ' warning' : ' warnings'));
    $('traySum').textContent = parts.join(', ');
    this._issueItems($('trayList'), issues);
  }
}

export { PreviewRenderer };
