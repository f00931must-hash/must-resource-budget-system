import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyFailure,recordDiagnosis,healthDiagnosis,diagnosticReport,createAccountService} from '../budget-diagnostics-core.mjs';
const manager='manager@example.test',teacher='teacher@example.test';
function fixture(role='manager'){
 const profiles=new Map([[manager,{enabled:true,role}],[teacher,{enabled:false,role:'user',name:'老師'}]]),writes=[],reads=[];
 const auth={currentUser:{email:manager}},snap=key=>({exists:()=>profiles.has(key),data:()=>structuredClone(profiles.get(key))});
 const sdk={auth,db:{},doc:(_,collection,id)=>({collection,id}),serverTimestamp:()=>({stamp:true}),getDocFromServer:async ref=>{reads.push(ref);return snap(ref.id)},runTransaction:async(_,fn)=>fn({get:async ref=>snap(ref.id),update:(ref,data)=>{writes.push({ref,data});profiles.set(ref.id,{...profiles.get(ref.id),...data})}})};
 return {service:createAccountService(sdk),profiles,writes,reads,auth,sdk};
}
test('only existing active managers may inspect or change account settings',async()=>{
 for(const role of ['teacher','advance','assistant']){const f=fixture(role);await assert.rejects(f.service.inspect(teacher));await assert.rejects(f.service.save(teacher,{role:'manager',enabled:true,expected:{role:'user',enabled:false}}));assert.equal(f.writes.length,0)}
 const f=fixture();const view=await f.service.inspect(teacher);assert.equal(view.profile.enabled,false);assert.equal(f.writes.length,0);
 await f.service.save(teacher,{role:'teacher',enabled:true,expected:view.profile});assert.equal(f.writes.length,1);assert.equal(f.writes[0].ref.collection,'users');assert.deepEqual(Object.keys(f.writes[0].data).sort(),['enabled','role','updatedAt','updatedBy']);
});
test('unchanged, stale, missing, invalid and self-lockout changes do not write',async()=>{
 const f=fixture();const expected={role:'user',enabled:false};
 assert.equal((await f.service.save(teacher,{...expected,expected})).changed,false);
 for(const change of [{role:'evil',enabled:true,expected},{role:'teacher',enabled:'true',expected},{role:'manager',enabled:true,expected:{role:'teacher',enabled:false}}])await assert.rejects(f.service.save(teacher,change));
 await assert.rejects(f.service.save('missing@example.test',{role:'user',enabled:true,expected}));
 await assert.rejects(f.service.save(manager,{role:'teacher',enabled:true,expected:{role:'manager',enabled:true}}));
 await assert.rejects(f.service.save(manager,{role:'manager',enabled:false,expected:{role:'manager',enabled:true}}));
 assert.equal(f.writes.length,0);
});
test('a lost manager role or changed signed-in account is checked again inside the transaction',async()=>{
 for(const scenario of ['role','identity']){
  const f=fixture();const original=f.sdk.runTransaction;
  const service=createAccountService({...f.sdk,runTransaction:async(...args)=>{if(scenario==='role')f.profiles.set(manager,{enabled:true,role:'teacher'});else f.auth.currentUser.email='other@example.test';return original(...args)}});
  await assert.rejects(service.save(teacher,{role:'manager',enabled:true,expected:{role:'user',enabled:false}}));assert.equal(f.writes.length,0);
 }
});
test('record status inspection never writes records',async()=>{
 assert.equal(recordDiagnosis({locked:true},teacher).kind,'locked');assert.equal(recordDiagnosis({advanceAllocationId:'a'},teacher).kind,'linked');assert.equal(recordDiagnosis({deleted:true},teacher).kind,'deleted');assert.equal(recordDiagnosis(null,teacher).kind,'missing');
 const f=fixture();await assert.rejects(f.service.inspectRecord('bad/id'));assert.equal(f.writes.length,0);
});
test('version diagnosis never invents a deployed-rules success',()=>{
 assert.equal(healthDiagnosis({ok:true,version:'0.7.0'},'0.7.0').kind,'ok');assert.equal(healthDiagnosis({ok:true,version:'0.6.3'},'0.7.0').kind,'different');assert.equal(healthDiagnosis(null,'0.7.0').kind,'unknown');assert.equal(diagnosticReport().rulesVersion,'unverified');
});
test('downloaded summaries are bounded and exclude messages, accounts, file paths and credentials',()=>{
 const raw='紀錄寫入失敗 Missing or insufficient permissions: teacher@example.test 6010 uploads/budget/private.pdf Bearer SECRET';
 const entry=classifyFailure(raw);assert.equal(entry.kind,'permission');assert.equal(entry.phase,'紀錄寫入');
 assert.equal(classifyFailure('Quota exceeded').kind,'quota');assert.equal(classifyFailure('token-expired').kind,'session');assert.equal(classifyFailure('已鎖定').kind,'workflow');assert.equal(classifyFailure('已儲存成功'),null);
 const report=diagnosticReport({checks:[{service:'upload',status:'ok',version:'0.7.0',email:teacher,token:'SECRET'}],events:Array.from({length:30},()=>({...entry,at:1,message:raw,token:'SECRET',phase:raw}))});
 assert.equal(report.events.length,20);const json=JSON.stringify(report);for(const secret of [teacher,'6010','private.pdf','SECRET','uploads/'])assert.ok(!json.includes(secret));assert.equal(report.events[0].phase,'未提供階段');
});

test('installment diagnosis gives an actionable empty-case cleanup and preserves history restrictions',()=>{
 assert.equal(recordDiagnosis({installment:{enabled:true,everUsed:false,entries:{}}},'manager@example.test').kind,'installment-empty');
 assert.match(recordDiagnosis({installment:{enabled:true,everUsed:false,entries:{}}},'manager@example.test').message,/取消勾選/);
 assert.equal(recordDiagnosis({installment:{enabled:true,everUsed:true,entries:{}}},'manager@example.test').kind,'installment-used');
 assert.equal(recordDiagnosis({installment:{enabled:true,closed:true}},'manager@example.test').kind,'installment-closed');
});
