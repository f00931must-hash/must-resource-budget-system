"""Test-only REST client. Fixed loopback address; no configurable production target."""
import base64,json,time,urllib.request,urllib.error
BASE='http://127.0.0.1:18947/v1/projects/demo-attach/databases/(default)/documents'
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def enc(v):
 if v is None:return {'nullValue':None}
 if isinstance(v,bool):return {'booleanValue':v}
 if isinstance(v,int):return {'integerValue':str(v)}
 if isinstance(v,float):return {'doubleValue':v}
 if isinstance(v,list):return {'arrayValue':{'values':[enc(x) for x in v]}}
 if isinstance(v,dict):return {'mapValue':{'fields':{k:enc(x) for k,x in v.items()}}}
 return {'stringValue':v}
def jwt(email):
 def b(v):return base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip('=')
 return b({'alg':'none','typ':'JWT'})+'.'+b({'iss':'https://securetoken.google.com/demo-attach','aud':'demo-attach','sub':email,'user_id':email,'email':email,'email_verified':True,'iat':int(time.time()),'exp':int(time.time())+3600,'firebase':{'sign_in_provider':'password'}})+'.'
def call(writes,actor='owner'):
 token=actor if actor=='owner' else jwt(actor)
 req=urllib.request.Request(BASE+':commit',data=json.dumps({'writes':writes}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 try:
  with OPENER.open(req) as r:return r.status,''
 except urllib.error.HTTPError as e:return e.code,e.read().decode()
def write(path,data,stamps=(),patch=False):
 w={'update':{'name':BASE.split('/v1/')[1]+'/'+path,'fields':{k:enc(v) for k,v in data.items()}}}
 if patch:w['updateMask']={'fieldPaths':list(data)}
 if stamps:w['updateTransforms']=[{'fieldPath':k,'setToServerValue':'REQUEST_TIME'} for k in stamps]
 return w
def update(path,data,actor,stamps=()):
 return write(path,{**data,'updatedBy':actor},['updatedAt',*stamps],True)
def seed(path,data):
 code,error=call([write(path,data)])
 assert code==200,error
count=0
def expect(name,writes,actor,allowed):
 global count
 code,error=call(writes,actor)
 assert code==(200 if allowed else 403),(name,code,error)
 assert 'maximum of 1000 expressions' not in error,(name,error)
 count+=1;print('PASS',name,flush=True)
