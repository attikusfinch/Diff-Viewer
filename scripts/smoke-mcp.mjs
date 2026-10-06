import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';

// This smoke test uses only an isolated test repository and isolated review data.
const root = process.cwd();
const directory = path.join(root, '.qa');
const runId=Date.now().toString(36);
const repository = path.join(directory, `smoke-repo-${runId}`);
const data = path.join(directory, `data-${runId}`);
const executable = process.argv[2] ?? path.join(root,'src-tauri','target','release',process.platform==='win32'?'patchwork.exe':'patchwork');
await mkdir(repository,{recursive:true});
await mkdir(data,{recursive:true});
function git(...args) { return execFileSync('git',['-C',repository,...args],{windowsHide:true,encoding:'utf8'}).trim(); }
git('init','-b','main');
git('config','user.name','Patchwork QA');git('config','user.email','qa@patchwork.local');
git('config','core.autocrlf','false');git('config','commit.gpgsign','false');
await writeFile(path.join(repository,'hello.ts'),'export const greeting = "hello";\n');
git('add','.');
if(!git('status','--porcelain').trim()) { /* A repeated smoke run may reuse its already committed fixture. */ }
else git('commit','-m','test: initial fixture');
await writeFile(path.join(repository,'hello.ts'),'export const greeting = "hello, agent";\n');
await writeFile(path.join(repository,'new file.txt'),'A new file\n');
const env={...process.env,PATCHWORK_DATA_DIR:data};
const desktop=spawn(executable,[],{env,windowsHide:true,stdio:'ignore'});
let client;
try {
  for(let i=0;i<60;i++) {
    try{await readFile(path.join(data,'bridge.json'));break}catch{}
    if(desktop.exitCode!==null)throw new Error(`Desktop exited with ${desktop.exitCode}`);
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  client=spawn(executable,['--mcp'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let sequence=0;
  createInterface({input:client.stdout}).on('line',line=>{
    const response=JSON.parse(line);const item=pending.get(response.id);
    if(item){clearTimeout(item.timeout);pending.delete(response.id);item.resolve(response);}
  });
  function call(method,params={}) {
    return new Promise((resolve,reject)=>{
      const id=++sequence;
      const timeout=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${method}`))},15000);
      pending.set(id,{resolve,reject,timeout});
      client.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  }
  async function tool(name,args={}) {
    const response=await call('tools/call',{name,arguments:args});
    assert.ok(!response.error,JSON.stringify(response.error));
    assert.equal(response.result.isError,false,response.result.content[0].text);
    return JSON.parse(response.result.content[0].text);
  }
  const init=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Patchwork QA',version:'1.0'}});
  assert.equal(init.result.serverInfo.name,'patchwork');
  client.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list=await call('tools/list');assert.equal(list.result.tools.length,8);
  assert.equal(list.result.tools.find(t=>t.name==='set_review_plan').annotations.readOnlyHint,false);
  const opened=await tool('open_repository',{path:repository});assert.equal(opened.name,path.basename(repository));
  const changes=await tool('list_changes');assert.equal(changes.files.length,2);
  assert.equal(changes.files.find(f=>f.path==='hello.ts').additions,1);
  assert.equal(changes.files.find(f=>f.path==='hello.ts').deletions,1);
  assert.equal(changes.files.find(f=>f.path==='new file.txt').additions,1);
  const plan=await tool('set_review_plan',{files:[
    {path:'hello.ts',priority:'validate',reason:'Validate the greeting against the spec.'},
    {path:'new file.txt',priority:'low',reason:'Documentation only.'},
  ]});
  assert.equal(plan.plan['hello.ts'].priority,'validate');
  assert.equal(plan.plan['hello.ts'].author,'Patchwork QA');
  assert.equal(plan.plan['hello.ts'].signature,changes.files.find(f=>f.path==='hello.ts').signature);
  assert.equal(plan.plan['new file.txt'].priority,'low');
  for(const files of [
    [{path:'hello.ts',priority:'low'},{path:'missing.ts',priority:'validate'}],
    [{path:'hello.ts',priority:'wrong'}],
    [{path:'../data/bridge.json',priority:'low'}],
  ]) {
    const rejected=await call('tools/call',{name:'set_review_plan',arguments:{files}});
    assert.equal(rejected.result.isError,true);
    assert.deepEqual((await tool('get_review')).plan,plan.plan);
  }
  await writeFile(path.join(repository,'hello.ts'),'export const greeting = "hello, reviewer";\n');
  const changed=await tool('list_changes');
  assert.notEqual(changed.files.find(f=>f.path==='hello.ts').signature,plan.plan['hello.ts'].signature);
  assert.deepEqual((await tool('get_review')).plan,plan.plan);
  const contents=await tool('get_file',{path:'hello.ts'});assert.match(contents.after,/hello, reviewer/);
  const diff=await tool('get_diff',{path:'hello.ts'});assert.match(diff.patch,/\+export const greeting/);
  const untracked=await tool('get_diff',{path:'new file.txt'});assert.match(untracked.patch,/\+A new file/);
  const shown=await tool('show_diff',{path:'hello.ts',line:1,mode:'file'});assert.equal(shown.opened,true);
  const review=await tool('add_comment',{path:'hello.ts',line:1,body:'Consider making the greeting configurable.',author:'QA'});
  assert.ok(review.comments.some(c=>c.body==='Consider making the greeting configurable.'));
  assert.equal((await tool('get_review')).comments.length,review.comments.length);
  const denied=await call('tools/call',{name:'get_file',arguments:{path:'../data/bridge.json'}});
  assert.equal(denied.result.isError,true);
  const unsupported=await call('tools/call',{name:'commit',arguments:{message:'not allowed'}});
  assert.equal(unsupported.error.code,-32602);
  client.stdin.write('{broken json\n');
  // A malformed request must not terminate the bridge.
  assert.deepEqual((await call('ping')).result,{});
  const saved=JSON.parse(await readFile(path.join(data,'reviews.json'),'utf8'));
  assert.ok(Object.keys(saved).length>0);
  assert.deepEqual(Object.values(saved)[0].plan,plan.plan);
  if(!process.argv.includes('--keep-open')) {
    assert.deepEqual((await tool('set_review_plan',{files:[]})).plan,{});
    assert.equal((await tool('get_review')).comments.length,review.comments.length);
  }
  console.log('MCP smoke passed: all 8 tools, line counts, priorities, validation, stale assessments, atomic plan updates, source reads, show_diff, comments and persistence.');
}finally{
  client?.stdin.end();
  setTimeout(()=>client?.kill(),250).unref();
  if(process.argv.includes('--keep-open')) { console.log(`Native QA window remains open (PID ${desktop.pid}). Close the window to finish this test.`); }
  else desktop.kill();
}
