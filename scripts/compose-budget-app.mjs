// Build-time/test-only composition of the exact currently used browser loaders.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
export async function composeBudgetApp(){
 const blobs=new Map();let application='';let context;
 const globals={console,location:{href:'https://example.test/budget/'},fetch:async input=>({ok:true,text:async()=>fs.readFileSync(path.basename(String(input).split('?')[0]),'utf8')}),Blob:class{constructor(parts){this.source=parts.join('')}},URL:class extends URL{static createObjectURL(blob){const id='blob:'+blobs.size;blobs.set(id,blob.source);return id}static revokeObjectURL(){}},alert:m=>{throw Error(m)},__import:async url=>{
  if(!blobs.has(url))return;
  const source=blobs.get(url);
  if(source.includes('initializeApp(')){application=source;return;}
  return vm.runInContext(source.replaceAll('await import(', 'await __import('),context);
 }};
 context=vm.createContext(globals);
 await vm.runInContext(fs.readFileSync('app-v165-loader.js','utf8').replaceAll('await import(', 'await __import('),context);
 if(!application)throw Error('Budget application was not composed');
 return application;
}
