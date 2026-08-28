// Budget no-voucher request flow v1.3.7
// Teachers may declare a record as not requiring a voucher when submitting.
// This is only a request. A manager must still explicitly approve the waiver before final review.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, addDoc, updateDoc, collection, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID = "must-resource-budget-system";
let profile = null;
let isManager = false;
let uiTimer = null;

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
    <span><strong>此單無需附上單據</strong><small>勾選後可先送出，不需上傳附件；管理員核對時仍須再次按「免附單據」確認後才能核對完成。</small></span>`;
  voucher.insertAdjacentElement("beforebegin",label);

  document.getElementById("recordNoVoucherRequest")?.addEventListener("change",syncRequestUI);
  document.getElementById("recordEstimated")?.addEventListener("change",()=>setTimeout(syncRequestUI,0));
  syncRequestUI();
}

function syncRequestUI(){
  const request=document.getElementById("recordNoVoucherRequest");
  if(!request) return;
  const estimated=document.getElementById("recordEstimated")?.checked===true;
  const requested=request.checked===true;
  request.disabled=estimated;
  if(estimated && requested) request.checked=false;

  const active=!estimated && request.checked;
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
  if(active && hint) hint.textContent="此筆由老師申報為無需附單據；送出後仍需管理員再次確認「免附單據」才能核對完成。";
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
  profile=userSnap.data(); isManager=profile.role==="manager";
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
    reviewStatus:"pending",reviewed:false,locked:false,note,
    ownerEmail:existing?.ownerEmail||email,
    ownerName:existing?.ownerName||profile.name||user.displayName||user.email,
    createdBy:existing?.createdBy||email,
    updatedAt:serverTimestamp(),updatedBy:email
  };

  if(id) await updateDoc(doc(c.db,"expenseRecords",id),data);
  else await addDoc(collection(c.db,"expenseRecords"),{...data,createdAt:serverTimestamp()});

  document.getElementById("recordDialog")?.close();
  location.reload();
}

async function refreshProfile(){
  const c=ctx(); if(!c?.auth.currentUser) return;
  const email=(c.auth.currentUser.email||"").toLowerCase();
  if(!email) return;
  try{
    const snap=await getDoc(doc(c.db,"users",email));
    profile=snap.exists()?snap.data():null;
    isManager=!!profile && profile.enabled===true && profile.role==="manager";
    scheduleManagerButtons();
  }catch(err){ console.warn("load manager profile failed",err); }
}

function hasMissingVoucher(card){
  return [...card.querySelectorAll(".danger-badge")].some(b=>b.textContent.trim()==="缺單據");
}
function scheduleManagerButtons(){ clearTimeout(uiTimer); uiTimer=setTimeout(patchManagerButtons,80); }
function patchManagerButtons(){
  if(!isManager) return;
  document.querySelectorAll("#recordList .record-card").forEach(card=>{
    const approve=card.querySelector("[data-approve-record]");
    if(!approve || !hasMissingVoucher(card)) return;
    const id=approve.dataset.approveRecord||"";
    if(!id) return;
    const actions=approve.closest(".record-actions");
    if(!actions || actions.querySelector("[data-manager-waive-voucher]")) return;
    const btn=document.createElement("button");
    btn.className="link-btn";
    btn.dataset.managerWaiveVoucher=id;
    btn.textContent="免附單據";
    btn.title="管理員確認此筆不需要核銷附件";
    btn.addEventListener("click",async e=>{
      e.preventDefault(); e.stopPropagation();
      await managerWaive(id);
    });
    approve.insertAdjacentElement("beforebegin",btn);
  });
}

async function managerWaive(id){
  const c=ctx(); if(!c?.auth.currentUser || !isManager) return;
  const snap=await getDoc(doc(c.db,"expenseRecords",id));
  if(!snap.exists()) return alert("找不到此筆使用紀錄。");
  const r=snap.data();
  if(r.reviewStatus==="approved" || r.reviewed===true || r.locked===true) return alert("此筆已核銷並鎖定。");
  if(r.voucherUrl||r.folderUrl) return alert("此筆已有核銷單據，不需要設定免附單據。");
  if(r.voucherNotRequired===true || r.voucherRequirementWaived===true) return alert("此筆已經由管理員確認為免附單據。");

  const requested=r.voucherNotRequiredRequested===true;
  const msg=`確定將「${r.purpose||"此筆"}」設定為免附核銷單據？\n\n金額：${money(r.amount)}\n${requested?"老師已於送出時申報此單無需附上單據。":"此筆尚未由老師申報免附單據，但管理員仍可依實際情況確認。"}\n\n確認後才能進行「核對完成」。`;
  if(!confirm(msg)) return;

  const email=(c.auth.currentUser.email||"").toLowerCase();
  try{
    await updateDoc(doc(c.db,"expenseRecords",id),{
      voucherNotRequired:true,
      voucherRequirementWaived:true,
      voucherRequirementWaivedBy:email,
      voucherRequirementWaivedAt:serverTimestamp(),
      amountConfirmed:true,
      amountConfirmedByManagerWaiver:true,
      updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(c.db,"auditLogs"),{
      type:"expense-voucher-waiver",targetId:id,
      planId:r.planId||document.getElementById("planSelect")?.value||"",
      action:"waive-voucher",actorEmail:email,createdAt:serverTimestamp()
    });
    location.reload();
  }catch(err){ alert("設定免附單據失敗："+(err?.message||err)); }
}

async function approveWaived(id){
  const c=ctx(); if(!c?.auth.currentUser || !isManager) return;
  const snap=await getDoc(doc(c.db,"expenseRecords",id));
  if(!snap.exists()) return;
  const r=snap.data();
  if(!(r.voucherNotRequired===true || r.voucherRequirementWaived===true)) return;
  if(!confirm(`確認「${r.purpose||"此筆"}」核對完成？\n${money(r.amount)}\n\n此筆已由管理員確認免附單據；完成後會鎖定。`)) return;
  const email=(c.auth.currentUser.email||"").toLowerCase();
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

// The main app has a submit handler in bubble phase. Capture the special no-voucher request first.
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

// Manager final review: if no voucher exists, require the explicit waiver step first.
document.addEventListener("click",async e=>{
  const approve=e.target.closest?.("[data-approve-record]");
  if(!approve || !isManager) return;
  const id=approve.dataset.approveRecord||"";
  if(!id) return;
  const c=ctx(); if(!c) return;
  const snap=await getDoc(doc(c.db,"expenseRecords",id));
  if(!snap.exists()) return;
  const r=snap.data();
  const waived=r.voucherNotRequired===true || r.voucherRequirementWaived===true;
  const hasVoucher=!!(r.voucherUrl||r.folderUrl);
  if(waived){
    e.preventDefault(); e.stopImmediatePropagation();
    try{ await approveWaived(id); }catch(err){ alert("核對失敗："+(err?.message||err)); }
    return;
  }
  if(!hasVoucher){
    e.preventDefault(); e.stopImmediatePropagation();
    alert(r.voucherNotRequiredRequested===true
      ? "此筆老師已申報『此單無需附上單據』。請先按『免附單據』由管理員再次確認，才能核對完成。"
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

const observer=new MutationObserver(()=>{
  ensureRequestField();
  scheduleManagerButtons();
});
observer.observe(document.documentElement,{childList:true,subtree:true});

document.addEventListener("DOMContentLoaded",()=>{
  ensureRequestField();
  setTimeout(refreshProfile,300);
});
window.addEventListener("load",()=>{
  ensureRequestField();
  setTimeout(refreshProfile,500);
});
setInterval(()=>{ if(!profile) refreshProfile(); else scheduleManagerButtons(); },1500);
