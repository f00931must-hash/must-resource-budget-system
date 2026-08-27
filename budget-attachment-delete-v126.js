import { getApps, getApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, updateDoc, addDoc, collection, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const WORKER_URL = "https://must-free-upload-service.f00931-must.workers.dev";

async function waitForFirebaseApp(timeoutMs=12000){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    if(getApps().length) return getApp();
    await new Promise(r=>setTimeout(r,80));
  }
  throw new Error("Firebase 初始化逾時");
}

const app = await waitForFirebaseApp();
const auth = getAuth(app);
const db = getFirestore(app);
let user=null;
let manager=false;
let cache={planId:"",plan:null,records:[]};
let timer=null;

function schedule(delay=260){
  clearTimeout(timer);
  timer=setTimeout(refreshAndPatch,delay);
}

function recordPath(r){
  return r?.voucherPath || r?.voucherStoragePath || pathFromUrl(r?.voucherUrl||r?.folderUrl||"");
}

function pathFromUrl(v){
  if(!v) return "";
  if(!/^https?:\/\//.test(v)) return String(v).replace(/^\/+/,"");
  try{
    const parts=new URL(v).pathname.split("/").filter(Boolean);
    const i=parts.indexOf("uploads");
    return i>=0 ? parts.slice(i).join("/") : "";
  }catch{return "";}
}

async function workerRequest(path,options={}){
  if(!user) throw new Error("尚未登入");
  const token=await user.getIdToken(true);
  const headers=new Headers(options.headers||{});
  headers.set("Authorization","Bearer "+token);
  const res=await fetch(WORKER_URL+path,{...options,headers});
  const data=await res.json().catch(()=>({}));
  if(!res.ok||data.ok===false) throw new Error(data.error||`附件服務錯誤（${res.status}）`);
  return data;
}

async function loadCache(){
  const planId=document.getElementById("planSelect")?.value||"";
  if(!planId){ cache={planId:"",plan:null,records:[]}; return; }
  const [planSnap,recSnap]=await Promise.all([
    getDoc(doc(db,"budgetPlans",planId)),
    getDocs(query(collection(db,"expenseRecords"),where("planId","==",planId)))
  ]);
  cache={
    planId,
    plan:planSnap.exists()?{id:planSnap.id,...planSnap.data()}:null,
    records:recSnap.docs.map(d=>({id:d.id,...d.data()}))
  };
}

function findRecordId(card){
  const el=card.querySelector("[data-edit-record],[data-delete-record],[data-approve-record],[data-unlock-record]");
  if(!el) return "";
  return el.dataset.editRecord||el.dataset.deleteRecord||el.dataset.approveRecord||el.dataset.unlockRecord||"";
}

function patchPlanClearButton(){
  if(!manager) return;
  const btn=document.getElementById("purgePlanAttachmentsBtn");
  if(!btn) return;
  const count=cache.records.filter(r=>!r.voucherPurged&&!!recordPath(r)).length;
  btn.disabled=count===0;
  btn.title=count?`此計畫共有 ${count} 份附件可清理（不刪除使用紀錄）`:"此計畫目前沒有可清理的附件";
  btn.onclick=clearPlanAttachments;
}

function patchIndividualButtons(){
  if(!manager) return;
  document.querySelectorAll("#recordList .record-card").forEach(card=>{
    const id=findRecordId(card);
    if(!id) return;
    const r=cache.records.find(x=>x.id===id);
    if(!r||r.voucherPurged||!recordPath(r)) return;
    const actions=card.querySelector(".record-actions");
    if(!actions||actions.querySelector(`[data-delete-voucher="${id}"]`)) return;
    const b=document.createElement("button");
    b.className="link-btn danger";
    b.dataset.deleteVoucher=id;
    b.textContent="刪除附件";
    b.title="只刪除核銷附件，不刪除此筆使用紀錄";
    b.onclick=()=>deleteSingleAttachment(id);
    actions.appendChild(b);
  });
}

async function markPurged(r,path,action){
  const email=(user?.email||"").toLowerCase();
  await updateDoc(doc(db,"expenseRecords",r.id),{
    voucherPurged:true,
    voucherPurgedAt:serverTimestamp(),
    voucherPurgedBy:email,
    voucherPurgedOriginalPath:path,
    voucherPurgedOriginalName:r.voucherFileName||"",
    voucherPurgedAction:action,
    voucherUrl:"",
    folderUrl:"",
    voucherPath:"",
    voucherStoragePath:"",
    archived:false,
    updatedAt:serverTimestamp(),
    updatedBy:email
  });
}

async function deleteSingleAttachment(id){
  if(!manager) return;
  const r=cache.records.find(x=>x.id===id);
  if(!r) return;
  const path=recordPath(r);
  if(!path) return alert("這筆目前沒有可刪除的附件。");
  if(!confirm(`確定只刪除「${r.purpose||"此筆紀錄"}」的核銷附件嗎？\n\n${r.voucherFileName||"附件"}\n\n使用紀錄與金額都會保留，附件刪除後無法復原。`)) return;
  try{
    await workerRequest("/delete",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({path,name:r.voucherFileName||"voucher"})
    });
    await markPurged(r,path,"single");
    await addDoc(collection(db,"auditLogs"),{
      type:"expense-voucher-purge",targetId:id,planId:cache.planId,action:"purge-single-voucher",
      actorEmail:(user.email||"").toLowerCase(),originalPath:path,createdAt:serverTimestamp()
    }).catch(()=>{});
    await refreshAndPatch();
    alert("附件已刪除，使用紀錄仍保留。");
  }catch(err){
    alert("刪除附件失敗："+(err?.message||err));
  }
}

async function clearPlanAttachments(){
  if(!manager||!cache.planId) return;
  const rows=cache.records.filter(r=>!r.voucherPurged&&!!recordPath(r));
  if(!rows.length) return alert("此計畫目前沒有可清理的附件。");
  const planName=cache.plan?.name||"此計畫";
  if(!confirm(`確定要清除「${planName}」的所有核銷附件嗎？\n\n共 ${rows.length} 份。\n只會刪除附件，不會刪除計畫、經費項目或使用紀錄。\n\n即使計畫仍在啟用中，也會立即刪除這些附件。`)) return;
  const typed=prompt("為避免誤刪，請輸入「刪除附件」四個字確認：");
  if(typed!=="刪除附件") return alert("確認文字不符，已取消。");

  const btn=document.getElementById("purgePlanAttachmentsBtn");
  if(btn){btn.disabled=true;btn.textContent=`清理中 0/${rows.length}`;}
  let ok=0,fail=0;
  for(let i=0;i<rows.length;i++){
    const r=rows[i];
    const path=recordPath(r);
    if(btn) btn.textContent=`清理中 ${i+1}/${rows.length}`;
    try{
      await workerRequest("/delete",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({path,name:r.voucherFileName||"voucher"})
      });
      await markPurged(r,path,"plan");
      ok++;
    }catch(err){
      console.warn("clear plan attachment failed",r.id,err);
      fail++;
    }
  }
  await addDoc(collection(db,"auditLogs"),{
    type:"plan-attachment-purge",targetId:cache.planId,planId:cache.planId,action:"purge-plan-attachments",
    deletedCount:ok,failedCount:fail,actorEmail:(user.email||"").toLowerCase(),createdAt:serverTimestamp()
  }).catch(()=>{});
  if(btn) btn.textContent="清除此計畫附件";
  await refreshAndPatch();
  alert(`附件清理完成。\n\n成功：${ok} 份\n失敗：${fail} 份\n\n所有使用紀錄仍保留。`);
}

async function refreshAndPatch(){
  if(!user||!manager) return;
  try{
    await loadCache();
    patchPlanClearButton();
    patchIndividualButtons();
  }catch(err){
    console.warn("budget attachment delete v1.2.6 patch failed",err);
  }
}

onAuthStateChanged(auth,async u=>{
  user=u;
  manager=false;
  if(!u) return;
  try{
    const snap=await getDoc(doc(db,"users",u.email.toLowerCase()));
    manager=snap.exists()&&snap.data().enabled===true&&snap.data().role==="manager";
    schedule(500);
  }catch(err){console.warn(err);}
});

document.getElementById("planSelect")?.addEventListener("change",()=>schedule(350));
const observer=new MutationObserver(()=>schedule(280));
observer.observe(document.body,{childList:true,subtree:true});
