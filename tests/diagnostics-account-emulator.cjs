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
const {createAccountService}=await import('../budget-diagnostics-core.mjs');
let touched=[];
const auth={currentUser:{email:'manager@example.test'}};
const service=createAccountService({auth,db:{},doc:(_,col,id)=>col+'/'+id,getDocFromServer:read,serverTimestamp:()=>({__serverTime:true}),runTransaction:async(_,fn)=>{const writes=[];const result=await fn({get:read,update:(ref,data)=>{assert.ok(ref.startsWith('users/'));touched.push(ref);writes.push(write(ref,data,true))}});if(writes.length)await commit(writes,jwt());return result}});
actor='manager@example.test';
await commit([write('users/'+actor,{enabled:true,role:'manager'}),write('users/teacher@example.test',{enabled:false,role:'user',name:'測試老師'}),write('expenseRecords/protected',{ownerEmail:'teacher@example.test',amount:6010,estimated:true})],'owner');
let current=await service.inspect('teacher@example.test');assert.equal(touched.length,0);
await service.save(current.email,{enabled:true,role:'teacher',expected:current.profile});assert.equal((await read('users/teacher@example.test')).data().enabled,true);assert.equal((await read('expenseRecords/protected')).data().amount,6010);console.log('actual account service enable teacher; finances unchanged PASS');
current=await service.inspect('teacher@example.test');await service.save(current.email,{enabled:true,role:'manager',expected:current.profile});assert.equal((await read('users/teacher@example.test')).data().role,'manager');console.log('actual account service explicit manager role update PASS');
actor='teacher@example.test';auth.currentUser.email=actor;
await commit([write('users/'+actor,{enabled:true,role:'teacher'})],'owner');
await assert.rejects(service.inspect('manager@example.test'));await assert.rejects(service.save(actor,{enabled:true,role:'manager',expected:{enabled:true,role:'teacher'}}));assert.equal(touched.length,2);console.log('actual teacher cannot use manager controls PASS');
})().catch(error=>{console.error(error);process.exitCode=1});
