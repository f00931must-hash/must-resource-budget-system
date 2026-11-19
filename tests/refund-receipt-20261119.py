"""Emulator-only refund receipt regression. No production endpoints or credentials."""
import json,base64,time,urllib.request,urllib.error,os
BASE='http://127.0.0.1:18947/v1/projects/demo-attach/databases/(default)/documents'
def enc(v):
 if v is None:return {'nullValue':None}
 if isinstance(v,bool):return {'booleanValue':v}
 if isinstance(v,int):return {'integerValue':str(v)}
 if isinstance(v,dict):return {'mapValue':{'fields':{k:enc(x) for k,x in v.items()}}}
 return {'stringValue':v}
def write(path,d,stamps=[]):
 w={'update':{'name':BASE.split('/v1/')[1]+'/'+path,'fields':{k:enc(v) for k,v in d.items()}}}
 if stamps:w['updateTransforms']=[{'fieldPath':k,'setToServerValue':'REQUEST_TIME'} for k in stamps]
 return w
def call(w,token):
 req=urllib.request.Request(BASE+':commit',data=json.dumps({'writes':w}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req) as r:return r.status,''
 except urllib.error.HTTPError as e:return e.code,e.read().decode()
def jwt(email):
 def b(v):return base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip('=')
 return b({'alg':'none','typ':'JWT'})+'.'+b({'iss':'https://securetoken.google.com/demo-attach','aud':'demo-attach','sub':email,'user_id':email,'email':email,'email_verified':True,'iat':int(time.time()),'exp':int(time.time())+3600,'firebase':{'sign_in_provider':'password'}})+'.'
owner='teacher@example.test'
for actor,role in [('manager@example.test','manager'),('officer@example.test','advance'),(owner,'teacher')]:
 assert call([write('users/'+actor,{'enabled':True,'role':role}),write('users/'+owner,{'enabled':True,'role':'teacher'}),write('advanceBatches/b',{'handlerEmail':'officer@example.test','planId':'p','deleted':False})],'owner')[0]==200
 for mode in ['first','additional','legacy','pending-adjustment','locked','wrong-amount','missing-expense','missing-allocation','wrong-link','alter-purpose','already-received','not-reported','not-received','disabled']:
  own=actor if role=='advance' else owner
  previous=20 if mode == 'additional' else 0
  a={'planId':'p','categoryId':'c','batchId':'b','expenseRecordId':'e','ownerEmail':own,'estimatedAmount':100,'allocationReceivedConfirmed':True,'refundReported':True,'refundReceivedConfirmed':False,'refundAmount':previous+10,'deleted':False,'refundConfirmedTotal':previous,'refundReportedBy':own}
  if mode=='legacy':a.pop('refundConfirmedTotal')
  r={'planId':'p','categoryId':'c','semester':'115-1','purpose':'test','ownerEmail':own,'createdBy':own,'advanceAllocationId':'a','advanceBatchId':'b','originalEstimatedAmount':100,'amount':100-previous,'estimated':True,'reviewStatus':'estimated','deleted':False}
  if mode=='pending-adjustment':r['actualAdjustment']={'status':'pending','amount':85,'requestedBy':own,'reason':'test'}
  if mode=='locked':r.update(estimated=False,reviewStatus='approved',locked=True,reviewed=True)
  if mode=='already-received':a['refundReceivedConfirmed']=True
  if mode=='not-reported':a['refundReported']=False
  if mode=='not-received':a['allocationReceivedConfirmed']=False
  if mode=='wrong-link':r['advanceAllocationId']='other'
  assert call([write('advanceAllocations/a',a),write('expenseRecords/e',r),write('users/'+actor,{'enabled':mode!='disabled','role':role})],'owner')[0]==200
  remaining=100-a['refundAmount']
  nr={**r,'amount':remaining,'refundAdjustment':{'allocationId':'a','originalAmount':100,'refundAmount':a['refundAmount'],'remainingAmount':remaining,'confirmedBy':actor},'updatedBy':actor}
  rs=['updatedAt','refundAdjustment.confirmedAt']
  if mode=='pending-adjustment':nr['actualAdjustment']={**r['actualAdjustment'],'status':'cancelled','reviewedBy':actor};rs+=['actualAdjustment.reviewedAt']
  if mode=='wrong-amount':nr['amount']-=1
  if mode=='alter-purpose':nr['purpose']='tampered'
  na={**a,'refundConfirmedTotal':a['refundAmount'],'refundHistory':{'receipt_1':{'amount':10,'total':a['refundAmount'],'confirmedBy':actor,'requestedBy':own,'requestedAt':None}},'refundReceivedConfirmed':True,'refundReceivedBy':actor,'settlementAmount':remaining,'updatedBy':actor}
  rw=write('expenseRecords/e',nr,rs);aw=write('advanceAllocations/a',na,['updatedAt','refundReceivedAt','refundHistory.receipt_1.confirmedAt'])
  writes=[rw,aw]
  if mode=='missing-expense':writes=[aw]
  if mode=='missing-allocation':writes=[rw]
  status,msg=call(writes,jwt(actor))
  expected=200 if role in ['manager','advance'] and mode in ['first','additional','legacy','pending-adjustment','locked'] else 403
  print(role,mode,status,'PASS' if status==expected else 'FAIL','LIMIT' if '1000' in msg else '',flush=True)
  assert status==expected,(role,mode,status,msg)
