import { getApps, getApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, updateDoc, addDoc, collection, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const app = getApps().length ? getApp() : null;
if (!app) throw new Error("Firebase 尚未初始化");
const auth = getAuth(app);
const db = getFirestore(app);
const money = new Intl.NumberFormat("zh-TW", { style:"currency", currency:"TWD", maximumFractionDigits:0 });
const UPLOAD_SERVICE_URL = "https://must-free-upload-service.f00931-must.workers.dev";

let currentUser = null;
let isManager = false;
let cache = { planId:"", plan:null, categories:[], records:[] };
let refreshTimer = null;

function scheduleRefresh(delay=120){
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshAndPatch, delay);
}

async function refreshAndPatch(){
  if(!currentUser) return;
  const planId = document.getElementById("planSelect")?.value || "";
  if(!planId) return;
  try{
    const [planSnap, catSnap, recSnap] = await Promise.all([
      getDoc(doc(db,"budgetPlans",planId)),
      getDocs(query(collection(db,"budgetCategories"), where("planId","==",planId))),
      getDocs(query(collection(db,"expenseRecords"), where("planId","==",planId)))
    ]);
    cache = {
      planId,
      plan: planSnap.exists()?{id:planSnap.id,...planSnap.data()}:null,
      categories: catSnap.docs.map(d=>({id:d.id,...d.data()})),
      records: recSnap.docs.map(d=>({id:d.id,...d.data()}))
    };
    patchBudgetTable();
    patchRecordCards();
    patchTodoCounts();
    patchPlanAttachmentPurgeButton();
  }catch(err){
    console.warn("budget v1.2.2 patch refresh failed", err);
  }
}

function patchBudgetTable(){
  const wrap=document.getElementById("budgetTableWrap");
  if(!wrap) return;
  const headCells=wrap.querySelectorAll("thead th");
  if(headCells.length) headCells[headCells.length-1].textContent="剩餘（括號＝未扣預估）";

  wrap.querySelectorAll("tbody tr").forEach(row=>{
    const cells=row.querySelectorAll("td");
    if(cells.length<2) return;
    const name=cells[0].textContent.trim();
    const category=cache.categories.find(c=>String(c.name||"").trim()===name);
    if(!category) return;
    const recs=cache.records.filter(r=>r.categoryId===category.id);
    const allUsed=recs.reduce((s,r)=>s+Number(r.amount||0),0);
    const nonEstimateUsed=recs.filter(r=>r.estimated!==true).reduce((s,r)=>s+Number(r.amount||0),0);
    const remaining=Number(category.budget||0)-allUsed;
    const remainingWithoutEstimate=Number(category.budget||0)-nonEstimateUsed;
    const last=cells[cells.length-1];
    last.textContent=`${money.format(remaining)}（${money.format(remainingWithoutEstimate)}）`;
    last.title="括號內為未扣除預估金額的剩餘額";
  });
}

function getRecordId(card){
  const btn=card.querySelector("[data-edit-record],[data-delete-record],[data-approve-record],[data-unlock-record]");
  if(!btn) return "";
  return btn.dataset.editRecord || btn.dataset.deleteRecord || btn.dataset.approveRecord || btn.dataset.unlockRecord || "";
}

function patchRecordCards(){
  const issueFilter=document.getElementById("filterIssue")?.value||"";
  document.querySelectorAll("#recordList .record-card").forEach(card=>{
    const id=getRecordId(card); if(!id) return;
    const r=cache.records.find(x=>x.id===id); if(!r) return;
    const waived=r.voucherNotRequired===true || r.voucherRequirementWaived===true;
    const purged=r.voucherPurged===true;
    const noVoucher=!(r.voucherUrl||r.folderUrl);

    if(waived || purged){
      card.querySelectorAll(".danger-badge").forEach(b=>{
        const t=b.textContent.trim();
        if(t==="缺單據" || t==="未確認金額") b.remove();
      });
      const statusArea=card.children?.[2];
      if(statusArea && purged && !statusArea.querySelector(".voucher-purged-badge")){
        const badge=document.createElement("span");
        badge.className="status voucher-purged-badge";
        badge.textContent="附件已清理";
        badge.title="此計畫附件已由管理員清理以釋放容量";
        statusArea.appendChild(badge);
      }else if(statusArea && waived && !statusArea.querySelector(".voucher-waived-badge")){
        const badge=document.createElement("span");
        badge.className="status done voucher-waived-badge";
        badge.textContent="免附單據";
        statusArea.appendChild(badge);
      }
      if(issueFilter==="missingVoucher" || issueFilter==="unconfirmed") card.style.display="none";
    }

    if(!isManager || r.estimated===true || r.reviewStatus==="approved" || r.reviewed===true || r.locked===true || purged) return;
    const actions=card.querySelector(".record-actions");
    if(!actions) return;

    if(noVoucher && !waived && !actions.querySelector("[data-waive-voucher]")){
      const b=document.createElement("button");
      b.className="link-btn";
      b.dataset.waiveVoucher=id;
      b.textContent="免附單據";
      b.title="適用於人事費等本來就不需要核銷單據的項目";
      b.onclick=()=>waiveVoucher(id);
      actions.appendChild(b);
    }

    if(waived){
      const approve=actions.querySelector("[data-approve-record]");
      if(approve && !approve.dataset.waiverReady){
        const clone=approve.cloneNode(true);
        clone.dataset.waiverReady="1";
        clone.onclick=()=>approveWaivedRecord(id);
        approve.replaceWith(clone);
      }
      if(!actions.querySelector("[data-require-voucher]")){
        const b=document.createElement("button");
        b.className="link-btn";
        b.dataset.requireVoucher=id;
        b.textContent="恢復需單據";
        b.onclick=()=>restoreVoucherRequirement(id);
        actions.appendChild(b);
      }
    }
  });
}

function patchTodoCounts(){
  if(!isManager) return;
  const valid=cache.records.filter(r=>r.voucherPurged!==true);
  const missingVoucher=valid.filter(r=>r.estimated!==true && !(r.voucherUrl||r.folderUrl) && r.voucherNotRequired!==true && r.voucherRequirementWaived!==true).length;
  const missingConfirm=valid.filter(r=>r.estimated!==true && r.voucherNotRequired!==true && r.voucherRequirementWaived!==true && r.amountConfirmed!==true && r.amountManuallyConfirmed!==true).length;
  document.querySelectorAll("[data-quick-issue]").forEach(btn=>{
    const key=btn.dataset.quickIssue;
    const strong=btn.querySelector("strong");
    if(!strong) return;
    if(key==="missingVoucher") strong.textContent=String(missingVoucher);
    if(key==="unconfirmed") strong.textContent=String(missingConfirm);
  });
}

function patchPlanAttachmentPurgeButton(){
  const deleteBtn=document.getElementById("deletePlanBtn");
  if(!deleteBtn || !isManager) return;
  let btn=document.getElementById("purgePlanAttachmentsBtn");
  if(!btn){
    btn=document.createElement("button");
    btn.id="purgePlanAttachmentsBtn";
    btn.className="ghost-btn manager-only";
    btn.style.color="#9a3412";
    btn.style.borderColor="#fdba74";
    btn.textContent="清除此計畫附件";
    btn.onclick=purgeCurrentPlanAttachments;
    deleteBtn.insertAdjacentElement("afterend",btn);
  }
  const attachmentCount=cache.records.filter(r=>!r.voucherPurged && (r.voucherPath||r.voucherStoragePath||r.voucherUrl||r.folderUrl)).length;
  const inactive=cache.plan?.active===false;
  btn.disabled=!inactive || attachmentCount===0;
  btn.title=!inactive
    ? "為避免誤刪，只有已停用的計畫才能整批清理附件"
    : attachmentCount===0 ? "此計畫目前沒有可清理的附件" : `此計畫共有 ${attachmentCount} 份附件可清理`;
}

async function uploadServiceRequest(path,options={}){
  if(!currentUser) throw new Error("尚未登入");
  const token=await currentUser.getIdToken(true);
  const headers=new Headers(options.headers||{});
  headers.set("Authorization","Bearer "+token);
  const res=await fetch(UPLOAD_SERVICE_URL+path,{...options,headers});
  const data=await res.json().catch(()=>({}));
  if(!res.ok||data.ok===false) throw new Error(data.error||`附件服務錯誤（${res.status}）`);
  return data;
}

function githubPathFromUrl(v){
  if(!v) return "";
  if(!/^https?:\/\//.test(v)) return String(v).replace(/^\/+/,'');
  try{
    const p=new URL(v).pathname.split('/').filter(Boolean), i=p.indexOf('uploads');
    if(i!==-1) return p.slice(i).join('/');
  }catch{}
  return "";
}

async function purgeCurrentPlanAttachments(){
  if(!isManager || !cache.planId || cache.plan?.active!==false) return;
  const rows=cache.records.filter(r=>!r.voucherPurged && (r.voucherPath||r.voucherStoragePath||r.voucherUrl||r.folderUrl));
  if(!rows.length) return alert("此計畫目前沒有可清理的附件。");
  const planName=cache.plan?.name||"此計畫";
  if(!confirm(`確定要清除「${planName}」的所有核銷附件嗎？\n\n共 ${rows.length} 份。\n只會刪除附件，不會刪除計畫、經費項目或使用紀錄。\n\n此動作無法復原。`)) return;
  const typed=prompt(`為避免誤刪，請輸入「刪除附件」四個字確認：`);
  if(typed!=="刪除附件") return alert("確認文字不符，已取消。");

  const btn=document.getElementById("purgePlanAttachmentsBtn");
  if(btn){ btn.disabled=true; btn.textContent=`清理中 0/${rows.length}`; }
  let ok=0, fail=0;
  const email=(currentUser.email||"").toLowerCase();

  for(let i=0;i<rows.length;i++){
    const r=rows[i];
    if(btn) btn.textContent=`清理中 ${i+1}/${rows.length}`;
    const path=r.voucherPath||r.voucherStoragePath||githubPathFromUrl(r.voucherUrl||r.folderUrl||"");
    if(!path){ fail++; continue; }
    try{
      await uploadServiceRequest("/delete",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({path,name:r.voucherFileName||"voucher"})
      });
      await updateDoc(doc(db,"expenseRecords",r.id),{
        voucherPurged:true,
        voucherPurgedAt:serverTimestamp(),
        voucherPurgedBy:email,
        voucherPurgedOriginalPath:path,
        voucherPurgedOriginalName:r.voucherFileName||"",
        voucherUrl:"",
        folderUrl:"",
        voucherPath:"",
        voucherStoragePath:"",
        updatedAt:serverTimestamp(),
        updatedBy:email
      });
      ok++;
    }catch(err){
      console.warn("purge attachment failed",r.id,err);
      fail++;
    }
  }

  try{
    await addDoc(collection(db,"auditLogs"),{
      type:"plan-attachment-purge",planId:cache.planId,targetId:cache.planId,
      action:"purge-plan-attachments",deletedCount:ok,failedCount:fail,
      actorEmail:email,createdAt:serverTimestamp()
    });
  }catch(err){ console.warn("purge audit log failed",err); }

  if(btn){ btn.textContent="清除此計畫附件"; }
  await refreshAndPatch();
  alert(`附件清理完成。\n\n成功：${ok} 份\n失敗：${fail} 份\n\n使用紀錄仍完整保留。`);
}

async function waiveVoucher(id){
  const r=cache.records.find(x=>x.id===id); if(!r) return;
  if(!confirm(`確認「${r.purpose||"此筆"}」屬於不需核銷單據的經費嗎？\n\n例如：人事費等依法或流程上本來就沒有核銷附件。`)) return;
  try{
    const email=(currentUser.email||"").toLowerCase();
    await updateDoc(doc(db,"expenseRecords",id),{
      voucherNotRequired:true,
      voucherRequirementWaived:true,
      voucherRequirementWaivedBy:email,
      voucherRequirementWaivedAt:serverTimestamp(),
      amountConfirmed:true,
      amountConfirmedByManagerWaiver:true,
      updatedAt:serverTimestamp(),
      updatedBy:email
    });
    await addDoc(collection(db,"auditLogs"),{
      type:"expense-voucher-waiver",targetId:id,planId:cache.planId,action:"waive-voucher",
      actorEmail:email,createdAt:serverTimestamp()
    });
    location.reload();
  }catch(err){ alert("設定免附單據失敗："+err.message); }
}

async function restoreVoucherRequirement(id){
  if(!confirm("確定恢復此筆為『需要核銷單據』？")) return;
  try{
    const email=(currentUser.email||"").toLowerCase();
    await updateDoc(doc(db,"expenseRecords",id),{
      voucherNotRequired:false,
      voucherRequirementWaived:false,
      amountConfirmed:false,
      amountConfirmedByManagerWaiver:false,
      updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(db,"auditLogs"),{
      type:"expense-voucher-waiver",targetId:id,planId:cache.planId,action:"restore-voucher-required",
      actorEmail:email,createdAt:serverTimestamp()
    });
    location.reload();
  }catch(err){ alert("恢復單據要求失敗："+err.message); }
}

async function approveWaivedRecord(id){
  const r=cache.records.find(x=>x.id===id); if(!r) return;
  if(!confirm(`確認「${r.purpose||"此筆"}」核對完成？\n${money.format(r.amount||0)}\n\n此筆已由管理員標記為免附單據，核對後會鎖定。`)) return;
  try{
    const email=(currentUser.email||"").toLowerCase();
    await updateDoc(doc(db,"expenseRecords",id),{
      reviewStatus:"approved",reviewed:true,locked:true,
      reviewedAt:serverTimestamp(),reviewedBy:email,
      updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(db,"auditLogs"),{
      type:"expense-review",targetId:id,planId:cache.planId,action:"approve-waived-voucher",
      actorEmail:email,createdAt:serverTimestamp()
    });
    location.reload();
  }catch(err){ alert("核對失敗："+err.message); }
}

onAuthStateChanged(auth, async user=>{
  currentUser=user;
  if(!user) return;
  try{
    const snap=await getDoc(doc(db,"users",user.email.toLowerCase()));
    isManager=snap.exists() && snap.data().enabled===true && snap.data().role==="manager";
    scheduleRefresh(350);
  }catch(err){ console.warn(err); }
});

document.getElementById("planSelect")?.addEventListener("change",()=>scheduleRefresh(250));
["filterIssue","filterReview","filterCategory","filterSemester"].forEach(id=>document.getElementById(id)?.addEventListener("change",()=>scheduleRefresh(120)));

const observer=new MutationObserver(()=>scheduleRefresh(120));
observer.observe(document.body,{childList:true,subtree:true});
