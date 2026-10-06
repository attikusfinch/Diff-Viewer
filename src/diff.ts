import { diffLines, diffWordsWithSpace } from 'diff';

export type LineKind = 'context' | 'add' | 'delete';
export interface DiffLine {
  kind: LineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
  changed?: { value: string; changed: boolean }[];
}
export interface SplitRow { left?: DiffLine; right?: DiffLine; changed: boolean }
export interface Gap { gap: true; count: number; start: number; end: number }
export type DisplayRow = SplitRow | Gap;

export function linesFor(before: string, after: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 1, newLine = 1;
  const chunks = diffLines(before, after, { stripTrailingCr: true, timeout: 700, maxEditLength: 10000 })
    ?? [{value:before,removed:true,added:false},{value:after,added:true,removed:false}];
  for (const chunk of chunks) {
    const texts = chunk.value.split('\n');
    if (texts.at(-1) === '') texts.pop();
    for (const text of texts) {
      const kind = chunk.added ? 'add' : chunk.removed ? 'delete' : 'context';
      lines.push({ kind, text,
        oldLine: kind === 'add' ? undefined : oldLine++,
        newLine: kind === 'delete' ? undefined : newLine++ });
    }
  }
  return lines;
}

export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === 'context') {
      rows.push({ left: lines[i], right: lines[i], changed: false }); i++; continue;
    }
    const removed: DiffLine[] = [], added: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === 'delete') removed.push(lines[i++]);
    while (i < lines.length && lines[i].kind === 'add') added.push(lines[i++]);
    for (let n = 0; n < Math.max(removed.length, added.length); n++) {
      let left = removed[n], right = added[n];
      // Word-level differences are bounded to avoid expensive work on generated/minified lines.
      if (left && right && left.text.length < 600 && right.text.length < 600) {
        const words = diffWordsWithSpace(left.text, right.text);
        left = { ...left, changed: words.filter(w => !w.added).map(w => ({ value: w.value, changed: !!w.removed })) };
        right = { ...right, changed: words.filter(w => !w.removed).map(w => ({ value: w.value, changed: !!w.added })) };
      }
      rows.push({ left, right, changed: true });
    }
  }
  return rows;
}

export function collapseRows(rows: SplitRow[], context: number, expanded: Set<string>): DisplayRow[] {
  const keep = new Set<number>();
  rows.forEach((row, i) => {
    if (row.changed) for (let n = Math.max(0, i - context); n <= Math.min(rows.length - 1, i + context); n++) keep.add(n);
  });
  const result: DisplayRow[] = [];
  for (let i = 0; i < rows.length;) {
    if (keep.has(i)) { result.push(rows[i++]); continue; }
    const start = i;
    while (i < rows.length && !keep.has(i)) i++;
    const count = i - start;
    if (count <= 3 || expanded.has(`${start}:${i}`)) { for (let n=start;n<i;n++) result.push(rows[n]); }
    else result.push({ gap: true, count, start, end: i });
  }
  return result;
}

export function fingerprint(before: string, after: string): string {
  let hash = 2166136261;
  for (const text of [before, '\0', after]) {
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  }
  return (hash >>> 0).toString(16);
}
