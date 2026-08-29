// Budget reminder send-window safeguard v1.6.3
// Manager-configurable allowed LINE send hours; default 09:00-18:00.
// Keeps base reminder module intact and adds a small isolated guard.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
const DEFAULT_START="09:00";
const DEFAULT_END="18:00";
const $=id=>document.getElementById(id);
let auth=null,db=null,currentEmail="",installed=false;

function app(){return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null;}
function planId(){return $("planSelect")?.value||"";}
function hhmmNow(){return new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date());}
function validTime(v){return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v||""));}
function inWindow(now,start,end){
  if(start===end)return true;
  if(start<end)return now>=start&&now<=end;
  return now>=start||now<=end; // supports overnight windows if ever intentionally configured
}
function values(){return{sendStartTime:validTime($("reminderSendStart")?.value)?$("reminderSendStart").value:DEFAULT_START,sendEndTime:validTime($("reminderSendEnd")?.value)?$("reminderSendEnd").value:DEFAULT_END};}

async function loadWindow(){
  const p=planId();
  let start=DEFAULT_START,end=DEFAULT_END;
  if(p&&db){
    try{const s=await getDoc(doc(db,"reminderSettings",p));if(s.exists()){const d=s.data();if(validTime(d.sendStartTime))start=d.sendStartTime;if(validTime(d.sendEndTime))end=d.sendEndTime;}}catch(e){console.warn("reminder send window load failed",e);}
  }
  if($("reminderSendStart"))$("reminderSendStart").value=start;
  if($("reminderSendEnd"))$("reminderSendEnd").value=end;
  renderWindowHint();
}
function renderWindowHint(){
  const hint=$("reminderSendWindowHint");if(!hint)return;
  const {sendStartTime,sendEndTime}=values();
  const now=hhmmNow(),ok=inWindow(now,sendStartTime,sendEndTime);
  hint.textContent=`台灣時間允許發送：${sendStartTime}～${sendEndTime}｜目前 ${now}${ok?"（可發送）":"（目前禁止發送）"}`;
  hint.style.color=ok?"#357a4b":"#b42318";
}

function install(){
  if(installed)return true;
  const rules=$("reminders")?.querySelector(".reminder-rule-grid")?.parentElement;
  if(!rules)return false;
  installed=true;
  const wrap=document.createElement("div");
  wrap.id="reminderSendWindowBox";
  wrap.style.cssText="margin-top:16px;padding-top:14px;border-top:1px solid #eee";
  wrap.innerHTML=`<div style="font-weight:700;margin-bottom:8px">允許發送時段</div><div class="two-cols" style="max-width:620px"><label>開始時間<input id="reminderSendStart" type="time" value="${DEFAULT_START}"></label><label>結束時間<input id="reminderSendEnd" type="time" value="${DEFAULT_END}"></label></div><small id="reminderSendWindowHint" class="muted" style="display:block;margin-top:8px"></small><small class="muted" style="display:block;margin-top:4px">不在允許時段內時，測試訊息與立即提醒皆不會送出。</small>`;
  rules.appendChild(wrap);

  $("reminderSendStart").addEventListener("change",renderWindowHint);
  $("reminderSendEnd").addEventListener("change",renderWindowHint);

  $("saveReminderSettingsBtn")?.addEventListener("click",async()=>{
    const p=planId();if(!p||!db)return;
    const v=values();
    try{await setDoc(doc(db,"reminderSettings",p),{...v,updatedAt:serverTimestamp(),updatedBy:currentEmail},{merge:true});}catch(e){console.error("save reminder send window failed",e);}
  });

  const guard=(ev)=>{
    const target=ev.target?.closest?.("#sendLineNowBtn,#sendLineTestBtn");if(!target)return;
    const {sendStartTime,sendEndTime}=values(),now=hhmmNow();
    if(inWindow(now,sendStartTime,sendEndTime))return;
    ev.preventDefault();ev.stopPropagation();ev.stopImmediatePropagation();
    alert(`目前為 ${now}，提醒訊息僅允許於 ${sendStartTime}～${sendEndTime} 發送，避免非工作時間打擾老師。`);
  };
  document.addEventListener("click",guard,true);
  $("planSelect")?.addEventListener("change",()=>setTimeout(loadWindow,0));
  $("reminderTab")?.addEventListener("click",()=>setTimeout(loadWindow,0));
  setInterval(renderWindowHint,60000);
  loadWindow();
  return true;
}

async function init(){
  for(let i=0;i<120;i++){const a=app();if(a){auth=getAuth(a);db=getFirestore(a);break;}await new Promise(r=>setTimeout(r,50));}
  if(!auth||!db)return;
  onAuthStateChanged(auth,user=>{currentEmail=String(user?.email||"").toLowerCase();if(!user)return;let tries=0;const t=setInterval(()=>{tries++;if(install()||tries>80)clearInterval(t);},100);});
}
init();
