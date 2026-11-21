import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
test('actual stage/private/recycle loader composition still produces a valid budget app',async()=>{
 const blobs=new Map();let application='';let context;
 const globals={console,location:{href:'https://example.test/budget/'},fetch:async input=>({ok:true,text:async()=>fs.readFileSync(path.basename(String(input).split('?')[0]),'utf8')}),Blob:class{constructor(parts){this.source=parts.join('')}},URL:class extends URL{static createObjectURL(blob){const id='blob:'+blobs.size;blobs.set(id,blob.source);return id}static revokeObjectURL(){}},alert:m=>assert.fail(m),__import:async url=>{
  if(!blobs.has(url))return;
  const source=blobs.get(url);
  if(source.includes('initializeApp(')){application=source;return;}
  return vm.runInContext(source.replaceAll('await import(', 'await __import('),context);
 }};
 context=vm.createContext(globals);
 await vm.runInContext(fs.readFileSync('app-v165-loader.js','utf8').replaceAll('await import(', 'await __import('),context);
 assert.ok(application,'application was composed');
 assert.ok(application.includes('form.append("system","budget")'));
 assert.ok(!application.includes('form.append("system","shared")'));
 for(const text of ['soft-delete-record','soft-delete-plan','soft-delete-category','estimated,estimateStage,hanlongAdvance','isBudgetManager(state.profile,state.user?.email)','amountConfirmedByManagerWaiver'])assert.ok(application.includes(text),text);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'budget-loader-'));
 try{const file=path.join(dir,'app.mjs');fs.writeFileSync(file,application);execFileSync('node',['--check',file])}finally{fs.rmSync(dir,{recursive:true})}
});
