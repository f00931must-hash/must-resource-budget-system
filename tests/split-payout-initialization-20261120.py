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

recipient='recipient@example.test'
for role in ['manager','advance','teacher']:
 actor=role+'@example.test'
 for mode in ['first','explicit-zero','additional','same-recipient','too-much','wrong-handler','already-received','missing-payout','wrong-child-total']:
  own='advance@example.test'
  a={'planId':'p','categoryId':'c','batchId':'b','expenseRecordId':'e','ownerEmail':own,'ownerName':'teacher','purpose':'test','categoryName':'雜支','estimatedAmount':8746,'deleted':False}
  if mode=='explicit-zero':a.update(payoutSplit=False,splitAssigned=0,splitUnreceived=0,splitRefundTotal=0,splitRecipients={})
  if mode in ['additional','same-recipient']:a.update(payoutSplit=True,splitAssigned=4000,splitUnreceived=4000,splitRefundTotal=0,splitRecipients={recipient if mode=='same-recipient' else 'previous@example.test':True})
  if mode=='already-received':a['allocationReceivedConfirmed']=True
  handler='unrelated@example.test' if mode=='wrong-handler' else own
  r={'planId':'p','categoryId':'c','semester':'115-1','ownerEmail':own,'advanceAllocationId':'a','advanceBatchId':'b','amount':8746,'estimated':True,'deleted':False}
  call([write('users/'+actor,{'enabled':True,'role':role}),write('users/'+recipient,{'enabled':True,'role':'teacher'}),write('advanceBatches/b',{'handlerEmail':handler,'planId':'p','deleted':False}),write('advanceAllocations/a',a),write('expenseRecords/e',r)],'owner')
  pid=role+'-'+mode
  value=9000 if mode=='too-much' else 1000
  p={'allocationId':'a','expenseRecordId':'e','batchId':'b','planId':'p','handlerEmail':handler,'ownerEmail':recipient,'ownerName':'recipient','purpose':'test','categoryName':'雜支','amount':value,'receivedConfirmed':False,'refundTotal':0,'refundPending':0,'deleted':False,'createdBy':actor,'updatedBy':actor}
  na={**a,'payoutSplit':True,'splitRecipients':{**a.get('splitRecipients',{}),recipient:True},'splitAssigned':a.get('splitAssigned',0)+value,'splitUnreceived':a.get('splitUnreceived',0)+value,'splitRefundTotal':a.get('splitRefundTotal',0),'splitMutationId':pid,'updatedBy':actor}
  if mode=='wrong-child-total':na['splitAssigned']+=1
  w=[write('advancePayouts/'+pid,p,['createdAt','updatedAt']),write('advanceAllocations/a',na,['updatedAt'])]
  if mode=='missing-payout':w=w[1:]
  status,msg=call(w,jwt(actor))
  expected=200 if role in ['manager','advance'] and (mode in ['first','explicit-zero','additional','same-recipient'] or mode=='wrong-handler' and role=='manager') else 403
  print(role,mode,status,'PASS' if status==expected else 'FAIL','LIMIT' if '1000' in msg else '',flush=True)
  assert status==expected,(role,mode,status,msg)
