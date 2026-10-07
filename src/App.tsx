import { useCallback, useEffect, useRef, useState } from 'react';
import { version } from '../package.json';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowDown, ArrowUp, Braces, Check, CheckCheck, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns2, Command, Copy, FileCode2, Files, FolderOpen, FolderTree, GitBranch, GitCommitHorizontal, GitCompareArrows, Keyboard, List, LoaderCircle, Menu, MessageSquare, Minus, PanelLeftClose, PanelLeftOpen, Palette, Plug, Plus, RefreshCw, Search, Settings2, ShieldCheck, SquareTerminal, WrapText, X } from 'lucide-react';
import { api, desktop } from './api';
import { demoReview, demoSnapshot, emptyReview } from './demo';
import { fingerprint } from './diff';
import DiffView from './components/DiffView';
import ImagePreview from './components/ImagePreview';
import type { DiffHandle } from './components/DiffView';
import FileTree, { FileIcon } from './components/FileTree';
import type { FileTreeHandle } from './components/FileTree';
import Modal from './components/Modal';
import type { Connection, FileContent, Mode, Preferences, Review, ShowDiff, Snapshot } from './types';

const defaults: Preferences = {theme:'graphite',fontSize:13,wrap:false,layout:'split',context:4,sidebarWidth:272,filesLayout:'list',changesExpanded:true};
const themeNames = {graphite:'Graphite',midnight:'Midnight',light:'Daylight',terminal:'Terminal'};
const mod = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';
function stored<T>(key:string,fallback:T):T { try {return JSON.parse(localStorage.getItem(key)??'null')??fallback}catch{return fallback} }
function save(key:string,value:unknown) { try {localStorage.setItem(key,JSON.stringify(value))}catch{/* Preferences remain valid for this session. */} }
const initialPreferences=stored<Preferences>('patchwork.preferences',defaults);
function validatedPreferences():Preferences {
  return {...defaults,...initialPreferences, theme:initialPreferences.theme in themeNames ? initialPreferences.theme : 'graphite',
    fontSize:Math.max(11,Math.min(18,Number(initialPreferences.fontSize)||13)),
    sidebarWidth:Math.max(220,Math.min(420,Number(initialPreferences.sidebarWidth)||272)),
    filesLayout:initialPreferences.filesLayout==='tree'?'tree':'list',
    changesExpanded:initialPreferences.changesExpanded!==false};
}
const languages:Record<string,string>={ts:'TypeScript',tsx:'TypeScript React',js:'JavaScript',jsx:'JavaScript React',rs:'Rust',json:'JSON',md:'Markdown',py:'Python',css:'CSS',html:'HTML',toml:'TOML',yml:'YAML',yaml:'YAML'};
const tools = ['open_repository','list_changes','get_diff','get_file','show_diff','get_review','add_comment','set_review_plan'];
const priorityOrder={validate:0,normal:1,low:2};
function contentFingerprint(file:FileContent) {return file.signature||fingerprint(file.images?.before?.dataUrl??file.before,file.images?.after?.dataUrl??file.after)}

export default function App() {
  const [snapshot,setSnapshot]=useState<Snapshot|null>(desktop?null:demoSnapshot());
  const [selected,setSelected]=useState(desktop?'':'src/mcp/server.ts');
  const [tabs,setTabs]=useState<string[]>(desktop?[]:['src/mcp/server.ts','src/review/workspace.ts']);
  const [file,setFile]=useState<FileContent|null>(null);
  const [review,setReview]=useState<Review>(desktop?emptyReview:demoReview);
  const [prefs,setPrefs]=useState<Preferences>(validatedPreferences);
  const [mode,setMode]=useState<Mode>('diff');
  const [filter,setFilter]=useState('');
  const [foldersCollapsed,setFoldersCollapsed]=useState(false);
  const [sidebar,setSidebar]=useState(()=>window.innerWidth>=900);
  const [reviewPanel,setReviewPanel]=useState(false);
  const [modal,setModal]=useState<'settings'|'agents'|'commands'|'commit'|'repository'|null>(null);
  const [settingsTab,setSettingsTab]=useState<'appearance'|'editor'|'shortcuts'>('appearance');
  const [agentType,setAgentType]=useState<'codex'|'claude'|'cursor'>('codex');
  const [connection,setConnection]=useState<Connection|null>(null);
  const [busy,setBusy]=useState(false);
  const [fileBusy,setFileBusy]=useState(false);
  const [error,setError]=useState('');
  const [fileError,setFileError]=useState('');
  const [toast,setToast]=useState('');
  const [commandQuery,setCommandQuery]=useState('');
  const [commandIndex,setCommandIndex]=useState(0);
  const [search,setSearch]=useState('');
  const [findOpen,setFindOpen]=useState(false);
  const [counts,setCounts]=useState({hunks:0,matches:0});
  const [commentLine,setCommentLine]=useState(1);
  const [commentSide,setCommentSide]=useState<'before'|'after'>('after');
  const [commentBody,setCommentBody]=useState('');
  const [commitMessage,setCommitMessage]=useState('');
  const [repoPath,setRepoPath]=useState('');
  const [revision,setRevision]=useState(0);
  const [recent,setRecent]=useState<string[]>(stored('patchwork.recent',[]));
  const [seenSignatures,setSeenSignatures]=useState<Record<string,string>>({});
  const diffRef=useRef<DiffHandle>(null);
  const treeRef=useRef<FileTreeHandle>(null);
  const fileFilter=useRef<HTMLInputElement>(null);
  const findInput=useRef<HTMLInputElement>(null);
  const commentInput=useRef<HTMLTextAreaElement>(null);
  const loadId=useRef(0);
  const snapshotRef=useRef(snapshot);
  const selectedRef=useRef(selected);
  const baseRef=useRef(snapshot?.base??'working');
  const busyRef=useRef(busy);
  const initialRef=useRef(false);
  const toastTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  snapshotRef.current=snapshot;selectedRef.current=selected;baseRef.current=snapshot?.base??'working';busyRef.current=busy;

  const notify=useCallback((message:string)=>{
    if(toastTimer.current)clearTimeout(toastTimer.current);
    setToast(message);toastTimer.current=setTimeout(()=>setToast(''),4200);
  },[]);
  useEffect(()=>()=>{if(toastTimer.current)clearTimeout(toastTimer.current)},[]);
  useEffect(()=>{document.documentElement.dataset.theme=prefs.theme;save('patchwork.preferences',prefs)},[prefs]);
  useEffect(()=>{
    const narrow=window.matchMedia('(max-width: 900px)');
    const changed=(e:MediaQueryListEvent)=>{if(e.matches)setSidebar(false)};
    narrow.addEventListener('change',changed);return ()=>narrow.removeEventListener('change',changed);
  },[]);
  useEffect(()=>{if(snapshot)document.title=`${snapshot.name} — Patchwork`},[snapshot?.name]);
  function preference<K extends keyof Preferences>(key:K,value:Preferences[K]) {setPrefs(p=>({...p,[key]:value}))}

  const selectFile=useCallback((path:string)=>{
    setSelected(path);setTabs(prev=>prev.includes(path)?prev:[...prev,path]);setFileError('');setSearch('');
    if(window.innerWidth<900)setSidebar(false);
  },[]);
  const load=useCallback(async (base=baseRef.current,path?:string)=>{
    const id=++loadId.current;setBusy(true);setError('');
    try {
      const next=await api<Snapshot>(path?'open_repository':'get_snapshot',path?{path,base}:{base});
      const feedback=await api<Review>('get_review',{base});
      if(id!==loadId.current)return;
      const switched=snapshotRef.current?.root!==next.root;
      setSnapshot(next);setReview(feedback);setRevision(v=>v+1);
      if(switched){setTabs([]);setSeenSignatures({});}
      const selection=!switched&&next.files.some(f=>f.path===selectedRef.current)?selectedRef.current:
        next.files.find(f=>feedback.plan[f.path]?.priority==='validate')?.path??next.files[0]?.path??'';
      setSelected(selection);if(selection)setTabs(prev=>prev.includes(selection)?prev:[...prev,selection]);
      if(path){setRecent(prev=>{const items=[next.root,...prev.filter(p=>p!==next.root)].slice(0,8);save('patchwork.recent',items);return items;});setModal(null);}
    }catch(e){if(id===loadId.current)setError(String(e));}
    finally{if(id===loadId.current)setBusy(false)}
  },[]);

  useEffect(()=>{
    if(initialRef.current)return;initialRef.current=true;
    if(desktop&&recent[0])void load('working',recent[0]);
    void api<Connection>('get_connection').then(setConnection).catch(e=>setError(String(e)));
  },[load,recent]);
  useEffect(()=>{
    if(!selected||!snapshot){setFile(null);return;}
    let active=true;setFileBusy(true);setFileError('');setCounts({hunks:0,matches:0});setFindOpen(false);
    void api<FileContent>('get_preview',{path:selected,base:snapshot.base}).then(next=>{
      if(!active)return;setFile(next);
      setSeenSignatures(prev=>({...prev,[next.path]:contentFingerprint(next)}));
    }).catch(e=>{if(active){setFile(null);setFileError(String(e))}}).finally(()=>{if(active)setFileBusy(false)});
    return ()=>{active=false};
  },[selected,snapshot?.root,snapshot?.base,snapshot?.baseCommit,snapshot?.files.find(f=>f.path===selected)?.signature,revision]);
  useEffect(()=>{
    if(!desktop)return;
    let active=true,inFlight=false;
    const timer=setInterval(async()=>{
      if(document.hidden||inFlight||busyRef.current)return;inFlight=true;
      try {
        const info=await api<Connection>('get_connection');if(active)setConnection(info);
        if(snapshotRef.current){
          const next=await api<Snapshot>('get_snapshot',{base:baseRef.current});
          if(active&&JSON.stringify(next)!==JSON.stringify(snapshotRef.current))setSnapshot(next);
        }
      }catch{/* Explicit refresh reports errors; background polling keeps the last readable state. */}
      finally{inFlight=false}
    },4000);
    return ()=>{active=false;clearInterval(timer)};
  },[]);
  useEffect(()=>{
    if(!desktop)return;
    let active=true;const disposers:(()=>void)[]=[];
    async function register() {
      const unlisten=await listen<ShowDiff>('show-diff',event=>{
        const context=event.payload;
        if(context.mode)setMode(context.mode);
        if(context.line)preference('context',-1);
        void load(context.base).then(()=>{
          if(context.path)selectFile(context.path);
          if(context.line)setTimeout(()=>diffRef.current?.line(context.line!),300);
        });
      });if(active)disposers.push(unlisten);else unlisten();
      const off=await listen<{path:string;base?:string}>('repository-opened',e=>void load(e.payload.base??'working',e.payload.path));
      if(active)disposers.push(off);else off();
      const reviewOff=await listen('review-updated',()=>{void api<Review>('get_review',{base:baseRef.current}).then(setReview).catch(e=>setError(String(e)))});
      if(active)disposers.push(reviewOff);else reviewOff();
    }
    void register().catch(e=>setError(String(e)));
    return ()=>{active=false;disposers.forEach(fn=>fn())};
  },[load,selectFile]);

  async function openRepository() {
    if(!desktop){setModal('repository');return;}
    try{const path=await open({directory:true,multiple:false,title:'Open a Git repository'});if(typeof path==='string')await load('working',path)}catch(e){setError(String(e))}
  }
  async function mutate(method:string,params:Record<string,unknown>,message?:string) {
    setBusy(true);setError('');
    try{await api(method,{...params,base:baseRef.current});await load();if(message)notify(message)}catch(e){setError(String(e))}finally{setBusy(false)}
  }
  function stageFile(path:string,staged:boolean) {void mutate('stage_file',{path,staged},`${path.split('/').at(-1)} ${staged?'staged':'unstaged'}`)}
  const current=snapshot?.files.find(f=>f.path===selected);
  const selectedPlan=review.plan[selected];
  const planStale=!!(selectedPlan?.signature&&current&&selectedPlan.signature!==current.signature);
  const orderedFiles=[...(snapshot?.files??[])].sort((a,b)=>priorityOrder[review.plan[a.path]?.priority??'normal']-priorityOrder[review.plan[b.path]?.priority??'normal']);
  const planCount=orderedFiles.filter(f=>review.plan[f.path]).length;
  async function clearPlan() {
    try{setReview(await api<Review>('set_review_plan',{base:baseRef.current,files:[]}));notify('Agent review plan cleared');}
    catch(e){setError(String(e))}
  }
  const validReviewed=Object.fromEntries(Object.entries(review.reviewed).filter(([path,hash])=>{
    const entry=snapshot?.files.find(f=>f.path===path);return entry?.signature===hash || (!entry?.signature && seenSignatures[path]===hash);
  }));
  const reviewedCount=snapshot?.files.filter(f=>validReviewed[f.path]).length??0;
  const isReviewed=!!(file&&review.reviewed[file.path]===(current?.signature??contentFingerprint(file)));
  const markReviewed=useCallback(async()=>{
    if(!file||!snapshot)return;
    try{const next=await api<Review>('set_reviewed',{path:selected,base:snapshot.base,reviewed:!isReviewed,fingerprint:current?.signature??contentFingerprint(file)});setReview(next);}
    catch(e){setError(String(e))}
  },[file,snapshot,selected,isReviewed,current?.signature]);
  function commentAt(line:number,side:'before'|'after') {setCommentLine(line);setCommentSide(side);setReviewPanel(true);setTimeout(()=>commentInput.current?.focus(),40)}
  async function addComment(e:React.FormEvent) {
    e.preventDefault();if(!commentBody.trim()||!selected)return;
    setBusy(true);
    try{setReview(await api<Review>('add_comment',{path:selected,line:commentLine,side:commentSide,body:commentBody.trim(),base:baseRef.current}));setCommentBody('');notify('Comment saved. Your agent can read it with get_review.');}
    catch(e){setError(String(e))}finally{setBusy(false)}
  }
  async function copy(value:string,message='Copied to clipboard') {try{await navigator.clipboard.writeText(value);notify(message)}catch{setError('Clipboard access is unavailable. Select and copy the text manually.')}}
  const onCounts=useCallback((hunks:number,matches:number)=>setCounts({hunks,matches}),[]);
  function closeTab(path:string) {
    setTabs(prev=>{const next=prev.filter(p=>p!==path);if(selected===path)setSelected(next.at(-1)??'');return next;});
  }
  function nextFile(direction:number) {
    const files=orderedFiles;if(!files.length)return;
    const index=files.findIndex(f=>f.path===selected);selectFile(files[(index+direction+files.length)%files.length].path);
  }

  const commands=[
    {title:'Open repository',detail:'Choose a local Git folder',shortcut:`${mod}+O`,icon:FolderOpen,action:()=>void openRepository()},
    {title:'Connect an agent',detail:'Configure Patchwork MCP',shortcut:'',icon:Plug,action:()=>setModal('agents')},
    {title:mode==='diff'?'Show full file':'Show diff',detail:'Switch the editor view',shortcut:'D',icon:FileCode2,action:()=>setMode(m=>m==='diff'?'file':'diff')},
    {title:prefs.layout==='split'?'Use unified diff':'Use split diff',detail:'Change the diff layout',shortcut:'',icon:Columns2,action:()=>preference('layout',prefs.layout==='split'?'unified':'split')},
    {title:isReviewed?'Mark as unreviewed':'Mark as reviewed',detail:'Track review progress',shortcut:'R',icon:CheckCheck,action:()=>void markReviewed()},
    {title:'Refresh changes',detail:'Read the current Git state',shortcut:`${mod}+Shift+R`,icon:RefreshCw,action:()=>void load()},
    {title:'Stage all changes',detail:'Add working changes to the index',shortcut:'',icon:Plus,action:()=>void mutate('stage_all',{staged:true},'All working changes staged')},
    {title:'Commit staged changes',detail:'Write a commit message',shortcut:'',icon:GitCommitHorizontal,action:()=>setModal('commit')},
    {title:'Appearance & settings',detail:'Theme, editor and shortcuts',shortcut:`${mod}+,`,icon:Palette,action:()=>setModal('settings')},
    {title:'Toggle file explorer',detail:'Make more room for code',shortcut:`${mod}+B`,icon:Files,action:()=>setSidebar(v=>!v)},
    {title:prefs.filesLayout==='tree'?'Show files without folders':'Show folder tree',detail:'Change the Changes list layout',shortcut:'',icon:List,action:()=>preference('filesLayout',prefs.filesLayout==='tree'?'list':'tree')},
    {title:prefs.changesExpanded?'Collapse changes':'Expand changes',detail:'Fold the changed file list',shortcut:'',icon:ChevronDown,action:()=>preference('changesExpanded',!prefs.changesExpanded)},
    {title:'Toggle review comments',detail:'Read and leave feedback',shortcut:'',icon:MessageSquare,action:()=>setReviewPanel(v=>!v)},
    ...(planCount?[{title:'Clear agent review plan',detail:'Remove suggested priorities for this comparison',shortcut:'',icon:X,action:()=>void clearPlan()}]:[]),
    ...orderedFiles.map(f=>({title:f.path,detail:review.plan[f.path]?.priority==='validate'?'Needs validation':review.plan[f.path]?.priority==='low'?'Lower priority':'Open changed file',shortcut:f.status,icon:FileCode2,action:()=>selectFile(f.path)})),
  ];
  const filteredCommands=commands.filter(c=>`${c.title} ${c.detail}`.toLowerCase().includes(commandQuery.toLowerCase()));
  useEffect(()=>{setCommandIndex(0)},[commandQuery]);
  useEffect(()=>{
    function keydown(e:KeyboardEvent) {
      const command=e.ctrlKey||e.metaKey;
      const editing=(e.target instanceof HTMLElement)&&(e.target.matches('input,textarea,select')||e.target.isContentEditable);
      if(command&&(e.key.toLowerCase()==='p'||e.key.toLowerCase()==='k')){e.preventDefault();setCommandQuery('');setCommandIndex(0);setModal(m=>m==='commands'?null:'commands');return;}
      if(command&&e.key===','){e.preventDefault();setModal('settings');return;}
      if(modal)return;
      if(command&&e.key.toLowerCase()==='o'){e.preventDefault();void openRepository();return;}
      if(command&&e.key.toLowerCase()==='b'){e.preventDefault();setSidebar(v=>!v);return;}
      if(command&&e.key.toLowerCase()==='f'){e.preventDefault();if(e.shiftKey){setSidebar(true);preference('changesExpanded',true);setTimeout(()=>fileFilter.current?.focus(),30)}else if(!file?.binary){setFindOpen(true);setTimeout(()=>findInput.current?.focus(),30)}return;}
      if(command&&e.shiftKey&&e.key.toLowerCase()==='r'){e.preventDefault();void load();return;}
      if(command&&e.key==='Enter'){e.preventDefault();setModal('commit');return;}
      if(e.key==='Escape'){setFindOpen(false);setSearch('');return;}
      if(editing)return;
      if(e.altKey&&(e.key==='ArrowDown'||e.key==='ArrowUp')){e.preventDefault();diffRef.current?.hunk(e.key==='ArrowDown'?1:-1);return;}
      if(!command&&!e.altKey){
        if(e.key==='j'){e.preventDefault();nextFile(1)}
        if(e.key==='k'){e.preventDefault();nextFile(-1)}
        if(e.key==='d')setMode(m=>m==='diff'?'file':'diff');
        if(e.key==='r')void markReviewed();
      }
    }
    window.addEventListener('keydown',keydown);return ()=>window.removeEventListener('keydown',keydown);
  });

  const visibleFiles=orderedFiles.filter(f=>f.path.toLowerCase().includes(filter.toLowerCase()));
  const additions=snapshot?.files.reduce((n,f)=>n+f.additions,0)??0;
  const deletions=snapshot?.files.reduce((n,f)=>n+f.deletions,0)??0;
  const selectedComments=review.comments.filter(c=>c.path===selected);
  const command=connection?.command??'patchwork';
  const configuration=agentType==='codex'?`[mcp_servers.patchwork]\ncommand = ${JSON.stringify(command)}\nargs = ["--mcp"]`:
    JSON.stringify({mcpServers:{patchwork:{command,args:['--mcp']}}},null,2);

  return <div className="app-shell">
    <header className="titlebar">
      <div className="brand"><img src="/logo.svg" alt="" width="27" height="27"/><span>patchwork<span className="brand-dot">.</span></span><span className="app-version">v{version}</span></div>
      <button className="workspace-switch" onClick={()=>void openRepository()} title="Open a repository"><FolderOpen size={14}/><span>{snapshot?.name??'Open workspace'}</span><ChevronDown size={12}/></button>
      <button className="command-trigger" onClick={()=>{setCommandQuery('');setModal('commands')}}><Search size={14}/><span>Find a file or run a command…</span><kbd>{mod} K</kbd></button>
      <div className="title-actions"><button className="connect-button" onClick={()=>setModal('agents')}><Plug size={14}/><span>{connection?.clients.length?`${connection.clients.length} agent${connection.clients.length===1?'':'s'}`:'Connect agent'}</span>{!!connection?.clients.length&&<span className="live-dot"/>}</button><button className="icon-button" title="Settings" aria-label="Settings" onClick={()=>setModal('settings')}><Settings2 size={16}/></button></div>
    </header>

    <div className="workspace">
      <nav className="activity-rail" aria-label="Workspace panels">
        <button className={sidebar?'active':''} title={`Files (${mod}+B)`} aria-label="Toggle file explorer" aria-pressed={sidebar} onClick={()=>setSidebar(v=>!v)}><Files size={21}/>{!!snapshot?.files.length&&<span className="activity-badge">{snapshot.files.length}</span>}</button>
        <button className={reviewPanel?'active':''} title="Review comments" aria-label="Toggle review comments" aria-pressed={reviewPanel} onClick={()=>setReviewPanel(v=>!v)}><MessageSquare size={20}/>{!!review.comments.length&&<span className="activity-badge">{review.comments.length}</span>}</button>
        <button className={modal==='agents'?'active':''} title="Agent connections" aria-label="Agent connections" onClick={()=>setModal('agents')}><Plug size={21}/></button>
        <div className="rail-spacer"/>
        <button title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={()=>{setSettingsTab('shortcuts');setModal('settings')}}><Keyboard size={20}/></button>
        <button title="Appearance" aria-label="Appearance" onClick={()=>{setSettingsTab('appearance');setModal('settings')}}><Palette size={20}/></button>
      </nav>

      {sidebar&&<aside className="explorer" style={{width:prefs.sidebarWidth}}>
        <div className="explorer-heading"><span>Explorer</span><div><button className="icon-button" title="Refresh changes" aria-label="Refresh changes" disabled={busy||!snapshot} onClick={()=>void load()}><RefreshCw size={14} className={busy?'spinning':''}/></button></div></div>
        <button className="repository-row" onClick={()=>void openRepository()}><FolderOpen size={16}/><span>{snapshot?.name??'No repository'}</span><ChevronDown size={13}/></button>
        {snapshot&&<div className="repository-branch"><GitBranch size={12}/><span>{snapshot.branch}</span></div>}
        <div className="changes-label"><button className="changes-toggle" aria-label={prefs.changesExpanded?'Collapse changes':'Expand changes'} aria-expanded={prefs.changesExpanded} aria-controls="changed-files" onClick={()=>preference('changesExpanded',!prefs.changesExpanded)}>
          {prefs.changesExpanded?<ChevronDown size={13}/>:<ChevronRight size={13}/>}<span>Changes</span><span className="count-badge">{snapshot?.files.length??0}</span></button>
          <div className="change-totals"><span className="added-text">+{additions}</span><span className="deleted-text">−{deletions}</span></div></div>
        <div id="changed-files" className="changes-content" hidden={!prefs.changesExpanded}>
          <div className="changes-view-bar"><div className="view-switch" role="group" aria-label="Changes layout">
            <button className={prefs.filesLayout==='tree'?'active':''} aria-pressed={prefs.filesLayout==='tree'} title="Group files into collapsible folders" onClick={()=>preference('filesLayout','tree')}><FolderTree size={13}/>Folders</button>
            <button className={prefs.filesLayout==='list'?'active':''} aria-pressed={prefs.filesLayout==='list'} title="Show files without folder rows" onClick={()=>preference('filesLayout','list')}><List size={13}/>Files</button>
          </div>{prefs.filesLayout==='tree'&&<button className="icon-button" title={filter?'Clear the filter to fold folders':foldersCollapsed?'Expand all folders':'Collapse all folders'} aria-label={foldersCollapsed?'Expand all folders':'Collapse all folders'} disabled={!!filter||!visibleFiles.some(f=>f.path.includes('/'))} onClick={()=>foldersCollapsed?treeRef.current?.expandAll():treeRef.current?.collapseAll()}>
            {foldersCollapsed?<ChevronsUpDown size={15}/>:<ChevronsDownUp size={15}/>}</button>}</div>
          <label className="file-filter"><Search size={13}/><input ref={fileFilter} value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Filter changed files…" aria-label="Filter changed files"/><span>{mod} ⇧ F</span></label>
          {!!planCount&&<div className="agent-plan-label"><Plug size={12}/><span>Agent review plan</span><button className="icon-button" title="Clear agent review plan" aria-label="Clear agent review plan" onClick={()=>void clearPlan()}><X size={12}/></button></div>}
          <div className="tree-scroll"><FileTree ref={treeRef} files={visibleFiles} selected={selected} reviewed={validReviewed} plan={review.plan} flat={prefs.filesLayout==='list'} filtering={!!filter} onSelect={selectFile} onStage={stageFile} onCollapseChange={setFoldersCollapsed}/></div>
        </div>
        <div className="explorer-bottom">
          {snapshot&&<><div className="review-progress-label"><span><CheckCheck size={13}/>Review progress</span><span>{reviewedCount} / {snapshot.files.length}</span></div><progress max={snapshot.files.length||1} value={reviewedCount} aria-label="Files reviewed"/>
          <div className="staging-row"><span><GitCommitHorizontal size={14}/>{snapshot.stagedCount} staged</span><button className="text-button" disabled={busy||!snapshot.files.length} onClick={()=>void mutate('stage_all',{staged:true},'All changes staged')}>Stage all<Plus size={12}/></button></div>
          <button className="commit-button" disabled={busy||!snapshot.stagedCount} onClick={()=>setModal('commit')}><GitCommitHorizontal size={14}/>Commit staged changes<span>{mod} ↵</span></button></>}
          <div className="local-note"><ShieldCheck size={12}/>Your code stays on your machine.</div>
        </div>
        <div className="sidebar-resize" role="separator" aria-label="Resize file explorer" aria-orientation="vertical" tabIndex={0}
          onKeyDown={e=>{if(e.key==='ArrowLeft')preference('sidebarWidth',Math.max(220,prefs.sidebarWidth-16));if(e.key==='ArrowRight')preference('sidebarWidth',Math.min(420,prefs.sidebarWidth+16));}}
          onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);const start=e.clientX,width=prefs.sidebarWidth;const target=e.currentTarget;
            const move=(event:PointerEvent)=>preference('sidebarWidth',Math.max(220,Math.min(420,width+event.clientX-start)));
            const up=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',up)};target.addEventListener('pointermove',move);target.addEventListener('pointerup',up);}}/>
      </aside>}

      <main className="editor-workspace">
        <div className="comparison-bar"><button className="icon-button sidebar-toggle" title="Toggle file explorer" aria-label="Toggle file explorer" onClick={()=>setSidebar(v=>!v)}>{sidebar?<PanelLeftClose size={15}/>:<PanelLeftOpen size={15}/>}</button>
          <div className="comparison-label"><GitCompareArrows size={15}/><span>Compare</span></div>
          <label className="base-select"><select aria-label="Comparison base" disabled={!snapshot||busy} value={snapshot?.base??'working'} onChange={e=>void load(e.target.value)}>
            <option value="working">Working tree</option><option value="staged">Staged changes</option>
            {(snapshot?.branches??[]).map(branch=><option key={branch} value={branch}>{branch}</option>)}
          </select><ChevronDown size={12}/></label><ChevronRight size={13} className="comparison-arrow"/><span className="branch-label"><GitBranch size={13}/>{snapshot?.branch??'HEAD'}</span>
          <span className="comparison-spacer"/><span className="comparison-note">{snapshot?.base==='working'?'Uncommitted changes':snapshot?.base==='staged'?'Ready to commit':'From common ancestor'}</span>
          {!desktop&&<span className="demo-badge">Demo workspace</span>}
        </div>
        {error&&<div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={()=>setError('')}><X size={14}/></button></div>}
        <div className="file-tabs" role="tablist" aria-label="Open files">
          {tabs.map(path=><div className={`file-tab ${selected===path?'active':''}`} key={path}>
            <button role="tab" aria-selected={selected===path} title={path} onClick={()=>selectFile(path)}><FileIcon path={path} size={14}/><span>{path.split('/').at(-1)}</span>{validReviewed[path]&&<Check size={12} className="reviewed-icon"/>}</button>
            <button className="tab-close" title="Close tab" aria-label={`Close ${path.split('/').at(-1)}`} onClick={()=>closeTab(path)}><X size={12}/></button>
          </div>)}
          <span className="tabs-spacer"/>{snapshot&&<span className="tabs-hint">{snapshot.files.length} changed files</span>}
        </div>

        {selected&&snapshot?<>
          <div className="editor-toolbar"><div className="breadcrumbs">{selected.split('/').map((part,i,parts)=><span key={i}>{i>0&&<ChevronRight size={11}/>}<span className={i===parts.length-1?'current-crumb':''}>{part}</span></span>)}</div>
            <div className="view-switch" aria-label="Editor view"><button className={mode==='diff'?'active':''} aria-pressed={mode==='diff'} onClick={()=>setMode('diff')}>Diff</button><button className={mode==='file'?'active':''} aria-pressed={mode==='file'} onClick={()=>setMode('file')}>Full file</button></div>
            <div className="toolbar-divider"/>
            <button className={`icon-button ${prefs.layout==='split'?'selected-tool':''}`} title={prefs.layout==='split'?'Switch to unified diff':'Switch to split diff'} aria-label="Toggle split or unified diff" disabled={mode==='file'} onClick={()=>preference('layout',prefs.layout==='split'?'unified':'split')}><Columns2 size={15}/></button>
            <button className={`icon-button ${prefs.wrap?'selected-tool':''}`} title="Toggle word wrap" aria-label="Toggle word wrap" aria-pressed={prefs.wrap} disabled={file?.binary} onClick={()=>preference('wrap',!prefs.wrap)}><WrapText size={16}/></button>
            <button className="icon-button" title="Copy file contents" aria-label="Copy file contents" disabled={!file||fileBusy||file.binary} onClick={()=>void copy(file!.after)}><Copy size={14}/></button>
            <button className="icon-button" title="Find in file" aria-label="Find in file" disabled={file?.binary} onClick={()=>{setFindOpen(v=>!v);setTimeout(()=>findInput.current?.focus(),30)}}><Search size={14}/></button>
          </div>
          <div className="file-info-bar"><FileIcon path={selected} size={14}/><span className="file-info-name">{selected.split('/').at(-1)}</span><span className={`change-type status-${current?.status}`}>{({A:'Added',M:'Modified',D:'Deleted',R:'Renamed'} as Record<string,string>)[current?.status??'']??'File'}</span>
            {current&&(current.binary?<span className="hunk-count">Binary change</span>:<><span className="added-text">+{current.additions}</span><span className="deleted-text">−{current.deletions}</span></>)}
            <span className="comparison-spacer"/><span className="hunk-count">{file?.images?'Image comparison':`${counts.hunks} ${counts.hunks===1?'change':'changes'}`}</span>
            <button className="icon-button" title="Previous change (Alt+↑)" aria-label="Previous change" onClick={()=>diffRef.current?.hunk(-1)} disabled={!counts.hunks}><ArrowUp size={14}/></button>
            <button className="icon-button" title="Next change (Alt+↓)" aria-label="Next change" onClick={()=>diffRef.current?.hunk(1)} disabled={!counts.hunks}><ArrowDown size={14}/></button>
            <div className="toolbar-divider"/>
            <button className={`review-button ${isReviewed?'is-reviewed':''}`} disabled={!file||fileBusy} onClick={()=>void markReviewed()} title="Toggle reviewed (R)">{isReviewed?<CheckCheck size={14}/>:<Check size={14}/>}<span>{isReviewed?'Reviewed':'Mark reviewed'}</span></button>
          </div>
          {selectedPlan&&<div className={`review-priority-bar priority-${selectedPlan.priority}`}>
            <div>{selectedPlan.priority==='validate'?<ShieldCheck size={14}/>:selectedPlan.priority==='low'?<ArrowDown size={14}/>:<Plug size={14}/>}
              <strong>{selectedPlan.priority==='validate'?'Needs your validation':selectedPlan.priority==='low'?'Lower priority':'Review note'}</strong>
              <span>Suggested by {selectedPlan.author}</span>
              {planStale&&<span className="plan-stale">Changed since this assessment</span>}
            </div>
            {selectedPlan.reason&&<p>{selectedPlan.reason}</p>}
          </div>}
          {findOpen&&!file?.binary&&<div className="find-bar"><Search size={14}/><input ref={findInput} autoFocus placeholder="Find in this file…" aria-label="Find in this file" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')diffRef.current?.find(e.shiftKey?-1:1)}}/><span>{counts.matches} matching lines</span><button className="icon-button" aria-label="Previous match" onClick={()=>diffRef.current?.find(-1)}><ArrowUp size={14}/></button><button className="icon-button" aria-label="Next match" onClick={()=>diffRef.current?.find(1)}><ArrowDown size={14}/></button><button className="icon-button" aria-label="Close find" onClick={()=>{setFindOpen(false);setSearch('')}}><X size={14}/></button></div>}
          {fileBusy||(!!file&&file.path!==selected)?<div className="code-skeleton" aria-label="Loading file">{Array.from({length:16},(_,i)=><div key={i} style={{width:`${[44,62,38,75,56,30][i%6]}%`}}/>)}</div>:
            fileError?<div className="editor-empty"><FileCode2 size={32}/><h2>Could not read this file</h2><p>{fileError}</p><button className="primary-button" onClick={()=>setRevision(v=>v+1)}>Try again</button></div>:
            file&&(file.images?<ImagePreview key={`${snapshot.root}:${snapshot.base}:${file.path}`} file={file} mode={mode} layout={prefs.layout}/>:<DiffView ref={diffRef} file={file} mode={mode} preferences={prefs} search={search} comments={selectedComments} onLine={commentAt} onCounts={onCounts}/>)}
          <div className="editor-footnote"><span><MessageSquare size={12}/>{file?.images?'Open Review to leave feedback on this image':'Click a line number to leave a review comment'}</span><span><kbd>J</kbd><kbd>K</kbd> files <span className="hint-divider">/</span><kbd>D</kbd> full file <span className="hint-divider">/</span><kbd>R</kbd> reviewed</span></div>
        </>:<div className="welcome-screen"><div className="welcome-mark"><Braces size={58}/><span>+</span></div><span className="welcome-product">patchwork.</span><h1>{snapshot?'A little clarity between commits.':'Your agent writes. You see the whole picture.'}</h1><p>{snapshot?(snapshot.files.length?'Choose a file to start reviewing the changes.':'The comparison is clean. Switch the base to review branch changes.'):'Open a Git repository, connect your agent, and make every change a little easier to understand.'}</p>
          <div className="welcome-actions"><button className="primary-button" onClick={()=>void openRepository()}><FolderOpen size={16}/>Open repository<kbd>{mod} O</kbd></button><button className="secondary-button" onClick={()=>setModal('agents')}><Plug size={16}/>Connect an agent</button></div>
          {recent.length>0&&<div className="recent-repos"><h3>Recent workspaces</h3>{recent.map(path=><button key={path} onClick={()=>void load('working',path)}><FolderOpen size={14}/><span>{path.split(/[\\/]/).at(-1)}</span><small>{path}</small><ChevronRight size={12}/></button>)}</div>}
          <div className="welcome-bottom"><SquareTerminal size={14}/>Built for the space between your spec and your next commit.</div>
        </div>}
      </main>

      {reviewPanel&&<aside className="review-panel"><div className="review-panel-header"><MessageSquare size={15}/><h2>Review</h2><span className="count-badge">{review.comments.length}</span><button className="icon-button" aria-label="Close review panel" onClick={()=>setReviewPanel(false)}><X size={14}/></button></div>
        <div className="review-panel-body"><div className="review-context"><span>Feedback for your agent</span><p>Comments stay with this repository and comparison. Your agent reads them through MCP.</p></div>
          {review.comments.length===0&&<div className="comments-empty"><MessageSquare size={24}/><p>A second pair of eyes,<br/>with something to say.</p><span>Click any line number to add a comment.</span></div>}
          {review.comments.map(comment=><article className="review-comment" key={comment.id}><button className="comment-location" onClick={()=>{selectFile(comment.path);preference('context',-1);setTimeout(()=>diffRef.current?.line(comment.line,comment.side),250)}}><FileIcon path={comment.path} size={12}/><span>{comment.path.split('/').at(-1)}:{comment.line}</span><small>{comment.side==='before'?'original':'modified'}</small></button><p>{comment.body}</p><footer><span>{comment.author}</span><time dateTime={new Date(comment.createdAt*1000).toISOString()}>{new Date(comment.createdAt*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time><button className="icon-button" aria-label="Delete comment" title="Delete comment" onClick={()=>void api<Review>('delete_comment',{id:comment.id,base:baseRef.current}).then(setReview).catch(e=>setError(String(e)))}><X size={12}/></button></footer></article>)}
        </div>
        {selected&&<form className="comment-form" onSubmit={e=>void addComment(e)}><div className="comment-form-location"><span>{selected.split('/').at(-1)}</span><label>Line<input aria-label="Comment line" type="number" min={1} value={commentLine} onChange={e=>setCommentLine(Math.max(1,Number(e.target.value)))}/></label><select aria-label="Comment side" value={commentSide} onChange={e=>setCommentSide(e.target.value as 'before'|'after')}><option value="after">Modified</option><option value="before">Original</option></select></div><textarea ref={commentInput} value={commentBody} onChange={e=>setCommentBody(e.target.value)} aria-label="Review comment" placeholder="What should your agent look at?" rows={4} maxLength={20000}/><button className="primary-button" disabled={!commentBody.trim()||busy}><MessageSquare size={13}/>Add comment</button></form>}
        <button className="export-review" disabled={!review.comments.length} onClick={()=>void copy(review.comments.map(c=>`${c.path}:${c.line} (${c.side})\n${c.body}`).join('\n\n'),'Review feedback copied')}><Copy size={13}/>Copy feedback for agent</button>
      </aside>}
    </div>

    <footer className="statusbar"><div><GitBranch size={12}/><span>{snapshot?.branch??'No repository'}</span>{snapshot&&<><span className="status-separator"/><span>{snapshot.files.length} changed</span><span className="added-text">+{additions}</span><span className="deleted-text">−{deletions}</span></>}</div>
      <div className="status-middle"><ShieldCheck size={11}/>Local workspace</div><div><button onClick={()=>setModal('agents')}><span className={`status-dot ${connection?.available?'ready':''}`}/>{desktop?(connection?.available?'MCP ready':'MCP unavailable'):'MCP · desktop required'}</button><span className="status-separator"/><span>{file?languages[file.language]??file.language.toUpperCase():'Patchwork'}</span><span>{file?.images?'Image':file?.binary?'Binary':'UTF-8'}</span><button onClick={()=>{setSettingsTab('appearance');setModal('settings')}}><Palette size={11}/>{themeNames[prefs.theme]}</button></div>
    </footer>

    {toast&&<div className="toast" role="status"><Check size={15}/><span>{toast}</span><button aria-label="Dismiss notification" onClick={()=>setToast('')}><X size={13}/></button></div>}

    {modal==='commands'&&<Modal title="Command palette" onClose={()=>setModal(null)} wide><div className="command-search"><Command size={18}/><input autoFocus value={commandQuery} onChange={e=>setCommandQuery(e.target.value)} placeholder="Find a file or run a command…" aria-label="Search commands" onKeyDown={e=>{
      if(e.key==='ArrowDown'){e.preventDefault();setCommandIndex(i=>Math.min(filteredCommands.length-1,i+1));}
      if(e.key==='ArrowUp'){e.preventDefault();setCommandIndex(i=>Math.max(0,i-1));}
      if(e.key==='Enter'&&filteredCommands[commandIndex]){e.preventDefault();setModal(null);filteredCommands[commandIndex].action();}
    }}/><kbd>esc</kbd></div><div className="command-list">{filteredCommands.length?filteredCommands.map((item,i)=><button key={item.title} className={i===commandIndex?'selected':''} onMouseEnter={()=>setCommandIndex(i)} onClick={()=>{setModal(null);item.action();}}><item.icon size={16}/><div><span>{item.title}</span><small>{item.detail}</small></div><kbd>{item.shortcut}</kbd></button>):<p className="command-no-results">No matching files or commands.</p>}</div><div className="command-footer"><span>↑ ↓ to navigate</span><span>↵ to select</span><span>esc to close</span></div></Modal>}

    {modal==='settings'&&<Modal title="Make yourself at home." subtitle="A workspace that feels like yours." onClose={()=>setModal(null)} wide>
      <div className="settings-tabs">{(['appearance','editor','shortcuts'] as const).map(tab=><button key={tab} className={settingsTab===tab?'active':''} onClick={()=>setSettingsTab(tab)}>{tab==='appearance'?<Palette size={14}/>:tab==='editor'?<FileCode2 size={14}/>:<Keyboard size={14}/>}<span>{tab[0].toUpperCase()+tab.slice(1)}</span></button>)}</div>
      <div className="settings-content">{settingsTab==='appearance'?<><div className="setting-intro"><h3>Color theme</h3><p>The same focus, in a different light.</p></div><div className="theme-options">{(Object.keys(themeNames) as Preferences['theme'][]).map(theme=><button key={theme} className={`theme-option ${prefs.theme===theme?'selected':''}`} onClick={()=>preference('theme',theme)} aria-pressed={prefs.theme===theme}>
        <div className="theme-preview" data-preview={theme}><div className="preview-sidebar"><i/><i/><i/></div><div className="preview-code"><i/><i/><i/><i/><i/></div></div><span>{themeNames[theme]}{prefs.theme===theme&&<Check size={14}/>}</span></button>)}</div><div className="setting-row"><div><label htmlFor="code-size">Code font size</label><p>Give long reviews a little breathing room.</p></div><div className="number-stepper"><button aria-label="Decrease code font size" disabled={prefs.fontSize<=11} onClick={()=>preference('fontSize',prefs.fontSize-1)}><Minus size={13}/></button><output id="code-size">{prefs.fontSize}px</output><button aria-label="Increase code font size" disabled={prefs.fontSize>=18} onClick={()=>preference('fontSize',prefs.fontSize+1)}><Plus size={13}/></button></div></div></>:
        settingsTab==='editor'?<><div className="setting-row"><div><label htmlFor="diff-layout">Default diff layout</label><p>Read changes side by side or in one column.</p></div><select id="diff-layout" value={prefs.layout} onChange={e=>preference('layout',e.target.value as Preferences['layout'])}><option value="split">Side by side</option><option value="unified">Unified</option></select></div><div className="setting-row"><div><label htmlFor="diff-context">Unchanged context</label><p>Full file mode always shows every line.</p></div><select id="diff-context" value={prefs.context} onChange={e=>preference('context',Number(e.target.value))}><option value={3}>3 lines</option><option value={4}>4 lines</option><option value={8}>8 lines</option><option value={-1}>All lines</option></select></div><div className="setting-row"><div><label htmlFor="word-wrap">Word wrap</label><p>Keep long lines inside the editor.</p></div><input id="word-wrap" type="checkbox" checked={prefs.wrap} onChange={e=>preference('wrap',e.target.checked)}/></div></>:
        <div className="shortcut-list">{[[`${mod} K / ${mod} P`,'Find files and commands'],[`${mod} O`,'Open a repository'],[`${mod} B`,'Toggle file explorer'],[`${mod} F`,'Find in file'],[`${mod} Shift F`,'Filter changed files'],[`${mod} Shift R`,'Refresh changes'],[`${mod} ,`,'Settings'],['J / K','Next / previous file'],['Alt ↓ / Alt ↑','Next / previous change'],['D','Switch diff / full file'],['R','Mark file reviewed']].map(([key,label])=><div key={key}><span>{label}</span><kbd>{key}</kbd></div>)}</div>}
      </div><div className="settings-footer"><span><Check size={13}/>Preferences save automatically</span><button className="secondary-button" onClick={()=>setPrefs(defaults)}>Reset defaults</button></div>
    </Modal>}

    {modal==='agents'&&<Modal title="Your agent. Your workspace." subtitle="Connect once. Review right where the work happens." onClose={()=>setModal(null)} wide>
      <div className="agent-modal-content">{!desktop&&<div className="demo-notice">This is example configuration. The desktop app supplies its exact executable path and live connections.</div>}
      {connection?.error&&<div className="demo-notice">MCP could not start: {connection.error}</div>}
      <div className="agent-status"><div className="agent-status-icon"><Plug size={20}/></div><div><strong>{connection?.clients.length?'Connected agents':connection?.available?'MCP is ready':'Connect from the desktop app'}</strong><span>{connection?.clients.length?connection.clients.map(c=>c.name).join(', '):'Local stdio transport · no account or API key'}</span></div><span className={`connection-pill ${connection?.available?'ready':''}`}>{connection?.clients.length?'Connected':connection?.available?'Listening':'Preview'}</span></div>
      <div className="agent-type-tabs">{(['codex','claude','cursor'] as const).map(type=><button className={type===agentType?'active':''} key={type} onClick={()=>setAgentType(type)}>{type==='codex'?<SquareTerminal size={15}/>:type==='claude'?<Command size={15}/>:<Menu size={15}/>}<span>{type==='codex'?'Codex':type==='claude'?'Claude Desktop':'Cursor'}</span></button>)}</div>
      <div className="agent-instruction"><span className="step-number">1</span><div><strong>Add Patchwork to your MCP configuration</strong><p>{agentType==='codex'?<>Append this to <code>~/.codex/config.toml</code>.</>:agentType==='cursor'?<>Merge this server into <code>~/.cursor/mcp.json</code>.</>:<>Merge this server into <code>claude_desktop_config.json</code>.</>}</p></div></div>
      <div className="configuration-block"><div><span>{agentType==='codex'?'config.toml':'MCP configuration'}</span><button className="text-button" onClick={()=>void copy(configuration,'MCP configuration copied')}><Copy size={13}/>Copy config</button></div><pre>{configuration}</pre></div>
      <div className="agent-instruction"><span className="step-number">2</span><div><strong>Restart the agent’s MCP connection</strong><p>Keep Patchwork open. The connected agent appears here after its handshake.</p></div></div>
      <div className="agent-instruction"><span className="step-number">3</span><div><strong>Let the agent bring you to the change</strong><p>“Open this repository in Patchwork and show me the diff against main.”</p></div></div>
      <details className="mcp-tools"><summary><Braces size={14}/>{tools.length} available tools<ChevronDown size={13}/></summary><div>{tools.map(tool=><code key={tool}>{tool}</code>)}</div></details>
      {connection?.clients.map(client=><div className="connected-agent" key={client.id}><span className="live-dot"/><strong>{client.name}</strong><span>{client.version}</span><small>Connected</small></div>)}
      <div className="agent-privacy"><ShieldCheck size={14}/><span>Agent tools read code and exchange review notes. Git writes happen through your controls in Patchwork.</span></div></div>
    </Modal>}

    {modal==='commit'&&<Modal title="Give this change a name." subtitle={`${snapshot?.stagedCount??0} staged files in ${snapshot?.name??'your repository'}`} onClose={()=>setModal(null)}>
      <form className="commit-form" onSubmit={async e=>{e.preventDefault();if(!commitMessage.trim())return;setBusy(true);setError('');try{const result=await api<{message:string}>('commit',{message:commitMessage});setCommitMessage('');setModal(null);await load();notify(result.message);}catch(e){setError(String(e));setModal(null);}finally{setBusy(false)}}}>
        {!desktop&&<div className="demo-notice">Demo commit: no local Git repository will be changed.</div>}
        <label htmlFor="commit-message">Commit message</label><textarea id="commit-message" autoFocus value={commitMessage} onChange={e=>setCommitMessage(e.target.value)} placeholder="feat: connect agent reviews through MCP" rows={4} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
        <div className="commit-file-list">{snapshot?.files.filter(f=>f.staged).map(f=><div key={f.path}><FileIcon path={f.path} size={14}/><span>{f.path}</span><span className={`status-${f.status}`}>{f.status}</span></div>)}</div>
        <div className="commit-form-actions"><button type="button" className="secondary-button" onClick={()=>setModal(null)}>Cancel</button><button className="primary-button" disabled={!commitMessage.trim()||!snapshot?.stagedCount||busy}>{busy?<LoaderCircle size={14} className="spinning"/>:<GitCommitHorizontal size={14}/>}Commit {snapshot?.stagedCount??0} files</button></div>
      </form>
    </Modal>}

    {modal==='repository'&&<Modal title="Open your workspace." subtitle="Choose a local Git repository in the desktop app." onClose={()=>setModal(null)}>
      <form className="repository-form" onSubmit={e=>{e.preventDefault();void load('working',repoPath)}}>{!desktop&&<div className="demo-notice">The browser preview uses a sample repository. To inspect your files, launch the desktop app with npm run desktop.</div>}<label htmlFor="repository-path">Repository path</label><input id="repository-path" autoFocus placeholder="C:\Projects\your-repo or /Users/you/your-repo" value={repoPath} onChange={e=>setRepoPath(e.target.value)}/><div className="commit-form-actions"><button type="button" className="secondary-button" onClick={()=>setModal(null)}>Back to workspace</button><button className="primary-button" disabled={!desktop||!repoPath.trim()||busy}><FolderOpen size={14}/>Open repository</button></div></form>
    </Modal>}
  </div>;
}
