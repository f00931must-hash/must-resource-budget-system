import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {grossAdvance,netAdvance} from '../budget-advance-totals.mjs';
const settlement=readFileSync(new URL('../budget-advance-settlement.js',import.meta.url),'utf8');
const context={Number};vm.createContext(context);
vm.runInContext(settlement.slice(settlement.indexOf('function refunded'),settlement.indexOf('export function settlementMarkup')).replace('export function','function'),context);
const confirmedRefund=context.confirmedRefund;
const balance=(receipt,a,r)=>receipt-netAdvance(a,confirmedRefund(a,r));
test('5088 allocated, 82 confirmed returned, 82 paid again returns net and cash balance to original',()=>{
 const original={estimatedAmount:5088};
 const refunded={...original,refundConfirmedTotal:82};
 const repaid={...refunded,advanceTopUpTotal:82};
 assert.equal(balance(10000,original,{amount:5088}),4912);
 assert.equal(balance(10000,refunded,{amount:5006}),4994);
 assert.equal(grossAdvance(repaid),5170);
 assert.equal(netAdvance(repaid,confirmedRefund(repaid,{amount:5006})),5088);
 assert.equal(balance(10000,repaid,{amount:5006}),4912);
 // Expense base already includes refund adjustment. Top-up is added once.
 assert.equal(5006+repaid.advanceTopUpTotal,5088);
});
test('top-ups without refunds consume available funds',()=>{
 assert.equal(balance(10000,{estimatedAmount:5088,advanceTopUpTotal:82},{amount:5088}),4830);
});
test('pending and inconsistent refunds do not free money',()=>{
 assert.equal(balance(10000,{estimatedAmount:5088,refundReported:true,refundAmount:82},{amount:5088}),4912);
 assert.equal(balance(10000,{estimatedAmount:5088,refundConfirmedTotal:82},{amount:5088}),4912);
});
test('legacy confirmed refunds and split refunds retain established validation',()=>{
 assert.equal(netAdvance({estimatedAmount:5088,advanceTopUpTotal:82},confirmedRefund({estimatedAmount:5088,refundReceivedConfirmed:true,refundAmount:82},{amount:5006})),5088);
 const split={estimatedAmount:5088,advanceTopUpTotal:82,payoutSplit:true,splitRefundTotal:82};
 assert.equal(netAdvance(split,confirmedRefund(split,{amount:5006})),5088);
});
test('multiple allocations conserve cash including repeated top-ups and refunds',()=>{
 const entries=[{estimatedAmount:5088,advanceTopUpTotal:82,refundConfirmedTotal:82},{estimatedAmount:1000,advanceTopUpTotal:120,refundConfirmedTotal:20}];
 const total=entries.reduce((s,a)=>s+netAdvance(a,confirmedRefund(a,{amount:a.estimatedAmount-a.refundConfirmedTotal})),0);
 assert.equal(total,6188);assert.equal(10000-total,3812);
});
test('manager display, allocation limit and cash summary all include top-ups',()=>{
 const src=readFileSync(new URL('../budget-advance-v150.js',import.meta.url),'utf8');
 assert.match(src,/estimateTotal\+=grossAdvance\(a\)/);
 assert.match(src,/const afterTotal=same.reduce\(\(s,a\)=>s\+netAdvance\(a,confirmedRefund\(a,recordForAllocation\(a\)\)\)/);
 assert.match(src,/receivedSum-estimateTotal\+returnedTotal/);
 assert.match(src,/const variance=actual===null\?null:net-actual/);
 assert.match(src,/淨預支合計 \$\{money.format\(net\)\}/);
});
