// Budget no-voucher request flow v1.3.11
// Teacher-side only: allows a teacher to request no-voucher handling when submitting.
// This request NEVER equals manager approval. Manager approval is handled separately.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, addDoc, updateDoc, collection, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID = "must-resource-budget-system";

function budgetApp(){ return getApps().find(a=>a.options?.projectId===PROJECT_ID) || null; }
function ctx(){
  const app=budgetApp();
  if(!app) return null;
  return { app, auth:getAuth(app), db:getFirestore(app) };
}
function money(n){ return new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0}).format(Number(n||0)); }

function ensureRequestField(){
  const estimateRow=document.querySelector("#recordDialog .estimate-row");
  const voucher=document.querySelector("#recordDialog .voucher-upload");
  if(!estimateRow || !voucher) return;
  if(document.getElementById("recordNoVoucherRequestWrap")) return;

  const label=document.createElement("label");
  label.id="recordNoVoucherRequestWrap";
  label.className="check-row";
  label.style.cssText="margin-top:12px;border:1px solid #ddd6ee;border-radius:12px;padding:12px 14px;background:#fbf9ff;";
  label.innerHTML=`<input id="recordNoVoucherRequest" type="checkbox" />
    <span><strong>此單無需附上單據</strong><small>勾選後可先送出，不需上傳附件；這只是老師申請，管理員仍須另外按「免附單據」確認後才能核對完成。</small></span>`;
  voucher.insertAdjacentElement("beforebegin",label);

  document.getElementById("recordNoVoucherRequest")?.addEventListener("change",syncRequestUI);
  document.getElementById("recordEstimated")?.addEventListener("change",()=>setTimeout(syncRequestUI,0));
  syncRequestUI();
}

function syncRequestUI(){
  const request=document.getElementById("recordNoVoucherRequest");
  if(!request) return;
  const estimated=document.getElementById("recordEstimated")?.checked===true;
  if(estimated && request.checked) request.checked=false;
  request.disabled=estimated;

  const active=!estimated && request.checked===true;
  const file=document.getElementById("recordVoucherFile");
  const archived=document.getElementById("recordArchived");
  const confirmed=document.getElementById("recordAmountConfirm");
  const uploadWrap=document.getElementById("uploadConfirmWrap");
  const confirmWrap=document.getElementById("manualConfirmWrap");
  const hint=document.getElementById("voucherRequirementHint");

  if(file) file.disabled=active;
  if(archived){ archived.disabled=active; if(active) archived.checked=false; }
  if(confirmed){ confirmed.disabled=active; if(active) confirmed.checked=false; }
  if(uploadWrap) uploadWrap.style.opacity=active?"0.5":"";
  if(confirmWrap) confirmWrap.style.opacity=active?"0.5":"";
  if(active && hint) hint.textContent="此筆僅由老師申請免附單據；管理員仍須另外按「免附單據」確認，才可核對完成。";
}

async function loadRequestForDialog(){
  ensureRequestField();
  const request=document.getElementById("recordNoVoucherRequest");
  if(!request) return;
  const id=document.getElementById("recordId")?.value||"";
  if(!id){ request.checked=false; syncRequestUI(); return; }
  const c=ctx(); if(!c) return;
  try{
    const snap=await getDoc(doc(c.db,"expenseRecords",id));
    request.checked=snap.exists() && snap.data().voucherNotRequiredRequested===true;
  }catch(err){ console.warn("load no-voucher request failed",err); }
  syncRequestUI();
}

async function saveRequestedRecord(){
  const c=ctx(); if(!c) throw new Error("Firebase 尚未初始化");
  const user=c.auth.currentUser; if(!user) throw new Error("尚未登入");
  const email=(user.email||"").toLowerCase();
  if(!email) throw new Error("無法辨識登入者");

  const id=document.getElementById("recordId")?.value||"";
  const planId=document.getElementById("planSelect")?.value||"";
  const categoryId=document.getElementById("recordCategory")?.value||"";
  const purpose=document.getElementById("recordPurpose")?.value.trim()||"";
  const amount=Number(document.getElementById("recordAmount")?.value||0);
  const semester=document.getElementById("recordSemester")?.value.trim()||"";
  const note=document.getElementById("recordNote")?.value.trim()||"";
  const file=document.getElementById("recordVoucherFile")?.files?.[0]||null;

  if(!planId) throw new Error("請先選擇計畫");
  if(!categoryId) throw new Error("請選擇經費項目");
  if(!purpose) throw new Error("請填寫用途／摘要");
  if(!/^\d{3}-[12]$/.test(semester)) throw new Error("學期請輸入例如 114-2、115-1");
  if(amount<0) throw new Error("金額不可小於 0");
  if(file) throw new Error("已勾選「此單無需附上單據」，請不要另外選擇附件");

  const [userSnap,planSnap,catSnap,existingSnap,recordsSnap]=await Promise.all([
    getDoc(doc(c.db,"users",email)),
    getDoc(doc(c.db,"budgetPlans",planId)),
    getDoc(doc(c.db,"budgetCategories",categoryId)),
    id?getDoc(doc(c.db,"expenseRecords",id)):Promise.resolve(null),
    getDocs(query(collection(c.db,"expenseRecords"),where("planId","==",planId)))
  ]);
  if(!userSnap.exists() || userSnap.data().enabled!==true) throw new Error("此帳號未獲授權");
  const profile=userSnap.data();
  const isManager=profile.role==="manager";
  if(!planSnap.exists()) throw new Error("找不到目前計畫");
  if(!id && planSnap.data().active===false) throw new Error("此計畫已停用，無法新增使用紀錄");
  if(!catSnap.exists()) throw new Error("找不到經費項目");
  const cat=catSnap.data();
  if(cat.planId!==planId) throw new Error("經費項目不屬於目前計畫");

  const existing=existingSnap?.exists()?existingSnap.data():null;
  if(existing){
    const locked=existing.reviewStatus==="approved" || existing.reviewed===true || existing.locked===true;
    if(locked) throw new Error("此筆已核銷並鎖定，請先由管理員解鎖");
    if(!isManager && String(existing.ownerEmail||"").toLowerCase()!==email) throw new Error("只能修改自己建立的使用紀錄");
    if(existing.voucherUrl||existing.folderUrl) throw new Error("此筆已有附件，不需再申報免附單據");
  }

  const used=recordsSnap.docs
    .map(d=>({id:d.id,...d.data()}))
    .filter(r=>r.deleted!==true && r.categoryId===categoryId && r.id!==id)
    .reduce((s,r)=>s+Number(r.amount||0),0);
  if(used+amount>Number(cat.budget||0)) throw new Error(`此筆會超過「${cat.name||"此經費項目"}」編列額度`);

  const data={
    planId,categoryId,purpose,amount,semester,estimated:false,
    archived:false,amountConfirmed:false,
    voucherNotRequiredRequested:true,
    voucherNotRequiredRequestedAt:serverTimestamp(),
    voucherNotRequiredRequestedBy:email,
    // IMPORTANT: teacher request never sets manager approval fields.
    reviewStatus:"pending",reviewed:false,locked:false,note,
    ownerEmail:existing?.ownerEmail||email,
    ownerName:existing?.ownerName||profile.name||user.displayName||user.email,
    createdBy:existing?.createdBy||email,
    updatedAt:serverTimestamp(),updatedBy:email
  };

  // Preserve any existing manager-waiver fields on edit; teacher-side request must never create/change them.
  if(id) await updateDoc(doc(c.db,"expenseRecords",id),data);
  else await addDoc(collection(c.db,"expenseRecords"),{...data,createdAt:serverTimestamp()});

  document.getElementById("recordDialog")?.close();
  location.reload();
}

async function approveConfirmedWaiver(id){
  const c=ctx(); if(!c?.auth.currentUser) return;
  const email=(c.auth.currentUser.email||"").toLowerCase();
  const [userSnap,recordSnap]=await Promise.all([
    getDoc(doc(c.db,"users",email)),
    getDoc(doc(c.db,"expenseRecords",id))
  ]);
  if(!userSnap.exists() || userSnap.data().enabled!==true || userSnap.data().role!=="manager") return;
  if(!recordSnap.exists()) return;
  const r=recordSnap.data();
  if(r.amountConfirmedByManagerWaiver!==true) return;
  if(!confirm(`確認「${r.purpose||"此筆"}」核對完成？\n${money(r.amount)}\n\n此筆已由管理員確認免附單據；完成後會鎖定。`)) return;

  await updateDoc(doc(c.db,"expenseRecords",id),{
    reviewStatus:"approved",reviewed:true,locked:true,
    reviewedAt:serverTimestamp(),reviewedBy:email,
    updatedAt:serverTimestamp(),updatedBy:email
  });
  await addDoc(collection(c.db,"auditLogs"),{
    type:"expense-review",targetId:id,planId:r.planId||"",action:"approve-waived-voucher",
    actorEmail:email,createdAt:serverTimestamp()
  });
  location.reload();
}

// Teacher-side special submit: request no voucher and bypass normal attachment requirements.
document.addEventListener("submit",async e=>{
  if(e.target?.id!=="recordForm") return;
  ensureRequestField();
  const requested=document.getElementById("recordNoVoucherRequest")?.checked===true;
  const estimated=document.getElementById("recordEstimated")?.checked===true;
  if(!requested || estimated) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const btn=document.getElementById("recordSaveBtn");
  try{
    if(btn){ btn.disabled=true; btn.textContent="儲存中…"; }
    await saveRequestedRecord();
  }catch(err){
    alert("儲存失敗："+(err?.message||err));
  }finally{
    if(btn){ btn.disabled=false; btn.textContent="儲存"; }
  }
},true);

// Manager final review: teacher request alone is never enough.
document.addEventListener("click",async e=>{
  const approve=e.target.closest?.("[data-approve-record]");
  if(!approve) return;
  const id=approve.dataset.approveRecord||"";
  if(!id) return;
  const c=ctx(); if(!c) return;
  const snap=await getDoc(doc(c.db,"expenseRecords",id));
  if(!snap.exists()) return;
  const r=snap.data();
  const hasVoucher=!!(r.voucherUrl||r.folderUrl);
  const managerWaived=r.amountConfirmedByManagerWaiver===true;

  if(managerWaived){
    e.preventDefault();
    e.stopImmediatePropagation();
    try{ await approveConfirmedWaiver(id); }catch(err){ alert("核對失敗："+(err?.message||err)); }
    return;
  }

  if(!hasVoucher){
    e.preventDefault();
    e.stopImmediatePropagation();
    alert(r.voucherNotRequiredRequested===true
      ? "此筆老師已申請『此單無需附上單據』，但尚未經管理員確認。請先按『免附單據』，再進行核對完成。"
      : "此筆缺少核銷單據。若確實不需附件，請先按『免附單據』確認後再核對。");
  }
},true);

document.addEventListener("click",e=>{
  if(e.target.closest?.("#newRecordBtn")) setTimeout(()=>{
    ensureRequestField();
    const x=document.getElementById("recordNoVoucherRequest"); if(x) x.checked=false;
    syncRequestUI();
  },0);
  if(e.target.closest?.("[data-edit-record]")) setTimeout(loadRequestForDialog,60);
},true);

// Only maintain the teacher-side form field. No manager button injection here.
const observer=new MutationObserver(()=>ensureRequestField());
observer.observe(document.documentElement,{childList:true,subtree:true});

document.addEventListener("DOMContentLoaded",ensureRequestField);
window.addEventListener("load",ensureRequestField);
