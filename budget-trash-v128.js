// Budget recycle bin v1.2.8
// Manager-only recycle bin for plans, categories, and usage records.
// Retention: 10 days. Attachments never enter recycle bin.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, updateDoc, deleteDoc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
const UPLOAD_SERVICE_URL="https://must-free-upload-service.f00931-must.workers.dev";
const RETENTION_MS=10*24*60*60*1000;
const $=id=>document.getElementById(id);
let db=null, auth=null, currentEmail="";

function tsMillis(v){
  if(!v) return 0;
  if(typeof v.toMillis==="function") return v.toMillis();
  if(typeof v.seconds==="number") return v.seconds*1000;
  const n=Date.parse(v); return Number.isFinite(n)?n:0;
}
function esc(v){return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m]));}
function money(v){return new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0}).format(Number(v||0));}
function daysLeft(item){
  const d=tsMillis(item.deletedAt); if(!d)return 10;
  return Math.max(0,Math.ceil((d+RETENTION_MS-Date.now())/(24*60*60*1000)));
}
function pathFromRecord(r){
  if(r.voucherPath)return r.voucherPath;
  if(r.voucherStoragePath)return r.voucherStoragePath;
  const v=r.voucherUrl||r.folderUrl||"";
  if(!v)return "";
  if(!/^https?:\/\//.test(v)){
    try{return decodeURIComponent(new URL(v,"https://dummy.local").searchParams.get("path")||"");}catch{return "";}
  }
  try{
    const u=new URL(v); const qp=u.searchParams.get("path"); if(qp)return decodeURIComponent(qp);
    const parts=u.pathname.split('/').filter(Boolean),i=parts.indexOf('uploads'); return i>=0?parts.slice(i).join('/'):"";
  }catch{return "";}
}
async function workerDeleteAttachment(r){
  const path=pathFromRecord(r); if(!path)return;
  const token=await auth.currentUser.getIdToken(true);
  const res=await fetch(UPLOAD_SERVICE_URL+"/delete",{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"content-type":"application/json"},
    body:JSON.stringify({path,system:"budget",name:r.voucherFileName||"voucher"})
  });
  const data=await res.json().catch(()=>({}));
  if(!res.ok&&res.status!==404) throw new Error(data.error||`附件刪除失敗（${res.status}）`);
}

async function waitForBudgetApp(){
  for(let i=0;i<120;i++){
    const app=getApps().find(a=>a.options?.projectId===PROJECT_ID);
    if(app)return app;
    await new Promise(r=>setTimeout(r,50));
  }
  return null;
}

function installUI(){
  if($("trash"))return;
  const nav=document.querySelector("nav.tabs");
  const main=document.querySelector("#appView main");
  if(!nav||!main)return;
  const btn=document.createElement("button");
  btn.className="tab manager-only";
  btn.dataset.view="trash";
  btn.textContent="🗑️ 回收桶";
  nav.appendChild(btn);

  const section=document.createElement("section");
  section.id="trash"; section.className="view manager-only";
  section.innerHTML=`
    <div class="section-head responsive-head">
      <div><h2>回收桶</h2><p>計畫、經費項目與使用紀錄保留 10 天；附件不進回收桶。</p></div>
      <button id="refreshTrashBtn" class="ghost-btn">↻ 重新整理</button>
    </div>
    <div class="panel" style="margin-bottom:16px"><strong>保留規則</strong><p class="muted" style="margin:6px 0 0">刪除後 10 天內可由管理員還原。超過 10 天會在管理員開啟系統時自動永久清除；使用紀錄若仍有附件，附件會在永久清除時直接刪除。</p></div>
    <div id="trashStatus" class="muted" style="margin-bottom:12px">讀取中…</div>
    <div id="trashList" class="record-list"></div>`;
  main.appendChild(section);

  btn.addEventListener("click",()=>{
    document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active-view",v.id==="trash"));
    document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t===btn));
    loadTrash();
  });
  $("refreshTrashBtn").addEventListener("click",loadTrash);
}

async function allDeleted(){
  const [plansSnap,catsSnap,recsSnap]=await Promise.all([
    getDocs(collection(db,"budgetPlans")),getDocs(collection(db,"budgetCategories")),getDocs(collection(db,"expenseRecords"))
  ]);
  return {
    plans:plansSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted===true),
    cats:catsSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted===true),
    recs:recsSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted===true)
  };
}

async function purgeExpired(data){
  const now=Date.now(); let purged=0;
  // Records first so their attachments can be removed safely before documents disappear.
  for(const r of data.recs){
    const when=tsMillis(r.deletedAt); if(!when||when+RETENTION_MS>now)continue;
    try{ await workerDeleteAttachment(r); }catch(e){ console.warn("expired attachment purge failed",r.id,e); continue; }
    await deleteDoc(doc(db,"expenseRecords",r.id)); purged++;
    await addDoc(collection(db,"auditLogs"),{type:"recycle-bin",targetId:r.id,planId:r.planId||"",action:"purge-expired-record",actorEmail:currentEmail,createdAt:serverTimestamp()});
  }
  for(const c of data.cats){
    const when=tsMillis(c.deletedAt); if(!when||when+RETENTION_MS>now)continue;
    await deleteDoc(doc(db,"budgetCategories",c.id)); purged++;
    await addDoc(collection(db,"auditLogs"),{type:"recycle-bin",targetId:c.id,planId:c.planId||"",action:"purge-expired-category",actorEmail:currentEmail,createdAt:serverTimestamp()});
  }
  for(const p of data.plans){
    const when=tsMillis(p.deletedAt); if(!when||when+RETENTION_MS>now)continue;
    await deleteDoc(doc(db,"budgetPlans",p.id)); purged++;
    await addDoc(collection(db,"auditLogs"),{type:"recycle-bin",targetId:p.id,action:"purge-expired-plan",actorEmail:currentEmail,createdAt:serverTimestamp()});
  }
  return purged;
}

async function restoreItem(type,id){
  const collectionName=type==="plan"?"budgetPlans":type==="category"?"budgetCategories":"expenseRecords";
  const snap=await getDoc(doc(db,collectionName,id)); if(!snap.exists())return;
  const data=snap.data();
  if(data.deleted!==true)return;
  if(daysLeft(data)<=0){alert("此資料已超過 10 天保留期限，無法還原。");return;}

  if(type==="record"){
    if(data.planId){ const p=await getDoc(doc(db,"budgetPlans",data.planId)); if(!p.exists()||p.data().deleted===true){alert("此使用紀錄所屬計畫目前不存在或仍在回收桶，請先還原計畫。");return;} }
    if(data.categoryId){ const c=await getDoc(doc(db,"budgetCategories",data.categoryId)); if(!c.exists()||c.data().deleted===true){alert("此使用紀錄所屬經費項目目前不存在或仍在回收桶，請先還原經費項目。");return;} }
  }
  if(type==="category"&&data.planId){
    const p=await getDoc(doc(db,"budgetPlans",data.planId)); if(!p.exists()||p.data().deleted===true){alert("此經費項目所屬計畫仍在回收桶，請先還原計畫。");return;}
  }

  const label=type==="plan"?(data.name||"此計畫"):type==="category"?(data.name||"此項目"):(data.purpose||"此筆紀錄");
  if(!confirm(`確定還原「${label}」嗎？`))return;
  await updateDoc(doc(db,collectionName,id),{deleted:false,deletedAt:null,deletedBy:null,restoredAt:serverTimestamp(),restoredBy:currentEmail,updatedAt:serverTimestamp(),updatedBy:currentEmail});
  await addDoc(collection(db,"auditLogs"),{type:"recycle-bin",targetId:id,planId:data.planId||"",action:`restore-${type}`,actorEmail:currentEmail,createdAt:serverTimestamp()});
  await loadTrash();
  alert("已還原。重新整理或切回原頁面即可看到資料。");
}

function card(type,item){
  const typeName=type==="plan"?"計畫":type==="category"?"經費項目":"使用紀錄";
  const title=type==="plan"?(item.name||"未命名計畫"):type==="category"?(item.name||"未命名項目"):(item.purpose||"未命名紀錄");
  const detail=type==="record"?`${money(item.amount)}｜${esc(item.ownerName||item.ownerEmail||"")}`:type==="category"?`編列 ${money(item.budget)}`:`${esc(item.year||"")} ${esc(item.term||"")}`;
  const left=daysLeft(item);
  return `<article class="record-card"><div class="record-main"><div class="record-top"><div><span class="status-badge">${typeName}</span> <strong>${esc(title)}</strong></div><span class="muted">剩 ${left} 天</span></div><div class="record-meta"><span>${detail}</span><span>刪除者：${esc(item.deletedBy||"—")}</span></div><div class="record-actions"><button class="link-btn" data-trash-restore="${type}:${item.id}">還原</button></div></div></article>`;
}

async function loadTrash(){
  if(!db)return;
  const status=$("trashStatus"),list=$("trashList"); if(!status||!list)return;
  status.textContent="讀取中…";
  try{
    let data=await allDeleted();
    const purged=await purgeExpired(data);
    if(purged)data=await allDeleted();
    const items=[...data.plans.map(x=>["plan",x]),...data.cats.map(x=>["category",x]),...data.recs.map(x=>["record",x])]
      .sort((a,b)=>tsMillis(b[1].deletedAt)-tsMillis(a[1].deletedAt));
    status.textContent=`回收桶共 ${items.length} 筆${purged?`；已自動永久清除 ${purged} 筆超過 10 天資料`:""}`;
    list.innerHTML=items.length?items.map(([t,x])=>card(t,x)).join(""):'<div class="empty">回收桶目前沒有資料。</div>';
    document.querySelectorAll("[data-trash-restore]").forEach(b=>b.onclick=()=>{const [t,id]=b.dataset.trashRestore.split(":");restoreItem(t,id).catch(e=>alert("還原失敗："+(e?.message||e)));});
  }catch(e){console.error(e);status.textContent="回收桶讀取失敗："+(e?.message||e);}
}

(async()=>{
  const app=await waitForBudgetApp(); if(!app)return;
  auth=getAuth(app); db=getFirestore(app);
  onAuthStateChanged(auth,async user=>{
    if(!user?.email)return;
    currentEmail=String(user.email).toLowerCase();
    try{
      const snap=await getDoc(doc(db,"users",currentEmail));
      if(!snap.exists()||snap.data().enabled!==true||snap.data().role!=="manager")return;
      installUI();
      const data=await allDeleted(); await purgeExpired(data);
    }catch(e){console.warn("Recycle bin init skipped",e);}
  });
})();
