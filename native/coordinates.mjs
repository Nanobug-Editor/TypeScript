/** Strict UTF-16 conversions between LSP and TypeScript's one-based protocol coordinates. */
import { invalid } from './errors.mjs';

export function position(location) { return { line: location.line - 1, character: location.offset - 1 }; }
export function range(span) { return { start: position(span.start), end: position(span.end) }; }
export function location(position) { return { line: position.line + 1, offset: position.character + 1 }; }

/** JavaScript string indices are UTF-16; reject half-surrogates and line-ending interiors. */
export function offset(text, point) {
  if (!Number.isInteger(point?.line) || !Number.isInteger(point?.character) || point.line < 0 || point.character < 0) throw invalid('Invalid UTF-16 position');
  let start = 0;
  for (let line = 0; line < point.line; line++) {
    const match = /\r\n|\r|\n/.exec(text.slice(start));
    if (!match) throw invalid('Position line exceeds source');
    start += match.index + match[0].length;
  }
  const end = /\r|\n/.exec(text.slice(start));
  const lineLength = end ? end.index : text.length - start;
  if (point.character > lineLength) throw invalid('Position column exceeds source');
  const index = start + point.character;
  const before = text.charCodeAt(index - 1), after = text.charCodeAt(index);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) throw invalid('Position splits a surrogate pair');
  return index;
}

export function endPosition(text) {
  const lines = text.split(/\r\n|\r|\n/);
  return { line: lines.length - 1, character: lines.at(-1).length };
}

/** Incremental edits are applied to an immutable snapshot copy; only a fully valid result is admitted. */
export function applyChanges(text, changes) {
  if (!Array.isArray(changes) || changes.length > 256) throw invalid('Invalid document changes');
  for (const change of changes) {
    if (typeof change.text !== 'string') throw invalid('Missing replacement text');
    if (!change.range) text = change.text;
    else {
      const start = offset(text, change.range.start), end = offset(text, change.range.end);
      if (start > end) throw invalid('Reversed document range');
      text = text.slice(0, start) + change.text + text.slice(end);
    }
  }
  return text;
}
