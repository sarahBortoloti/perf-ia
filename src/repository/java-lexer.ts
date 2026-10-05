export interface JavaTokens {
  values: string[];
  structural: string[];
}

/** Keep literal values for annotations, but mask them in the structural view. */
export function tokenizeJava(source: string): JavaTokens {
  const values: string[] = [];
  const structural: string[] = [];
  let cursor = 0;
  function literal(delimiter: string, description: string): void {
    const start = cursor;
    cursor += delimiter.length;
    while (cursor < source.length) {
      if (source[cursor] === '\\') { cursor += 2; continue; }
      if (source.startsWith(delimiter, cursor)) {
        cursor += delimiter.length;
        values.push(source.slice(start, cursor));
        structural.push('');
        return;
      }
      if (delimiter.length === 1 && /[\r\n]/.test(source[cursor])) throw new Error(`Unterminated Java ${description}`);
      cursor++;
    }
    throw new Error(`Unterminated Java ${description}`);
  }
  while (cursor < source.length) {
    const character = source[cursor];
    if (/\s/.test(character)) { cursor++; continue; }
    if (source.startsWith('//', cursor)) {
      while (cursor < source.length && !/[\r\n]/.test(source[cursor])) cursor++;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2);
      if (end < 0) throw new Error('Unterminated Java block comment');
      cursor = end + 2; continue;
    }
    if (source.startsWith('"""', cursor)) { literal('"""', 'text block'); continue; }
    if (character === '"' || character === "'") { literal(character, character === '"' ? 'string literal' : 'character literal'); continue; }
    const start = cursor++;
    if (/[A-Za-z_$]/.test(character)) {
      while (cursor < source.length && /[\w$]/.test(source[cursor])) cursor++;
    } else if (/\d/.test(character)) {
      while (cursor < source.length && /\d/.test(source[cursor])) cursor++;
    }
    const token = source.slice(start, cursor);
    values.push(token); structural.push(token);
  }
  return { values, structural };
}

/** Validate genuine syntax delimiters once and index each opener's closer. */
export function matchJavaDelimiters(structural: string[]): Map<number, number> {
  const pairs = new Map([['(', ')'], ['{', '}'], ['[', ']']]);
  const stack: { index: number; expected: string }[] = [];
  const matches = new Map<number, number>();
  for (let index = 0; index < structural.length; index++) {
    const token = structural[index];
    const expected = pairs.get(token);
    if (expected !== undefined) stack.push({ index, expected });
    else if ([')', '}', ']'].includes(token)) {
      const opener = stack.pop();
      if (!opener || opener.expected !== token) throw new Error('Unbalanced Java delimiters');
      matches.set(opener.index, index);
    }
  }
  if (stack.length) throw new Error('Unbalanced Java delimiters');
  return matches;
}
