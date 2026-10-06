import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ChevronsUpDown, FileCode2, MessageSquarePlus, SearchX } from 'lucide-react';
import { collapseRows, linesFor, splitRows } from '../diff';
import type { DiffLine, DisplayRow, SplitRow } from '../diff';
import type { FileContent, Mode, Preferences, Comment } from '../types';

export interface DiffHandle { hunk: (direction: number) => void; line: (line: number, side?: 'before' | 'after') => void; find: (direction: number) => void }
interface Props {
  file: FileContent;
  mode: Mode;
  preferences: Preferences;
  search: string;
  comments: Comment[];
  onLine: (line: number, side: 'before' | 'after') => void;
  onCounts: (hunks: number, matches: number) => void;
}

function marked(value: string, query: string) {
  if (!query) return value;
  const lower = value.toLowerCase(), needle = query.toLowerCase();
  const parts = [];
  let i = 0;
  for (let pos = lower.indexOf(needle); pos !== -1; pos = lower.indexOf(needle, i)) {
    parts.push(value.slice(i, pos), <mark key={pos}>{value.slice(pos, pos + needle.length)}</mark>);
    i = pos + needle.length;
  }
  parts.push(value.slice(i));
  return parts;
}

function Syntax({value, search}: {value: string; search: string}) {
  if(value.length>4000)return <>{marked(value,search)}</>;
  const tokens = value.split(/(\/\/.*$|#.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|\b(?:import|from|const|let|var|export|async|await|return|function|if|else|throw|new|class|interface|type|pub|fn|use|struct|impl|match|mod|for|in|while|try|catch|true|false|null|undefined|as)\b|\b\d+(?:\.\d+)?\b)/g);
  return <>{tokens.map((token, i) => {
    let kind = '';
    if (/^(\/\/|#)/.test(token)) kind = 'syntax-comment';
    else if (/^["'`]/.test(token)) kind = 'syntax-string';
    else if (/^\d/.test(token)) kind = 'syntax-number';
    else if (/^(import|from|const|let|var|export|async|await|return|function|if|else|throw|new|class|interface|type|pub|fn|use|struct|impl|match|mod|for|in|while|try|catch|true|false|null|undefined|as)$/.test(token)) kind = 'syntax-keyword';
    return <span className={kind} key={i}>{marked(token, search)}</span>;
  })}</>;
}

function CodeLine({line, side, search, onLine, commented, horizontal=0}: {
  line?: DiffLine; side: 'before' | 'after'; search: string;
  onLine: Props['onLine']; commented: boolean; horizontal?: number;
}) {
  const number = side === 'before' ? line?.oldLine : line?.newLine;
  if (!line) return <div className="code-cell blank" aria-hidden="true"><span className="line-number"/><span className="line-sign"/><code> </code></div>;
  return <div className={`code-cell ${line.kind}`} data-line={number} data-side={side}>
    <button className={`line-number ${commented ? 'has-comment' : ''}`} onClick={()=>onLine(number ?? 1, side)}
      title={`Add comment on ${side === 'before' ? 'original' : 'modified'} line ${number}`} aria-label={`Comment on ${side} line ${number}`}>
      <span>{number}</span><MessageSquarePlus size={12}/>
    </button>
    <span className="line-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ''}</span>
    <code><span className="code-line-text" style={horizontal?{transform:`translateX(-${horizontal}px)`}:undefined}>{line.changed ? line.changed.map((w, i)=><span key={i} className={w.changed ? 'word-change' : ''}><Syntax value={w.value} search={search}/></span>) : <Syntax value={line.text} search={search}/>}</span></code>
  </div>;
}

const DiffView = forwardRef<DiffHandle, Props>(function DiffView({file, mode, preferences, search, comments, onLine, onCounts}, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);
  const [viewportWidth, setViewportWidth] = useState(1000);
  const [horizontal,setHorizontal]=useState(0);
  const horizontalRefs=useRef<(HTMLDivElement|null)[]>([]);
  const cursor = useRef({hunk:-1,find:-1});
  const lines = useMemo(()=>linesFor(file.before, file.after), [file.before, file.after]);
  const allRows = useMemo(()=>splitRows(lines), [lines]);
  const split = preferences.layout === 'split' && mode === 'diff';
  const longest=useMemo(()=>lines.reduce((max,l)=>Math.max(max,l.text.replace(/\t/g,'    ').length),0),[lines]);
  const rows: DisplayRow[] = useMemo(()=>{
    if (mode === 'file') return allRows; // Deleted lines remain visible so complete context includes the changes.
    let source = allRows;
    if (!split) source = lines.map(line=>({left:line.kind==='delete'?line:undefined, right:line.kind!=='delete'?line:undefined,changed:line.kind!=='context'}));
    if (search) return source;
    return preferences.context === -1 ? source : collapseRows(source, preferences.context, expanded);
  },[allRows,lines,mode,split,search,preferences.context,expanded]);

  const rowHeights = useMemo(()=>rows.map(row=>{
    if ('gap' in row) return 48;
    if (!preferences.wrap) return preferences.fontSize * 1.8 * (mode==='file' && row.changed && row.left && row.right ? 2 : 1);
    const width = (viewportWidth / (split ? 2 : 1)) - (split ? 84 : 114);
    const chars = Math.max(10, Math.floor(width / (preferences.fontSize * .61)));
    const texts = [row.left?.text ?? '', row.right?.text ?? ''];
    const counts=texts.map(t=>Math.ceil(Math.max(1,t.replace(/\t/g,'    ').length)/chars));
    return (mode==='file' && row.changed && row.left && row.right ? counts[0]+counts[1] : Math.max(...counts)) * preferences.fontSize * 1.8;
  }),[rows,preferences.fontSize,preferences.wrap,viewportWidth,split,mode]);
  const offsets = useMemo(()=>{
    const result=[0]; rowHeights.forEach(h=>result.push(result.at(-1)!+h)); return result;
  },[rowHeights]);
  const hunks = useMemo(()=>rows.flatMap((r,i)=>!('gap' in r) && r.changed && (i===0 || 'gap' in rows[i-1] || !(rows[i-1] as SplitRow).changed) ? [i] : []),[rows]);
  const matches = useMemo(()=>search ? rows.flatMap((r,i)=>!('gap' in r) && [r.left?.text,r.right?.text].some(t=>t?.toLowerCase().includes(search.toLowerCase())) ? [i] : []) : [],[rows,search]);
  useEffect(()=>onCounts(hunks.length,matches.length),[hunks.length,matches.length,onCounts]);
  useEffect(()=>{
    setExpanded(new Set()); cursor.current={hunk:-1,find:-1};setHorizontal(0);
    horizontalRefs.current.forEach(el=>{if(el)el.scrollLeft=0;});
    scrollRef.current?.scrollTo(0,0); setScrollTop(0);
  },[file.path,mode,preferences.layout]);
  useEffect(()=>{
    const el=scrollRef.current;
    if (!el) return;
    const observer=new ResizeObserver(()=>{setViewportHeight(el.clientHeight);setViewportWidth(el.clientWidth)});
    observer.observe(el); return ()=>observer.disconnect();
  },[]);
  useEffect(()=>{cursor.current.find=-1},[search]);

  function scrollTo(index: number) {
    const el=scrollRef.current;
    if (el) el.scrollTo({top:Math.max(0,offsets[index]-80),behavior:'instant'});
  }
  useImperativeHandle(ref,()=>({
    hunk(direction) {
      if (!hunks.length) return;
      cursor.current.hunk=(cursor.current.hunk+direction+hunks.length)%hunks.length;
      scrollTo(hunks[cursor.current.hunk]);
    },
    find(direction) {
      if (!matches.length) return;
      cursor.current.find=(cursor.current.find+direction+matches.length)%matches.length;
      scrollTo(matches[cursor.current.find]);
    },
    line(number,side='after') {
      const index=rows.findIndex(r=>!('gap' in r) && (side==='before'?r.left?.oldLine:r.right?.newLine)===number);
      if (index>=0) scrollTo(index);
      else {
        const gaps=rows.filter((r):r is Extract<DisplayRow,{gap:true}>=>'gap' in r);
        setExpanded(new Set(gaps.map(g=>`${g.start}:${g.end}`)));
        setTimeout(()=>{
          const target=scrollRef.current?.querySelector(`[data-line="${number}"][data-side="${side}"]`);
          target?.scrollIntoView({block:'center'});
        },50);
      }
    },
  }));

  if (file.binary) return <div className="editor-empty"><FileCode2 size={36}/><h2>Preview unavailable</h2><p>This file is binary, is not UTF-8, or exceeds the 2 MB preview limit.</p></div>;
  if (!rows.length) return <div className="editor-empty"><FileCode2 size={32}/><h2>{file.after ? 'No changes in this file' : 'This file is empty'}</h2><p>Select another file from the explorer.</p></div>;

  // Virtualize long diffs. Offsets account for wrapping, gutters and expanded context.
  const virtual=rows.length>400;
  let start=0,end=rows.length;
  if (virtual) {
    let lo=0,hi=offsets.length-1;
    while (lo<hi) {const mid=(lo+hi)>>1;if(offsets[mid]<scrollTop)lo=mid+1;else hi=mid;}
    start=Math.max(0,lo-12);
    end=start;
    while(end<rows.length && offsets[end]<scrollTop+viewportHeight+500)end++;
  }
  function renderRow(row: DisplayRow,index: number) {
    if ('gap' in row) return <button key={`gap-${row.start}`} className="context-gap" onClick={()=>setExpanded(prev=>new Set([...prev,`${row.start}:${row.end}`]))}>
      <ChevronsUpDown size={13}/><span>Expand {row.count} unchanged lines</span><span className="gap-rule"/>
    </button>;
    const common={search,onLine};
    if (split) return <div className="split-row" key={index} style={{minHeight:rowHeights[index]}} data-changed={row.changed || undefined}>
      <CodeLine {...common} horizontal={preferences.wrap?0:horizontal} line={row.left} side="before" commented={comments.some(c=>c.side==='before' && c.line===row.left?.oldLine)}/>
      <CodeLine {...common} horizontal={preferences.wrap?0:horizontal} line={row.right} side="after" commented={comments.some(c=>c.side==='after' && c.line===row.right?.newLine)}/>
    </div>;
    // Full-file mode uses paired rows but preserves original deletions before replacements.
    if (mode==='file' && row.changed && row.left && row.right) return <div key={index} className="file-replacement">
      <CodeLine {...common} line={row.left} side="before" commented={comments.some(c=>c.side==='before'&&c.line===row.left?.oldLine)}/>
      <CodeLine {...common} line={row.right} side="after" commented={comments.some(c=>c.side==='after'&&c.line===row.right?.newLine)}/>
    </div>;
    const line=row.right??row.left;
    return <div key={index} className="unified-row" style={{minHeight:rowHeights[index]}} data-changed={row.changed || undefined}>
      {mode==='diff' && <span className="old-number">{row.left?.oldLine??(line?.kind==='context'?line.oldLine:'')}</span>}
      <CodeLine {...common} line={line} side={row.right?'after':'before'} commented={comments.some(c=>c.side===(row.right?'after':'before')&&c.line===(row.right?.newLine??row.left?.oldLine))}/>
    </div>;
  }
  return <div className={`diff-view ${split?'split':'unified'} ${preferences.wrap?'wrap':''}`}>
    {split && <div className="diff-column-headings"><span><span className="version-dot before"/>Original<span className="version-ref">base</span></span><span><span className="version-dot after"/>Modified<span className="version-ref">{mode==='diff'?'current':''}</span></span></div>}
    {search && !matches.length && <div className="find-empty"><SearchX size={14}/>No matching lines</div>}
    <div ref={scrollRef} className="code-scroll" onScroll={e=>setScrollTop(e.currentTarget.scrollTop)} style={{'--code-size':`${preferences.fontSize/16}rem`} as React.CSSProperties}>
      <div className="code-rows" style={!split&&!preferences.wrap?{minWidth:Math.max(viewportWidth,longest*preferences.fontSize*.61+120)}:undefined}>
        {virtual && <div style={{height:offsets[start]}} aria-hidden="true"/>}
        {rows.slice(start,end).map((r,i)=>renderRow(r,start+i))}
        {virtual && <div style={{height:offsets.at(-1)!-offsets[end]}} aria-hidden="true"/>}
        <div className="end-of-file"><span>End of file</span>{file.after && !file.after.endsWith('\n') && <span>No newline at end of file</span>}</div>
      </div>
    </div>
    {split&&!preferences.wrap&&<div className="horizontal-panels">{[0,1].map(i=><div key={i} ref={el=>{horizontalRefs.current[i]=el}} onScroll={e=>{
      const left=e.currentTarget.scrollLeft;setHorizontal(left);horizontalRefs.current.forEach(el=>{if(el&&el!==e.currentTarget&&el.scrollLeft!==left)el.scrollLeft=left;});
    }} aria-label={`Scroll ${i===0?'original':'modified'} code horizontally`} tabIndex={0}><div style={{width:Math.max(viewportWidth/2,longest*preferences.fontSize*.61+90),height:1}}/></div>)}</div>}
  </div>;
});
export default DiffView;
