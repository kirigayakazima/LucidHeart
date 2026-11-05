import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildShape } from '../core.mjs';
import { scoreNode } from '../scoring.mjs';

const NOW = '2026-11-04T12:00:00Z';
const toolDir = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-shape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const heartDir = path.join(root, 'heart'), memoryDir = path.join(root, 'memory'), archive = path.join(root, 'archive');
  for (const d of [heartDir, memoryDir, archive]) fs.mkdirSync(d);
  function write(rel, text) { const p=path.join(root,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text); }
  const entry = (id, props={}) => ({ id, kind:'fact',scope:'xiaoman_private',status:'active',content:id,
    confidence:1,createdAt:NOW,validFrom:NOW,source:{},...props });
  const journal = (records) => records.map(([action,e])=>JSON.stringify({action,entry:e})).join('\n')+'\n';
  write('memory/journal.jsonl','');write('archive/journal.jsonl','');
  return { root,heartDir,memoryDir,archive,write,entry,journal,
    run:(opts={})=>buildShape({heartDir,memoryDir,scope:'xiaoman_private',now:NOW,...opts}) };
}
function fingerprint(root) {
  const out={};
  function walk(d) { for(const name of fs.readdirSync(d).sort()) {const p=path.join(d,name),s=fs.statSync(p);if(s.isDirectory())walk(p);else out[path.relative(root,p)]={hash:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),mtime:s.mtimeMs};} }
  walk(root);return out;
}
test('five sources, explicit layers, UTF-8 provenance and no writes or SQLite sidecars', t=>{
  const f=fixture(t);
  f.write('heart/notebook.md','# 本子\n- 2026-11-03 认真听完再说\n');
  f.write('heart/facts.md','- 历史偏好，不能充当当前事实\n');
  f.write('heart/MEMORY/2026-11-03.phone.md','- 20:30 [phone] 自己记下的一件事 · src:abc12345 via:self\n- 21:30 [phone] 一起聊的一件事 · src:def12345 via:chat\n');
  f.write('heart/src-index.json',JSON.stringify({abc12345:{session:'abc12345-full'}}));
  f.write('heart/dream/insights.json',JSON.stringify([{id:'d1',statement:'也许应该晚点说',category:'communication',type:'hypothesis',status:'candidate',confidence:.7}]));
  f.write('memory/journal.jsonl',f.journal([['create',f.entry('new',{content:'这是当前偏好',kind:'preference'})]]));
  const before=fingerprint(f.root), r=f.run();
  assert.deepEqual(fingerprint(f.root),before);
  assert.equal(r.complete,true);assert.equal(r.nodes.length,6);
  assert.deepEqual(new Set(r.nodes.map(n=>n.layer)),new Set(['principles','legacy','dream','current']));
  const episode=r.nodes.find(n=>n.session==='abc12345-full');
  assert.equal(episode.via,'self');assert.equal(episode.t,'2026-11-03T12:30:00.000Z');
  assert.equal(r.nodes.filter(n=>n.score.eligibleForRecall).length,1);
  assert.ok(r.sources.every(s=>s.sha256.length===64));
});
test('journal replay suppresses revoked/superseded text and scopes; never double-count facts.md', t=>{
  const f=fixture(t), old=f.entry('old'), updated=f.entry('new',{supersedesId:'old'}), revoked=f.entry('forgotten',{content:'REVOKED_SECRET'});
  f.write('memory/journal.jsonl',f.journal([['create',old],['supersede',updated],['create',revoked],['revoke',{...revoked,status:'revoked'}],['create',f.entry('sister',{scope:'axing_private'})],['create',f.entry('shared',{scope:'shared'})]]));
  f.write('memory/facts.md','- REVOKED_SECRET stale derived view\n');
  const r=f.run();
  assert.deepEqual(r.nodes.map(n=>n.sourceId).sort(),['new','shared']);
  assert.equal(r.omitted.revoked,1);assert.equal(r.omitted.superseded,1);assert.equal(r.omitted.otherScope,1);
  assert.ok(!JSON.stringify(r).includes('REVOKED_SECRET'));
});
test('malformed or truncated journal fails the source closed instead of reviving a revoked entry', t=>{
  const f=fixture(t);
  f.write('memory/journal.jsonl',f.journal([['create',f.entry('secret',{content:'SHOULD_NOT_SURFACE'})]])+'{"action":"revoke",');
  const r=f.run();assert.equal(r.complete,false);assert.equal(r.nodes.length,0);
  assert.ok(r.warnings.some(w=>w.code==='JOURNAL_SOURCE_SUPPRESSED'));
  assert.ok(!JSON.stringify(r).includes('SHOULD_NOT_SURFACE'));
});
test('importance, confidence, temporal validity and display decay remain separate',()=>{
  const episode={type:'episodic',layer:'current',status:'active',t:'2026-10-05T12:00:00Z',confidence:.8};
  const s=scoreNode(episode,{now:NOW});assert.equal(s.retention,.5);assert.equal(s.importance,.55);assert.equal(s.confidence,.8);
  assert.equal(scoreNode({...episode,type:'preference'},{now:NOW}).retention,1);
  assert.equal(scoreNode({...episode,pinned:true},{now:NOW}).retention,1);
  assert.equal(scoreNode({...episode,status:'candidate'},{now:NOW}).eligibleForRecall,false);
  assert.equal(scoreNode({...episode,layer:'legacy'},{now:NOW}).eligibleForRecall,false);
  assert.equal(scoreNode({...episode,validTo:'2026-11-01T00:00:00Z'},{now:NOW}).eligibleForRecall,false);
  assert.equal(scoreNode({...episode,t:null,confidence:null},{now:NOW}).confidence,null);
  assert.equal(scoreNode({...episode,t:null},{now:NOW}).ageDays,null);
});
test('no unknown-session mega-cluster; bounded hub edges; identical local IDs stay distinct across roots', t=>{
  const f=fixture(t);
  const records=Array.from({length:1000},(_,i)=>['create',f.entry(String(i),{source:{sessionId:'unknown'}})]);
  f.write('memory/journal.jsonl',f.journal(records));
  f.write('archive/journal.jsonl',f.journal([['create',f.entry('0')]]));
  const r=f.run({archiveMemoryDirs:[f.archive]});
  assert.equal(r.nodes.length,1001);assert.equal(new Set(r.nodes.map(n=>n.id)).size,1001);
  assert.equal(r.groups.filter(g=>g.type==='same-src').length,0);
  assert.equal(r.edges.length,1000);assert.equal(r.summary.isolated,1);
  assert.equal(r.nodes.find(n=>n.layer==='archive').score.eligibleForRecall,false);
});
test('missing current source is explicit, never falls back to stale markdown',t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.memoryDir,'journal.jsonl'));f.write('memory/facts.md','- old material\n');
  const r=f.run();assert.equal(r.complete,false);assert.equal(r.nodes.length,0);assert.equal(r.warnings[0].code,'SOURCE_MISSING');
});
test('shared export does not relabel private Heart material or private memory as shared',t=>{
  const f=fixture(t);f.write('heart/notebook.md','- PRIVATE_PRINCIPLE\n');
  f.write('memory/journal.jsonl',f.journal([['create',f.entry('PRIVATE_FACT')],['create',f.entry('public',{scope:'shared'})]]));
  const r=f.run({scope:'shared'});assert.deepEqual(r.nodes.map(n=>n.sourceId),['public']);
  assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
});
test('CLI requires explicit scope, refuses output in a source, refuses existing files',t=>{
  const f=fixture(t);
  const cli=(out,scope='xiaoman_private')=>spawnSync(process.execPath,[path.join(toolDir,'export.mjs'),'--heart-dir',f.heartDir,'--memory-dir',f.memoryDir,'--scope',scope,'--out',out],{encoding:'utf8'});
  assert.equal(cli(path.join(f.heartDir,'bad.json')).status,1);
  const out=path.join(f.root,'export.json');assert.equal(cli(out).status,0);
  assert.equal(cli(out).status,1);assert.equal(cli(path.join(f.root,'bad.json'),'all').status,1);
});
test('resource limits fail explicitly rather than silently truncating sources',t=>{
  const f=fixture(t);f.write('heart/dream/insights.json',JSON.stringify([{statement:'a',status:'candidate'},{statement:'b',status:'candidate'}]));
  assert.throws(()=>f.run({maxNodes:1}),/NODE_LIMIT/);
  f.write('memory/journal.jsonl','x'.repeat(101));
  const r=f.run({maxFileBytes:100});assert.equal(r.complete,false);assert.ok(r.warnings.length>0);
});
test('viewer script parses, prohibits connections and never injects memory HTML',()=>{
  const html=fs.readFileSync(path.join(toolDir,'viewer.html'),'utf8');
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.ok(html.includes("connect-src 'none'"));assert.ok(!html.includes('innerHTML'));
});

test('viewer demo, filtering and node details work in an isolated DOM harness',async()=>{
  // This tests event behavior without a browser/network; it is not visual acceptance.
  class Element {
    constructor(){this.children=[];this.handlers={};this.attrs={};this.value='all';this.textContent='';}
    setAttribute(k,v){this.attrs[k]=v;}
    appendChild(e){this.children.push(e);}
    replaceChildren(){this.children=[];}
    addEventListener(event,fn){this.handlers[event]=fn;}
  }
  const elements=new Map();
  const get=id=>{if(id==='memory-shape-snapshot')return null;if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  get('search').value='';
  const document={getElementById:get,createElementNS:()=>new Element()};
  const html=fs.readFileSync(path.join(toolDir,'viewer.html'),'utf8');
  const context=vm.createContext({document});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  get('demo').handlers.click();assert.match(get('count').textContent,/6 条/);
  assert.equal(get('sky').children.filter(e=>e.attrs.class==='node').length,6);
  get('via').value='self';get('via').handlers.input();assert.match(get('count').textContent,/3 条/);
  get('sky').children.find(e=>e.attrs.class==='node').handlers.click();
  assert.match(get('detail').textContent,/认真|听完|先听/);
  get('search').value='没有这条';get('search').handlers.input();assert.match(get('count').textContent,/0 条/);
  // Memory HTML remains inert text even when it looks like executable markup.
  const text='<img src=x onerror=alert(1)>';
  const bad={schemaVersion:1,nodes:[{id:'x',text,layer:'current',via:'unknown',type:'fact',status:'active',weight:.9}],groups:[],edges:[]};
  get('via').value='all';get('search').value='';
  await get('file').handlers.change({target:{files:[{size:100,name:'test.json',text:async()=>JSON.stringify(bad)}]}});
  get('sky').children.find(e=>e.attrs.class==='node').handlers.click();
  assert.ok(get('detail').textContent.startsWith(text));
  assert.equal(get('detail').children.length,0);
});

test('single-file renderer escapes script termination and refuses overwrites',t=>{
  const f=fixture(t), input=path.join(f.root,'input.json'), output=path.join(f.root,'view.html');
  const text='</script><script>throw new Error("injected")</script>';
  fs.writeFileSync(input,JSON.stringify({schemaVersion:1,nodes:[{text}]}));
  const run=()=>spawnSync(process.execPath,[path.join(toolDir,'render.mjs'),'--input',input,'--out',output],{encoding:'utf8'});
  assert.equal(run().status,0);assert.equal(run().status,1);
  const html=fs.readFileSync(output,'utf8');assert.ok(!html.includes(text));
  const embedded=html.match(/id="memory-shape-snapshot">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(embedded).nodes[0].text,text);
});
