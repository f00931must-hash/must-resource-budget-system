const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync('budget-advance-link-existing-v153.js','utf8');const fn=src.slice(src.indexOf('async function saveLink(e){'),src.indexOf('window.addEventListener("click"'));
(async()=>{for(const mode of ['success','verify-denied','read-denied','transaction-denied','audit-denied','double-submit']){
const error=Object.assign(new Error('Missing or insufficient permissions.'),{code:'permission-denied'}),fields={advanceExistingSave:{disabled:mode==='double-submit'},advanceExistingAllocationId:{value:''},advanceExistingRecordSelect:{value:'e'},advanceExistingNote:{value:''},advanceExistingEstimateDialog:{close(){}}};
let writes=[],alerts=[],reloads=0,txCount=0;
let batch={semester:'115-1',categoryIds:['c']},record={id:'e',amount:100,ownerEmail:'teacher@example.test',categoryId:'c',planId:'p',semester:'115-1',estimated:true};
const c={console:{error(){}},$:k=>fields[k],verifyManager:async()=>{if(mode==='verify-denied')throw error;return'manager@example.test'},batchId:()=>'b',planId:()=>'p',availableRecords:[record],getDoc:async()=>{if(mode==='read-denied')throw error;return{exists:()=>true,data:()=>batch}},db:{},doc:(...args)=>args.length===1?{id:'new'}:{id:args[2]},collection:()=>({}),batchCategoryIds:b=>b.categoryIds,batchCategoryLabel:()=>'',num:Number,ownOnly:false,approved:()=>false,serverTimestamp:()=>({time:true}),runTransaction:async(_,fn)=>{txCount++;if(mode==='transaction-denied')throw error;await fn({get:async ref=>({exists:()=>true,data:()=>ref.id==='e'?record:batch}),set:(ref,d)=>writes.push(['set',d]),update:(ref,d)=>writes.push(['update',d])})},addDoc:async()=>{if(mode==='audit-denied')throw error},location:{reload(){reloads++}},alert:x=>alerts.push(x)};
vm.createContext(c);await vm.runInContext(fn+';saveLink({preventDefault(){}})',c);
if(mode==='success'){assert.equal(writes.length,2);assert.equal(reloads,1);assert.equal(alerts.length,0)}
if(mode==='audit-denied'){assert.equal(writes.length,2);assert.match(alerts[0],/已儲存/);assert.match(alerts[0],/操作紀錄/);assert.equal(reloads,0)}
if(mode==='transaction-denied'){assert.equal(writes.length,0);assert.match(alerts[0],/未完成/)}
if(mode==='verify-denied')assert.match(alerts[0],/驗證管理員資格/);
if(mode==='read-denied')assert.match(alerts[0],/讀取預支批次/);
if(mode==='double-submit')assert.equal(txCount,0);else assert.equal(fields.advanceExistingSave.disabled,false);
console.log(mode,'PASS');
}})().catch(e=>{console.error(e);process.exitCode=1});
