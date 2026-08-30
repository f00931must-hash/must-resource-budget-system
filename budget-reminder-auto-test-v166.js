// Budget automatic reminder test button v1.6.6
// Adds a safe end-to-end test for Service Account + Firestore + LINE.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

const PROJECT_ID="must-resource-budget-system";
const NOTIFY_WORKER="https://must-resource-notify-service.f00931-must.workers.dev";
const $=id=>document.getElementById(id);

function app(){return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null;}

async function callAutoTest(){
  const a=app();
  if(!a) throw new Error("Firebase 尚未載入");
  const auth=getAuth(a);
  const user=auth.currentUser;
  if(!user) throw new Error("請重新登入");
  const token=await user.getIdToken();
  const r=await fetch(NOTIFY_WORKER+"/auto/test",{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"content-type":"application/json"},
    body:"{}"
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||`自動通知測試失敗（${r.status}）`);
  return d;
}

function install(){
  const host=$("sendLineTestBtn")?.parentElement;
  if(!host||$("sendAutoReminderTestBtn")) return !!$("sendAutoReminderTestBtn");
  const btn=document.createElement("button");
  btn.id="sendAutoReminderTestBtn";
  btn.className="ghost-btn";
  btn.textContent="測試自動通知";
  btn.title="驗證 Service Account、Firestore 與 LINE，不會寫入正式提醒狀態";
  host.insertBefore(btn,$("sendLineNowBtn")||null);
  btn.addEventListener("click",async()=>{
    if(!confirm("這會傳送 1 則「自動提醒測試成功」訊息到目前綁定的 LINE 群組。\n\n不會修改正式提醒紀錄。確定測試嗎？")) return;
    btn.disabled=true;
    const old=btn.textContent;
    btn.textContent="測試中…";
    try{
      const d=await callAutoTest();
      alert(`自動通知測試成功！\n\n已啟用提醒的計畫：${Number(d.enabledPlans||0)} 個\nLINE 群組應已收到測試訊息。`);
    }catch(e){
      console.error("automatic reminder test failed",e);
      alert("自動通知測試失敗："+(e?.message||e));
    }finally{
      btn.disabled=false;
      btn.textContent=old;
    }
  });
  return true;
}

for(let i=0;i<100&&!install();i++) await new Promise(r=>setTimeout(r,100));
