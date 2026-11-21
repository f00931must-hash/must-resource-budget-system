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
const policy=await import("../budget-permissions.mjs");
const source=fs.readFileSync('budget-split-payout.js','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
for(const role of ['manager','advance']){
 const handler='advance@example.test',admin=role+'@example.test',recipient='recipient@example.test';actor=admin;
 const a={planId:'p',batchId:'b',expenseRecordId:'e',ownerEmail:handler,estimatedAmount:8746,deleted:false,purpose:'雜支',categoryName:'雜支'};
 const r={planId:'p',ownerEmail:handler,categoryId:'c',semester:'115-1',advanceAllocationId:'a',amount:8746,estimated:true,deleted:false};
 await commit([write('users/'+admin,{enabled:true,role}),write('users/'+recipient,{enabled:true,role:'teacher',name:'測試老師'}),write('advanceBatches/b',{planId:'p',handlerEmail:handler,deleted:false}),write('advanceAllocations/a',a),write('expenseRecords/e',r)],'owner');
 let form,dialog,amountToAdd=1000,seq=0,alerts=[];
 const submit={disabled:false};
 const context={...policy,console,Intl,getApps:()=>[{options:{projectId:'must-resource-budget-system'}}],getAuth:()=>({currentUser:{email:actor}}),getFirestore:()=>({}),getDoc:read,getDocs:async()=>({docs:[{id:recipient,data:()=>({enabled:true,role:'teacher',name:'測試老師'})}]}),collection:(_,col)=>col,doc:(...args)=>{const path=args.length===1?args[0]+'/'+role+'-p'+(++seq):args[1]+'/'+args[2];const ref=new String(path);ref.id=path.split('/').pop();return ref},query:()=>{},where:()=>{},serverTimestamp:()=>({__serverTime:true}),runTransaction:async(_,fn)=>{let w=[];await fn({get:read,set:(ref,d)=>w.push(write(ref,d)),update:(ref,d)=>w.push(write(ref,d,true))});await commit(w,jwt())},window:{dispatchEvent(){}},Event:class{},confirm:()=>true,alert:s=>alerts.push(s),FormData:class{get(k){return k==='owner'?recipient:String(amountToAdd)}},document:{getElementById:()=>null,createElement:()=>{form={querySelector:()=>submit};dialog={querySelector:s=>s==='form'?form:{},showModal(){},close(){}};return dialog},body:{append(){}}}};
 vm.createContext(context);vm.runInContext(source,context);
 for(const value of [1000,2000]){amountToAdd=value;await vm.runInContext("addDialog('a')",context);await form.onsubmit({preventDefault(){},target:form});assert.equal(alerts.length,0,alerts.join());assert.equal(submit.disabled,false)}
 let parent=(await read('advanceAllocations/a')).data();assert.equal(parent.splitAssigned,3000);assert.equal(parent.splitUnreceived,3000);assert.equal((await read('expenseRecords/e')).data().amount,8746);console.log(role,'actual addDialog first + additional PASS');
 async function act(email,action,id,value){actor=email;context.button={disabled:false,dataset:{splitAction:action,payout:id},parentElement:{querySelector:()=>({value})}};await vm.runInContext('splitAction(button)',context);assert.equal(context.button.disabled,false)}
 await act(recipient,'receive',role+'-p1');parent=(await read('advanceAllocations/a')).data();assert.equal(parent.splitUnreceived,2000);console.log(role,'actual receive PASS');
 await act(admin,'remove',role+'-p2');parent=(await read('advanceAllocations/a')).data();assert.equal(parent.splitAssigned,1000);assert.equal(parent.splitUnreceived,0);console.log(role,'actual remove PASS');
 await act(recipient,'refund-report',role+'-p1',100);assert.equal((await read('advancePayouts/'+role+'-p1')).data().refundPending,100);console.log(role,'actual refund report PASS');
 await act(admin,'refund-receive',role+'-p1');parent=(await read('advanceAllocations/a')).data();assert.equal(parent.splitRefundTotal,100);assert.equal((await read('expenseRecords/e')).data().amount,8646);console.log(role,'actual refund receive PASS');
}
})().catch(e=>{console.error(e);process.exitCode=1});
