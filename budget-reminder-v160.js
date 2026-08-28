// Budget reminder manager center v1.6.1
// Stable manager-only reminder settings + preview.
// IMPORTANT: no nav MutationObserver here. The previous observer fought with the
// advance-tab observer and caused an infinite DOM reorder loop / page hang.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, where, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
const $=id=>document.getElementById(id);
let auth=null,db=null,currentEmail="",isManager=false,records=[],settings=null,installed=false;
const DEFAULTS={enabled:false,lineEnabled:true,emailEnabled:false,missingVoucherEnabled:true,missingVoucherAfterDays:3,unconfirmedEnabled:true,unconfirmedAfterDays:3,estimatedEnabled:true,estimatedAfterDays:14,repeatEveryDays:3,lineSummaryMode:"names",messagePrefix:"【資源教室經費提醒】"};

function app(){return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null;}
function planId(){return $("planSelect")?.value||"";}
function esc(v){return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m]));}
function daysSince(ts){if(!ts)return 0;const d=ts?.toDate?.()||new Date(ts);return Number.isNaN(d.getTime())?0:Math.max(0,Math.floor((Date.now()-d.getTime())/86400000));}
function approved(r){return r?.reviewStatus==="approved"||r?.reviewed===true||r?.locked===true;}
function managerWaived(r){return r?.voucherWaiverManagerConfirmed===true||r?.amountConfirmedByManagerWaiver===true;}
function hasVoucher(r){return !!(r?.voucherUrl||r?.folderUrl);}
function confirmed(r){return r?.amountConfirmed===true||r?.amountManuallyConfirmed===true||managerWaived(r);}
function ageOf(r){return daysSince(r.updatedAt||r.createdAt);}

function installUI(){
  if(installed||$("reminders"))return true;
  const nav=document.querySelector("nav.tabs"),main=document.querySelector("#appView main");
  if(!nav||!main)return false;
  installed=true;
  const btn=document.createElement("button");
  btn.id="reminderTab";btn.className="tab manager-only";btn.dataset.view="reminders";btn.textContent="提醒系統";
  const trash=nav.querySelector('[data-view="trash"]');
  if(trash)nav.insertBefore(btn,trash);else nav.appendChild(btn);

  const section=document.createElement("section");
  section.id="reminders";section.className="view manager-only";
  section.innerHTML=`<div class="section-head responsive-head"><div><h2>提醒系統</h2><p>僅限經費管理員設定。先設定提醒規則與預覽對象；LINE／Email 實際發送後續由 Worker 串接。</p></div><button id="saveReminderSettingsBtn" class="primary-btn">儲存提醒設定</button></div>
  <div class="panel" style="margin-bottom:16px"><div class="panel-head"><h3>通知方式</h3><span class="muted">尚未串接發送服務</span></div><label class="check-row"><input id="reminderEnabled" type="checkbox"><span><strong>啟用此計畫的提醒系統</strong><small>關閉時不執行提醒。</small></span></label><div class="two-cols" style="margin-top:12px"><label class="check-row"><input id="reminderLineEnabled" type="checkbox"><span><strong>LINE 群組提醒</strong><small>未來由資源教室 LINE Bot 發到指定工作群組。</small></span></label><label class="check-row"><input id="reminderEmailEnabled" type="checkbox"><span><strong>Email 個別提醒</strong><small>未來依使用紀錄 ownerEmail 寄送。</small></span></label></div><div class="two-cols" style="margin-top:12px"><label>LINE 群組內容<select id="reminderLineSummaryMode"><option value="names">顯示老師姓名＋筆數</option><option value="count">只顯示總筆數</option></select></label><label>提醒訊息開頭<input id="reminderMessagePrefix" maxlength="60"></label></div></div>
  <div class="panel" style="margin-bottom:16px"><div class="panel-head"><h3>提醒規則</h3><span class="muted">依最後更新時間計算</span></div><div class="reminder-rule-grid"><div class="reminder-rule-card"><label class="check-row"><input id="ruleMissingVoucher" type="checkbox"><span><strong>缺少核銷單據</strong></span></label><label>幾天後開始提醒<input id="ruleMissingVoucherDays" type="number" min="0" max="365" step="1"></label></div><div class="reminder-rule-card"><label class="check-row"><input id="ruleUnconfirmed" type="checkbox"><span><strong>未確認 Key 金額</strong></span></label><label>幾天後開始提醒<input id="ruleUnconfirmedDays" type="number" min="0" max="365" step="1"></label></div><div class="reminder-rule-card"><label class="check-row"><input id="ruleEstimated" type="checkbox"><span><strong>預估待追蹤</strong></span></label><label>幾天後開始提醒<input id="ruleEstimatedDays" type="number" min="0" max="365" step="1"></label></div></div><label style="display:block;margin-top:14px;max-width:320px">重複提醒間隔（天）<input id="ruleRepeatDays" type="number" min="1" max="30" step="1"></label></div>
  <div class="panel"><div class="panel-head"><h3>目前待提醒預覽</h3><button id="refreshReminderPreviewBtn" class="ghost-btn">重新試算</button></div><div id="reminderPreviewSummary" class="summary-grid"></div><div id="reminderPreviewList" style="margin-top:12px"></div></div>`;
  main.appendChild(section);

  const style=document.createElement("style");
  style.textContent=`#reminders .reminder-rule-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}#reminders .reminder-rule-card{border:1px solid #e7def3;border-radius:14px;padding:14px;background:#fcfaff}#reminders .reminder-preview-row{display:grid;grid-template-columns:1.3fr 1.5fr .8fr 1fr;gap:12px;padding:12px 0;border-bottom:1px solid #eee;align-items:center}#reminders .reminder-preview-row:last-child{border-bottom:0}#reminders .reminder-badge{display:inline-flex;padding:4px 8px;border-radius:999px;background:#fff2e8;color:#9a4d00;font-size:12px;font-weight:700}@media(max-width:900px){#reminders .reminder-rule-grid{grid-template-columns:1fr}#reminders .reminder-preview-row{grid-template-columns:1fr 1fr}}`;
  document.head.appendChild(style);

  btn.addEventListener("click",()=>{document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active-view",v.id==="reminders"));document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t===btn));history.replaceState(null,"","#reminders");loadAll().catch(showError);});
  $("saveReminderSettingsBtn").addEventListener("click",saveSettings);
  $("refreshReminderPreviewBtn").addEventListener("click",async()=>{try{await loadRecords();renderPreview();}catch(e){showError(e);}});
  $("planSelect")?.addEventListener("change",()=>{if($("reminders")?.classList.contains("active-view"))loadAll().catch(showError);});
  return true;
}

function fillForm(){const s={...DEFAULTS,...(settings||{})};$("reminderEnabled").checked=s.enabled===true;$("reminderLineEnabled").checked=s.lineEnabled!==false;$("reminderEmailEnabled").checked=s.emailEnabled===true;$("reminderLineSummaryMode").value=s.lineSummaryMode||"names";$("reminderMessagePrefix").value=s.messagePrefix||DEFAULTS.messagePrefix;$("ruleMissingVoucher").checked=s.missingVoucherEnabled!==false;$("ruleMissingVoucherDays").value=Number(s.missingVoucherAfterDays??3);$("ruleUnconfirmed").checked=s.unconfirmedEnabled!==false;$("ruleUnconfirmedDays").value=Number(s.unconfirmedAfterDays??3);$("ruleEstimated").checked=s.estimatedEnabled!==false;$("ruleEstimatedDays").value=Number(s.estimatedAfterDays??14);$("ruleRepeatDays").value=Number(s.repeatEveryDays??3);}
function formData(){return{enabled:$("reminderEnabled").checked,lineEnabled:$("reminderLineEnabled").checked,emailEnabled:$("reminderEmailEnabled").checked,lineSummaryMode:$("reminderLineSummaryMode").value||"names",messagePrefix:$("reminderMessagePrefix").value.trim()||DEFAULTS.messagePrefix,missingVoucherEnabled:$("ruleMissingVoucher").checked,missingVoucherAfterDays:Number($("ruleMissingVoucherDays").value||0),unconfirmedEnabled:$("ruleUnconfirmed").checked,unconfirmedAfterDays:Number($("ruleUnconfirmedDays").value||0),estimatedEnabled:$("ruleEstimated").checked,estimatedAfterDays:Number($("ruleEstimatedDays").value||0),repeatEveryDays:Math.max(1,Number($("ruleRepeatDays").value||3))};}
async function saveSettings(){try{if(!isManager)throw new Error("僅限管理員設定");const p=planId();if(!p)throw new Error("請先選擇計畫");const data=formData();await setDoc(doc(db,"reminderSettings",p),{...data,planId:p,updatedAt:serverTimestamp(),updatedBy:currentEmail},{merge:true});settings=data;renderPreview();alert("提醒設定已儲存。LINE／Email 實際發送尚未啟用。");}catch(e){showError(e);}}
async function loadRecords(){const p=planId();if(!p){records=[];return;}const snap=await getDocs(query(collection(db,"expenseRecords"),where("planId","==",p)));records=snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.deleted!==true);}
function classify(r,s){if(approved(r))return[];const age=ageOf(r),out=[];if(s.estimatedEnabled!==false&&r.estimated===true&&age>=Number(s.estimatedAfterDays||0))out.push("預估待追蹤");if(r.estimated!==true){if(s.missingVoucherEnabled!==false&&!hasVoucher(r)&&!managerWaived(r)&&age>=Number(s.missingVoucherAfterDays||0))out.push("缺少核銷單據");if(s.unconfirmedEnabled!==false&&!confirmed(r)&&!managerWaived(r)&&age>=Number(s.unconfirmedAfterDays||0))out.push("未確認 Key 金額");}return out;}
function renderPreview(){if(!$("reminderPreviewList"))return;const s={...DEFAULTS,...(settings||{}),...formData()},rows=[];for(const r of records){const reasons=classify(r,s);if(reasons.length)rows.push({r,reasons,age:ageOf(r)});}const teachers=new Set(rows.map(x=>String(x.r.ownerEmail||"").toLowerCase()).filter(Boolean));const counts={missing:0,unconfirmed:0,estimated:0};rows.forEach(x=>x.reasons.forEach(reason=>{if(reason==="缺少核銷單據")counts.missing++;if(reason==="未確認 Key 金額")counts.unconfirmed++;if(reason==="預估待追蹤")counts.estimated++;}));$("reminderPreviewSummary").innerHTML=[["待提醒老師",teachers.size],["缺少核銷單據",counts.missing],["未確認 Key 金額",counts.unconfirmed],["預估待追蹤",counts.estimated]].map(([l,v])=>`<div class="summary-card"><span>${l}</span><strong>${v}</strong></div>`).join("");if(!rows.length){$("reminderPreviewList").innerHTML='<div class="empty">目前沒有符合提醒規則的使用紀錄。</div>';return;}$("reminderPreviewList").innerHTML=rows.map(({r,reasons,age})=>`<div class="reminder-preview-row"><div><strong>${esc(r.ownerName||r.ownerEmail||"未填老師")}</strong><small class="muted" style="display:block">${esc(r.ownerEmail||"")}</small></div><div><strong>${esc(r.purpose||"未填用途")}</strong><small class="muted" style="display:block">${esc(r.semester||"未填學期")}</small></div><div>${reasons.map(x=>`<span class="reminder-badge">${esc(x)}</span>`).join(" ")}</div><div><small class="muted">距最後更新</small><strong style="display:block">${age} 天</strong></div></div>`).join("");}
async function loadAll(){const p=planId();if(!p){settings=null;records=[];fillForm();renderPreview();return;}const [sSnap]=await Promise.all([getDoc(doc(db,"reminderSettings",p)),loadRecords()]);settings=sSnap.exists()?sSnap.data():{...DEFAULTS};fillForm();renderPreview();}
function showError(err){console.error("reminder center error",err);alert("提醒系統發生錯誤："+(err?.message||err));}
async function init(){for(let i=0;i<120;i++){const a=app();if(a){auth=getAuth(a);db=getFirestore(a);break;}await new Promise(r=>setTimeout(r,50));}if(!auth||!db)return;onAuthStateChanged(auth,async user=>{isManager=false;if(!user?.email)return;currentEmail=user.email.toLowerCase();try{const u=await getDoc(doc(db,"users",currentEmail));isManager=u.exists()&&u.data().enabled===true&&u.data().role==="manager";if(!isManager)return;for(let i=0;i<30&&!installUI();i++)await new Promise(r=>setTimeout(r,100));if(location.hash==="#reminders")$("reminderTab")?.click();}catch(e){showError(e);}});}
init();
