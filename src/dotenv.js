import { parseEnv } from 'node:util';
import { EnvshareError } from './error.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const blankOrComment = /[ \t]*(?:#[^\n]*)?(?:\n|$)/y;
const assignmentHead = /[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/y;
const unquotedValue = /[^#\n]*/y;

function matchAt(pattern, text, index) {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

function sameValues(entries, values) {
  return entries.size === Object.keys(values).length &&
    [...entries].every(([key, entry]) => Object.hasOwn(values, key) && values[key] === entry.value);
}

export function parseDotenv(bytes, label) {
  const invalid = () => new EnvshareError(label + ' に解釈できない dotenv 記法があります。');
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw invalid();
  }
  const newline = text.match(/\r?\n/)?.[0] ?? '\n';
  text = text.replaceAll('\r\n', '\n');
  if (/[\0\r]/.test(text)) throw invalid();

  // Node's parser may accept or silently skip ambiguous lines. Require every
  // record to be recognized, then check that Node reads the same final values.
  const entries = new Map();
  const caseNames = new Map();
  for (let i = 0; i < text.length;) {
    const blank = matchAt(blankOrComment, text, i);
    if (blank?.[0]) {
      i = blankOrComment.lastIndex;
      continue;
    }
    const head = matchAt(assignmentHead, text, i);
    if (!head) throw invalid();

    const key = head[1];
    const folded = key.toUpperCase();
    // Node 24 does not preserve __proto__. Windows environment names ignore case.
    if (key === '__proto__' || (caseNames.has(folded) && caseNames.get(folded) !== key)) throw invalid();
    caseNames.set(folded, key);
    const start = assignmentHead.lastIndex;
    const quote = text[start];
    let end;
    if (quote === "'" || quote === '"' || quote === '\x60') {
      const close = text.indexOf(quote, start + 1);
      if (close === -1) throw invalid();
      end = close + 1;
    } else {
      matchAt(unquotedValue, text, start);
      end = unquotedValue.lastIndex;
    }

    if (!matchAt(blankOrComment, text, end)) throw invalid();
    i = blankOrComment.lastIndex;
    const line = key + '=' + text.slice(start, end).replace(/[ \t]+$/, '');
    const unit = parseEnv(line);
    if (!Object.hasOwn(unit, key) || Object.keys(unit).length !== 1) throw invalid();
    entries.set(key, { value: unit[key], line });
  }
  if (!sameValues(entries, parseEnv(text))) throw invalid();

  return { bytes, text, newline, entries };
}

export function renderEntries(entries, newline = '\n') {
  return [...entries.values()].map(({ line }) => line.replaceAll('\n', newline)).join(newline) + newline;
}

export function appendEntries(doc, changed, label) {
  if (changed.size === 0) return doc.bytes;
  const separator = doc.text && !doc.text.endsWith('\n') ? doc.newline : '';
  const combined = Buffer.concat([doc.bytes, Buffer.from(separator + renderEntries(changed, doc.newline))]);
  const after = parseDotenv(combined, label).entries;
  const expected = new Map([...doc.entries, ...changed]);
  if (after.size !== expected.size ||
      [...expected].some(([key, entry]) => after.get(key)?.value !== entry.value)) {
    throw new EnvshareError(label + ' に値を安全に追記できません。');
  }
  return combined;
}
