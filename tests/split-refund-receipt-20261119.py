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
 for mode in ['first','additional','missing-expense','missing-parent','missing-payout','wrong-total','not-handler']:
  prev=20 if mode=='additional' else 0
  a={'planId':'p','categoryId':'c','batchId':'b','expenseRecordId':'e','ownerEmail':'officer@example.test','estimatedAmount':100,'deleted':False,'payoutSplit':True,'allocationReceivedConfirmed':False,'refundReported':False,'splitAssigned':100,'splitUnreceived':0,'splitRefundTotal':prev,'splitMutationId':'old','splitRecipients':{owner:True}}
  p={'planId':'p','batchId':'b','allocationId':'a','expenseRecordId':'e','ownerEmail':owner,'handlerEmail':'officer@example.test','amount':100,'deleted':False,'receivedConfirmed':True,'refundTotal':prev,'refundPending':10}
  r={'planId':'p','categoryId':'c','semester':'115-1','ownerEmail':'officer@example.test','advanceAllocationId':'a','advanceBatchId':'b','amount':100-prev,'estimated':True,'reviewStatus':'estimated','deleted':False}
  call([write('users/'+actor,{'enabled':True,'role':role}),write('advanceBatches/b',{'handlerEmail':'unrelated@example.test' if mode=='not-handler' else 'officer@example.test','planId':'p','deleted':False}),write('advanceAllocations/a',a),write('advancePayouts/pay',p),write('expenseRecords/e',r)],'owner')
  na={**a,'splitRefundTotal':prev+10,'splitMutationId':'pay','updatedBy':actor}
  np={**p,'refundTotal':prev+10,'refundPending':0,'refundHistory':{'r1':{'amount':10,'by':actor}},'refundReceivedBy':actor,'updatedBy':actor}
  nr={**r,'amount':90-prev,'updatedBy':actor}
  if mode=='wrong-total':nr['amount']-=1
  w=[write('advancePayouts/pay',np,['updatedAt','refundReceivedAt','refundHistory.r1.at']),write('advanceAllocations/a',na,['updatedAt']),write('expenseRecords/e',nr,['updatedAt'])]
  if mode=='missing-expense':w=w[:2]
  if mode=='missing-parent':w=[w[0],w[2]]
  if mode=='missing-payout':w=w[1:]
  status,msg=call(w,jwt(actor))
  expected=200 if role in ['manager','advance'] and (mode in ['first','additional'] or mode=='not-handler' and role=='manager') else 403
  print('split',role,mode,status,'PASS' if status==expected else 'FAIL',flush=True)
  assert status==expected,(role,mode,status,msg)
