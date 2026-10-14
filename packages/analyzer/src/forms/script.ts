/**
 * Just enough JavaScript reading to get form definitions out of inline scripts: string literals,
 * JSON-ish array literals, and the jQuery calls that inject them. Not a JS parser; it only has to
 * skip over strings correctly.
 */

export interface JsString {
  value: string;
  /** Offset of the opening quote. */
  start: number;
  /** Offset just past the closing quote. */
  end: number;
}

/** Reads the string literal whose opening quote is at `start` (', " or ` without interpolation). */
export function readJsString(src: string, start: number): JsString | null {
  const quote = src[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let value = '';
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i]!;
    if (c === quote) return { value, start, end: i + 1 };
    if (quote !== '`' && (c === '\n' || c === '\r')) return null;
    if (c !== '\\') {
      value += c;
      continue;
    }
    const n = src[++i];
    if (n === undefined) return null;
    switch (n) {
      case 'n': value += '\n'; break;
      case 'r': value += '\r'; break;
      case 't': value += '\t'; break;
      case 'b': value += '\b'; break;
      case 'f': value += '\f'; break;
      case 'v': value += '\v'; break;
      case '0': value += '\0'; break;
      case '\r': if (src[i + 1] === '\n') i++; break; // line continuation
      case '\n': break;
      case 'x': value += String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16)); i += 2; break;
      case 'u': {
        if (src[i + 1] === '{') {
          const close = src.indexOf('}', i);
          value += String.fromCodePoint(parseInt(src.slice(i + 2, close), 16));
          i = close;
        } else {
          value += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16));
          i += 4;
        }
        break;
      }
      default: value += n;
    }
  }
  return null;
}

/** Every string literal in a script, skipping comments. */
export function jsStrings(src: string): JsString[] {
  const out: JsString[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
    } else if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) break;
      i = close + 1;
    } else if (c === "'" || c === '"' || c === '`') {
      const s = readJsString(src, i);
      if (!s) continue;
      out.push(s);
      i = s.end - 1;
    }
  }
  return out;
}

/** The bracketed literal ([...] or {...}) starting at `start`, skipping over strings. */
export function readBracketed(src: string, start: number): string | null {
  const open = src[start];
  if (open !== '[' && open !== '{') return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const s = readJsString(src, i);
      if (!s) return null;
      i = s.end - 1;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      if (--depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}
