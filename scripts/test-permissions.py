#!/usr/bin/env python3
"""Start a local demo-project emulator and run the complete permissions suite.
No production auth, Firebase CLI, service accounts, or live records are used.
"""
import json,os,pathlib,subprocess,sys,time,urllib.request,urllib.error
ROOT=pathlib.Path(__file__).resolve().parents[1]
CACHE=ROOT/'.emulator';CACHE.mkdir(exist_ok=True)
JAR=CACHE/'firestore.jar'
URL='https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.19.8.jar'
if not JAR.exists():urllib.request.urlretrieve(URL,JAR)
PORT=18947
HEALTH=f'http://127.0.0.1:{PORT}/'
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
 OPENER.open(HEALTH,timeout=.3)
 raise SystemExit(f'Port {PORT} is already occupied; refusing to reuse an unknown server.')
except (urllib.error.URLError,TimeoutError):pass
LOG=CACHE/'rules.log'
ENV={**os.environ,'NO_PROXY':'127.0.0.1,localhost','no_proxy':'127.0.0.1,localhost','ASSERT':'1'}
SUITE=[
 ('python','tests/expense-permissions-20261118.py'),
 ('python','tests/reused-voucher-permissions-20261118.py'),
 ('python','tests/allocation-link-20261120.py'),
 ('python','tests/refund-receipt-20261119.py'),
 ('python','tests/split-refund-receipt-20261119.py'),
 ('python','tests/split-payout-initialization-20261120.py'),
 ('node','tests/installments-emulator.cjs'),
 ('node','tests/diagnostics-account-emulator.cjs'),
 ('node','tests/expense-form-emulator-20261120.cjs'),
 ('node','tests/refund-button-emulator-20261119.cjs'),
 ('node','tests/split-payout-lifecycle-20261120.cjs'),
 ('node','tests/no-voucher-form-20261118.cjs'),
 ('node','tests/allocation-save-diagnostics-20261120.cjs'),
]
if (ROOT/'tests/permissions-matrix.py').exists():SUITE.insert(0,('python','tests/permissions-matrix.py'))
results=[]
with LOG.open('w') as stream:
 proc=subprocess.Popen(['java','-jar',str(JAR),'--host','127.0.0.1','--port',str(PORT),'--project_id','demo-attach','--rules',str(ROOT/'firestore.rules')],stdout=stream,stderr=subprocess.STDOUT,cwd=ROOT,env=ENV)
 try:
  for _ in range(120):
   if proc.poll() is not None:raise RuntimeError('Emulator exited: '+LOG.read_text()[-5000:])
   try:OPENER.open(HEALTH,timeout=.3);break
   except (urllib.error.URLError,TimeoutError):time.sleep(.25)
  else:raise RuntimeError('Emulator did not start: '+LOG.read_text()[-5000:])
  for executable,path in SUITE:
   # This reset is confined to the hardcoded loopback demo emulator.
   OPENER.open(urllib.request.Request(HEALTH+'emulator/v1/projects/demo-attach/databases/(default)/documents',method='DELETE'),timeout=10).read()
   run=subprocess.run([sys.executable if executable=='python' else executable,path],cwd=ROOT,env=ENV,capture_output=True,text=True,timeout=120)
   output=run.stdout+run.stderr
   (CACHE/(pathlib.Path(path).name+'.log')).write_text(output)
   count=sum('PASS' in line for line in output.splitlines())
   ok=run.returncode==0 and 'FAIL' not in output and 'LIMIT' not in output
   results.append({'suite':path,'passed':ok,'scenario_lines':count})
   print(f'{"PASS" if ok else "FAIL"} {path} ({count} result lines)',flush=True)
   if not ok:print(output[-8000:],flush=True)
  # A rejection is not a correct result if it merely exhausted the evaluator.
  budget_errors='maximum of 1000 expressions' in LOG.read_text()
  report={'project':'demo-attach','host':'127.0.0.1','rules':subprocess.check_output(['git','hash-object','firestore.rules'],cwd=ROOT,text=True).strip(),'results':results,'rules_budget_errors':budget_errors,'production_tested':False}
  (CACHE/'report.json').write_text(json.dumps(report,indent=2))
  if budget_errors:print('FAIL: rule evaluation budget exhausted in emulator log')
  if budget_errors or any(not r['passed'] for r in results):raise SystemExit(1)
 finally:
  proc.terminate()
  try:proc.wait(timeout=10)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
