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
let src=fs.readFileSync('budget-advance-settlement.js','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
for(const role of ['manager','advance'])for(const mode of ['first','additional','pending','locked']){
 actor=role+'@example.test';let owner=role==='advance'?actor:'teacher@example.test',previous=mode==='additional'?20:0;
 const a={estimatedAmount:100,ownerEmail:owner,expenseRecordId:'e',batchId:'b',planId:'p',categoryId:'c',allocationReceivedConfirmed:true,refundReported:true,refundReceivedConfirmed:false,refundConfirmedTotal:previous,refundAmount:previous+10,deleted:false};
 const r={amount:100-previous,ownerEmail:owner,createdBy:owner,categoryId:'c',semester:'115-1',advanceAllocationId:'a',advanceBatchId:'b',estimated:true,deleted:false,...(mode==='pending'?{actualAdjustment:{status:'pending',amount:85,requestedBy:owner,reason:'test'}}:{}),...(mode==='locked'?{locked:true,reviewed:true,reviewStatus:'approved'}:{})};
 await commit([write('users/'+actor,{enabled:true,role}),write('advanceBatches/b',{handlerEmail:actor,deleted:false}),write('advanceAllocations/a',a),write('expenseRecords/e',r)],'owner');
 let alerts=[];const app={options:{projectId:'must-resource-budget-system'}};
 const ctx={Intl,console,getApps:()=>[app],getAuth:()=>({currentUser:{email:actor}}),getFirestore:()=>({}),doc:(_,col,id)=>col+'/'+id,getDoc:read,serverTimestamp:()=>({__serverTime:true}),confirm:()=>true,alert:x=>alerts.push(x),window:{dispatchEvent(){}},Event:class{},runTransaction:async(_,fn)=>{let writes=[];await fn({get:read,update:(ref,d)=>writes.push(write(ref,d,true))});await commit(writes,jwt())}};
 vm.createContext(ctx);let button={dataset:{settlementAction:'receive',allocation:'a'},disabled:false};ctx.button=button;
 await vm.runInContext(src+';settlementAction(button)',ctx);
 const nr=(await read('expenseRecords/e')).data(),na=(await read('advanceAllocations/a')).data();
 assert.equal(nr.amount,90-previous);assert.equal(na.refundConfirmedTotal,10+previous);assert.equal(na.refundReceivedConfirmed,true);assert.equal(button.disabled,false);assert.equal(alerts.length,1);if(mode==='pending')assert.equal(nr.actualAdjustment.status,'cancelled');
 console.log('actual settlementAction',role,mode,'PASS');
}
})().catch(e=>{console.error(e);process.exitCode=1});
