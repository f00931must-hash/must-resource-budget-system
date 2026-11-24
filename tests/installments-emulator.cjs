const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const BASE='http://127.0.0.1:18947/v1/projects/demo-attach/databases/(default)/documents';
let actor='manager@example.test';
const b=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt=()=>b({alg:'none',typ:'JWT'})+'.'+b({iss:'https://securetoken.google.com/demo-attach',aud:'demo-attach',sub:actor,user_id:actor,email:actor,email_verified:true,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,firebase:{sign_in_provider:'password'}})+'.';
function enc(v){if(v===null)return{nullValue:null};if(typeof v==='boolean')return{booleanValue:v};if(typeof v==='number')return{integerValue:String(v)};if(typeof v==='object')return{mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,enc(v)]))}};return{stringValue:v}}
function dec(v){if(v.mapValue)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,v])=>[k,dec(v)]));if(v.integerValue!==undefined)return Number(v.integerValue);return v.booleanValue??v.stringValue??v.timestampValue??null}
async function commit(w,token){const res=await fetch(BASE+':commit',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({writes:w})});let data=await res.json();if(!res.ok)throw Error(JSON.stringify(data));return data}
async function read(ref){const res=await fetch(BASE+'/'+ref,{headers:{Authorization:'Bearer '+jwt()}});const x=await res.json();if(!res.ok)throw Error(JSON.stringify(x));return{exists:()=>true,data:()=>Object.fromEntries(Object.entries(x.fields||{}).map(([k,v])=>[k,dec(v)]))}}
function write(ref,d,patch=false){const transforms=[];function walk(v,path){if(v&&v.__serverTime){transforms.push({fieldPath:path,setToServerValue:'REQUEST_TIME'});return undefined}if(v&&typeof v==='object'&&!Array.isArray(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x,path?path+'.'+k:k)]).filter(([,x])=>x!==undefined));return v}let fields=walk(d,'');const w={update:{name:BASE.split('/v1/')[1]+'/'+ref,fields:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,enc(v)]))}};if(patch)w.updateMask={fieldPaths:Object.keys(d)};if(transforms.length)w.updateTransforms=transforms;return w}
(async()=>{
const {emptyInstallment,mutateInstallment,occupiedAmount,reconciliationParts}=await import('../budget-installments-core.mjs');
const teacher='teacher@example.test',other='other@example.test',manager='manager@example.test';
await commit([teacher,other,manager].map(email=>write('users/'+email,{enabled:true,role:email===manager?'manager':'teacher'})),'owner');
const original={planId:'p',categoryId:'misc',purpose:'test parent',semester:'115-1',amount:140000,estimated:true,estimateStage:'purchasing',reviewStatus:'estimated',reviewed:false,locked:false,archived:false,amountConfirmed:false,ownerEmail:teacher,ownerName:'fake',createdBy:teacher,updatedBy:teacher,installment:emptyInstallment()};
let data={...original};actor=teacher;
const put=async record=>commit([write('expenseRecords/parent',{...record,updatedBy:actor,updatedAt:{__serverTime:true}})],jwt());
await put(data);console.log('teacher creates staged parent PASS');
const forged={...data,installment:{...data.installment,total:8000}};
await assert.rejects(commit([write('expenseRecords/forged',forged)],jwt()));console.log('cannot create prefilled aggregate PASS');
const entry={purpose:'supplies',date:'2026-11-24',amount:8000,reimbursementNo:'G123456789',voucher:{url:'https://example.test/private-test',name:'fake.pdf',path:'fake',type:'application/pdf',size:10},confirmed:true,reviewed:false};
data={...data,installment:mutateInstallment(data,'save','item1',entry)};await put(data);assert.equal(occupiedAmount(data),140000);console.log('append single child does not double-count PASS');
actor=other;await assert.rejects(put({...data,note:'other'}));actor=teacher;console.log('unrelated teacher denied PASS');
await assert.rejects(put({...data,installment:{...data.installment,everUsed:false,enabled:false}}));console.log('mode lock cannot be reset PASS');
await assert.rejects(put({...data,installment:{...data.installment,total:0}}));console.log('forged aggregate denied PASS');
await assert.rejects(put({...data,installment:{...data.installment,closed:true}}));console.log('teacher close denied PASS');
const selfReviewed={...data,installment:{...data.installment,reviewedTotal:8000,entries:{item1:{...entry,reviewed:true}}}};
await assert.rejects(put(selfReviewed));console.log('teacher cannot self-review PASS');
await assert.rejects(put({...data,amount:1}));console.log('parent original amount immutable PASS');
await assert.rejects(put({...data,installment:{...data.installment,entries:{item1:entry,item2:entry},total:16000,mutationKey:'item1'}}));console.log('multiple child mutation rejected PASS');
await assert.rejects(put({...data,advanceAllocationId:'fake'}));console.log('staged parent cannot link to legacy advance accounting PASS');
actor=manager;data={...data,installment:mutateInstallment(data,'review','item1',null,true)};await put(data);console.log('manager reviews teacher child PASS');
actor=teacher;await assert.rejects(put({...data,installment:{...data.installment,entries:{},total:0,reviewedTotal:0,mutationKey:'item1'}}));console.log('reviewed child deletion denied PASS');
actor=manager;data={...data,installment:mutateInstallment(data,'close','',null,true)};await put(data);assert.equal(occupiedAmount(data),8000);assert.equal(reconciliationParts(data).reduce((n,r)=>n+r.amount,0),8000);console.log('manager closes once and releases 132000 PASS');
await assert.rejects(put({...data,installment:{...data.installment,closed:false}}));await assert.rejects(put({...data,amount:0}));console.log('closed case cannot reopen or release again PASS');
const disabled={...original,installment:{...emptyInstallment(),enabled:false}};await commit([write('expenseRecords/empty',original)],'owner');
await commit([write('expenseRecords/empty',{...disabled,updatedBy:manager,updatedAt:{__serverTime:true}})],jwt());console.log('empty mode can be disabled PASS');
})().catch(error=>{console.error(error);process.exitCode=1});
