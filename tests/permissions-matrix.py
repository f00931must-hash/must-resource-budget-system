"""UI payload/role/state coverage supplementing the historical regressions."""
from _emulator_client import *
T='teacher@example.test';M='manager@example.test';A='advance@example.test';O='other@example.test'
for who,role in [(T,'teacher'),(O,'teacher'),(M,'manager'),(A,'advance')]:seed('users/'+who,{'enabled':True,'role':role,'name':who})
base={'ownerEmail':T,'ownerName':'老師','createdBy':O,'planId':'p','categoryId':'c','amount':6010,'semester':'115-1','purpose':'特推會','note':'','estimated':True,'reviewStatus':'estimated','reviewed':False,'locked':False,'deleted':False}
def expense(name,patch,who=T,allowed=True,old=None,stamps=()):
 seed('expenseRecords/e',old or base)
 expect(name,[update('expenseRecords/e',patch,who,stamps)],who,allowed)
for who in [T,M,A,O]:
 own=who in [T,M]
 for name,patch in [('amount',{'amount':6020}),('semester',{'semester':'114-2'}),('category',{'categoryId':'other'}),('purpose',{'purpose':'修正'}),('hanlong',{'hanlongAdvance':True}),('stage',{'estimateStage':'purchasing'})]:expense(who+' '+name,patch,who,own)
 formal={**base,'estimated':False,'estimateStage':'','reviewStatus':'pending','voucherUrl':'https://example.test/e.pdf','archived':True,'amountConfirmed':True}
 expense(who+' reuse evidence',{'note':'已確認','archived':True,'amountConfirmed':True},who,own,formal)
 expense(who+' change evidence',{'voucherUrl':'https://example.test/new.pdf','voucherPath':'uploads/budget/new','voucherStoragePath':'uploads/budget/new','voucherFileName':'new.pdf','voucherFileType':'application/pdf','voucherFileSize':100},who,own,formal)
 detach={'voucherUrl':'','folderUrl':'','voucherPath':'','voucherStoragePath':'','voucherFileName':'','voucherFileType':'','voucherFileSize':0,'archived':False,'amountConfirmed':False,'amountManuallyConfirmed':False}
 expense(who+' detach evidence',detach,who,own,formal)
 expense(who+' soft delete',{'deleted':True,'deletedBy':who},who,own,stamps=['deletedAt'])
 expense(who+' restore',{'deleted':False,'deletedAt':None,'deletedBy':None,'restoredBy':who},who,who==M,{**base,'deleted':True},['restoredAt'])
 expense(who+' change unlinked owner',{'ownerEmail':O,'ownerName':'另一位'},who,who==M)
 expense(who+' change linked reporting owner',{'accountingOwnerEmail':O,'accountingOwnerName':'另一位'},who,who==M,{**base,'advanceAllocationId':'a'})
 purge={'voucherPurged':True,'voucherPurgedBy':who,'voucherPurgedOriginalPath':'uploads/budget/old','voucherPurgedOriginalName':'e.pdf','voucherPurgedAction':'single','voucherUrl':'','folderUrl':'','voucherPath':'','voucherStoragePath':'','archived':False}
 expense(who+' purge stored evidence',purge,who,who==M,formal,['voucherPurgedAt'])
 expense(who+' approve',{'reviewStatus':'approved','reviewed':True,'locked':True,'reviewedBy':who},who,who==M,formal,['reviewedAt'])
 expense(who+' reopen',{'reviewStatus':'pending','reviewed':False,'locked':False,'unlockedBy':who},who,who==M,{**formal,'reviewStatus':'approved','locked':True,'reviewed':True},['unlockedAt'])
# Both sides of top-ups and cancellation must commit together.
for who in [T,M,A,O]:
 allocation={'ownerEmail':A,'batchId':'b','expenseRecordId':'e','estimatedAmount':6010,'deleted':False}
 record={**base,'ownerEmail':A,'advanceAllocationId':'a','advanceBatchId':'b'}
 seed('advanceBatches/b',{'handlerEmail':A,'planId':'p','deleted':False})
 for mode in ['both','expense-only','allocation-only']:
  seed('advanceAllocations/a',allocation);seed('expenseRecords/e',record)
  writes=[update('advanceAllocations/a',{'advanceTopUpTotal':100},who),update('expenseRecords/e',{'advanceTopUpTotal':100},who)]
  if mode=='expense-only':writes=writes[1:]
  if mode=='allocation-only':writes=writes[:1]
  expect(who+' top-up '+mode,writes,who,who==M and mode=='both')
 for orphan in [False,True]:
  seed('advanceAllocations/a',allocation);seed('expenseRecords/e',{**record,'deleted':orphan})
  writes=[update('advanceAllocations/a',{'deleted':True,'deletedBy':who,**({'orphanSourceRemoved':True} if orphan else {})},who,['deletedAt'])]
  if not orphan:writes.append(update('expenseRecords/e',{'advanceAllocationId':'','advanceBatchId':'','advanceLinked':False},who))
  expect(who+' unlink orphan='+str(orphan),writes,who,who in [M,A])
# Master account uses the same active profile gate for financial writes.
for enabled in [False,True]:
 who='master004400@gmail.com';seed('users/'+who,{'enabled':enabled,'role':'manager'})
 expense('primary manager enabled='+str(enabled),{'amount':6020},who,enabled)
# Rejected writes must not fall into an unbounded generic allow rule.
for patch in [{'planId':'different'},{'createdBy':T},{'amount':-1},{'accountingVoucherAmount':10},{'unrecognizedAdminField':True}]:expense('reject '+str(patch),patch,M,False)
# Receipt authority: teachers handle their own receipts, managers may handle anyone's.
for who in [T,M,A,O]:
 for collection in ['advanceBatches','budgetPlans','budgetCategories']:
  doc={'planId':'p','handlerEmail':A,'createdBy':A,'createdAt':'legacy','title':'old','deleted':False}
  seed(collection+'/managed',doc)
  expect(who+' edit '+collection,[update(collection+'/managed',{'title':'new'},who)],who,who==M or who==A and collection=='advanceBatches')
 allocation={'planId':'p','ownerEmail':T,'batchId':'b','expenseRecordId':'e','estimatedAmount':6010,'deleted':False}
 seed('advanceAllocations/a',allocation)
 expect(who+' receive full allocation',[update('advanceAllocations/a',{'allocationReceivedConfirmed':True,'allocationReceivedBy':who},who,['allocationReceivedAt'])],who,who in [T,M])
 allocation.update(allocationReceivedConfirmed=True)
 seed('advanceAllocations/a',allocation)
 expect(who+' report full-allocation refund',[update('advanceAllocations/a',{'refundReported':True,'refundReceivedConfirmed':False,'refundConfirmedTotal':0,'refundAmount':100,'refundReportedBy':who},who,['refundReportedAt'])],who,who in [T,M])
# Existing pending actual-amount requests still support review, without a generic manager fallback.
for who in [T,M,A,O]:
 old={**base,'advanceAllocationId':'a','voucherUrl':'https://example.test/e.pdf','amountConfirmed':True,'actualAdjustment':{'status':'pending','amount':5900,'reason':'差額','requestedBy':T}}
 alloc={'ownerEmail':T,'batchId':'b','expenseRecordId':'e','estimatedAmount':6010,'deleted':False}
 for action in ['approve','reject','approve-expense-only']:
  seed('expenseRecords/e',old);seed('advanceAllocations/a',alloc)
  adj={**old['actualAdjustment'],'status':'rejected' if action=='reject' else 'approved','reviewedBy':who}
  patch={'actualAdjustment':adj}
  if action!='reject':patch.update(amount=5900,estimated=False,estimateStage='',reviewStatus='pending',archived=True)
  writes=[update('expenseRecords/e',patch,who,['actualAdjustment.reviewedAt'])]
  if action=='approve':writes.append(update('advanceAllocations/a',{'settlementAmount':5900},who))
  expect(who+' actual adjustment '+action,writes,who,who==M and action!='approve-expense-only')

# A disabled user can read their own profile to get a useful inactive-account message,
# but cannot read/write finances or inspect other user profiles.
for active in [False,True]:
 seed('users/'+T,{'enabled':active,'role':'teacher'})
 for path,allowed in [('users/'+T,True),('users/'+O,False),('expenseRecords/e',active)]:
  req=urllib.request.Request(BASE+'/'+path,headers={'Authorization':'Bearer '+jwt(T)})
  try:
   with OPENER.open(req) as response:code=response.status
  except urllib.error.HTTPError as error:code=error.code
  assert code==(200 if allowed else 403),(active,path,code)
  print('PASS own-profile/financial read',active,path)
