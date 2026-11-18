"""Local Firestore emulator regression tests. Never connects to production.
Run emulator on 127.0.0.1:18947, project demo-attach, with ../firestore.rules.
Then run: python tests/expense-permissions-20261118.py
"""
import json,base64,time,urllib.request,urllib.error
BASE='http://127.0.0.1:18947/v1/projects/demo-attach/databases/(default)/documents'
def enc(v):
 if v is None:return {'nullValue':None}
 if isinstance(v,bool): return {'booleanValue':v}
 if isinstance(v,int): return {'integerValue':str(v)}
 return {'stringValue':v}
def call(writes,token):
 req=urllib.request.Request(BASE+':commit',data=json.dumps({'writes':writes}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req) as r:return r.status,''
 except urllib.error.HTTPError as e:return e.code,e.read().decode()
def write(path,d,stamp=False):
 w={'update':{'name':BASE.split('/v1/')[1]+'/'+path,'fields':{k:enc(v) for k,v in d.items()}}}
 if stamp:w['updateTransforms']=[{'fieldPath':'updatedAt','setToServerValue':'REQUEST_TIME'}]
 return w
def token(email):
 def b(v):return base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip('=')
 return b({'alg':'none','typ':'JWT'})+'.'+b({'iss':'https://securetoken.google.com/demo-attach','aud':'demo-attach','sub':email,'user_id':email,'email':email,'email_verified':True,'iat':int(time.time()),'exp':int(time.time())+3600,'firebase':{'sign_in_provider':'password'}})+'.'
actor='teacher@example.test'
print('seed user',call([write('users/'+actor,{'enabled':True,'role':'teacher'})],'owner')[0])
base={'planId':'p','categoryId':'c','purpose':'test','amount':100,'semester':'115-1','estimated':True,'estimateStage':'reimbursing','hanlongAdvance':False,'archived':False,'amountConfirmed':False,'reviewStatus':'estimated','reviewed':False,'locked':False,'note':'','ownerEmail':actor,'ownerName':'測試老師','createdBy':actor,'updatedBy':actor,'voucherUrl':'','deleted':False}

manager='manager@example.test'
call([write('users/'+manager,{'enabled':True,'role':'manager'})],'owner')
for who in [actor,manager]:
 for linked in [False,True]:
  for mode in ['create','request','edit','confirm','review','revoke','other','locked','amount','owner','self-approve']:
   old=base.copy()
   if linked:old.update(advanceAllocationId='a',advanceBatchId='b',originalEstimatedAmount=100)
   if mode in ['edit','confirm','review','revoke']:
    old.update(estimated=False,voucherNotRequiredRequested=True,reviewStatus='pending')
   if mode in ['review','revoke']:
    old.update(voucherWaiverManagerConfirmed=True,voucherNotRequired=True,voucherRequirementWaived=True,amountConfirmed=True,amountConfirmedByManagerWaiver=True)
   if mode=='locked':old.update(locked=True,reviewed=True,reviewStatus='approved')
   new=old.copy();new.update(estimated=False,reviewStatus='pending',reviewed=False,locked=False,voucherNotRequiredRequested=True,voucherNotRequiredRequestedBy=who,updatedBy=who)
   transforms=['updatedAt','voucherNotRequiredRequestedAt']
   if mode=='edit':new=old.copy();new.update(purpose='edited',updatedBy=who);transforms=['updatedAt']
   if mode in ['confirm','revoke']:
    new=old.copy();v=mode=='confirm';new.update(voucherWaiverManagerConfirmed=v,voucherWaiverManagerConfirmedBy=who if v else '',voucherWaiverManagerConfirmedAt=None,voucherNotRequired=v,voucherRequirementWaived=v,amountConfirmed=v,amountConfirmedByManagerWaiver=v,updatedBy=who)
    transforms=['updatedAt']+(['voucherWaiverManagerConfirmedAt'] if v else [])
   if mode=='review':
    new=old.copy();new.update(reviewStatus='approved',reviewed=True,locked=True,reviewedBy=who,updatedBy=who);transforms=['updatedAt','reviewedAt']
   if mode=='other':old['ownerEmail']='unrelated@example.test';new['ownerEmail']=old['ownerEmail']
   if mode=='amount':new['amount']=101
   if mode=='owner':new['ownerEmail']='unrelated@example.test'
   if mode=='self-approve':new['amountConfirmedByManagerWaiver']=True
   path='expenseRecords/test';call([write(path,old)],'owner')
   if mode=='create':
    path='expenseRecords/new-'+who+str(linked);new=base.copy();new.update(ownerEmail=who,createdBy=who,estimated=False,reviewStatus='pending',voucherNotRequiredRequested=True,voucherNotRequiredRequestedBy=who,updatedBy=who)
   w=write(path,new);w['updateTransforms']=[{'fieldPath':k,'setToServerValue':'REQUEST_TIME'} for k in transforms]
   for k in transforms:w['update']['fields'].pop(k,None)
   status,msg=call([w],token(who))
   expected=200 if (mode in ['create','request','edit'] or mode in ['confirm','review','revoke','other'] and who==manager or mode=='amount' and not linked) else 403
   print(who,linked,mode,status,'PASS' if status==expected else 'FAIL',('LIMIT' if '1000' in msg else ''),flush=True)
   assert status==expected,(who,linked,mode,status,msg)

for linked in [False,True]:
 for mode in ['submit','estimate','replace','other','locked','change-linked-amount','change-owner','change-plan','change-category','change-semester','change-createdBy','change-accounting','negative-amount']:
  old=base.copy()
  if linked:old.update(advanceAllocationId='a',advanceBatchId='b',originalEstimatedAmount=100)
  if mode=='replace':old.update(estimated=False,estimateStage='',reviewStatus='pending',voucherUrl='https://example.test/old',archived=True,amountConfirmed=True)
  if mode=='locked':old.update(reviewStatus='approved',locked=True,reviewed=True)
  new=old.copy();new.update(voucherUrl='https://example.test/new',voucherPath='uploads/test',voucherStoragePath='uploads/test',voucherFileName='test.pdf',voucherFileSize=20,voucherFileType='application/pdf',updatedBy=actor)
  if mode!='estimate':new.update(estimated=False,estimateStage='',reviewStatus='pending',archived=True,amountConfirmed=True,locked=False,reviewed=False)
  if mode=='change-linked-amount':new['amount']=101
  if mode=='change-owner':new['ownerEmail']='other@example.test'
  for m,k,v in [('change-plan','planId','other'),('change-category','categoryId','other'),('change-semester','semester','114-2'),('change-createdBy','createdBy','other'),('change-accounting','accountingVoucherAmount',1),('negative-amount','amount',-1)]:
   if mode==m:new[k]=v
  path='expenseRecords/test';call([write(path,old)],'owner')
  who=actor if mode!='other' else 'other@example.test'
  if mode=='other':call([write('users/'+who,{'enabled':True,'role':'teacher'})],'owner')
  status,msg=call([write(path,new,True)],token(who))
  expected=200 if mode in ['submit','estimate','replace'] or (not linked and mode in ['change-linked-amount','change-category','change-semester']) else 403
  print(linked,mode,status,'PASS' if status==expected else 'FAIL',flush=True)
  assert status==expected,(linked,mode,status,msg)
