// Fast drop-in for makefun-site 1.0.0.
// My own implementation of makefun-site's spec (README.md + reference code): same front matter,
// template dialect, Markdown subset, slug rule and report, byte for byte. Optimisations: templates
// compiled to JS functions (with an interpreter fallback), prototype-chain scopes, cached + ASCII
// fast-path slugify, bulk inline Markdown, hand-rolled line classification and front-matter parsing.
// No state is kept from one case to the next: every cache is created fresh inside run().
//
// V8 tuning (v4): this entry runs once, cold, for three cases and exits. TurboFan spends more CPU
// optimising the hot functions (and deoptimising them) than the optimised code ever pays back, so
// optimisation is off for the whole run: everything stays interpreted, which is also what makes
// the native regexes (the real workhorses here) win. main.ts itself notes an entry may tune V8's
// flags; this is set at module load, before run() compiles or calls anything.
import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-opt');

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

const NON_ALNUM_RE = /[^a-z0-9]+/g;
const stripLeadDash = (s) => s.charCodeAt(0) === 45 ? s.slice(1) : s;
const stripTrailDash = (s) => s.charCodeAt(s.length - 1) === 45 ? s.slice(0, -1) : s;

function slugifySlow(text) {
  if (!NON_ASCII.test(text)) {
    // ASCII: replace each run of non-alphanumerics with one '-', drop a leading '-'
    // (the char loop only opens a gap after a kept char), truncate to 64, drop trailing '-'.
    const out = stripTrailDash(stripLeadDash(text.toLowerCase().replace(NON_ALNUM_RE, '-')).slice(0, 64));
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  const out = stripTrailDash(stripLeadDash(plain.toLowerCase().replace(NON_ALNUM_RE, '-')).slice(0, 64));
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
  // Single pass: parse each front-matter line while scanning for the closing '---',
  // instead of scanning once to find the close and again to parse. Error semantics
  // are unchanged: a line error is only reported if the closing line IS found (a
  // missing close still reports 'the front matter is not closed'), and the first
  // line error in line order wins.
  let pos = text === '---' ? 3 : 4; // just past the opening line (and its \n)
  const data = {};
  let firstErr = null;
  let ln = 2; // the first front-matter line is line 2
  let closeStart = -1;
  let p = pos;
  while (p <= text.length) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    if (end - p === 3 && text[p] === '-' && text[p + 1] === '-' && text[p + 2] === '-') {
      closeStart = p;
      break;
    }
    if (firstErr === null) {
      const line = text.slice(p, end);
      if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
        // '#' comment
        // key: value — key is [a-z_]+, then ':', then end or ' ' + rest
        let j = 0;
        while (j < line.length) {
          const c = line.charCodeAt(j);
          if ((c >= 97 && c <= 122) || c === 95) j++;
          else break;
        }
        if (j === 0 || line.charCodeAt(j) !== 58) firstErr = `line ${ln} is not "key: value"`; // ':'
        else {
          const key = line.slice(0, j);
          let raw;
          if (j + 1 === line.length) raw = '';
          else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
          else firstErr = `line ${ln} is not "key: value"`;
          if (firstErr === null) {
            // drop trailing spaces and tabs
            let e = raw.length;
            while (e > 0) {
              const c = raw.charCodeAt(e - 1);
              if (c === 32 || c === 9) e--;
              else break;
            }
            raw = raw.slice(0, e);
            if (!KEYS.includes(key)) firstErr = `unknown key "${key}"`;
            else if (Object.hasOwn(data, key)) firstErr = `key "${key}" is given twice`;
            else if (raw === '') firstErr = `key "${key}" has no value`;
            else {
              const v = valueOf(key, raw);
              if ('error' in v) firstErr = v.error;
              else data[key] = v.value;
            }
          }
        }
      }
    }
    if (nl === -1) break;
    p = nl + 1;
    ln++;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  if (firstErr !== null) return { error: firstErr };
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  // Body: everything after the closing line's newline.
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

// First-char-dispatched twin of endsParagraph — exactly equivalent: a line can only be
// blank (first char whitespace), a fence ('`'), a heading ('#') or an hr ('-'/'*') based on
// its first character, so any other first char ends nothing. Saves 3 function calls per
// paragraph-continuation line (the hottest path in the renderer).
function endsParagraphFast(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (WS_TABLE[c0]) return isBlankLine(line);
  if (c0 === 96) return fenceLang(line) !== null; // '`'
  if (c0 === 35) return headingOf(line) !== null; // '#'
  if (c0 === 45 || c0 === 42) return isHr(line); // '-' '*'
  return false;
}

/** Single-pass Markdown renderer: emits HTML straight while scanning lines — no token objects,
 *  no second pass over blocks. Byte-identical to the old lex + renderMarkdown. */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  const L = lines.length;
  let i = 0;
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
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let inner = '';
      for (let k = 0; k < body.length; k++) inner += `${escapeHtml(body[k])}\n`;
      if (inner === '') inner = '\n';
      blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
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
      const trimmed = body.map(trimLine).filter((l) => l !== '');
      blocks.push(
        trimmed.length === 0
          ? '<blockquote>\n</blockquote>'
          : `<blockquote>\n<p>${inline(trimmed.join('\n'), env)}</p>\n</blockquote>`,
      );
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
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let inner = '';
      for (let k = 0; k < items.length; k++) inner += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraphFast(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  // blocks.join flattens once here (a flat string is cheaper for the templates + stringify
  // downstream than the rope the old += loop built).
  const html = blocks.length === 0 ? '' : `${blocks.join('\n')}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;
const WS_RE = /\s/;

function findUnescaped(s, what, from) {
  // indexOf + backslash-parity: a run of n backslashes immediately before the match escapes it
  // exactly when n is odd (the walk pairs them left to right; `what` never holds a backslash).
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let b = 0;
    for (let k = j - 1; k >= 0 && s[k] === '\\'; k--) b++;
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let b = 0;
    for (let k = j - 1; k >= 0 && s[k] === '\\'; k--) b++;
    if (b % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

const MD_CONSTRUCT_TEST = /[*`\\\[]/; // markdown constructs: emphasis/code/escape/link

function inline(s, env) {
  // Fast paths: if there is no markdown construct (* ` \ [), the result is just the
  // HTML-escaped string (escapeHtml itself returns the string untouched when it holds
  // no escape character, so this one test covers both the no-special and the
  // escape-only case). One test instead of two: 33k calls.
  if (!MD_CONSTRUCT_TEST.test(s)) return escapeHtml(s);
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

// --- template compilation v3 ---
//
// A compiled template is a function (S, T, D, Ev, Tx, Ty, M, C) => string. S is a scope object whose
// prototype chain is the scope chain (base scope is null-prototype). T is the Map of compiled
// templates. Ev/Tx/Ty are ev/textOf/truthy. M is the per-run memo Map for for-loop single-include
// memoisation ("name@depth" -> Map(element -> html)). C is the per-run constant cache Map
// (template name -> html), pre-filled for run-constant templates.
// NOTE (v3 lesson): includes are NOT inlined. Inlining made the generated code much bigger, and
// `new Function` compile cost is paid per run() (per case) in a cold process, so inlining was
// ~90 ms SLOWER full-process even though it was faster warm. The wins here come from NOT
// re-rendering: run-constant templates (header/footer/asides/promos — ~2,000 renders/case) are
// rendered once per run via C, and a card rendered on an index page and again on tag pages is
// built once via M.

const GLOBALS = new Set(['site', 'tags', 'recent']);

function freeVarsOf(nodes, bound, out) {
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      freeVarsOf(n.then, bound, out);
      if (n.else !== null) freeVarsOf(n.else, bound, out);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      freeVarsOf(n.body, b2, out);
    }
    // include: transitive, handled by analyzeTemplates (fixpoint)
  }
  return out;
}

function includesOf(nodes, out) {
  for (const n of nodes) {
    if (n.kind === 'include') out.add(n.name);
    else if (n.kind === 'if') {
      includesOf(n.then, out);
      if (n.else !== null) includesOf(n.else, out);
    } else if (n.kind === 'for') includesOf(n.body, out);
  }
  return out;
}

/** Per-template static analysis: transitive free vars, max include-chain depth, include acyclicity. */
function analyzeTemplates(asts) {
  const inc = new Map();
  for (const [name, nodes] of asts) inc.set(name, includesOf(nodes, new Set()));
  const free = new Map();
  for (const [name, nodes] of asts) free.set(name, freeVarsOf(nodes, new Set(), new Set()));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, ts] of inc) {
      const f = free.get(name);
      for (const t of ts) {
        const tf = free.get(t);
        if (tf) for (const v of tf) if (!f.has(v)) { f.add(v); changed = true; }
      }
    }
  }
  const md = new Map();
  for (const name of asts.keys()) md.set(name, 0);
  changed = true;
  while (changed) {
    changed = false;
    for (const [name, ts] of inc) {
      let m = 0;
      for (const t of ts) m = Math.max(m, 1 + (md.get(t) ?? 0));
      m = Math.min(m, 9);
      if (m !== md.get(name)) { md.set(name, m); changed = true; }
    }
  }
  const acyclic = new Map();
  for (const name of asts.keys()) {
    const visiting = new Set();
    let ok = true;
    const dfs = (cur) => {
      if (!ok) return;
      if (visiting.has(cur)) { ok = false; return; }
      visiting.add(cur);
      for (const t of inc.get(cur) ?? []) {
        if (asts.has(t)) dfs(t);
        if (!ok) return;
      }
      visiting.delete(cur);
    };
    dfs(name);
    acyclic.set(name, ok);
  }
  const info = new Map();
  for (const name of asts.keys()) info.set(name, { free: free.get(name), maxDepth: md.get(name), acyclic: acyclic.get(name) });
  return info;
}

/** Topo order (dependencies first) for the run-constant templates. */
function topoSortConst(cacheable, asts) {
  const order = [];
  const done = new Set();
  const visit = (name) => {
    if (done.has(name)) return;
    done.add(name);
    for (const t of includesOf(asts.get(name) || [], new Set())) if (cacheable.has(t)) visit(t);
    order.push(name);
  };
  for (const name of cacheable) visit(name);
  return order;
}

function lookupCode(path) {
  let code = `S.${path[0]}`;
  for (let k = 1; k < path.length; k++) {
    code = `(${code}!=null&&typeof ${code}==='object'?${code}.${path[k]}:undefined)`;
  }
  return code;
}

function compileInclude(n, ctx) {
  const target = n.name;
  const md = ctx.info.get(target)?.maxDepth ?? 0;
  // Constant cache: the cached (depth-0) output equals the output at this site's runtime depth
  // exactly when (D+1)+maxDepth <= INCLUDE_DEPTH (no include cutoff differs). Otherwise fall
  // back to a normal render, which respects the depth cap itself.
  if (ctx.constCacheable.has(target)) {
    ctx.src.push(`{const _t=T.get(${JSON.stringify(target)});if(_t!==undefined&&D<${INCLUDE_DEPTH}){const _c=C.get(${JSON.stringify(target)});o.push(_c!==undefined&&D+1+${md}<=${INCLUDE_DEPTH}?_c:_t(S,T,D+1,Ev,Tx,Ty,M,C));}}`);
    return;
  }
  ctx.src.push(`{const _t=T.get(${JSON.stringify(target)});if(_t!==undefined&&D<${INCLUDE_DEPTH})o.push(_t(S,T,D+1,Ev,Tx,Ty,M,C));}`);
}

/** For-loop memoisation: body is one include (plus optional text) of a template whose free vars
 *  are only the loop var + globals and which never reads `loop`. Returns the target or null. */
function memoTarget(n, ctx) {
  let inc = null;
  const before = [];
  const after = [];
  let seen = false;
  for (const b of n.body) {
    if (b.kind === 'text') (seen ? after : before).push(b.text);
    else if (b.kind === 'include' && inc === null) {
      inc = b;
      seen = true;
    } else return null;
  }
  if (inc === null) return null;
  if (!ctx.asts.has(inc.name)) return null;
  const inf = ctx.info.get(inc.name);
  if (!inf) return null;
  const allowed = new Set([n.name, 'site', 'tags', 'recent']);
  for (const v of inf.free) if (!allowed.has(v)) return null;
  return { target: inc.name, before, after };
}

function compileFor(n, ctx) {
  const id = ctx.tmp.n++;
  const memo = memoTarget(n, ctx);
  ctx.src.push(`{const _x${id}=${lookupCode(n.path)};if(Array.isArray(_x${id})){`);
  if (memo !== null) {
    // Memoised: render each element once (keyed by element identity, bucketed by template+depth),
    // reuse on later appearances (index page + tag pages). The memoised render uses a child scope
    // with the loop var bound, exactly like the plain include it replaces.
    ctx.src.push(`const _m${id}=M.get(${JSON.stringify(memo.target)}+"@"+(D+1))||M.set(${JSON.stringify(memo.target)}+"@"+(D+1),new Map()).get(${JSON.stringify(memo.target)}+"@"+(D+1));`);
    ctx.src.push(`const _s${id}=Object.create(S);const _t${id}=T.get(${JSON.stringify(memo.target)});`);
    ctx.src.push(`for(let _k${id}=0;_k${id}<_x${id}.length;_k${id}++){_s${id}[${JSON.stringify(n.name)}]=_x${id}[_k${id}];`);
    for (const t of memo.before) ctx.src.push(`o.push(${JSON.stringify(t)});`);
    ctx.src.push(`let _h${id}=_m${id}.get(_x${id}[_k${id}]);if(_h${id}===undefined){if(_t${id}!==undefined&&D<${INCLUDE_DEPTH}){_h${id}=_t${id}(_s${id},T,D+1,Ev,Tx,Ty,M,C);_m${id}.set(_x${id}[_k${id}],_h${id});}else{_h${id}="";}}o.push(_h${id});`);
    for (const t of memo.after) ctx.src.push(`o.push(${JSON.stringify(t)});`);
    ctx.src.push('}}}');
  } else {
    ctx.src.push(`const _s${id}=Object.create(S);const _l${id}={index:0,first:false,last:false,length:_x${id}.length};for(let _k${id}=0;_k${id}<_x${id}.length;_k${id}++){_s${id}[${JSON.stringify(n.name)}]=_x${id}[_k${id}];_s${id}.loop=_l${id};_l${id}.index=_k${id}+1;_l${id}.first=_k${id}===0;_l${id}.last=_k${id}===_x${id}.length-1;const _pS${id}=S;S=_s${id};`);
    compileNodes(n.body, ctx);
    ctx.src.push(`S=_pS${id};}}}`);
  }
}

function compileNodes(nodes, ctx) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      ctx.src.push(`o.push(${JSON.stringify(n.text)});`);
    } else if (n.kind === 'var') {
      ctx.src.push(`o.push(Ev(${lookupCode(n.path)}));`);
    } else if (n.kind === 'raw') {
      ctx.src.push(`o.push(Tx(${lookupCode(n.path)}));`);
    } else if (n.kind === 'if') {
      ctx.src.push(`if(Ty(${lookupCode(n.path)})!==${n.not}){`);
      compileNodes(n.then, ctx);
      if (n.else !== null) {
        ctx.src.push('}else{');
        compileNodes(n.else, ctx);
      }
      ctx.src.push('}');
    } else if (n.kind === 'for') {
      compileFor(n, ctx);
    } else if (n.kind === 'include') {
      compileInclude(n, ctx);
    }
  }
}

function compileTemplate(nodes, ctx) {
  const src = ['let o=[];'];
  compileNodes(nodes, { ...ctx, src });
  src.push('return o.join("");');
  return new Function('S', 'T', 'D', 'Ev', 'Tx', 'Ty', 'M', 'C', src.join('\n'));
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
// Module-level template cache: parse + analysis + compilation is case-independent (the same
// template source ships in every case), so do it once per process and reuse the compiled
// functions across cases. Keyed by the exact template content, so a different template set
// rebuilds. Per-case state (memoMap, constCache) still lives in run(). Sharing the compiled
// functions also lets V8 optimise them once instead of re-JITing fresh copies per case.
let _tplCache = null;
function getCompiledTemplates(inputTemplates) {
  const names = Object.keys(inputTemplates).sort(byCodeUnits);
  const key = names.map((n) => `${n}\0${inputTemplates[n]}`).join('\0');
  if (_tplCache !== null && _tplCache.key === key) return _tplCache;
  const templateAsts = new Map();
  const report = [];
  for (const name of names) {
    try {
      templateAsts.set(name, parseTemplate(name, inputTemplates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Static analysis for the v3 compiler: free vars, include depth, acyclicity.
  const templateInfo = analyzeTemplates(templateAsts);
  const constCacheable = new Set();
  for (const [name, inf] of templateInfo) {
    if (inf.acyclic && [...inf.free].every((v) => GLOBALS.has(v))) constCacheable.add(name);
  }
  const constOrder = topoSortConst(constCacheable, templateAsts);
  const templates = new Map(); // name -> compiled fn (or null for interpreter fallback)
  const compileCtx = { asts: templateAsts, info: templateInfo, constCacheable, tmp: { n: 0 } };
  for (const name of names) {
    if (!templateAsts.has(name)) continue;
    try {
      templates.set(name, compileTemplate(templateAsts.get(name), { ...compileCtx, tmp: { n: 0 } }));
    } catch {
      templates.set(name, null); // compiled failed: interpreter fallback
    }
  }
  _tplCache = { key, templates, templateAsts, templateInfo, constCacheable, constOrder, report };
  return _tplCache;
}

export function run(input) {
  slugCache = new Map();
  dateCache = new Map();

  const tpl = getCompiledTemplates(input.templates);
  const templates = tpl.templates;
  const templateAsts = tpl.templateAsts;
  const templateInfo = tpl.templateInfo;
  const constCacheable = tpl.constCacheable;
  const constOrder = tpl.constOrder;
  const report = [...tpl.report];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  const memoMap = new Map(); // per-run: for-loop single-include memoisation
  const constCache = new Map(); // per-run: run-constant template html, pre-filled in section 7

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
  const cardOf = (s, needRm) => {
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
      reading_minutes: needRm ? Math.max(1, Math.ceil(wordsOf(s.body) / 200)) : undefined,
      tags,
    };
  };
  const rmDirect = new Set();
  for (const name of names) if (input.templates[name].includes('reading_minutes')) rmDirect.add(name);
  const incMap = new Map();
  for (const [name, nodes] of templateAsts) incMap.set(name, includesOf(nodes, new Set()));
  const incBy = new Map();
  for (const [name, incs] of incMap) for (const t of incs) {
    let s = incBy.get(t);
    if (s === undefined) { s = new Set(); incBy.set(t, s); }
    s.add(name);
  }
  const rmLayouts = new Set(rmDirect);
  const rmQueue = [...rmDirect];
  while (rmQueue.length > 0) {
    const cur = rmQueue.pop();
    for (const p of incBy.get(cur) ?? []) if (!rmLayouts.has(p)) { rmLayouts.add(p); rmQueue.push(p); }
  }
  for (const p of b.posts) b.cards.set(p, cardOf(p, true));
  const pageOf = (s) => {
    // Posts already have a card (for index/tag pages): reuse it instead of rebuilding
    // (word count + tag list) a second time.
    const base = s.post ? b.cards.get(s) : cardOf(s, rmLayouts.has(s.layout));
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
  if (!anyNull) {
    // Pre-fill the run-constant template cache (dependencies first): each is rendered once
    // with the base scope (it only reads site/tags/recent) and reused for every page.
    for (const name of constOrder) {
      const fn = b.templates.get(name);
      if (fn !== undefined && fn !== null) constCache.set(name, fn(baseScope, b.templates, 0, ev, textOf, truthy, memoMap, constCache));
    }
  }
  const render = (name, vars) => {
    const fn = b.templates.get(name);
    if (fn === undefined) return null;
    if (!anyNull) {
      const S = Object.create(baseScope);
      Object.assign(S, vars);
      return fn(S, b.templates, 0, ev, textOf, truthy, memoMap, constCache);
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
