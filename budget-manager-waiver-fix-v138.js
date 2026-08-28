// Budget manager waiver reliability fix v1.3.8
// Restore the manager-only "免附單據" confirmation button reliably.
// Do not rely on the older patch's cached isManager flag; the existence of the
// manager-only approve button is used for UI placement, and permission is rechecked
// against Firestore when the action is clicked.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, updateDoc, addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
let timer=null;

function app(){ return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null; }
function context(){
  const a=app(); if(!a) return null;
  return {auth:getAuth(a),db:getFirestore(a)};
}
function money(n){ return new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0}).format(Number(n||0)); }
function missingVoucher(card){
  return [...card.querySelectorAll(".danger-badge")].some(x=>x.textContent.trim()==="缺單據");
}
async function assertManager(){
  const c=context();
  const user=c?.auth.currentUser;
  if(!c||!user?.email) throw new Error("尚未登入");
  const email=user.email.toLowerCase();
  const snap=await getDoc(doc(c.db,"users",email));
  if(!snap.exists() || snap.data().enabled!==true || snap.data().role!=="manager") throw new Error("只有經費管理員可以確認免附單據");
  return {c,user,email};
}

function patchButtons(){
  document.querySelectorAll("#recordList .record-card").forEach(card=>{
    const approve=card.querySelector("[data-approve-record]");
    if(!approve || !missingVoucher(card)) return;
    const id=approve.dataset.approveRecord||"";
    const actions=approve.closest(".record-actions");
    if(!id||!actions||actions.querySelector("[data-manager-waive-v138]")) return;

    // If an older patch already produced the correct button, do not duplicate it.
    if(actions.querySelector("[data-manager-waive-voucher],[data-waive-voucher]")) return;

    const btn=document.createElement("button");
    btn.className="link-btn";
    btn.dataset.managerWaiveV138=id;
    btn.textContent="免附單據";
    btn.title="管理員再次確認此筆確實不需附核銷單據";
    btn.addEventListener("click",async e=>{
      e.preventDefault(); e.stopPropagation();
      try{ await waive(id); }
      catch(err){ alert("設定免附單據失敗："+(err?.message||err)); }
    });
    approve.insertAdjacentElement("beforebegin",btn);
  });
}
function schedule(){ clearTimeout(timer); timer=setTimeout(patchButtons,60); }

async function waive(id){
  const {c,email}=await assertManager();
  const ref=doc(c.db,"expenseRecords",id);
  const snap=await getDoc(ref);
  if(!snap.exists()) throw new Error("找不到此筆使用紀錄");
  const r=snap.data();
  if(r.reviewStatus==="approved"||r.reviewed===true||r.locked===true) throw new Error("此筆已核銷並鎖定");
  if(r.voucherUrl||r.folderUrl) throw new Error("此筆已有核銷單據，不需要設定免附單據");
  if(r.voucherNotRequired===true||r.voucherRequirementWaived===true){
    alert("此筆已由管理員確認為免附單據，可直接按「核對完成」。");
    return;
  }

  const requested=r.voucherNotRequiredRequested===true;
  const text=`確定將「${r.purpose||"此筆"}」確認為「免附單據」？\n\n金額：${money(r.amount)}\n${requested?"老師送出時已勾選「此單無需附上單據」。":"老師送出時未勾選免附單據，請確認實際狀況。"}\n\n這是管理員的第二次確認；確認後才可核對完成。`;
  if(!confirm(text)) return;

  await updateDoc(ref,{
    voucherNotRequired:true,
    voucherRequirementWaived:true,
    voucherRequirementWaivedBy:email,
    voucherRequirementWaivedAt:serverTimestamp(),
    amountConfirmed:true,
    amountConfirmedByManagerWaiver:true,
    updatedAt:serverTimestamp(),updatedBy:email
  });
  await addDoc(collection(c.db,"auditLogs"),{
    type:"expense-voucher-waiver",targetId:id,planId:r.planId||"",action:"waive-voucher",
    actorEmail:email,createdAt:serverTimestamp()
  });
  location.reload();
}

// Fallback approval handler. The base app refuses no-voucher records even after a waiver;
// intercept a waived record and complete the manager review here.
document.addEventListener("click",async e=>{
  const approve=e.target.closest?.("[data-approve-record]");
  if(!approve) return;
  const id=approve.dataset.approveRecord||"";
  if(!id) return;
  try{
    const {c,email}=await assertManager();
    const ref=doc(c.db,"expenseRecords",id);
    const snap=await getDoc(ref); if(!snap.exists()) return;
    const r=snap.data();
    const hasVoucher=!!(r.voucherUrl||r.folderUrl);
    const waived=r.voucherNotRequired===true||r.voucherRequirementWaived===true;
    if(hasVoucher) return; // normal base workflow

    e.preventDefault(); e.stopImmediatePropagation();
    if(!waived){
      alert(r.voucherNotRequiredRequested===true
        ? "此筆老師已申報「此單無需附上單據」。請先按「免附單據」由管理員再次確認，才能核對完成。"
        : "此筆缺少核銷單據。若確實不需附件，請先按「免附單據」確認後再核對。");
      return;
    }
    if(!confirm(`確認「${r.purpose||"此筆"}」核對完成？\n${money(r.amount)}\n\n此筆已由管理員確認免附單據；完成後會鎖定。`)) return;
    await updateDoc(ref,{
      reviewStatus:"approved",reviewed:true,locked:true,
      reviewedAt:serverTimestamp(),reviewedBy:email,
      updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(c.db,"auditLogs"),{
      type:"expense-review",targetId:id,planId:r.planId||"",action:"approve-waived-voucher",
      actorEmail:email,createdAt:serverTimestamp()
    });
    location.reload();
  }catch(err){
    console.warn("manager waiver approval fallback",err);
  }
},true);

new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener("DOMContentLoaded",schedule);
window.addEventListener("load",schedule);
setInterval(schedule,1000);
