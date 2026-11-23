// Fast drop-in for makefun-site 1.0.0.
// My own implementation of makefun-site's spec (README.md + reference code): same front matter,
// template dialect, Markdown subset, slug rule and report, byte for byte. Optimisations: templates
// compiled to JS functions (with an interpreter fallback), prototype-chain scopes, cached + ASCII
// fast-path slugify, bulk inline Markdown, hand-rolled line classification and front-matter parsing.
// No state is kept from one case to the next: every cache is created fresh inside run().

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const INCLUDE_DEPTH = 8;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ANY = /[&<>"']/;
const ESC_ANY_G = /[&<>"']/g;

/** Regex replace wins in the real metric: the manual scan built rope strings whose flattening is charged at stringify. */
function escapeHtml(s) {
  return ESC_ANY.test(s) ? s.replace(ESC_ANY_G, (c) => ESCAPES[c]) : s;
}

let slugCache;
const NON_ASCII = /[^\x00-\x7F]/;
const MARK_RE = /\p{M}/gu;

function slugify(text) {
  let out = slugCache.get(text);
  if (out !== undefined) return out;
  out = slugifySlow(text);
  slugCache.set(text, out);
  return out;
}

function slugifySlow(text) {
  if (!NON_ASCII.test(text)) {
    // ASCII: NFKD is the identity and there are no combining marks.
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, 64);
    let end = out.length;
    while (end > 0 && out[end - 1] === '-') end--;
    out = out.slice(0, end);
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

let dateCache;
function longDate(date) {
  let out = dateCache.get(date);
  if (out === undefined) {
    const parts = date.split('-');
    out = `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
    dateCache.set(date, out);
  }
  return out;
}

/** Word count: runs of non-whitespace, exactly /\S+/g. Lookup-table whitespace test beats the inline predicate. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        if (i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        const n = raw[i + 1];
        if (n !== '"' && n !== '\\') return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93)
        return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k];
        if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  // Exactly line.trim() === '' (all JS whitespace), without allocating.
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    const ws =
      c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
      c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (!ws) return false;
  }
  return true;
}

function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing line '---' by scanning lines.
  let pos = text === '---' ? 3 : 4; // just past the opening line (and its \n)
  let closeLine = -1; // 1-based line number of the closing '---'
  let lineNo = 2; // the first front-matter line is line 2
  let scan = pos;
  while (scan <= text.length) {
    const nl = text.indexOf('\n', scan);
    const end = nl === -1 ? text.length : nl;
    if (end - scan === 3 && text[scan] === '-' && text[scan + 1] === '-' && text[scan + 2] === '-') {
      closeLine = lineNo;
      break;
    }
    if (nl === -1) break;
    scan = nl + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Re-scan the front-matter lines (between pos and the closing line) to parse them.
  let p = pos;
  let ln = 2;
  while (ln < closeLine) {
    const nl = text.indexOf('\n', p);
    const line = text.slice(p, nl);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      // '#' comment
      // key: value — key is [a-z_]+, then ':', then end or ' ' + rest
      let j = 0;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if ((c >= 97 && c <= 122) || c === 95) j++;
        else break;
      }
      if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${ln} is not "key: value"` }; // ':'
      const key = line.slice(0, j);
      let raw;
      if (j + 1 === line.length) raw = '';
      else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
      else return { error: `line ${ln} is not "key: value"` };
      // drop trailing spaces and tabs
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c === 32 || c === 9) e--;
        else break;
      }
      raw = raw.slice(0, e);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = nl + 1;
    ln++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  // Body: everything after the closing line's newline.
  const closeStart = p; // start of the closing line
  const closeNl = text.indexOf('\n', closeStart);
  const body = closeNl === -1 ? '' : text.slice(closeNl + 1);
  return { data, body };
}

// ---------------------------------------------------------------- markdown

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return line.slice(a, b);
}

function restIsBlank(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Fence opener: ``` + lang [A-Za-z0-9_+-]* + spaces/tabs only. Returns lang or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 95 || c === 43 || c === 45
    )
      i++;
    else break;
  }
  if (!restIsBlank(line, i)) return null;
  return line.slice(3, i);
}

function isFenceClose(line) {
  return (
    line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && restIsBlank(line, 3)
  );
}

/** Heading: 1-6 '#' + space/tab + non-empty text. Returns {depth, text} or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length) {
    const d = line.charCodeAt(a);
    if (d === 32 || d === 9) a++;
    else break;
  }
  if (a >= line.length) return null;
  const text = trimLine(line.slice(a));
  if (text === '') return null;
  return { depth: n, text };
}

function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false; // '-' or '*'
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  return restIsBlank(line, 3);
}

/** Bullet: '- ' or '* '. Returns the item text or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** Ordered: 1-9 digits + '. '. Returns {start, text} or null. */
function orderedOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) >= 48 && line.charCodeAt(n) <= 57) n++;
  if (n === 0 || n > 9) return null;
  if (line.charCodeAt(n) !== 46 || line.charCodeAt(n + 1) !== 32) return null; // '.' ' '
  return { start: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

const CONTINUED_RE = /^ {2,}\S/;

function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < L && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      i++;
      continue;
    }
    if (isHr(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      // '>'
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < L) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      tokens.push({
        type: 'list',
        ordered: isOrdered,
        start: isOrdered ? ordered.start : 1,
        items: items.map((parts) => parts.join('\n')),
      });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;
const WS_RE = /\s/;

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  INLINE_SPECIAL.lastIndex = 0;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) {
      out += s.slice(i);
      break;
    }
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s[j];
    if (c === '&') {
      out += '&amp;';
      i = j + 1;
    } else if (c === '<') {
      out += '&lt;';
      i = j + 1;
    } else if (c === '>') {
      out += '&gt;';
      i = j + 1;
    } else if (c === '"') {
      out += '&quot;';
      i = j + 1;
    } else if (c === "'") {
      out += '&#39;';
      i = j + 1;
    } else if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        out += s[j + 1] === '>' ? '&gt;' : s[j + 1];
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
        i = m2 + 1;
      } else {
        out += '[';
        i = j + 1;
      }
    } else {
      out += c;
      i = j + 1;
    }
  }
  return out;
}

function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        let inner = '';
        for (let k = 0; k < t.lines.length; k++) inner += `${escapeHtml(t.lines[k])}\n`;
        if (inner === '') inner = '\n';
        blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(
          t.lines.length === 0
            ? '<blockquote>\n</blockquote>'
            : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`,
        );
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        let inner = '';
        for (let k = 0; k < t.items.length; k++) inner += `<li>${inline(t.items[k], env)}</li>\n`;
        blocks.push(`${open}\n${inner}</${tag}>`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  let html = '';
  for (let k = 0; k < blocks.length; k++) html += `${blocks[k]}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** textOf + escapeHtml in one call, for {{ }} nodes (numbers/booleans never need escaping). */
function ev(v) {
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtml(v.map(textOf).join(', '));
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Interpreter fallback (same semantics as the reference renderer). */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += ctx.escape(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        });
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// --- template compilation ---
//
// A compiled template is a function (S, T, D, Es, Tx, Ty) => string. S is a scope object whose
// prototype chain is the scope chain (base scope is null-prototype). T is the Map of compiled
// templates. Es/Tx/Ty are escapeHtml/textOf/truthy. Lookup code is generated inline: the first
// segment reads S.name (prototype chain), later segments walk own data properties.

function lookupCode(path, tmp) {
  let code = `S.${path[0]}`;
  for (let k = 1; k < path.length; k++) {
    code = `(${code}!=null&&typeof ${code}==='object'?${code}.${path[k]}:undefined)`;
  }
  return code;
}

function compileNodes(nodes, src, tmp) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      src.push(`o.push(${JSON.stringify(n.text)});`);
    } else if (n.kind === 'var') {
      src.push(`o.push(Ev(${lookupCode(n.path, tmp)}));`);
    } else if (n.kind === 'raw') {
      src.push(`o.push(Tx(${lookupCode(n.path, tmp)}));`);
    } else if (n.kind === 'if') {
      src.push(`if(Ty(${lookupCode(n.path, tmp)})!==${n.not}){`);
      compileNodes(n.then, src, tmp);
      if (n.else !== null) {
        src.push('}else{');
        compileNodes(n.else, src, tmp);
      }
      src.push('}');
    } else if (n.kind === 'for') {
      const id = tmp.n++;
      src.push(`{const _x${id}=${lookupCode(n.path, tmp)};if(Array.isArray(_x${id})){const _s${id}=Object.create(S);const _l${id}={index:0,first:false,last:false,length:_x${id}.length};for(let _k${id}=0;_k${id}<_x${id}.length;_k${id}++){_s${id}[${JSON.stringify(n.name)}]=_x${id}[_k${id}];_s${id}.loop=_l${id};_l${id}.index=_k${id}+1;_l${id}.first=_k${id}===0;_l${id}.last=_k${id}===_x${id}.length-1;const _pS${id}=S;S=_s${id};`);
      compileNodes(n.body, src, tmp);
      src.push(`S=_pS${id};}}}`);
    } else if (n.kind === 'include') {
      src.push(`{const _t=T.get(${JSON.stringify(n.name)});if(_t!==undefined&&D<${INCLUDE_DEPTH})o.push(_t(S,T,D+1,Ev,Tx,Ty));}`);
    }
  }
}

function compileTemplate(nodes) {
  const src = ['let o=[];'];
  compileNodes(nodes, src, { n: 0 });
  src.push('return o.join("");');
  return new Function('S', 'T', 'D', 'Ev', 'Tx', 'Ty', src.join('\n'));
}

// ---------------------------------------------------------------- build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  slugCache = new Map();
  dateCache = new Map();

  const templates = new Map(); // name -> compiled fn (or AST for fallback)
  const templateAsts = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      const ast = parseTemplate(name, input.templates[name]);
      templateAsts.set(name, ast);
      try {
        templates.set(name, compileTemplate(ast));
      } catch {
        templates.set(name, null); // compiled failed: interpreter fallback
      }
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const b = {
    input,
    base,
    templates,
    templateAsts,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. sources, sorted by path; .md sources have \r\n / \r made \n
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      b.sources.push({ path: f.path, text });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. permalinks
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. markdown + link resolution
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const cardOf = (s) => {
    const tagList = s.tagRefs;
    const tags = new Array(tagList.length);
    for (let k = 0; k < tagList.length; k++) {
      const t = tagList[k];
      tags[k] = { name: t.name, slug: t.slug, url: t.url };
    }
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags,
    };
  };
  for (const p of b.posts) b.cards.set(p, cardOf(p));
  const pageOf = (s) => {
    // Posts already have a card (for index/tag pages): reuse it instead of rebuilding
    // (word count + tag list) a second time.
    const base = s.post ? b.cards.get(s) : cardOf(s);
    const c = { ...base };
    c.slug = s.slug;
    c.content = s.html;
    c.toc = s.toc; // same {level, id, html} entries; templates only read them
    c.newer = linkOf(s.newer ?? null);
    c.older = linkOf(s.older ?? null);
    c.is_post = s.post;
    return c;
  };
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const baseScope = Object.create(null);
  baseScope.site = site;
  baseScope.tags = allTags;
  baseScope.recent = recent;
  // If any template failed to compile, use the interpreter for every render (correctness first).
  const anyNull = [...b.templates.values()].some((v) => v === null);
  const ctx = { templates: b.templateAsts, escape: escapeHtml };
  const render = (name, vars) => {
    const fn = b.templates.get(name);
    if (fn === undefined) return null;
    if (!anyNull) {
      const S = Object.create(baseScope);
      Object.assign(S, vars);
      return fn(S, b.templates, 0, ev, textOf, truthy);
    }
    // Interpreter fallback: rebuild the chain scope (vars + site/tags/recent).
    const chain = { vars: Object.create(null), parent: null };
    Object.assign(chain.vars, vars);
    chain.vars.site = site;
    chain.vars.tags = allTags;
    chain.vars.recent = recent;
    return renderNodes(b.templateAsts.get(name), chain, ctx, 0);
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. report
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}
