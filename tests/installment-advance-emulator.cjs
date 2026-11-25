const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const BASE='http://127.0.0.1:18947/v1/projects/demo-attach/databases/(default)/documents';
let actor='manager@example.test';
const b=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt=()=>b({alg:'none',typ:'JWT'})+'.'+b({iss:'https://securetoken.google.com/demo-attach',aud:'demo-attach',sub:actor,user_id:actor,email:actor,email_verified:true,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,firebase:{sign_in_provider:'password'}})+'.';
function enc(v){if(Array.isArray(v))return{arrayValue:{values:v.map(enc)}};if(v===null)return{nullValue:null};if(typeof v==='boolean')return{booleanValue:v};if(typeof v==='number')return{integerValue:String(v)};if(typeof v==='object')return{mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,enc(v)]))}};return{stringValue:v}}
function dec(v){if(v.arrayValue)return(v.arrayValue.values||[]).map(dec);if(v.mapValue)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,v])=>[k,dec(v)]));if(v.integerValue!==undefined)return Number(v.integerValue);return v.booleanValue??v.stringValue??v.timestampValue??null}
async function commit(w,token){const res=await fetch(BASE+':commit',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({writes:w})});let data=await res.json();if(!res.ok)throw Error(JSON.stringify(data));return data}
async function read(ref){const res=await fetch(BASE+'/'+ref,{headers:{Authorization:'Bearer '+jwt()}});const x=await res.json();if(!res.ok)throw Error(JSON.stringify(x));return{exists:()=>true,data:()=>Object.fromEntries(Object.entries(x.fields||{}).map(([k,v])=>[k,dec(v)]))}}
function write(ref,d,patch=false){const transforms=[];function walk(v,path){if(v&&v.__serverTime){transforms.push({fieldPath:path,setToServerValue:'REQUEST_TIME'});return undefined}if(v&&typeof v==='object'&&!Array.isArray(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x,path?path+'.'+k:k)]).filter(([,x])=>x!==undefined));return v}let fields=walk(d,'');const w={update:{name:BASE.split('/v1/')[1]+'/'+ref,fields:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,enc(v)]))}};if(patch)w.updateMask={fieldPaths:Object.keys(d)};if(transforms.length)w.updateTransforms=transforms;return w}

(async()=>{
const policy=await import('../budget-permissions.mjs');
const {linkInstallmentAllocation,unlinkInstallmentAllocation}=await import('../budget-installment-advance.mjs');
const {emptyInstallment}=await import('../budget-installments-core.mjs');
const source=fs.readFileSync('budget-split-payout.js','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
for(const role of ['manager','advance']){
 const handler='advance@example.test',admin=role+'@example.test',secondRecipient='second@example.test';let recipient='recipient@example.test';actor=admin;
 await commit(['a','second'].map(id=>({delete:BASE.split('/v1/')[1]+'/advanceAllocations/'+id})),'owner');
 const batch={id:'b',planId:'p',semester:'115-1',categoryId:'c',categoryIds:role==='manager'?['c']:[],handlerEmail:handler,deleted:false};
 const r={id:'e',planId:'p',ownerEmail:handler,ownerName:'測試老師',categoryId:'c',semester:'115-1',purpose:'整筆雜支',amount:140000,estimated:true,deleted:false,installment:{...emptyInstallment(),everUsed:true,total:34734,entries:{cards:{date:'2026-11-25',purpose:'卡牌',amount:5734,reimbursementNo:'',reviewed:false,voucher:null},film:{date:'2026-11-25',purpose:'霧膜',amount:29000,reimbursementNo:'',reviewed:false,voucher:null}}}};
 await commit([write('users/'+admin,{enabled:true,role}),write('users/'+handler,{enabled:true,role:'advance'}),write('users/'+recipient,{enabled:true,role:'teacher',name:'測試老師'}),write('users/'+secondRecipient,{enabled:true,role:'teacher',name:'另一位老師'}),write('advanceBatches/b',batch),write('expenseRecords/e',r)],'owner');
 const linked=linkInstallmentAllocation(r,'cards',batch,'a',admin,{__serverTime:true}),a=linked.allocation;
 await commit([write('advanceAllocations/a',a),write('expenseRecords/e',{installment:linked.installment,updatedBy:actor,updatedAt:{__serverTime:true}},true)],jwt());console.log(role,'real rules item allocation link PASS');
 let form,dialog,amountToAdd=1000,seq=0,alerts=[];
 const submit={disabled:false};
 const context={...policy,console,Intl,getApps:()=>[{options:{projectId:'must-resource-budget-system'}}],getAuth:()=>({currentUser:{email:actor}}),getFirestore:()=>({}),getDoc:read,getDocs:async()=>({docs:[{id:recipient,data:()=>({enabled:true,role:'teacher',name:'測試老師'})}]}),collection:(_,col)=>col,doc:(...args)=>{const path=args.length===1?args[0]+'/'+role+'-p'+(++seq):args[1]+'/'+args[2];const ref=new String(path);ref.id=path.split('/').pop();return ref},query:()=>{},where:()=>{},serverTimestamp:()=>({__serverTime:true}),runTransaction:async(_,fn)=>{let w=[];await fn({get:read,set:(ref,d)=>w.push(write(ref,d)),update:(ref,d)=>w.push(write(ref,d,true))});await commit(w,jwt())},window:{dispatchEvent(){}},Event:class{},confirm:()=>true,alert:s=>alerts.push(s),FormData:class{get(k){return k==='owner'?recipient:String(amountToAdd)}},document:{getElementById:()=>null,createElement:()=>{form={querySelector:()=>submit};dialog={querySelector:s=>s==='form'?form:{},showModal(){},close(){}};return dialog},body:{append(){}}}};
 vm.createContext(context);vm.runInContext(source,context);

 for(const value of [1000,2000]){if(value===2000)recipient=secondRecipient;amountToAdd=value;await vm.runInContext("addDialog('a')",context);await form.onsubmit({preventDefault(){},target:form});assert.equal(alerts.length,0,alerts.join());}
 assert.equal((await read('advanceAllocations/a')).data().splitAssigned,3000);console.log(role,'actual staged split allocation PASS');
 async function act(email,action,id,value){actor=email;context.button={disabled:false,dataset:{splitAction:action,payout:id},parentElement:{querySelector:()=>({value})}};await vm.runInContext('splitAction(button)',context);}
 recipient='recipient@example.test';await assert.rejects(act(secondRecipient,'receive',role+'-p1'));console.log(role,'other teacher cannot confirm another payout PASS');
 await act(recipient,'receive',role+'-p1');assert.equal((await read('advanceAllocations/a')).data().splitUnreceived,2000);console.log(role,'actual teacher receipt PASS');
 await act(admin,'remove',role+'-p2');assert.equal((await read('advanceAllocations/a')).data().splitAssigned,1000);console.log(role,'actual unreceived payout removal PASS');
 await act(recipient,'refund-report',role+'-p1',100);await act(admin,'refund-receive',role+'-p1');
 assert.equal((await read('advanceAllocations/a')).data().splitRefundTotal,100);
 let after=(await read('expenseRecords/e')).data();assert.equal(after.amount,140000);assert.equal(after.installment.total,34734);assert.equal(after.installment.entries.cards.amount,5734);console.log(role,'cash refund does not rewrite parent budget or expense detail PASS');
 actor=admin;
 const changed={...after.installment,entries:{...after.installment.entries,cards:{...after.installment.entries.cards,amount:5735}},total:34735,mutationKey:'cards'};
 await assert.rejects(commit([write('expenseRecords/e',{installment:changed,updatedBy:actor,updatedAt:{__serverTime:true}},true)],jwt()));console.log(role,'allocated child amount locked by rules PASS');
 const duplicate=linkInstallmentAllocation;assert.throws(()=>duplicate({id:'e',...after},'cards',batch,'duplicate',actor,{__serverTime:true}));
 const fake={...a,installmentEntryId:'film'};await assert.rejects(commit([write('advanceAllocations/fake',fake)],jwt()));console.log(role,'unpaired or duplicate allocation denied PASS');
 const second=linkInstallmentAllocation({id:'e',...after},'film',batch,'second',actor,{__serverTime:true});
 await commit([write('advanceAllocations/second',second.allocation),write('expenseRecords/e',{installment:second.installment,updatedBy:actor,updatedAt:{__serverTime:true}},true)],jwt());
 const beforeUnlink=(await read('expenseRecords/e')).data(),next=unlinkInstallmentAllocation(beforeUnlink,{id:'second',...second.allocation});
 await commit([write('advanceAllocations/second',{deleted:true,deletedBy:actor,deletedAt:{__serverTime:true},updatedBy:actor,updatedAt:{__serverTime:true}},true),write('expenseRecords/e',{installment:next,updatedBy:actor,updatedAt:{__serverTime:true}},true)],jwt());
 assert.equal((await read('expenseRecords/e')).data().installment.entries.film.advanceAllocationId,'');console.log(role,'unassigned item unlink preserves source PASS');
}
})().catch(e=>{console.error(e);process.exitCode=1});
