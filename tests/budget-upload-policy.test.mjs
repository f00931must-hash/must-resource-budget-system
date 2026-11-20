import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../cloudflare-worker/must-free-upload-service-v0.7.0.js',import.meta.url),'utf8');
function policy(profile,{record=null,uploader='',supers=''}={}) {
 const c={calls:[],fsGet:async url=>{c.calls.push(url);return url.includes('/expenseRecords/')?record:profile},gh:async()=>[{commit:{committer:{email:uploader}}}],fail:(m,code)=>{throw Object.assign(Error(m),{code})}};
 vm.createContext(c);
 const auth=source.slice(source.indexOf('async function authorize('),source.indexOf('async function assertPortalAdmin('));
 const del=source.slice(source.indexOf('async function assertBudgetDelete('),source.indexOf('async function budgetAccessSync('));
 vm.runInContext(auth+'\n'+del+'\nglobalThis.api={authorize,assertBudgetDelete}',c);
 const id={project:'demo-budget',email:'teacher@example.test',token:'test-only'};
 const env={BUDGET_FIREBASE_PROJECT_ID:'demo-budget',SUPER_ADMIN_EMAILS:supers};
 return {...c.api,c,id,env};
}
const profile=role=>({fields:{enabled:{booleanValue:true},role:{stringValue:role}}});
test('budget uses a live users profile without separate GitHub allowlist',async()=>{
 for(const role of ['teacher','manager','advance','user']){
  const p=policy(profile(role));await p.authorize(p.id,p.env);
  assert.equal(p.c.calls.length,1);assert.match(p.c.calls[0],/\/users\/teacher%40example.test$/);
 }
});
test('disabled, missing and assistant profiles cannot use budget attachments, including configured super admins',async()=>{
 for(const x of [null,{fields:{enabled:{booleanValue:false},role:{stringValue:'manager'}}},profile('assistant')]) {
  const p=policy(x,{supers:'teacher@example.test'});
  await assert.rejects(p.authorize(p.id,p.env),e=>e.code===403);
 }
});
test('delete is limited to manager, matching record owner/path, or original uploader',async()=>{
 const path='uploads/budget/old.pdf';
 for(const [role,record,uploader,allowed] of [
  ['manager',null,'',true],['teacher',null,'teacher@example.test',true],
  ['teacher',{fields:{ownerEmail:{stringValue:'teacher@example.test'},voucherPath:{stringValue:path}}},'',true],
  ['teacher',{fields:{ownerEmail:{stringValue:'other@example.test'},voucherPath:{stringValue:path}}},'',false],
  ['teacher',{fields:{ownerEmail:{stringValue:'teacher@example.test'},voucherPath:{stringValue:'different'}}},'',false]
 ]) {
  const p=policy(profile(role),{record,uploader});await p.authorize(p.id,p.env);
  const action=p.assertBudgetDelete(p.id,p.env,{},path,'record-id');
  if(allowed)await action;else await assert.rejects(action,e=>e.code===403);
 }
});
