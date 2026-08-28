// Budget manager waiver click handler v1.3.10
// The waiver button is rendered directly by the main record renderer.
// Only amountConfirmedByManagerWaiver means a manager actually confirmed the waiver.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, updateDoc, addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";

function app(){ return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null; }
function money(n){ return new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0}).format(Number(n||0)); }

async function waive(id){
  const a=app();
  if(!a) return alert("經費系統尚未初始化，請重新整理後再試。");
  const auth=getAuth(a), db=getFirestore(a), user=auth.currentUser;
  if(!user?.email) return alert("尚未登入，請重新登入後再試。");
  const email=user.email.toLowerCase();

  const [userSnap,recordSnap]=await Promise.all([
    getDoc(doc(db,"users",email)),
    getDoc(doc(db,"expenseRecords",id))
  ]);
  if(!userSnap.exists() || userSnap.data().enabled!==true || userSnap.data().role!=="manager"){
    return alert("此功能僅限經費管理員使用。");
  }
  if(!recordSnap.exists()) return alert("找不到此筆使用紀錄。");

  const r=recordSnap.data();
  if(r.reviewStatus==="approved" || r.reviewed===true || r.locked===true) return alert("此筆已核銷並鎖定。");
  if(r.voucherUrl||r.folderUrl) return alert("此筆已有核銷單據，不需要設定免附單據。");
  if(r.amountConfirmedByManagerWaiver===true) return alert("此筆已經由管理員確認為免附單據。");

  const requested=r.voucherNotRequiredRequested===true;
  const msg=`確定將「${r.purpose||"此筆"}」設定為免附核銷單據？\n\n金額：${money(r.amount)}\n${requested?"老師已於送出時申報此單無需附上單據。":"老師尚未申報免附單據，請確認確實不需要附件。"}\n\n確認後才能進行「核對完成」。`;
  if(!confirm(msg)) return;

  try{
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
      type:"expense-voucher-waiver",
      targetId:id,
      planId:r.planId||document.getElementById("planSelect")?.value||"",
      action:"waive-voucher",
      actorEmail:email,
      createdAt:serverTimestamp()
    });
    location.reload();
  }catch(err){
    alert("設定免附單據失敗："+(err?.message||err));
  }
}

document.addEventListener("click",e=>{
  const btn=e.target.closest?.("[data-manager-waive-voucher]");
  if(!btn) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  waive(btn.dataset.managerWaiveVoucher||"");
},true);
