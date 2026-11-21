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
const {composeBudgetApp}=await import('../scripts/compose-budget-app.mjs');
const policy=await import('../budget-permissions.mjs');
const source=await composeBudgetApp();
const fn=source.slice(source.indexOf('async function saveRecord(e){'),source.indexOf('async function detachOwnVoucher'));
for(const role of ['teacher','manager'])for(const mode of ['new','new-other','amount','semester','category','stage','new-file','existing-file-submit','linked-submit']){
 actor=role+'@example.test';
 const owner=role==='manager'&&mode!=='new'?'teacher@example.test':actor;
 const existing=mode.startsWith('new')&&mode!=='new-file'?null:{id:'e',planId:'p',categoryId:'c',ownerEmail:owner,ownerName:'測試老師',createdBy:'other@example.test',amount:100,semester:'115-1',purpose:'test',note:'',estimated:true,estimateStage:'estimated',hanlongAdvance:false,reviewStatus:'estimated',reviewed:false,locked:false,deleted:false,archived:false,amountConfirmed:false,...(mode.includes('submit')?{voucherUrl:'https://example.test/existing.pdf'}:{}),...(mode==='linked-submit'?{advanceAllocationId:'a',advanceBatchId:'b'}:{})};
 const actual=mode.includes('submit')||mode==='new-file';
 const fields={recordId:{value:existing?'e':''},recordCategory:{value:mode==='category'?'d':'c'},recordAmount:{value:mode==='amount'?'101':'100'},recordSemester:{value:mode==='semester'?'114-2':'115-1'},recordEstimated:{checked:!actual},recordPurpose:{value:'test'},recordNote:{value:''},recordVoucherFile:{files:mode==='new-file'?[{size:100,name:'test.pdf',type:'application/pdf'}]:[]},recordArchived:{checked:actual||!!existing?.voucherUrl},recordAmountConfirm:{checked:actual},recordProposedActualAmount:{value:''},recordAdjustmentReason:{value:''},recordStageReimbursing:{checked:mode==='stage'},recordStagePurchasing:{checked:false},recordHanlongAdvance:{checked:false},recordPurchaseOrderNo:{value:''},recordReimbursementNo:{value:''},recordSaveBtn:{},recordDialog:{close(){}}};
 await commit([write('users/'+actor,{enabled:true,role}),write('users/'+owner,{enabled:true,role:owner===actor?role:'teacher'}),...(existing?[write('expenseRecords/e',existing)]:[])],'owner');
 let toasts=[],savedId='',updates=0;
 const ctx={console,state:{user:{email:actor},profile:{enabled:true,role},activePlanId:'p',records:existing?[existing]:[],categories:[{id:'c'},{id:'d'}]},$:k=>fields[k],isManager:()=>policy.isBudgetManager({enabled:true,role},actor),isApproved:r=>r.reviewStatus==='approved'||r.reviewed||r.locked,isPlanActive:()=>true,selectedRecordOwner:()=>({email:owner,name:'測試老師'}),responsibleExpenseEmail:r=>r.ownerEmail,accountingAmount:r=>Number(r.amount)+Number(r.advanceTopUpTotal||0),toast:s=>toasts.push(s),money:new Intl.NumberFormat('zh-TW'),Number,doc:(_,col,id)=>col+'/'+id,db:{},serverTimestamp:()=>({__serverTime:true}),updateDoc:async(ref,data)=>{await commit([write(ref,data,true)],jwt());savedId=ref.split('/').pop();updates++},addDoc:async(col,data)=>{const id=role+'-'+mode+'-new-record';await commit([write(col+'/'+id,data)],jwt());savedId=id;updates++;return{id}},collection:(_,col)=>col,refreshOneExpense:async()=>{},loadPlanData:async()=>{},renderAll(){},uploadVoucherFile:async()=>({name:'new.pdf',path:'uploads/budget/new.pdf',url:'https://example.test/new.pdf',size:100,type:'application/pdf'}),githubDeleteFile:async()=>{},githubPathFromUrl:()=>''};
 vm.createContext(ctx);await vm.runInContext(fn+';saveRecord({preventDefault(){}})',ctx);
 assert.equal(updates,1,toasts.join(';'));const row=(await read('expenseRecords/'+savedId)).data();
 assert.equal(row.amount,mode==='amount'?101:100);assert.equal(row.ownerEmail,owner);assert.equal(row.estimated,!actual);assert.equal(row.semester,mode==='semester'?'114-2':'115-1');if(mode==='stage')assert.equal(row.estimateStage,'reimbursing');
 console.log('actual saveRecord',role,mode,'PASS');
}
})().catch(e=>{console.error(e);process.exitCode=1});
