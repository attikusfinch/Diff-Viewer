import { describe, expect, it } from 'vitest';
import { linesFor, splitRows, collapseRows, fingerprint } from './diff';

describe('diff rendering model', () => {
  it('preserves independent before/after line numbers through insertions', () => {
    const rows = splitRows(linesFor('a\nb\nc\n', 'a\nnew\nb\nc\n'));
    expect(rows.map(r => [r.left?.oldLine, r.right?.newLine])).toEqual([[1,1], [undefined,2], [2,3], [3,4]]);
  });
  it('pairs replacement lines and isolates word changes', () => {
    const [row] = splitRows(linesFor('const count = 1;\n', 'const count = 2;\n'));
    expect(row.left?.changed?.find(w => w.changed)?.value).toBe('1');
    expect(row.right?.changed?.find(w => w.changed)?.value).toBe('2');
  });
  it('collapses unchanged context and expands exact ranges', () => {
    const before = Array.from({length: 40}, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 20', 'changed 20');
    const rows = splitRows(linesFor(before, after));
    const collapsed = collapseRows(rows, 3, new Set());
    expect(collapsed.filter(r => 'gap' in r)).toHaveLength(2);
    const keys = collapsed.filter(r => 'gap' in r).map(r => `${r.start}:${r.end}`);
    expect(collapseRows(rows, 3, new Set(keys))).toHaveLength(rows.length);
  });
  it('handles empty files and missing trailing newlines', () => {
    expect(linesFor('', '')).toEqual([]);
    expect(linesFor('', 'hello')).toEqual([{kind:'add',text:'hello',oldLine:undefined,newLine:1}]);
    expect(linesFor('hello', '')[0].kind).toBe('delete');
  });
  it('invalidates reviewed content when either side changes', () => {
    expect(fingerprint('old', 'new')).not.toBe(fingerprint('old', 'changed'));
    expect(fingerprint('old', 'new')).not.toBe(fingerprint('different', 'new'));
  });
  it('expands large unchanged ranges without overflowing the call stack', () => {
    const text='line\n'.repeat(140000);
    const rows=splitRows(linesFor(text,text));
    const gaps=collapseRows(rows,3,new Set());
    expect(gaps).toHaveLength(1);
    expect(collapseRows(rows,3,new Set(['0:140000']))).toHaveLength(140000);
  });
});
