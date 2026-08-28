// Budget admin unified controller v1.4.1
// Single source of truth for manager no-voucher confirm / revoke / final review.
// Teacher request (voucherNotRequiredRequested) NEVER equals manager confirmation.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, updateDoc, addDoc, collection, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
let auth=null, db=null, manager=false, records=[];
let timer=null;
let ready=false;

function app(){ return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null; }
function money(n){ return new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0}).format(Number(n||0)); }
function isApproved(r){ return r?.reviewStatus==="approved" || r?.reviewed===true || r?.locked===true; }
function managerConfirmed(r){ return r?.voucherWaiverManagerConfirmed===true; }
function hasVoucher(r){ return !!(r?.voucherUrl||r?.folderUrl); }
function recordId(card){
  const el=card.querySelector("[data-edit-record],[data-delete-record],[data-approve-record],[data-unlock-record],[data-manager-waive-voucher],[data-manager-revoke-waiver]");
  if(!el) return "";
  return el.dataset.editRecord||el.dataset.deleteRecord||el.dataset.approveRecord||el.dataset.unlockRecord||el.dataset.managerWaiveVoucher||el.dataset.managerRevokeWaiver||"";
}
function setListVisible(show){
  const list=document.getElementById("recordList");
  if(list) list.style.visibility=show?"":"hidden";
}
function ensureBadge(area,text,cls="danger-badge"){
  if(!area) return;
  if([...area.querySelectorAll(".status")].some(x=>x.textContent.trim()===text)) return;
  const b=document.createElement("span");
  b.className=`status ${cls}`;
  b.textContent=text;
  area.appendChild(b);
}
function removeBadge(area,text){
  if(!area) return;
  [...area.querySelectorAll(".status")].forEach(x=>{ if(x.textContent.trim()===text) x.remove(); });
}
function placeBeforeApprove(actions,button){
  const approve=actions.querySelector("[data-approve-record]");
  if(approve) approve.insertAdjacentElement("beforebegin",button);
  else actions.appendChild(button);
}

function patchCards(){
  if(!manager) return;
  document.querySelectorAll("#recordList .record-card").forEach(card=>{
    const id=recordId(card); if(!id) return;
    const r=records.find(x=>x.id===id); if(!r || r.deleted===true || r.estimated===true || isApproved(r)) return;
    const actions=card.querySelector(".record-actions");
    const status=card.children?.[2];
    if(!actions) return;

    const confirmed=managerConfirmed(r);
    const voucher=hasVoucher(r);

    // Remove every legacy/doubled waiver control first.
    actions.querySelectorAll("[data-manager-waive-voucher],[data-waive-voucher],[data-require-voucher],[data-require-voucher-clean],[data-manager-revoke-waiver]").forEach(x=>x.remove());

    if(!voucher && !confirmed){
      removeBadge(status,"免附單據");
      ensureBadge(status,"缺單據");
      if(r.amountConfirmed!==true && r.amountManuallyConfirmed!==true) ensureBadge(status,"未確認金額");

      const b=document.createElement("button");
      b.className="link-btn";
      b.dataset.managerWaiveVoucher=id;
      b.textContent="免附單據";
      b.title="管理員二次確認此筆確實不需要核銷附件";
      placeBeforeApprove(actions,b);
    }

    if(confirmed){
      removeBadge(status,"缺單據");
      removeBadge(status,"未確認金額");
      ensureBadge(status,"免附單據","done");

      const b=document.createElement("button");
      b.className="link-btn";
      b.dataset.managerRevokeWaiver=id;
      b.textContent="撤銷免附";
      b.title="撤銷管理員的免附單據確認";
      placeBeforeApprove(actions,b);
    }
  });
}

function patchTodoCounts(){
  if(!manager) return;
  const valid=records.filter(r=>r.deleted!==true && r.voucherPurged!==true);
  const missingVoucher=valid.filter(r=>r.estimated!==true && !hasVoucher(r) && !managerConfirmed(r)).length;
  const missingConfirm=valid.filter(r=>r.estimated!==true && !managerConfirmed(r) && r.amountConfirmed!==true && r.amountManuallyConfirmed!==true).length;
  document.querySelectorAll("[data-quick-issue]").forEach(btn=>{
    const strong=btn.querySelector("strong"); if(!strong) return;
    if(btn.dataset.quickIssue==="missingVoucher") strong.textContent=String(missingVoucher);
    if(btn.dataset.quickIssue==="unconfirmed") strong.textContent=String(missingConfirm);
  });
}

async function refresh(){
  if(!manager || !db){ if(ready) setListVisible(true); return; }
  const planId=document.getElementById("planSelect")?.value||"";
  if(!planId){ records=[]; setListVisible(true); return; }
  try{
    const snap=await getDocs(query(collection(db,"expenseRecords"),where("planId","==",planId)));
    records=snap.docs.map(d=>({id:d.id,...d.data()}));
    patchCards();
    patchTodoCounts();
  }catch(err){ console.warn("budget admin unified refresh failed",err); }
  finally{ ready=true; setListVisible(true); }
}
function schedule(ms=80){ clearTimeout(timer); timer=setTimeout(refresh,ms); }

async function verifyManagerAndRecord(id){
  const a=app(); if(!a) throw new Error("經費系統尚未初始化");
  const aAuth=getAuth(a), aDb=getFirestore(a), user=aAuth.currentUser;
  if(!user?.email) throw new Error("尚未登入");
  const email=user.email.toLowerCase();
  const [userSnap,recordSnap]=await Promise.all([
    getDoc(doc(aDb,"users",email)),
    getDoc(doc(aDb,"expenseRecords",id))
  ]);
  if(!userSnap.exists() || userSnap.data().enabled!==true || userSnap.data().role!=="manager") throw new Error("此功能僅限經費管理員使用");
  if(!recordSnap.exists()) throw new Error("找不到此筆使用紀錄");
  return {db:aDb,user,email,r:recordSnap.data()};
}

async function confirmWaiver(id){
  try{
    const {db,email,r}=await verifyManagerAndRecord(id);
    if(isApproved(r)) return alert("此筆已核銷並鎖定。");
    if(hasVoucher(r)) return alert("此筆已有核銷單據，不需要設定免附單據。");
    if(managerConfirmed(r)) return alert("此筆已由管理員確認免附單據。");
    const requested=r.voucherNotRequiredRequested===true;
    const msg=`確定將「${r.purpose||"此筆"}」確認為免附核銷單據？\n\n金額：${money(r.amount)}\n${requested?"老師已於送出時申請『此單無需附上單據』。":"老師未申請免附單據，請確認此筆確實不需要附件。"}\n\n這是管理員二次確認；確認後才可核對完成。`;
    if(!confirm(msg)) return;
    await updateDoc(doc(db,"expenseRecords",id),{
      voucherWaiverManagerConfirmed:true,
      voucherWaiverManagerConfirmedBy:email,
      voucherWaiverManagerConfirmedAt:serverTimestamp(),
      // Keep legacy fields synchronized only for old reports/rules; they are NOT used as manager-state truth anymore.
      voucherNotRequired:true,
      voucherRequirementWaived:true,
      amountConfirmed:true,
      amountConfirmedByManagerWaiver:true,
      updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(db,"auditLogs"),{
      type:"expense-voucher-waiver",targetId:id,planId:r.planId||"",action:"manager-confirm-waiver",
      actorEmail:email,createdAt:serverTimestamp()
    });
    location.reload();
  }catch(err){ alert("設定免附單據失敗："+(err?.message||err)); }
}

async function revokeWaiver(id){
  try{
    const {db,email,r}=await verifyManagerAndRecord(id);
    if(!managerConfirmed(r)) return;
    if(!confirm(`確定撤銷「${r.purpose||"此筆"}」的免附單據確認？\n\n撤銷後會恢復為需要核銷單據。`)) return;
    await updateDoc(doc(db,"expenseRecords",id),{
      voucherWaiverManagerConfirmed:false,
      voucherWaiverManagerConfirmedBy:"",
      voucherWaiverManagerConfirmedAt:null,
      voucherNotRequired:false,
      voucherRequirementWaived:false,
      amountConfirmed:false,
      amountConfirmedByManagerWaiver:false,
      updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(db,"auditLogs"),{
      type:"expense-voucher-waiver",targetId:id,planId:r.planId||"",action:"manager-revoke-waiver",
      actorEmail:email,createdAt:serverTimestamp()
    });
    location.reload();
  }catch(err){ alert("撤銷免附單據失敗："+(err?.message||err)); }
}

async function approveWaived(id){
  try{
    const {db,email,r}=await verifyManagerAndRecord(id);
    if(!managerConfirmed(r)) return false;
    if(!confirm(`確認「${r.purpose||"此筆"}」核對完成？\n${money(r.amount)}\n\n此筆已由管理員確認免附單據；完成後會鎖定。`)) return true;
    await updateDoc(doc(db,"expenseRecords",id),{
      reviewStatus:"approved",reviewed:true,locked:true,
      reviewedAt:serverTimestamp(),reviewedBy:email,
      updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(db,"auditLogs"),{
      type:"expense-review",targetId:id,planId:r.planId||"",action:"approve-manager-waived-voucher",
      actorEmail:email,createdAt:serverTimestamp()
    });
    location.reload();
    return true;
  }catch(err){ alert("核對失敗："+(err?.message||err)); return true; }
}

// SINGLE manager click controller. Loaded before teacher-side module; stopImmediatePropagation prevents duplicates.
document.addEventListener("click",async e=>{
  const waive=e.target.closest?.("[data-manager-waive-voucher]");
  if(waive){
    e.preventDefault(); e.stopImmediatePropagation();
    await confirmWaiver(waive.dataset.managerWaiveVoucher||"");
    return;
  }
  const revoke=e.target.closest?.("[data-manager-revoke-waiver]");
  if(revoke){
    e.preventDefault(); e.stopImmediatePropagation();
    await revokeWaiver(revoke.dataset.managerRevokeWaiver||"");
    return;
  }
  const approve=e.target.closest?.("[data-approve-record]");
  if(approve && manager){
    const id=approve.dataset.approveRecord||"";
    const r=records.find(x=>x.id===id);
    if(r && !hasVoucher(r)){
      e.preventDefault(); e.stopImmediatePropagation();
      if(managerConfirmed(r)) await approveWaived(id);
      else alert(r.voucherNotRequiredRequested===true
        ? "此筆老師已申請『此單無需附上單據』。請先按『免附單據』由管理員二次確認，再核對完成。"
        : "此筆缺少核銷單據。若確實不需附件，請先按『免附單據』確認。"
      );
      return;
    }
  }
},true);

async function init(){
  setListVisible(false);
  for(let i=0;i<120;i++){
    const a=app();
    if(a){ auth=getAuth(a); db=getFirestore(a); break; }
    await new Promise(r=>setTimeout(r,50));
  }
  if(!auth||!db){ ready=true; setListVisible(true); return; }
  onAuthStateChanged(auth,async user=>{
    if(!user?.email){ manager=false; ready=true; setListVisible(true); return; }
    try{
      const snap=await getDoc(doc(db,"users",user.email.toLowerCase()));
      manager=snap.exists() && snap.data().enabled===true && snap.data().role==="manager";
      ready=true;
      if(manager) schedule(50); else setListVisible(true);
    }catch(err){ console.warn(err); ready=true; setListVisible(true); }
  });
}

document.getElementById("planSelect")?.addEventListener("change",()=>schedule(80));
["filterIssue","filterReview","filterCategory","filterSemester"].forEach(id=>document.getElementById(id)?.addEventListener("input",()=>schedule(60)));
new MutationObserver(()=>{ if(manager) schedule(60); }).observe(document.getElementById("recordList")||document.body,{childList:true,subtree:true});
init();
