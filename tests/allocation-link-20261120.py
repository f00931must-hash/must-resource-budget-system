"""Emulator-only refund receipt regression. No production endpoints or credentials."""
import json,base64,time,urllib.request,urllib.error,os
BASE='http://127.0.0.1:18947/v1/projects/demo-attach/databases/(default)/documents'
def enc(v):
 if v is None:return {'nullValue':None}
 if isinstance(v,bool):return {'booleanValue':v}
 if isinstance(v,int):return {'integerValue':str(v)}
 if isinstance(v,list):return {'arrayValue':{'values':[enc(x) for x in v]}}
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
for role in ['manager','advance','teacher']:
 actor=role+'@example.test'
 for mode in ['first','other-owner','single-category','empty-link','preexisting-original','already-linked','locked','mismatch-category','mismatch-semester','wrong-amount','missing-allocation']:
  own=owner if role=='manager' or mode=='other-owner' else actor
  batch={'planId':'p','semester':'115-1','categoryIds':['c','d'],'handlerEmail':'advance@example.test','deleted':False}
  if mode=='single-category':batch={'planId':'p','semester':'115-1','categoryId':'c','handlerEmail':'advance@example.test','deleted':False}
  record={'planId':'p','categoryId':'c','semester':'115-1','purpose':'test','ownerEmail':own,'ownerName':'測試','createdBy':own,'amount':100,'estimated':True,'reviewStatus':'estimated','reviewed':False,'locked':False,'deleted':False}
  if mode=='empty-link':record['advanceAllocationId']=''
  if mode=='preexisting-original':record['originalEstimatedAmount']=90
  if mode=='already-linked':record['advanceAllocationId']='old'
  if mode=='locked':record.update(locked=True,reviewed=True,reviewStatus='approved')
  if mode=='mismatch-category':batch['categoryIds']=['other']
  if mode=='mismatch-semester':batch['semester']='114-2'
  assert call([write('users/'+actor,{'enabled':True,'role':role}),write('users/'+own,{'enabled':True,'role':role if own==actor else 'teacher'}),write('advanceBatches/b',batch),write('expenseRecords/e',record)],'owner')[0]==200
  # A fresh allocation id is essential, just as doc(collection(...)) generates in saveLink.
  aid=role+'-'+mode
  allocation={'planId':'p','batchId':'b','expenseRecordId':'e','categoryId':'c','categoryName':'test','ownerEmail':own,'ownerName':'測試','purpose':'test','estimatedAmount':101 if mode=='wrong-amount' else 100,'note':'','recordOrigin':'existing-estimate','deleted':False,'createdBy':actor,'updatedBy':actor}
  new={**record,'advanceBatchId':'b','advanceAllocationId':aid,'advanceLinked':True,'originalEstimatedAmount':record.get('originalEstimatedAmount',100),'updatedBy':actor}
  writes=[write('advanceAllocations/'+aid,allocation,['createdAt','updatedAt']),write('expenseRecords/e',new,['updatedAt'])]
  if mode=='missing-allocation':writes=writes[1:]
  status,msg=call(writes,jwt(actor))
  allowed=role=='manager' and mode in ['first','other-owner','single-category','empty-link','preexisting-original'] or role=='advance' and mode in ['first','single-category','empty-link','preexisting-original']
  expected=200 if allowed else 403
  print(role,mode,status,'PASS' if status==expected else 'FAIL','LIMIT' if '1000' in msg else '',flush=True)
  assert status==expected,(role,mode,status,msg)
