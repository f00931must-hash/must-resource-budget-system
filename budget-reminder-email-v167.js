// Budget reminder email recipient settings v1.6.7
// School email addresses are stored through the notification Worker in private GitHub.
// Firestore is only used to list authorized users/names; no school email is saved there.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, collection, getDocs } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
const NOTIFY_WORKER="https://must-resource-notify-service.f00931-must.workers.dev";
const $=id=>document.getElementById(id);
let auth=null,db=null,installed=false,users=[],recipientConfig={},providerConfigured=false;

function app(){return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null;}
function esc(v){return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m]));}
function escAttr(v){return esc(v).replace(/'/g,"&#39;");}

async function notifyFetch(path,options={}){
  const user=auth?.currentUser;
  if(!user)throw new Error("請重新登入");
  const token=await user.getIdToken();
  const r=await fetch(NOTIFY_WORKER+path,{...options,headers:{Authorization:`Bearer ${token}`,"content-type":"application/json",...(options.headers||{})}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||`通知服務錯誤（${r.status}）`);
  return d;
}

function install(){
  if(installed||$("emailRecipientPanel"))return true;
  const section=$("reminders");
  if(!section)return false;
  const panels=[...section.querySelectorAll(":scope > .panel")];
  const rulesPanel=panels.find(p=>p.querySelector("#ruleMissingVoucher"))||panels[panels.length-1];
  const panel=document.createElement("div");
  panel.id="emailRecipientPanel";
  panel.className="panel";
  panel.style.marginBottom="16px";
  panel.innerHTML=`
    <div class="panel-head">
      <div><h3>Email 收件人設定</h3><span class="muted">學校信箱僅存於私密設定，不使用 Google 登入信箱寄送。</span></div>
      <button id="saveEmailRecipientsBtn" class="primary-btn">儲存 Email 設定</button>
    </div>
    <div id="emailProviderStatus" class="reminder-line-status" style="margin-bottom:12px"><strong>讀取中…</strong><small>正在確認 Email 寄件服務。</small></div>
    <div id="emailRecipientList"><div class="empty">正在讀取老師名單…</div></div>`;
  if(rulesPanel)section.insertBefore(panel,rulesPanel);else section.appendChild(panel);

  const style=document.createElement("style");
  style.textContent=`
    #emailRecipientList .email-recipient-row{display:grid;grid-template-columns:1fr 1.25fr 1.4fr auto;gap:10px;align-items:center;padding:11px 0;border-bottom:1px solid #eee}
    #emailRecipientList .email-recipient-row:last-child{border-bottom:0}
    #emailRecipientList .email-recipient-row input{margin:0}
    #emailRecipientList .email-recipient-row small{display:block;color:#777}
    @media(max-width:900px){#emailRecipientList .email-recipient-row{grid-template-columns:1fr}#emailRecipientList .email-recipient-row button{justify-self:start}}
  `;
  document.head.appendChild(style);

  $("saveEmailRecipientsBtn")?.addEventListener("click",saveRecipients);
  $("reminderTab")?.addEventListener("click",()=>setTimeout(()=>loadAll().catch(showError),100));
  installed=true;
  loadAll().catch(showError);
  return true;
}

async function loadUsers(){
  if(!db)return;
  const snap=await getDocs(collection(db,"users"));
  users=snap.docs.map(d=>({loginEmail:String(d.id||"").toLowerCase(),...d.data()}))
    .filter(u=>u.enabled===true)
    .sort((a,b)=>String(a.name||a.loginEmail).localeCompare(String(b.name||b.loginEmail),"zh-Hant"));
}

async function loadConfig(){
  const d=await notifyFetch("/email/config",{method:"GET"});
  recipientConfig=d.recipients||{};
  providerConfigured=d.emailProviderConfigured===true;
}

async function loadAll(){
  if(!auth?.currentUser)return;
  await Promise.all([loadUsers(),loadConfig()]);
  render();
}

function render(){
  const status=$("emailProviderStatus");
  if(status){
    status.className="reminder-line-status "+(providerConfigured?"ok":"bad");
    status.innerHTML=providerConfigured
      ? '<strong>✅ Email 寄件服務已設定</strong><small>可直接使用右側「測試」寄送到各老師的學校信箱。</small>'
      : '<strong>⚠️ Email 寄件服務尚未設定</strong><small>學校信箱現在可以先儲存；完成寄件服務設定後即可測試與自動寄送。</small>';
  }
  const list=$("emailRecipientList");
  if(!list)return;
  if(!users.length){list.innerHTML='<div class="empty">目前沒有已啟用的經費系統使用者。</div>';return;}
  list.innerHTML=users.map(u=>{
    const saved=recipientConfig[String(u.loginEmail).toLowerCase()]||{};
    return `<div class="email-recipient-row">
      <div><strong>${esc(u.name||u.loginEmail)}</strong><small>${esc(u.role==="manager"?"經費管理員":"經費使用者")}</small></div>
      <div><small>系統登入帳號</small><span>${esc(u.loginEmail)}</span></div>
      <div><input class="school-email-input" data-login-email="${escAttr(u.loginEmail)}" data-name="${escAttr(u.name||"")}" type="email" placeholder="老師學校信箱" value="${escAttr(saved.schoolEmail||"")}"></div>
      <button class="ghost-btn" data-test-school-email="${escAttr(u.loginEmail)}">測試</button>
    </div>`;
  }).join("");
  list.querySelectorAll("[data-test-school-email]").forEach(btn=>btn.addEventListener("click",()=>testEmail(btn.dataset.testSchoolEmail)));
}

function collectRecipients(){
  const out={};
  document.querySelectorAll(".school-email-input").forEach(input=>{
    const loginEmail=String(input.dataset.loginEmail||"").toLowerCase();
    if(!loginEmail)return;
    out[loginEmail]={name:input.dataset.name||"",schoolEmail:String(input.value||"").trim()};
  });
  return out;
}

async function saveRecipients(){
  const btn=$("saveEmailRecipientsBtn");
  try{
    btn.disabled=true;btn.textContent="儲存中…";
    const recipients=collectRecipients();
    const d=await notifyFetch("/email/config",{method:"POST",body:JSON.stringify({recipients})});
    recipientConfig=recipients;
    alert(`Email 收件人設定已儲存，共 ${d.count||0} 位老師已設定學校信箱。`);
  }catch(e){showError(e);}finally{btn.disabled=false;btn.textContent="儲存 Email 設定";}
}

async function testEmail(loginEmail){
  const input=document.querySelector(`.school-email-input[data-login-email="${CSS.escape(loginEmail)}"]`);
  const to=String(input?.value||"").trim();
  if(!to)return alert("請先輸入這位老師的學校信箱。");
  if(!providerConfigured)return alert("學校信箱可以先儲存；目前 Email 寄件服務尚未設定，所以還不能寄測試信。");
  try{
    await notifyFetch("/email/test",{method:"POST",body:JSON.stringify({to})});
    alert(`測試信已寄到 ${to}`);
  }catch(e){showError(e);}
}

function showError(e){console.error(e);alert("Email 提醒設定發生錯誤："+(e?.message||e));}

async function boot(){
  const a=app();
  if(!a){setTimeout(boot,100);return;}
  auth=getAuth(a);db=getFirestore(a);
  for(let i=0;i<60&&!install();i++)await new Promise(r=>setTimeout(r,100));
}

boot();
