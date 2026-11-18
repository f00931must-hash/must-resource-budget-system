"""52 emulator-only cases for reused vouchers and ordinary form saves.
Run from repository root against localhost:18947, project demo-attach,
using firestore.rules. This script never connects to production.
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
  for mode in ['submit-existing','confirm-existing','semester','category','stage','manager-other','other-denied','locked','negative','change-owner','change-plan','change-linked-money','approve-yourself']:
   old=base.copy();old.update(voucherUrl='https://example.test/existing.pdf',voucherFileName='existing.pdf',voucherFileSize=100)
   if linked:old.update(advanceAllocationId='a',advanceBatchId='b',originalEstimatedAmount=100)
   if mode!='submit-existing':old.update(estimated=False,reviewStatus='pending',estimateStage='',archived=True,amountConfirmed=True)
   if mode=='confirm-existing':old.update(archived=False,amountConfirmed=False)
   if mode=='stage':old.update(estimated=True,reviewStatus='estimated',estimateStage='purchasing')
   if mode=='manager-other':old['ownerEmail']=actor
   if mode=='other-denied':old['ownerEmail']='unrelated@example.test'
   if mode=='locked':old.update(locked=True,reviewed=True,reviewStatus='approved')
   new=old.copy();new.update(estimated=False,reviewStatus='pending',estimateStage='',archived=True,amountConfirmed=True,updatedBy=who,reviewed=False,locked=False)
   if mode=='semester':new['semester']='114-2'
   if mode=='category':new['categoryId']='other'
   if mode=='stage':new.update(estimated=True,estimateStage='reimbursing',reviewStatus='estimated',archived=False,amountConfirmed=False)
   if mode=='negative':new['amount']=-1
   if mode=='change-owner':new['ownerEmail']='new@example.test'
   if mode=='change-plan':new['planId']='other'
   if mode=='change-linked-money':new['amount']=101
   if mode=='approve-yourself':new.update(reviewStatus='approved',reviewed=True,locked=True)
   call([write('expenseRecords/test',old)],'owner')
   w=write('expenseRecords/test',new,True)
   status,msg=call([w],token(who))
   allowed=mode in ['submit-existing','confirm-existing','stage','manager-other'] or (mode=='other-denied' and who==manager) or (mode in ['semester','category','change-linked-money'] and not linked)
   expected=200 if allowed else 403
   print(who,linked,mode,status,'PASS' if status==expected else 'FAIL',('LIMIT' if '1000' in msg else ''),flush=True)
   assert status==expected,(who,linked,mode,status,msg)
