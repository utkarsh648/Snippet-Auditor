// Lightweight HTML code editor: a textarea for input, caret, selection and undo,
// layered over a syntax-highlighted <pre>. No build step, no dependencies.

var LH = 22, PAD = 14;

/* =========================================================
   Syntax highlighting (HTML with embedded CSS + JS)
   ========================================================= */
var Highlight = (function () {
  function esc(s) { return s.replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); }
  function sp(c, s) { return s ? '<span class="t-' + c + '">' + esc(s) + '</span>' : ''; }
  var JS_KW = {}; 'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await'.split(' ').forEach(function (k) { JS_KW[k] = 1; });
  var JS_LIT = { 'true': 1, 'false': 1, 'null': 1, 'undefined': 1, 'NaN': 1, 'Infinity': 1 };
  var COMMENT_OPEN = '<!' + '--', COMMENT_CLOSE = '--' + '>';

  function js(src) {
    var re = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|`(?:\\[\s\S]|[^`\\])*`?|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_$][\w$]*|\s+|[\s\S]/y;
    var out = '', m;
    re.lastIndex = 0;
    while (re.lastIndex < src.length && (m = re.exec(src))) {
      var t = m[0], c = t.charAt(0);
      if (c === '/' && (t.charAt(1) === '/' || t.charAt(1) === '*')) out += sp('com', t);
      else if (c === '"' || c === "'" || c === '`') out += sp('str', t);
      else if (c >= '0' && c <= '9') out += sp('num', t);
      else if (/[A-Za-z_$]/.test(c)) {
        if (JS_KW[t]) out += sp('kw', t);
        else if (JS_LIT[t]) out += sp('num', t);
        else if (/^\s*\(/.test(src.slice(re.lastIndex, re.lastIndex + 24))) out += sp('fn', t);
        else out += esc(t);
      } else out += esc(t);
    }
    return out;
  }

  function css(src) {
    var re = /\/\*[\s\S]*?(?:\*\/|$)|"[^"\n]*"?|'[^'\n]*'?|[{}:;,()]|#[\w-]+|-?\d*\.?\d+[a-zA-Z%]*|@?[\w-]+|\s+|[\s\S]/y;
    var out = '', m, depth = 0, val = false;
    re.lastIndex = 0;
    while (re.lastIndex < src.length && (m = re.exec(src))) {
      var t = m[0], c = t.charAt(0);
      if (t.slice(0, 2) === '/*') out += sp('com', t);
      else if (c === '"' || c === "'") out += sp('str', t);
      else if (t === '{') { depth++; val = false; out += sp('punc', t); }
      else if (t === '}') { depth = Math.max(0, depth - 1); val = false; out += sp('punc', t); }
      else if (t === ':') { if (depth > 0 && !val) { val = true; out += sp('punc', t); } else out += sp('sel', t); }
      else if (t === ';') { val = false; out += sp('punc', t); }
      else if (c === '#') out += sp(depth > 0 && val ? 'num' : 'sel', t);
      else if (c === '@') out += sp('kw', t);
      else if (/^-?\.?\d/.test(t)) out += sp(depth > 0 && val ? 'num' : 'sel', t);
      else if (/^[\w-]/.test(t)) out += sp(depth === 0 ? 'sel' : (val ? 'val' : 'prop'), t);
      else if (/^\s+$/.test(t)) out += t;
      else out += depth === 0 ? sp('sel', t) : esc(t);
    }
    return out;
  }

  function html(src) {
    var out = '', i = 0, n = src.length, lower = src.toLowerCase();
    var tagRe = /<(\/?)([!A-Za-z][\w:-]*)/y;
    var attrRe = /(\s+)|(\/?>)|([^\s=\/>"']+)|(=)(\s*)("[^"]*"?|'[^']*'?|[^\s>"']+)?|([\s\S])/y;
    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) { out += esc(src.slice(i)); break; }
      if (lt > i) { out += esc(src.slice(i, lt)); i = lt; }
      if (src.startsWith(COMMENT_OPEN, i)) {
        var ce = src.indexOf(COMMENT_CLOSE, i + 4); ce = ce < 0 ? n : ce + 3;
        out += sp('com', src.slice(i, ce)); i = ce; continue;
      }
      tagRe.lastIndex = i;
      var m = tagRe.exec(src);
      if (!m) { out += '&lt;'; i++; continue; }
      var name = m[2], closing = m[1] === '/', isDoc = name.charAt(0) === '!';
      out += sp('punc', '<' + m[1]) + sp(isDoc ? 'doc' : 'tag', name);
      i = tagRe.lastIndex;
      var ended = false;
      while (i < n) {
        attrRe.lastIndex = i;
        var a = attrRe.exec(src);
        if (!a) break;
        i = attrRe.lastIndex;
        if (a[1]) out += a[1];
        else if (a[2]) { out += sp('punc', a[2]); ended = true; break; }
        else if (a[3]) out += sp(isDoc ? 'doc' : 'attr', a[3]);
        else if (a[4]) out += sp('punc', '=') + (a[5] || '') + sp('str', a[6] || '');
        else out += esc(a[7]);
      }
      var lname = name.toLowerCase();
      if (ended && !closing && (lname === 'style' || lname === 'script')) {
        var e = lower.indexOf('</' + lname, i); if (e < 0) e = n;
        var body = src.slice(i, e);
        out += lname === 'style' ? css(body) : js(body);
        i = e;
      }
    }
    return out;
  }
  return { html: html };
})();

/* =========================================================
   HtmlEditor — lightweight code editor
   (textarea for input/caret/selection/undo, highlighted <pre> beneath)
   ========================================================= */
var VOID_TAGS = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };

function HtmlEditor(root, handlers) {
  this.h = handlers || {};
  this.ta = root.querySelector('textarea');
  this.code = root.querySelector('#highlight');
  this.pre = this.code.parentNode;
  this.gutter = root.querySelector('#gutter');
  this.active = root.querySelector('#activeLine');
  this.lineCount = 0; this.line = 1; this.escaped = false; this._raf = 0;
  var self = this;
  this.ta.addEventListener('input', function () {
    if (self.h.onChange) self.h.onChange(self.ta.value);
    self._schedule();
  });
  this.ta.addEventListener('scroll', function () { self._sync(); }, { passive: true });
  this.ta.addEventListener('keydown', function (e) { self._onKey(e); });
  this.ta.addEventListener('focus', function () { self.escaped = false; });
  ['click', 'keyup', 'select', 'focus'].forEach(function (ev) { self.ta.addEventListener(ev, function () { self._cursor(); }); });
  document.addEventListener('selectionchange', function () { if (document.activeElement === self.ta) self._cursor(); });
}
HtmlEditor.prototype.getValue = function () { return this.ta.value; };
HtmlEditor.prototype.setValue = function (v) {
  this.ta.value = v;
  this.ta.setSelectionRange(0, 0);
  this.ta.scrollTop = 0; this.ta.scrollLeft = 0;
  this._render();
};
HtmlEditor.prototype._schedule = function () {
  var self = this;
  if (this._raf) return;
  this._raf = requestAnimationFrame(function () { self._raf = 0; self._render(); });
};
HtmlEditor.prototype._render = function () {
  var v = this.ta.value;
  this.code.innerHTML = Highlight.html(v) + '\n';
  var count = v.split('\n').length;
  if (count !== this.lineCount) {
    var parts = new Array(count);
    for (var i = 0; i < count; i++) parts[i] = '<div>' + (i + 1) + '</div>';
    this.gutter.innerHTML = parts.join('');
    this.lineCount = count;
    this._markLine(true);
  }
  this._cursor();
};
HtmlEditor.prototype._markLine = function (force) {
  var kids = this.gutter.children;
  if (this._onEl) this._onEl.classList.remove('on');
  this._onEl = kids[this.line - 1] || null;
  if (this._onEl) this._onEl.classList.add('on');
};
HtmlEditor.prototype._cursor = function () {
  var v = this.ta.value, s = this.ta.selectionStart;
  var before = v.slice(0, s);
  var line = 1, idx = -1;
  while ((idx = before.indexOf('\n', idx + 1)) !== -1) line++;
  var col = s - before.lastIndexOf('\n');
  if (line !== this.line) { this.line = line; this._markLine(); }
  this._sync();
  if (this.h.onCursor) this.h.onCursor(line, col);
};
HtmlEditor.prototype._sync = function () {
  var t = this.ta.scrollTop, l = this.ta.scrollLeft;
  this.pre.style.transform = 'translate(' + (-l) + 'px,' + (-t) + 'px)';
  this.gutter.style.transform = 'translateY(' + (-t) + 'px)';
  this.active.style.transform = 'translateY(' + (PAD + (this.line - 1) * LH - t) + 'px)';
};
HtmlEditor.prototype._insert = function (text) {
  var ok = false;
  try { ok = document.execCommand(text === '' ? 'delete' : 'insertText', false, text); } catch (e) { ok = false; }
  if (!ok) {
    this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
    this.ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
};
HtmlEditor.prototype._indent = function (outdent) {
  var ta = this.ta, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
  var ls = v.lastIndexOf('\n', s - 1) + 1;
  var le = (e > s && v.charAt(e - 1) === '\n') ? e - 1 : e;
  var leEnd = v.indexOf('\n', le); if (leEnd < 0) leEnd = v.length;
  var lines = v.slice(ls, leEnd).split('\n');
  var first = 0, total = 0;
  var next = lines.map(function (ln, i) {
    if (outdent) {
      var m = ln.match(/^( {1,2}|\t)/), r = m ? m[0].length : 0;
      if (i === 0) first = -r; total -= r; return ln.slice(r);
    }
    if (i === 0) first = 2; total += 2; return '  ' + ln;
  }).join('\n');
  if (total === 0) return;
  ta.setSelectionRange(ls, leEnd);
  this._insert(next);
  ta.setSelectionRange(Math.max(ls, s + first), Math.max(ls, e + total));
};
HtmlEditor.prototype._onKey = function (e) {
  var ta = this.ta;
  if (e.key === 'Escape') { this.escaped = true; return; }
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (this.escaped) return; // allow keyboard users to leave the editor
    e.preventDefault();
    var v0 = ta.value, s0 = ta.selectionStart, e0 = ta.selectionEnd;
    if (s0 !== e0 && v0.slice(s0, e0).indexOf('\n') !== -1) this._indent(e.shiftKey);
    else if (e.shiftKey) this._indent(true);
    else this._insert('  ');
    return;
  }
  this.escaped = false;
  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    var v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    var ls = v.lastIndexOf('\n', s - 1) + 1;
    var lineBefore = v.slice(ls, s);
    var indent = (lineBefore.match(/^[ \t]*/) || [''])[0];
    var prev = v.charAt(s - 1), after = v.slice(en, en + 2);
    var openTag = /<([A-Za-z][\w-]*)(?:\s[^<>]*)?>$/.exec(lineBefore);
    var opensBlock = (openTag && !VOID_TAGS[openTag[1].toLowerCase()] && !/\/>$/.test(lineBefore)) || prev === '{' || prev === '(' || prev === '[';
    var closesNext = (after === '</' && openTag) || (prev === '{' && after.charAt(0) === '}') || (prev === '(' && after.charAt(0) === ')') || (prev === '[' && after.charAt(0) === ']');
    if (opensBlock && closesNext) {
      this._insert('\n' + indent + '  \n' + indent);
      var pos = s + 1 + indent.length + 2;
      ta.setSelectionRange(pos, pos);
    } else if (opensBlock) {
      this._insert('\n' + indent + '  ');
    } else {
      this._insert('\n' + indent);
    }
    this._cursor();
  }
};
HtmlEditor.prototype.goTo = function (line, col) {
  var v = this.ta.value, idx = 0;
  for (var l = 1; l < line; l++) {
    var nx = v.indexOf('\n', idx);
    if (nx === -1) { idx = v.length; break; }
    idx = nx + 1;
  }
  var lineEnd = v.indexOf('\n', idx); if (lineEnd < 0) lineEnd = v.length;
  idx = Math.min(lineEnd, idx + Math.max(0, (col || 1) - 1));
  this.ta.focus();
  this.ta.setSelectionRange(idx, idx);
  this.ta.scrollTop = Math.max(0, (line - 1) * LH - this.ta.clientHeight / 3);
  this._cursor();
};


export { Highlight, HtmlEditor };
