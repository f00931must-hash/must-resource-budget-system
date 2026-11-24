import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyInstallment,mutateInstallment,occupiedAmount,reconciliationParts,installmentBuckets} from '../budget-installments-core.mjs';
const entry={date:'2026-11-24',purpose:'耗材',amount:8000,reimbursementNo:'G12345678',voucher:{url:'https://example.test/file.pdf'},confirmed:true};
const parent=()=>({purpose:'雜支',amount:140000,installment:emptyInstallment()});
test('staged lifecycle reserves once, reviews then releases only unspent money',()=>{
 let r=parent();r.installment=mutateInstallment(r,'save','one',entry);assert.equal(occupiedAmount(r),140000);assert.equal(r.amount-r.installment.total,132000);
 assert.equal(reconciliationParts(r).reduce((s,x)=>s+x.amount,0),140000);
 assert.throws(()=>mutateInstallment(r,'close','',null,true));
 r.installment=mutateInstallment(r,'review','one',null,true);r.installment=mutateInstallment(r,'close','',null,true);
 assert.equal(occupiedAmount(r),8000);assert.equal(reconciliationParts(r).reduce((s,x)=>s+x.amount,0),8000);assert.throws(()=>mutateInstallment(r,'close','',null,true));
});
test('no legacy record changes and zero additional charge for children',()=>{
 for(const r of [{amount:300},{amount:300,advanceTopUpTotal:82},{amount:300,installment:{enabled:false}}])assert.equal(occupiedAmount(r),Number(r.amount)+Number(r.advanceTopUpTotal||0));
 const r={amount:300};assert.equal(reconciliationParts(r)[0],r);
});
test('mode remains locked after deleting all entries; empty unused mode can turn off',()=>{
 const r=parent();assert.equal(mutateInstallment(r,'disable').enabled,false);r.installment=mutateInstallment(r,'save','one',entry);r.installment=mutateInstallment(r,'delete','one');assert.equal(r.installment.total,0);assert.throws(()=>mutateInstallment(r,'disable'));
});
test('rejects missing evidence, overdraw, negative amount and non-manager review',()=>{
 const r=parent();assert.throws(()=>mutateInstallment(r,'save','one',{...entry,amount:140001}));assert.throws(()=>mutateInstallment(r,'save','one',{...entry,amount:-1}));assert.throws(()=>mutateInstallment(r,'save','one',{...entry,voucher:null}));
 r.installment=mutateInstallment(r,'save','one',entry);assert.throws(()=>mutateInstallment(r,'review','one',null,false));
});
test('editing replaces one amount; manager review locks edits until explicit unlock',()=>{
 const r=parent();r.installment=mutateInstallment(r,'save','one',entry);r.installment=mutateInstallment(r,'save','one',{...entry,amount:9000});assert.equal(r.installment.total,9000);
 r.installment=mutateInstallment(r,'review','one',null,true);assert.throws(()=>mutateInstallment(r,'delete','one'));
 r.installment=mutateInstallment(r,'unlock','one',null,true);r.installment=mutateInstallment(r,'delete','one');assert.equal(r.installment.total,0);assert.equal(r.installment.reviewedTotal,0);
});

test('dashboard buckets add to occupation before and after closure without duplicating parent',()=>{
 const r=parent();r.installment=mutateInstallment(r,'save','one',entry);
 assert.deepEqual(installmentBuckets(r),{approved:0,pending:8000,reserved:132000});
 r.installment=mutateInstallment(r,'review','one',null,true);
 assert.deepEqual(installmentBuckets(r),{approved:8000,pending:0,reserved:132000});
 r.installment=mutateInstallment(r,'close','',null,true);
 assert.deepEqual(installmentBuckets(r),{approved:8000,pending:0,reserved:0});
});
