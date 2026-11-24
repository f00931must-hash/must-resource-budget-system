import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import jsdom from '../.emulator/node_modules/jsdom/lib/api.js';
import * as core from '../budget-installments-core.mjs';
const {JSDOM}=jsdom;
async function page(manager=false){
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://example.test/budget/',runScripts:'outside-only'}),w=dom.window;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};w.confirm=()=>true;
 const $=id=>w.document.getElementById(id),writes=[],errors=[],records=new Map(),state={user:{email:'teacher@example.test'},activePlanId:'p',plans:[{id:'p',active:true}],records:[]};
 const stamp=()=>({seconds:1});
 const ctx={$,state,db:{},doc:(_,col,id)=>({col,id}),collection:(_,col)=>col,addDoc:async(col,data)=>{writes.push({col,data});records.set('parent',data);return{id:'parent'};},runTransaction:async(_,fn)=>fn({get:async ref=>({data:()=>records.get(ref.id)}),update:(ref,data)=>{writes.push({col:ref.col,data});records.set(ref.id,{...records.get(ref.id),...data});}}),serverTimestamp:stamp,isManager:()=>manager,toast:e=>errors.push(e),refreshOneExpense:async id=>{state.records=[{id,...records.get(id)}];},uploadVoucherFile:async()=>({url:'https://example.test/fake.pdf',name:'fake.pdf',path:'test',type:'application/pdf',size:12}),selectedRecordOwner:()=>({email:state.user.email,name:'fake'}),esc:String,escAttr:String,money:new Intl.NumberFormat('zh-TW')};
 Object.assign(w,core);const src=fs.readFileSync('budget-installments-ui.mjs','utf8').replace(/^import .*;\n/,'').replace('export function','function');
 vm.runInContext(src,dom.getInternalVMContext());const api=w.installInstallments(ctx);
 $('recordCategory').innerHTML='<option value="c">雜支</option>';$('recordSemester').value='115-1';$('recordPurpose').value='fake';$('recordAmount').value='140000';$('recordInstallment').checked=true;
 return {dom,w,$,state,writes,errors,records,api};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
test('new checked record hides parent evidence and creates a single reserved parent',async()=>{
 const p=await page();try{p.$('recordInstallment').onchange();assert.equal(p.$('recordForm').querySelector('.voucher-upload').hidden,true);
 assert.equal(await p.api.save(null),true);assert.equal(p.writes.length,1);assert.equal(p.writes[0].data.amount,140000);assert.equal(p.state.records.length,1);assert.equal(core.occupiedAmount(p.state.records[0]),140000);
 }finally{p.dom.window.close();}
});
test('existing ordinary records are never converted or written on form sync',async()=>{
 const p=await page();try{p.api.sync({id:'old',amount:123});assert.equal(p.$('recordInstallment').disabled,true);assert.equal(p.$('recordInstallment').checked,false);assert.equal(await p.api.save({id:'old',amount:123}),false);assert.equal(p.writes.length,0);
 }finally{p.dom.window.close();}
});
test('actual dialog saves child evidence, keeps parent occupation, then manager reviews and closes',async()=>{
 const p=await page(true);try{
 await p.api.save(null);p.$('recordList').innerHTML=p.api.markup(p.state.records[0]);p.w.document.querySelector('[data-installment]').click();await tick();
 p.$('instPurpose').value='耗材';p.$('instAmount').value='8000';p.$('instNumber').value='G12345678';p.$('instConfirmed').checked=true;
 Object.defineProperty(p.$('instFile'),'files',{value:[new p.w.File(['fake'],'fake.pdf',{type:'application/pdf'})]});
 await p.$('installmentEntryForm').onsubmit({preventDefault(){}});
 let parent=p.state.records[0];assert.equal(parent.installment.total,8000);assert.equal(core.occupiedAmount(parent),140000);assert.equal(Object.values(parent.installment.entries)[0].voucher.url,'https://example.test/fake.pdf');
 p.api.sync(parent);assert.equal(p.$('recordInstallment').disabled,true);
 p.w.document.querySelector('[data-action="review"]').click();await tick();assert.equal(p.state.records[0].installment.reviewedTotal,8000);
 p.$('instCloseCase').click();await tick();parent=p.state.records[0];assert.equal(parent.installment.closed,true);assert.equal(core.occupiedAmount(parent),8000);assert.equal(p.$('installmentEntryForm'),null);
 assert.ok(p.writes.every(x=>x.col==='expenseRecords'));assert.ok(!p.errors.some(x=>x.includes('失敗')));
 }finally{p.dom.window.close();}
});
test('teacher has no review or close controls and upload-less save fails visibly',async()=>{
 const p=await page();try{await p.api.save(null);p.$('recordList').innerHTML=p.api.markup(p.state.records[0]);p.w.document.querySelector('[data-installment]').click();await tick();assert.equal(p.$('instCloseCase'),null);assert.equal(p.w.document.querySelector('[data-action="review"]'),null);
 p.$('instPurpose').value='耗材';p.$('instAmount').value='8000';p.$('instConfirmed').checked=true;await p.$('installmentEntryForm').onsubmit({preventDefault(){}});assert.equal(p.writes.length,1);assert.match(p.errors.at(-1),/單據/);
 }finally{p.dom.window.close();}
});

test('real capture-phase submit guard does not make installment saving silently skip',async()=>{
 const p=await page();try{
  vm.runInContext(fs.readFileSync('budget-submit-guard-v169.js','utf8'),p.dom.getInternalVMContext());
  let pending,calls=0;p.$('recordForm').addEventListener('submit',event=>{event.preventDefault();calls++;pending=p.api.save(null);});
  const event=()=>new p.w.Event('submit',{bubbles:true,cancelable:true});
  p.$('recordForm').dispatchEvent(event());p.$('recordForm').dispatchEvent(event());
  await pending;await tick();
  assert.equal(calls,1);assert.equal(p.writes.length,1);assert.equal(p.$('recordSaveBtn').disabled,false);
  assert.equal(p.$('recordSavingOverlay').classList.contains('hidden'),true);
 }finally{p.dom.window.close();}
});
test('validation errors release the actual saving overlay without creating a record',async()=>{
 const p=await page();try{
  vm.runInContext(fs.readFileSync('budget-submit-guard-v169.js','utf8'),p.dom.getInternalVMContext());
  p.$('recordPurpose').value='';let pending;
  p.$('recordForm').addEventListener('submit',event=>{event.preventDefault();pending=p.api.save(null);});
  p.$('recordForm').dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await pending;await tick();
  assert.equal(p.writes.length,0);assert.equal(p.$('recordSavingOverlay').classList.contains('hidden'),true);assert.equal(p.$('recordSaveBtn').disabled,false);
 }finally{p.dom.window.close();}
});
