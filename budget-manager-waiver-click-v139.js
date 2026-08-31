// Budget manager event shield v1.6.9
// All manager review clicks are handled here once, so older handlers never show duplicate confirms.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, updateDoc, addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
let reviewBusy=false;
function app(){ return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null; }
function money(n){ return new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0}).format(Number(n||0)); }
function approved(r){ return r?.reviewStatus==="approved" || r?.reviewed===true || r?.locked===true; }
function managerConfirmed(r){ return r?.voucherWaiverManagerConfirmed===true || r?.amountConfirmedByManagerWaiver===true; }
function hasVoucher(r){ return !!(r?.voucherUrl||r?.folderUrl); }
function amountConfirmed(r){ return r?.amountConfirmed===true || r?.amountManuallyConfirmed===true || r?.amountConfirmedByManagerWaiver===true; }

async function ctxFor(id){
  const a=app(); if(!a) throw new Error("經費系統尚未初始化");
  const auth=getAuth(a), db=getFirestore(a), user=auth.currentUser;
  if(!user?.email) throw new Error("尚未登入");
  const email=user.email.toLowerCase();
  const [u,r]=await Promise.all([getDoc(doc(db,"users",email)),getDoc(doc(db,"expenseRecords",id))]);
  if(!u.exists() || u.data().enabled!==true || u.data().role!=="manager") throw new Error("此功能僅限經費管理員使用");
  if(!r.exists()) throw new Error("找不到此筆使用紀錄");
  return {db,email,r:r.data()};
}

async function confirmWaiver(id){
  try{
    const {db,email,r}=await ctxFor(id);
    if(approved(r)) return alert("此筆已核銷並鎖定。");
    if(hasVoucher(r)) return alert("此筆已有核銷單據，不需要設定免附單據。");
    if(managerConfirmed(r)) return alert("此筆已由管理員確認免附單據。");
    const requested=r.voucherNotRequiredRequested===true;
    if(!confirm(`確定將「${r.purpose||"此筆"}」確認為免附核銷單據？\n\n金額：${money(r.amount)}\n${requested?"老師已於送出時申請『此單無需附上單據』。":"老師未申請免附單據，請確認此筆確實不需要附件。"}\n\n確認後即可再按『核對完成』。`)) return;
    await updateDoc(doc(db,"expenseRecords",id),{
      voucherWaiverManagerConfirmed:true,voucherWaiverManagerConfirmedBy:email,voucherWaiverManagerConfirmedAt:serverTimestamp(),
      voucherNotRequired:true,voucherRequirementWaived:true,amountConfirmed:true,amountConfirmedByManagerWaiver:true,
      updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(db,"auditLogs"),{type:"expense-voucher-waiver",targetId:id,planId:r.planId||"",action:"manager-confirm-waiver",actorEmail:email,createdAt:serverTimestamp()});
    location.reload();
  }catch(err){ alert("設定免附單據失敗："+(err?.message||err)); }
}

async function revokeWaiver(id){
  try{
    const {db,email,r}=await ctxFor(id);
    if(!managerConfirmed(r)) return;
    if(!confirm(`確定撤銷「${r.purpose||"此筆"}」的免附單據確認？\n\n撤銷後會恢復為需要核銷單據。`)) return;
    await updateDoc(doc(db,"expenseRecords",id),{
      voucherWaiverManagerConfirmed:false,voucherWaiverManagerConfirmedBy:"",voucherWaiverManagerConfirmedAt:null,
      voucherNotRequired:false,voucherRequirementWaived:false,amountConfirmed:false,amountConfirmedByManagerWaiver:false,
      updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(db,"auditLogs"),{type:"expense-voucher-waiver",targetId:id,planId:r.planId||"",action:"manager-revoke-waiver",actorEmail:email,createdAt:serverTimestamp()});
    location.reload();
  }catch(err){ alert("撤銷免附單據失敗："+(err?.message||err)); }
}

async function reviewOnce(id){
  if(reviewBusy) return;
  reviewBusy=true;
  try{
    const {db,email,r}=await ctxFor(id);
    if(approved(r)) return;
    if(r.estimated===true) return alert("預估／請購中紀錄尚未進入正式核銷，不能核對完成。");
    if(!hasVoucher(r) && !managerConfirmed(r)){
      alert(r.voucherNotRequiredRequested===true
        ? "此筆老師已申請『此單無需附上單據』。請先按『免附單據』由管理員確認，再核對完成。"
        : "此筆缺少核銷單據。若確實不需附件，請先按『免附單據』確認。"
      );
      return;
    }
    if(hasVoucher(r) && !amountConfirmed(r)) return alert("此筆尚未確認核銷單據與 Key 金額相同。");
    const extra=managerConfirmed(r)&&!hasVoucher(r)?"\n此筆已由管理員確認免附單據。":"";
    if(!confirm(`確認「${r.purpose||"此筆"}」核對完成？\n${money(r.amount)}${extra}\n\n完成後會鎖定。`)) return;
    await updateDoc(doc(db,"expenseRecords",id),{
      reviewStatus:"approved",reviewed:true,locked:true,
      reviewedAt:serverTimestamp(),reviewedBy:email,updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(db,"auditLogs"),{type:"expense-review",targetId:id,planId:r.planId||"",action:managerConfirmed(r)&&!hasVoucher(r)?"approve-manager-waived-voucher":"approve",actorEmail:email,createdAt:serverTimestamp()});
    location.reload();
  }catch(err){ alert("核對失敗："+(err?.message||err)); }
  finally{ reviewBusy=false; }
}

window.addEventListener("click",async e=>{
  const waive=e.target.closest?.("[data-manager-waive-voucher]");
  if(waive){ e.preventDefault(); e.stopImmediatePropagation(); await confirmWaiver(waive.dataset.managerWaiveVoucher||""); return; }

  const revoke=e.target.closest?.("[data-manager-revoke-waiver]");
  if(revoke){ e.preventDefault(); e.stopImmediatePropagation(); await revokeWaiver(revoke.dataset.managerRevokeWaiver||""); return; }

  const approveBtn=e.target.closest?.("[data-approve-record]");
  if(!approveBtn) return;
  const id=approveBtn.dataset.approveRecord||""; if(!id) return;
  const a=app(),user=a?getAuth(a).currentUser:null; if(!user?.email) return;
  try{
    const db=getFirestore(a),u=await getDoc(doc(db,"users",user.email.toLowerCase()));
    if(!u.exists() || u.data().enabled!==true || u.data().role!=="manager") return;
    e.preventDefault(); e.stopImmediatePropagation();
    await reviewOnce(id);
  }catch(err){
    e.preventDefault(); e.stopImmediatePropagation();
    alert("核對失敗："+(err?.message||err));
  }
},true);

import("./budget-issue-filter-v143.js?v=1.6.9");
