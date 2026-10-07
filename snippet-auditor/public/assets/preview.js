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
   (which keeps error line numbers aligned with the editor).

   It also contains the visual-QA engine. The iframe is sandboxed WITHOUT
   allow-same-origin, so the parent page cannot read the prototype DOM, and the
   prototype cannot read the parent (its token or API). Screen/target detection
   therefore runs here and reports over postMessage, validated by event.source
   and a per-render channel id:
     parent → frame: qa:mode {on}, qa:track {items}, qa:focus {item}
     frame → parent: qa:positions, qa:hover, qa:pick, qa:cancel, qa:focused
   Nothing here edits the prototype's saved HTML. While annotating, a temporary
   cursor style is added and removed again when annotation mode ends. */
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
  var QA_INTERACTIVE = 'button,a[href],input,select,textarea,label,summary,[role="button"],[role="tab"],[role="link"],[role="checkbox"],[role="switch"],[role="radio"],[role="option"],[role="menuitem"]';
  var QA_SEMANTIC_ATTRS = ['data-testid', 'data-test', 'name', 'aria-label', 'for', 'href', 'alt', 'title', 'placeholder'];
  var QA_UNSTABLE_DATA = /^data-(qa-|state|active|selected|open|index|key|reactid|v-|testid|test$)/;
  var QA_UNSTABLE_CLASS = /^(is-|has-|js-|ng-|active$|selected$|open$|hover$|focus|disabled$|checked$|show$|hidden$)|[0-9a-f]{6,}|^css-|^sc-|__[A-Za-z0-9]{5,}$/;
  var qa = { mode: false, hoverEl: null, track: [], raf: 0, last: '', styleEl: null, mut: 0 };
  function qaEsc(s) { s = String(s); return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'); }
  function qaText(n) { return ((n && (n.innerText || n.textContent)) || '').replace(/\s+/g, ' ').trim(); }
  function qaShort(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1).trim() + '…' : s; }
  function qaVisible(n) {
    if (!n || !n.getClientRects || !n.getClientRects().length) return false;
    var cs = getComputedStyle(n);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function qaDocHeight() {
    var d = document.documentElement, b = document.body;
    return Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0, window.innerHeight, 1);
  }
  function qaLastVisible(sel, from) {
    var near = from && from.closest ? from.closest(sel) : null;
    if (near && qaVisible(near)) return near;
    var all = document.querySelectorAll(sel), best = null;
    for (var i = 0; i < all.length; i++) { if (qaVisible(all[i])) best = all[i]; }
    return best;
  }
  function qaScreen(from) {
    var el = qaLastVisible('[data-qa-screen]', from);
    var v = el ? (el.getAttribute('data-qa-screen') || '').trim() : '';
    if (v) return qaShort(v, 150);
    var cur = document.querySelector('[aria-current="step"],[aria-current="page"],[role="tab"][aria-selected="true"]');
    if (cur && qaText(cur)) return qaShort(qaText(cur), 150);
    if (document.title && document.title.trim()) return qaShort(document.title, 150);
    if (location.hash && location.hash.length > 1) { try { return qaShort(decodeURIComponent(location.hash.slice(1)), 150); } catch (e) {} }
    return 'Current screen';
  }
  function qaStateOf(from) {
    var el = qaLastVisible('[data-qa-state]', from);
    var v = el ? (el.getAttribute('data-qa-state') || '').trim() : '';
    return v ? qaShort(v, 100) : 'Default';
  }
  function qaUnique(sel, el) {
    try { var m = document.querySelectorAll(sel); return m.length === 1 && m[0] === el; } catch (e) { return false; }
  }
  function qaPath(el) {
    var parts = [], n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      var base = null;
      if (n !== el) {
        var qid = n.getAttribute('data-qa-id'), sc = n.getAttribute('data-qa-screen');
        if (qid && qaUnique('[data-qa-id="' + qaEsc(qid) + '"]', n)) base = '[data-qa-id="' + qaEsc(qid) + '"]';
        else if (n.id && qaUnique('#' + qaEsc(n.id), n)) base = '#' + qaEsc(n.id);
        else if (sc && qaUnique('[data-qa-screen="' + qaEsc(sc) + '"]', n)) base = '[data-qa-screen="' + qaEsc(sc) + '"]';
      }
      if (base) { parts.unshift(base); break; }
      if (n === document.body) { parts.unshift('body'); break; }
      var seg = n.tagName.toLowerCase(), p = n.parentElement;
      if (p) {
        var same = 0, idx = 0;
        for (var c = p.firstElementChild; c; c = c.nextElementSibling) { if (c.tagName === n.tagName) { same++; if (c === n) idx = same; } }
        if (same > 1) seg += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(seg);
      n = p;
    }
    return parts.join(' > ');
  }
  function qaSelector(el) {
    var tag = el.tagName.toLowerCase(), v, s, i;
    v = el.getAttribute('data-qa-id');
    if (v) { s = '[data-qa-id="' + qaEsc(v) + '"]'; if (qaUnique(s, el)) return { selector: s, quality: 'qa' }; }
    if (el.id && !/\d{4,}/.test(el.id)) { s = '#' + qaEsc(el.id); if (qaUnique(s, el)) return { selector: s, quality: 'id' }; }
    for (i = 0; i < QA_SEMANTIC_ATTRS.length; i++) {
      v = el.getAttribute(QA_SEMANTIC_ATTRS[i]);
      if (v && v.length <= 80) { s = tag + '[' + QA_SEMANTIC_ATTRS[i] + '="' + qaEsc(v) + '"]'; if (qaUnique(s, el)) return { selector: s, quality: 'attr' }; }
    }
    for (i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') === 0 && !QA_UNSTABLE_DATA.test(a.name) && a.value && a.value.length <= 60) {
        s = tag + '[' + a.name + '="' + qaEsc(a.value) + '"]';
        if (qaUnique(s, el)) return { selector: s, quality: 'attr' };
      }
    }
    var cls = [];
    for (i = 0; i < el.classList.length; i++) { if (!QA_UNSTABLE_CLASS.test(el.classList[i])) cls.push(el.classList[i]); }
    for (i = 0; i < cls.length; i++) { s = tag + '.' + qaEsc(cls[i]); if (qaUnique(s, el)) return { selector: s, quality: 'class' }; }
    if (cls.length > 1) { s = tag + '.' + cls.map(qaEsc).join('.'); if (qaUnique(s, el)) return { selector: s, quality: 'class' }; }
    return { selector: qaPath(el), quality: 'path' };
  }
  function qaContext(el) {
    var n = el.parentElement;
    for (var d = 0; n && d < 4 && n !== document.body; d++, n = n.parentElement) {
      var l = n.getAttribute('data-qa-label');
      if (l && l.trim()) return qaShort(l, 40);
      var h = n.querySelector('h1,h2,h3,h4,h5,h6,strong,b,legend');
      if (h && !h.contains(el) && !el.contains(h) && qaText(h)) return qaShort(qaText(h), 40);
    }
    return '';
  }
  function qaWithContext(text, kind, el) {
    if (text.split(' ').length > 2) return text + ' ' + kind;
    var ctx = qaContext(el);
    return ctx && text.toLowerCase().indexOf(ctx.toLowerCase()) < 0 ? text + ' ' + kind + ' (' + ctx + ')' : text + ' ' + kind;
  }
  function qaLabel(el) {
    var tag = el.tagName.toLowerCase(), role = el.getAttribute('role') || '', v, t;
    v = el.getAttribute('aria-label'); if (v && v.trim()) return qaShort(v, 80);
    v = el.getAttribute('data-qa-label'); if (v && v.trim()) return qaShort(v, 80);
    if (tag === 'button' || role === 'button' || (tag === 'input' && /^(submit|button|reset)$/i.test(el.type))) {
      t = qaText(el) || el.value || '';
      t = t.replace(/[\u2190-\u21FF›»✓]+/g, '').trim();
      if (t) return qaWithContext(qaShort(t, 50), 'button', el);
    }
    if (tag === 'a') { t = qaText(el); if (t) return qaWithContext(qaShort(t, 50), 'link', el); }
    if (/^(input|select|textarea)$/.test(tag) || role === 'switch' || role === 'checkbox') {
      var kind = tag === 'select' ? 'selector' : role === 'switch' ? 'toggle' : el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'option' : 'field';
      var lab = el.id ? document.querySelector('label[for="' + qaEsc(el.id) + '"]') : null;
      if (!lab && el.closest) lab = el.closest('label');
      var lt = lab ? (qaText(lab.querySelector('strong,b,h1,h2,h3,h4,h5,h6')) || qaText(lab)) : '';
      if (!lt) { var row = el.parentElement && el.parentElement.querySelector('h1,h2,h3,h4,h5,h6,legend,strong'); lt = row ? qaText(row) : ''; }
      if (lt) return qaShort(lt, 50) + ' ' + kind;
      if (el.placeholder) return qaShort(el.placeholder, 50) + ' ' + kind;
      return kind === 'field' ? 'Input field' : kind.charAt(0).toUpperCase() + kind.slice(1);
    }
    v = el.getAttribute('title'); if (v && v.trim()) return qaShort(v, 80);
    v = el.getAttribute('alt'); if (v && v.trim()) return qaShort(v, 60) + ' image';
    if (/^h[1-6]$/.test(tag)) { t = qaText(el); return t ? 'Heading: ' + qaShort(t, 50) : 'Heading'; }
    var head = el.querySelector && el.querySelector('h1,h2,h3,h4,h5,h6,strong,b,legend');
    if (head && qaText(head)) return qaShort(qaText(head), 50);
    t = qaText(el);
    if (t) return qaShort(t, 50);
    var names = { img: 'Image', svg: 'Icon', nav: 'Navigation', header: 'Header', footer: 'Footer', section: 'Section', form: 'Form', ul: 'List', ol: 'List', li: 'List item', table: 'Table', p: 'Paragraph', video: 'Video', canvas: 'Canvas' };
    return names[tag] || 'Selected area';
  }
  function qaCandidate(t) {
    if (t && t.nodeType !== 1) t = t.parentElement;
    if (!t || !t.closest) return document.body;
    var svg = t.closest('svg');
    if (svg && svg.parentElement) t = svg;
    for (var n = t; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.hasAttribute('data-qa-id') || n.matches(QA_INTERACTIVE)) return n;
    }
    return t;
  }
  function qaIsScreen(el) {
    if (!el || el === document.body || el === document.documentElement) return true;
    if (el.tagName.toLowerCase() === 'main' || el.hasAttribute('data-qa-screen')) return true;
    if (el.hasAttribute('data-qa-id') || el.matches(QA_INTERACTIVE)) return false;
    var r = el.getBoundingClientRect();
    return r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.6;
  }
  function qaRect(el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  function qaPoint(item, screen) {
    var vw = window.innerWidth, docH = qaDocHeight();
    var hasAnchor = typeof item.anchorX === 'number' && typeof item.anchorY === 'number';
    var onScreen = !item.screenName || item.screenName === screen;
    if (item.targetType === 'element' && item.targetSelector) {
      var el = null;
      try { el = document.querySelector(item.targetSelector); } catch (e) { el = null; }
      if (el) {
        if (!qaVisible(el)) return { key: item.key, status: 'hidden' };
        var r = el.getBoundingClientRect();
        var y = r.top < 0 && r.bottom > 0 ? 4 : r.top;
        return { key: item.key, status: 'found', x: r.right, y: y, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
      }
      if (!onScreen) return { key: item.key, status: 'elsewhere' };
      if (!hasAnchor) return { key: item.key, status: 'missing' };
      return { key: item.key, status: 'missing', x: item.anchorX * vw, y: item.anchorY * docH - window.scrollY };
    }
    if (!hasAnchor) return { key: item.key, status: onScreen ? 'none' : 'elsewhere' };
    if (!onScreen) return { key: item.key, status: 'elsewhere' };
    return { key: item.key, status: 'anchor', x: item.anchorX * vw, y: item.anchorY * docH - window.scrollY };
  }
  function qaReport() {
    qa.raf = 0;
    var screen = qaScreen(null), state = qaStateOf(null);
    var items = qa.track.map(function (t) { return qaPoint(t, screen); });
    var msg = { screen: screen, state: state, vw: window.innerWidth, vh: window.innerHeight, items: items };
    var sig = JSON.stringify(msg);
    if (sig !== qa.last) { qa.last = sig; send('qa:positions', msg); }
    if (qa.mode && qa.hoverEl) qaHover(qa.hoverEl);
  }
  function qaSchedule() { if (!qa.raf) qa.raf = requestAnimationFrame(qaReport); }
  function qaHover(el) {
    if (!el) { send('qa:hover', null); return; }
    if (qaIsScreen(el)) { send('qa:hover', { type: 'screen', label: 'Entire screen: ' + qaScreen(el), rect: null }); return; }
    send('qa:hover', { type: 'element', label: qaLabel(el), rect: qaRect(el) });
  }
  function qaSetMode(on) {
    qa.mode = !!on;
    if (qa.mode) {
      if (!qa.styleEl) { qa.styleEl = document.createElement('style'); qa.styleEl.textContent = '*,*::before,*::after{cursor:crosshair !important;}'; }
      (document.head || document.documentElement).appendChild(qa.styleEl);
    } else {
      if (qa.styleEl && qa.styleEl.parentNode) qa.styleEl.parentNode.removeChild(qa.styleEl);
      qa.hoverEl = null;
      send('qa:hover', null);
    }
  }
  function qaPick(e) {
    var el = qaCandidate(e.target), vw = window.innerWidth, vh = window.innerHeight, docH = qaDocHeight();
    var out = {
      screenName: qaScreen(el), screenState: qaStateOf(el),
      targetType: 'screen', targetSelector: null, targetLabel: 'Entire screen',
      anchorX: Math.min(1, Math.max(0, e.clientX / vw)),
      anchorY: Math.min(1, Math.max(0, (e.clientY + window.scrollY) / docH)),
      viewportWidth: vw, viewportHeight: vh
    };
    if (!qaIsScreen(el)) {
      var sel = qaSelector(el);
      if (sel.quality === 'path' && !el.matches(QA_INTERACTIVE) && !qaText(el)) {
        out.targetType = 'area'; out.targetLabel = 'Selected area';
      } else {
        out.targetType = 'element'; out.targetSelector = sel.selector; out.targetLabel = qaLabel(el);
      }
    }
    qaSetMode(false);
    send('qa:pick', out);
    qaSchedule();
  }
  function qaFocus(item) {
    var smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var screen = qaScreen(null);
    if (item.targetType === 'element' && item.targetSelector) {
      var el = null;
      try { el = document.querySelector(item.targetSelector); } catch (e) { el = null; }
      if (el && qaVisible(el)) { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: smooth ? 'smooth' : 'auto' }); return 'found'; }
      if (el) return 'hidden';
    }
    if (item.screenName && item.screenName !== screen) return 'elsewhere';
    if (typeof item.anchorY === 'number') {
      window.scrollTo({ top: Math.max(0, item.anchorY * qaDocHeight() - window.innerHeight / 2), behavior: smooth ? 'smooth' : 'auto' });
      return item.targetType === 'element' ? 'missing' : 'anchor';
    }
    return 'none';
  }
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'contextmenu', 'auxclick'].forEach(function (type) {
    window.addEventListener(type, function (e) { if (qa.mode) { e.preventDefault(); e.stopImmediatePropagation(); } }, { capture: true, passive: false });
  });
  window.addEventListener('click', function (e) {
    if (!qa.mode) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    qaPick(e);
  }, true);
  window.addEventListener('mousemove', function (e) {
    if (!qa.mode) return;
    var el = qaCandidate(e.target);
    if (el !== qa.hoverEl) { qa.hoverEl = el; qaHover(el); }
  }, true);
  document.addEventListener('mouseleave', function () { if (qa.mode) { qa.hoverEl = null; send('qa:hover', null); } });
  window.addEventListener('keydown', function (e) {
    if (qa.mode && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); qaSetMode(false); send('qa:cancel', {}); }
  }, true);
  window.addEventListener('scroll', qaSchedule, { passive: true, capture: true });
  window.addEventListener('resize', qaSchedule);
  window.addEventListener('transitionend', qaSchedule, true);
  window.addEventListener('animationend', qaSchedule, true);
  if (window.MutationObserver) {
    new MutationObserver(function () { clearTimeout(qa.mut); qa.mut = setTimeout(qaSchedule, 80); })
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  window.addEventListener('load', qaSchedule);
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || d.__sa !== token || d.dir !== 'down') return;
    var data = d.data || {};
    if (d.type === 'qa:mode') { qaSetMode(!!data.on); }
    else if (d.type === 'qa:track') { qa.track = Array.isArray(data.items) ? data.items.slice(0, 500) : []; qa.last = ''; qaSchedule(); }
    else if (d.type === 'qa:focus') { var st = qaFocus(data); send('qa:focused', { key: data.key, status: st, screen: qaScreen(null) }); qa.last = ''; qaSchedule(); }
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
/** Send a message to the live preview frame (opaque origin, so '*' is required;
    the frame only accepts messages from its parent carrying its own channel id). */
PreviewRenderer.prototype.post = function (type, data) {
  var p = this.current;
  if (!p || !p.frame.contentWindow) return false;
  p.frame.contentWindow.postMessage({ __sa: p.token, dir: 'down', type: type, data: data }, '*');
  return true;
};
PreviewRenderer.prototype.reload = function () { if (this.lastHtml != null) this.render(this.lastHtml); };
PreviewRenderer.prototype._finish = function (p) {
  if (p.loaded || this.pending !== p) return;
  p.loaded = true;
  if (this.current && this.current.frame !== p.frame) this.current.frame.remove();
  this.current = p; this.pending = null;
  p.frame.classList.remove('is-loading');
  if (this.h.onLoaded) this.h.onLoaded();
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
    default:
      if (/^qa:/.test(d.type) && p === this.current && this.h.onQa) this.h.onQa(d.type, d.data);
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
      onQa: function (type, data) { if (self.opts.onQa) self.opts.onQa(type, data); },
      onLoaded: function () { if (self.opts.onLoaded) self.opts.onLoaded(); },
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
      if (this.opts.onLoaded) this.opts.onLoaded();
      return;
    }
    this.renderer.render(html, opts);
  }
  reload() { if (this.html != null) this.render(this.html); }
  post(type, data) { return this.renderer.post(type, data); }
  get live() { return !!this.renderer.current; }

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

  /**
   * Header context. screen: detected current screen of the prototype.
   * selected: { number } of the selected note, or null. count: notes on this screen.
   */
  setContext({ screen, selected, count } = {}) {
    const pill = $('ctxPill'), text = $('ctxText');
    pill.classList.toggle('is-plain', !screen);
    text.textContent = screen ? 'Current: ' + screen : 'Preview';
    pill.title = text.textContent;
    const meta = $('ctxMeta');
    if (meta) {
      meta.hidden = !selected && !count;
      $('ctxMetaText').textContent = selected
        ? 'Selected: ' + String(selected.number).padStart(2, '0')
        : count + (count === 1 ? ' note here' : ' notes here');
      $('ctxClear').hidden = !selected;
    }
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
