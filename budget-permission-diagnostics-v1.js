import {getApps} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js';
import {getAuth,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import {getFirestore,doc,getDocFromServer,runTransaction,serverTimestamp} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import {isBudgetManager,budgetRole} from './budget-permissions.mjs';
import {DIAGNOSTICS_VERSION,EXPECTED_RELEASE,classifyFailure,diagnosticReport,healthDiagnosis,createAccountService} from './budget-diagnostics-core.mjs?v=20261124-3';
const $=id=>document.getElementById(id),PROJECT='must-resource-budget-system';
let auth,db,service,events=[],checks=[],loaded=null,account='',storageKey='budget-diagnostics-anonymous';
const nativeAlert=window.alert.bind(window);
function tell(message){$('pdMessage').textContent=message;}
function capture(error){
  const entry=classifyFailure(error);if(!entry)return;
  const now=Date.now(),last=events.at(-1);
  if(last&&now-last.at<1500&&last.code===entry.code&&last.phase===entry.phase)return;
  events=[...events,{at:now,...entry}].slice(-20);
  try{sessionStorage.setItem(storageKey,JSON.stringify(diagnosticReport({events}).events));}catch{}
  $('pdHelp').hidden=false;renderEvents();
}
window.alert=message=>{capture(message);return nativeAlert(message);};
window.addEventListener('unhandledrejection',event=>capture(event.reason));
window.addEventListener('error',event=>capture(event.error||event.message));
window.addEventListener('budget-permission-error',event=>capture(event.detail));
function exportReport(){
  const blob=new Blob([JSON.stringify(diagnosticReport({checks,events}),null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='permission-diagnostics-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function renderEvents(){
  const list=$('pdErrors');if(!list)return;list.replaceChildren();
  if(!events.length){list.textContent='本分頁尚未記錄到錯誤。這不代表已測試過所有操作。';return;}
  const labels={permission:'權限被拒絕',quota:'用量額度',session:'登入狀態',workflow:'操作條件',unknown:'其他錯誤'};
  for(const e of events.slice().reverse()){
    const p=document.createElement('p');p.textContent=new Date(e.at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})+'｜'+(labels[e.kind]||labels.unknown)+'｜'+e.phase+'｜'+(e.saved==='yes'?'已儲存，先確認清單勿重複送出':'儲存結果未確認，先查看清單勿連點');list.append(p);
  }
}
function install(){
  if($('permissionDiagnostics'))return;
  const style=document.createElement('style');style.textContent=`#permissionDiagnostics .pd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}#permissionDiagnostics .pd-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}#permissionDiagnostics .pd-result{white-space:pre-line;line-height:1.7;background:#f5f2fa;padding:12px;border-radius:10px}#permissionDiagnostics input[type=email]{width:100%}#pdMessage{white-space:pre-line;color:#513576}#pdHelp{position:fixed;right:18px;bottom:16px;z-index:60}#pdSelfHelp{max-width:520px;width:90%;border:1px solid #e4dcf0;border-radius:16px;padding:22px}#pdSelfHelp::backdrop{background:#0005}`;document.head.append(style);
  const help=document.createElement('button');help.id='pdHelp';help.className='ghost-btn';help.textContent='查看錯誤與排除方式';help.hidden=true;document.body.append(help);
  const dialog=document.createElement('dialog');dialog.id='pdSelfHelp';dialog.innerHTML=`<h3>遇到錯誤先這樣處理</h3><p>先保留輸入內容並查看清單，避免重複送出。更新登入不會重送剛才的操作。</p><p>已鎖定的紀錄須先由管理員解鎖；已連結預支的金額請走追加或退款。</p><p>若帳號與狀態均正確，仍顯示權限不足，可能是規則或程式問題，重新授權不一定能解決。</p><button type="button" id="pdSelfRefresh" class="primary-btn">更新我的登入狀態</button> <button type="button" id="pdSelfExport" class="ghost-btn">下載錯誤摘要</button> <button type="button" id="pdSelfClose" class="ghost-btn">關閉</button><p id="pdSelfMessage" aria-live="polite"></p>`;document.body.append(dialog);
  help.onclick=()=>dialog.showModal();$('pdSelfClose').onclick=()=>dialog.close();$('pdSelfExport').onclick=exportReport;$('pdSelfRefresh').onclick=()=>refreshLogin('pdSelfMessage');
  const panel=document.createElement('section');panel.id='permissionDiagnostics';panel.className='view';panel.innerHTML=`<div class="section-head"><div><h2>權限診斷與修復</h2><p>檢查帳號與服務版本。只有你明確儲存帳號設定時才會修改授權；不測試寫入經費紀錄。</p></div></div><p id="pdMessage" role="status" aria-live="polite"></p><div class="pd-grid"><div class="panel"><h3>1. 帳號資格</h3><label>老師的完整電子郵件<input type="email" id="pdAccount" autocomplete="off"></label><div class="pd-row"><button id="pdInspect" class="primary-btn">檢查帳號</button><button id="pdRefresh" class="ghost-btn">更新我的登入狀態</button></div><p id="pdAccountResult" class="pd-result">請輸入老師的帳號後檢查。</p><fieldset id="pdAccountFields" disabled><label>角色<select id="pdRole"><option value="user">一般老師</option><option value="teacher">一般老師（teacher）</option><option value="advance">預支承辦人</option><option value="manager">經費管理員</option></select></label><label><input type="checkbox" id="pdEnabled"> 已啟用</label><button id="pdSave" class="primary-btn" type="button">儲存帳號授權</button></fieldset><p class="hint">這裡不建立新帳號、不修改負責老師，也不重送原本失敗的操作。</p></div><div class="panel"><h3>2. 網頁與服務版本</h3><button id="pdVersions" class="ghost-btn">檢查版本（唯讀）</button><p id="pdVersionsResult" class="pd-result">尚未檢查。</p><p>Firebase 已發布規則的版本無法由網頁直接讀取；帳號讀取成功，也不代表所有寫入一定通過。</p><a href="https://console.firebase.google.com/project/must-resource-budget-system/firestore/rules" target="_blank" rel="noopener">開啟 Firebase 規則後台</a><p><a href="https://raw.githubusercontent.com/f00931must-hash/must-resource-budget-system/main/firestore.rules" target="_blank" rel="noopener">查看目前程式對應的完整規則</a></p><button id="pdReload" class="ghost-btn">保留資料後重新整理網頁</button></div><div class="panel"><h3>3. 使用紀錄的操作條件</h3><p>也可以在使用紀錄卡片按「診斷」，查看該筆是否鎖定或連結預支。</p><label>紀錄編號<input id="pdRecord" autocomplete="off" maxlength="128"></label><button id="pdInspectRecord" class="ghost-btn">唯讀檢查這筆紀錄</button><p id="pdRecordResult" class="pd-result">尚未選取紀錄。本頁不直接解鎖、解除分配或修改金額。</p><button id="pdBackRecord" class="ghost-btn">回使用紀錄處理</button></div><div class="panel"><h3>4. 本分頁錯誤摘要</h3><p>僅保留本瀏覽器分頁最近 20 筆，不上傳伺服器，不包含老師姓名、帳號、經費金額或附件內容。</p><div id="pdErrors" class="pd-result"></div><div class="pd-row"><button id="pdExport" class="ghost-btn">下載診斷摘要</button><button id="pdClear" class="ghost-btn">清除此分頁摘要</button></div></div></div>`;
  document.querySelector('#appView main')?.append(panel);
  const tab=document.createElement('button');tab.id='permissionDiagnosticsTab';tab.className='tab hidden manager-only';tab.dataset.view=panel.id;tab.textContent='權限診斷';document.querySelector('nav.tabs')?.append(tab);
  tab.onclick=()=>openPanel();
  $('pdInspect').onclick=()=>guard($('pdInspect'),async()=>{loaded=null;$('pdAccountFields').disabled=true;loaded=await service.inspect($('pdAccount').value);if(!loaded){$('pdAccountResult').textContent='找不到這個帳號。請先在入口管理介面建立經費授權。';return;}const p=loaded.profile;$('pdAccountResult').textContent=(p.name||'未填姓名')+'｜'+loaded.email+'\n'+(p.enabled===true?'已啟用':'未啟用')+'｜目前角色：'+(p.role||'未設定');$('pdRole').value=p.role||'';$('pdEnabled').checked=p.enabled===true;$('pdAccountFields').disabled=false;tell('帳號已讀取。若要更改，請核對角色與啟用狀態後按儲存。');});
  $('pdAccount').oninput=()=>{loaded=null;$('pdAccountFields').disabled=true;};
  $('pdSave').onclick=()=>guard($('pdSave'),async()=>{
    if(!loaded)throw Error('請先檢查帳號');
    const role=$('pdRole').value,enabled=$('pdEnabled').checked;
    if(role===loaded.profile.role&&enabled===loaded.profile.enabled){tell('設定相同，沒有寫入任何資料。');return;}
    if(!confirm('確認變更 '+loaded.email+' 的經費授權？\n角色：'+$('pdRole').selectedOptions[0]?.textContent+'；'+(enabled?'啟用':'停用')+'。\n管理員可以處理所有人的經費資料。這不會修改任何經費紀錄。'))return;
    const result=await service.save(loaded.email,{role,enabled,expected:loaded.profile});loaded=null;$('pdAccountFields').disabled=true;tell(result.changed?'帳號授權已更新。請該老師保留輸入內容後重新登入；原本的操作不會自動重送。':'設定相同，沒有寫入。');
  });
  $('pdRefresh').onclick=()=>refreshLogin('pdMessage');$('pdReload').onclick=()=>{if(confirm('請先保存或複製尚未儲存的內容。確認重新整理？'))location.reload();};
  $('pdVersions').onclick=()=>guard($('pdVersions'),checkVersions);$('pdInspectRecord').onclick=()=>guard($('pdInspectRecord'),inspectRecord);
  $('pdBackRecord').onclick=()=>{document.querySelector('.tab[data-view="records"]')?.click();const id=$('pdRecord').value;const target=document.querySelector('[data-edit-record="'+CSS.escape(id)+'"],[data-unlock-record="'+CSS.escape(id)+'"]');target?.scrollIntoView({block:'center'});};
  $('pdExport').onclick=exportReport;$('pdClear').onclick=()=>{events=[];try{sessionStorage.removeItem(storageKey);}catch{}renderEvents();};
  const toast=$('toast');if(toast)new MutationObserver(()=>{if(!toast.classList.contains('hidden'))capture(toast.textContent);}).observe(toast,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});
  new MutationObserver(addRecordButtons).observe($('recordList'),{childList:true,subtree:true});renderEvents();
}
async function guard(button,work){
  if(button.disabled)return;button.disabled=true;
  try{if(!service)throw Error('尚未登入');await work();}catch(error){capture(error);tell(error.code==='permission-denied'?'讀取或帳號設定被拒絕。請先更新登入；若仍失敗，下載摘要，本頁不會放寬規則。':String(error.message||error));}finally{button.disabled=false;}
}
function openPanel(){
  if($('permissionDiagnosticsTab').classList.contains('hidden'))return;
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active-view',v.id==='permissionDiagnostics'));document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.id==='permissionDiagnosticsTab'));renderEvents();
}
async function inspectRecord(){const result=await service.inspectRecord($('pdRecord').value.trim());$('pdRecordResult').textContent=result.message;}
function addRecordButtons(){
  if($('permissionDiagnosticsTab')?.classList.contains('hidden'))return;
  for(const card of document.querySelectorAll('#recordList .record-card')){
    if(card.querySelector('[data-pd-record]'))continue;
    const anchor=card.querySelector('[data-edit-record],[data-unlock-record],[data-installment]');if(!anchor)continue;
    const id=anchor.dataset.editRecord||anchor.dataset.unlockRecord||anchor.dataset.installment,b=document.createElement('button');b.type='button';b.className='link-btn';b.dataset.pdRecord=id;b.textContent='診斷';b.onclick=()=>{openPanel();$('pdRecord').value=id;void guard($('pdInspectRecord'),inspectRecord);};anchor.parentElement.append(b);
  }
}
async function refreshLogin(output){
  const el=$(output);try{if(!auth?.currentUser)throw Error('尚未登入，請先登入');await auth.currentUser.getIdToken(true);const snap=await getDocFromServer(doc(db,'users',auth.currentUser.email.toLowerCase()));el.textContent=snap.exists()&&snap.data().enabled===true?'登入憑證已更新。請先保留輸入內容，再重新整理取得最新角色；不會自動重送操作。':'目前帳號未啟用，請由管理員檢查授權。';}catch(error){capture(error);el.textContent='登入更新未完成。請保留內容後重新登入。';}
}
async function checkVersions(){
  checks=[];const lines=['診斷工具：'+DIAGNOSTICS_VERSION];
  const appScript=document.querySelector('script[src*="app-v165-loader.js"]');const version=appScript?new URL(appScript.src,location.href).searchParams.get('v'):'';
  checks.push({service:'app',status:version===EXPECTED_RELEASE.app?'ok':'different',version});lines.push('網頁：'+(version===EXPECTED_RELEASE.app?'符合目前版次':'版次不符，請保留內容後重新整理'));
  for(const [name,label,url] of [['upload','附件服務','https://must-free-upload-service.f00931-must.workers.dev/health'],['notify','通知服務','https://must-resource-notify-service.f00931-must.workers.dev/health']]){
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),10000);
    try{const response=await fetch(url,{cache:'no-store',signal:abort.signal});const data=response.ok?await response.json():null;const result=healthDiagnosis(data,EXPECTED_RELEASE[name]);checks.push({service:name,status:result.kind,version:data?.version});lines.push(label+'：'+result.text);}catch{checks.push({service:name,status:'unknown'});lines.push(label+'：檢查未完成，不能判斷部署版本。');}finally{clearTimeout(timer);}
  }
  lines.push('Firebase：已發布規則版本無法由網頁確認。沒有執行寫入測試。');$('pdVersionsResult').textContent=lines.join('\n');
}
async function init(){
  install();
  for(let tries=0;tries<200;tries++){
    const app=getApps().find(a=>a.options?.projectId===PROJECT);
    if(app){auth=getAuth(app);db=getFirestore(app);service=createAccountService({auth,db,doc,getDocFromServer,runTransaction,serverTimestamp});onAuthStateChanged(auth,async user=>{
      loaded=null;$('pdAccountFields').disabled=true;$('permissionDiagnosticsTab').classList.add('hidden');
      if(account!==user?.uid){events=[];checks=[];account=user?.uid||'';storageKey='budget-diagnostics-v1:'+account;try{events=diagnosticReport({events:JSON.parse(sessionStorage.getItem(storageKey)||'[]')}).events;}catch{}renderEvents();}
      if(!user)return;
      try{const snap=await getDocFromServer(doc(db,'users',user.email.toLowerCase()));if(auth.currentUser?.uid!==user.uid)return;if(snap.exists()&&isBudgetManager(snap.data(),user.email)){$('permissionDiagnosticsTab').classList.remove('hidden');$('pdAccount').value=user.email;addRecordButtons();}}catch(error){capture(error);}
    });return;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
void init().catch(error=>{console.error('Permission diagnostics initialization failed',error);});
