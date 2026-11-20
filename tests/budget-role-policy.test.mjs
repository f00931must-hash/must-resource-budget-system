import {test} from 'node:test';
import assert from 'node:assert/strict';
import {budgetRole,isBudgetManager,canUseAdvance,isAdvanceOnly} from '../budget-permissions.mjs';
test('all UI modules share active role/primary-manager interpretation',()=>{
 for(const role of ['manager','advance','teacher','user','assistant'])for(const enabled of [true,false]) {
  const p={enabled,role};
  assert.equal(isBudgetManager(p,'teacher@example.test'),enabled&&role==='manager');
  assert.equal(canUseAdvance(p,'teacher@example.test'),enabled&&['manager','advance'].includes(role));
  assert.equal(isAdvanceOnly(p,'teacher@example.test'),enabled&&role==='advance');
  assert.equal(isBudgetManager(p,'MASTER004400@GMAIL.COM'),enabled);
 }
 assert.equal(budgetRole(null),null);
});
