import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import jsdom from '../.emulator/node_modules/jsdom/lib/api.js';
import * as core from '../budget-diagnostics-core.mjs';
import * as policy from '../budget-permissions.mjs';
const {JSDOM}=jsdom;
async function page(role='manager'){
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://example.test/budget/',runScripts:'outside-only'}),w=dom.window;
 const actor={email:'manager@example.test',uid:'test-uid',getIdToken:async()=>{tokens++;return 'TEST-ONLY'}},profiles=new Map([[actor.email,{enabled:true,role}],["teacher@example.test",{enabled:false,role:'user',name:'測試老師'}]]),writes=[],reads=[],pending=[],exports=[];let tokens=0;
 const snap=ref=>({exists:()=>profiles.has(ref.id),data:()=>structuredClone(profiles.get(ref.id))});
 Object.assign(w,{...core,...policy,getApps:()=>[{options:{projectId:'must-resource-budget-system'}}],getAuth:()=>({currentUser:actor}),getFirestore:()=>({}),doc:(_,collection,id)=>({collection,id}),getDocFromServer:async ref=>{reads.push(ref);return snap(ref)},runTransaction:async(_,fn)=>fn({get:async ref=>snap(ref),update:(ref,data)=>{writes.push({ref,data});profiles.set(ref.id,{...profiles.get(ref.id),...data})}}),serverTimestamp:()=>({time:true}),onAuthStateChanged:(_,callback)=>{pending.push(callback(actor));return()=>{}},alert(){},confirm:()=>true,fetch:async url=>({ok:true,json:async()=>({ok:true,version:String(url).includes('upload')?'0.7.0':'1.1.8'})}),CSS:{escape:v=>v},Blob});
 w.URL.createObjectURL=blob=>{exports.push(blob);return 'blob:test'};w.URL.revokeObjectURL=()=>{};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.document.addEventListener('click',event=>{if(event.target.download)event.preventDefault()});
 const source=fs.readFileSync('budget-permission-diagnostics-v1.js','utf8').replace(/^import .*;\n/gm,'').replace('void init().catch','init().catch');
 await vm.runInContext(source,dom.getInternalVMContext());await Promise.all(pending);
 return {w,dom,profiles,writes,reads,exports,tokens:()=>tokens,$:id=>w.document.getElementById(id)};
}
test('manager tab reads only its own profile until a manual diagnostic action',async()=>{
 const p=await page();try{assert.ok(!p.$('permissionDiagnosticsTab').classList.contains('hidden'));assert.deepEqual(p.reads.map(r=>r.collection),['users']);assert.equal(p.writes.length,0);
 p.$('pdAccount').value='teacher@example.test';await p.$('pdInspect').onclick();assert.equal(p.writes.length,0);assert.equal(p.$('pdAccountFields').disabled,false);
 p.$('pdRole').value='teacher';p.$('pdEnabled').checked=true;await p.$('pdSave').onclick();assert.equal(p.writes.length,1);assert.equal(p.writes[0].ref.collection,'users');assert.equal(p.profiles.get('teacher@example.test').enabled,true);
 }finally{p.dom.window.close()}
});
test('teacher cannot use administrator account controls even if hidden DOM is exposed',async()=>{
 const p=await page('teacher');try{assert.ok(p.$('permissionDiagnosticsTab').classList.contains('hidden'));p.$('pdAccount').value='teacher@example.test';await p.$('pdInspect').onclick();assert.equal(p.writes.length,0);assert.equal(p.$('pdAccountFields').disabled,true)}finally{p.dom.window.close()}
});
test('version checks do not read or write finances and show mismatch/unknown honestly',async()=>{
 const p=await page();try{p.reads.length=0;await p.$('pdVersions').onclick();assert.equal(p.reads.length,0);assert.equal(p.writes.length,0);assert.match(p.$('pdVersionsResult').textContent,/通知服務：目前 1.1.8/);assert.match(p.$('pdVersionsResult').textContent,/規則版本無法/)}finally{p.dom.window.close()}
});
test('a denied alert produces a bounded redacted download and refresh does not retry a write',async()=>{
 const p=await page();try{p.w.alert('紀錄寫入失敗 Missing or insufficient permissions teacher@example.test 6010 Bearer SECRET');assert.equal(p.$('pdHelp').hidden,false);
 p.$('pdSelfExport').onclick();const json=await p.exports[0].text();for(const secret of ['teacher@example.test','6010','SECRET'])assert.ok(!json.includes(secret));assert.match(json,/permission-denied/);
 await p.$('pdSelfRefresh').onclick();assert.equal(p.tokens(),1);assert.equal(p.writes.length,0);
 }finally{p.dom.window.close()}
});
test('record cards get one manager-only diagnostic button without automatic record reads',async()=>{
 const p=await page();try{
  p.reads.length=0;p.$('recordList').innerHTML='<div class="record-card"><div><button data-edit-record="record-id">編輯</button></div></div>';
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(p.$('recordList').querySelectorAll('[data-pd-record]').length,1);assert.equal(p.reads.length,0);
  p.$('recordList').querySelector('[data-pd-record]').onclick();await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(p.reads.map(r=>r.collection),['users','expenseRecords']);assert.equal(p.writes.length,0);
 }finally{p.dom.window.close()}
});
test('staged cards without edit/unlock buttons still expose actionable diagnosis',async()=>{
 const p=await page();try{
  p.profiles.set('staged-empty',{ownerEmail:'manager@example.test',installment:{enabled:true,everUsed:false,entries:{}}});
  p.$('recordList').innerHTML='<article class="record-card"><div><button data-installment="staged-empty">明細</button></div></article>';
  await new Promise(resolve=>setTimeout(resolve,10));
  const button=p.$('recordList').querySelector('[data-pd-record]');assert.ok(button);button.click();
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.match(p.$('pdRecordResult').textContent,/取消勾選/);assert.equal(p.writes.length,0);
 }finally{p.dom.window.close();}
});
