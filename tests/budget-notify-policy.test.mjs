import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../cloudflare-worker/must-resource-notify-service-v1.2.0.js',import.meta.url),'utf8');
const baseline=fs.readFileSync(new URL('../cloudflare-worker/must-resource-notify-service-v1.1.8.js',import.meta.url),'utf8');
test('manual notification authorization uses the live active manager profile',async()=>{
 for(const [role,enabled,email,ok] of [['manager',true,'m@example.test',true],['teacher',true,'t@example.test',false],['advance',true,'a@example.test',false],['manager',false,'m@example.test',false],['user',true,'master004400@gmail.com',true]]) {
  const context={fetch:async url=>{assert.match(url,/\/users\//);return{ok:true,json:async()=>({fields:{enabled:{booleanValue:enabled},role:{stringValue:role}}})}},fail:(message,status)=>{throw Object.assign(Error(message),{status})}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function assertBudgetManager('),source.indexOf('async function lineStatus('))+';globalThis.check=assertBudgetManager',context);
  const result=context.check({email,token:'test-only'},{BUDGET_FIREBASE_PROJECT_ID:'demo-budget'});
  if(ok)assert.equal(await result,true);else await assert.rejects(result,e=>e.status===403);
 }
});
test('scheduler, recipients, message sending and purchasing eligibility code are unchanged',()=>{
 const tail=text=>text.slice(text.indexOf('function safeServiceAccountStatus'));
 assert.equal(tail(source),tail(baseline));
});
