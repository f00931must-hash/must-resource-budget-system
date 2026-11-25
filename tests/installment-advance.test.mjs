import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installmentAdvanceCandidates,linkInstallmentAllocation,unlinkInstallmentAllocation,installmentAllocationRecord} from '../budget-installment-advance.mjs';
import {occupiedAmount,emptyInstallment,mutateInstallment} from '../budget-installments-core.mjs';
const parent=()=>({id:'parent',planId:'p',semester:'115-1',categoryId:'misc',ownerEmail:'teacher@example.test',purpose:'雜支整筆請購',amount:140000,installment:{...emptyInstallment(),everUsed:true,total:34734,entries:{cards:{date:'2026-11-25',purpose:'卡牌及免洗餐具',amount:5734,reimbursementNo:'',reviewed:false,voucher:null},film:{date:'2026-11-25',purpose:'玻璃霧膜',amount:29000,reimbursementNo:'',reviewed:false,voucher:null}}}});
const batch={id:'batch',planId:'p',semester:'115-1',categoryIds:['misc']};
test('only unlinked children appear, with distinct labels and no duplicate parent',()=>{
 const r=parent(),rows=installmentAdvanceCandidates([r,{id:'normal',amount:9}]);assert.equal(rows.length,3);assert.equal(rows[0].amount,5734);assert.match(rows[0].purpose,/整筆請購｜卡牌/);assert.equal(rows[2].id,'normal');
 r.installment.entries.cards.advanceAllocationId='a';assert.equal(installmentAdvanceCandidates([r]).length,1);
 r.installment.closed=true;assert.equal(installmentAdvanceCandidates([r]).length,0);
});
test('linking adds a payment allocation and does not change reserved amount, child total or expense count',()=>{
 const r=parent(),result=linkInstallmentAllocation(r,'cards',batch,'a','manager@example.test','now');
 assert.equal(result.allocation.estimatedAmount,5734);assert.equal(result.allocation.payoutSplit,true);assert.equal(result.allocation.expenseRecordId,'parent');assert.equal(result.installment.total,34734);assert.equal(occupiedAmount({...r,installment:result.installment}),140000);
 assert.equal(result.installment.entries.cards.advanceAllocationId,'a');assert.equal(r.installment.entries.cards.advanceAllocationId,undefined);
 const virtual=installmentAllocationRecord(result.allocation,[r]);assert.equal(virtual.amount,5734);assert.equal(virtual.estimated,false);
});
test('duplicate, cross-term and cross-category assignments are rejected',()=>{
 const r=parent();r.installment=linkInstallmentAllocation(r,'cards',batch,'a','manager','now').installment;
 assert.throws(()=>linkInstallmentAllocation(r,'cards',batch,'b','manager','now'));
 assert.throws(()=>linkInstallmentAllocation(parent(),'cards',{...batch,semester:'114-2'},'a','manager','now'));
 assert.throws(()=>linkInstallmentAllocation(parent(),'cards',{...batch,categoryIds:['other']},'a','manager','now'));
});
test('linked child amount and deletion are locked while late evidence remains editable',()=>{
 const r=parent();r.installment=linkInstallmentAllocation(r,'cards',batch,'a','manager','now').installment;
 const e=r.installment.entries.cards;assert.throws(()=>mutateInstallment(r,'delete','cards'));assert.throws(()=>mutateInstallment(r,'save','cards',{...e,amount:5}));
 const next=mutateInstallment(r,'save','cards',{...e,voucher:{url:'https://example.test/late.pdf'}});assert.equal(next.entries.cards.advanceAllocationId,'a');assert.equal(next.total,34734);
});
test('unlink only after unreceived child payments removed, preserving ledger and balance',()=>{
 const r=parent(),linked=linkInstallmentAllocation(r,'cards',batch,'a','manager','now');r.installment=linked.installment;
 assert.throws(()=>unlinkInstallmentAllocation(r,{id:'a',...linked.allocation,splitAssigned:100}));
 const s=unlinkInstallmentAllocation(r,{id:'a',...linked.allocation});assert.equal(s.entries.cards.advanceAllocationId,'');assert.equal(s.total,34734);assert.equal(s.everUsed,true);
});
