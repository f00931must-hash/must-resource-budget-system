const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync('budget-no-voucher-request-v137.js','utf8');
const fn=src.slice(src.indexOf('async function saveRequestedRecord(){'),src.indexOf('async function approveConfirmedWaiver'));
(async()=>{
const policy=await import("../budget-permissions.mjs");
for(const role of ['teacher','manager'])for(const mode of ['create','submit','linked','edit']){
 const email=role+'@example.test',existing=mode==='create'?null:{planId:'p',categoryId:'c',purpose:'old',amount:100,semester:'115-1',estimated:true,ownerEmail:role==='manager'?'teacher@example.test':email,ownerName:'測試',createdBy:'teacher@example.test',hanlongAdvance:false,...(mode==='linked'?{advanceAllocationId:'a',advanceTopUpTotal:20}:{}),...(mode==='edit'?{voucherNotRequiredRequested:true,estimated:false}:{})};
 const fields={recordId:{value:existing?'id':''},planSelect:{value:'p'},recordCategory:{value:'c'},recordPurpose:{value:'new'},recordAmount:{value:mode==='linked'?'120':'100'},recordSemester:{value:'115-1'},recordNote:{value:''},recordVoucherFile:{files:[]},recordHanlongAdvance:{checked:false},recordPurchaseOrderNo:{value:'P123'},recordReimbursementNo:{value:'R123'},recordDialog:{close(){}}};
 let writes=[],reads=[];
 const context={...policy,ctx:()=>({db:{},auth:{currentUser:{email}}}),document:{getElementById:k=>fields[k]},window:{dispatchEvent(){}},CustomEvent:class{},serverTimestamp:()=>({__timestamp:true}),doc:(_,col,id)=>({col,id}),collection:(_,col)=>col,getDoc:async ref=>{reads.push(ref.col);const data=ref.col==='users'?{enabled:true,role,name:'測試'}:ref.col==='expenseRecords'?existing:ref.col==='budgetPlans'?{active:true}:{planId:'p',budget:0};return {exists:()=>!!data,data:()=>data}},updateDoc:async(ref,data)=>writes.push({ref,data}),addDoc:async(ref,data)=>{writes.push({ref,data});return{id:'new'}}};
 vm.createContext(context);await vm.runInContext(fn+';saveRequestedRecord()',context);
 assert.equal(writes.length,1);let d=writes[0].data;
 assert.equal(d.purchaseOrderNo,'P123');assert.equal(d.reimbursementNo,'R123');
 assert.ok(!('voucherNotRequired' in d));assert.ok(!('amountConfirmedByManagerWaiver' in d));
 if(mode!=='edit'){assert.equal(d.reviewStatus,'pending');assert.equal(d.amount,100);assert.equal(d.estimateStage,'');assert.equal(d.ownerEmail,existing?.ownerEmail||email);assert.equal(d.voucherNotRequiredRequested,true)}
 assert.ok(reads.length<=4);console.log(role,mode,'PASS');
}
})().catch(e=>{console.error(e);process.exitCode=1});
