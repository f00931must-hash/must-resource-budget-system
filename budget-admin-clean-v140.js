// Budget admin clean patch v1.4.0
// Teacher no-voucher request and manager waiver confirmation are completely separate.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, updateDoc, addDoc, collection, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
let auth=null, db=null, manager=false, records=[];
let timer=null;

function app(){ return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null; }
function money(n){ return new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0}).format(Number(n||0)); }
function recordId(card){
  const el=card.querySelector("[data-edit-record],[data-delete-record],[data-approve-record],[data-unlock-record],[data-manager-waive-voucher]");
  if(!el) return "";
  return el.dataset.editRecord||el.dataset.deleteRecord||el.dataset.approveRecord||el.dataset.unlockRecord||el.dataset.managerWaiveVoucher||"";
}
function isApproved(r){ return r?.reviewStatus==="approved" || r?.reviewed===true || r?.locked===true; }
function managerConfirmed(r){ return r?.voucherWaiverManagerConfirmed===true; }
function hasVoucher(r){ return !!(r?.voucherUrl||r?.folderUrl); }

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

    if(!voucher && !confirmed){
      removeBadge(status,"免附單據");
      ensureBadge(status,"缺單據");
      if(r.amountConfirmed!==true && r.amountManuallyConfirmed!==true) ensureBadge(status,"未確認金額");
      if(!actions.querySelector("[data-manager-waive-voucher]")){
        const approve=actions.querySelector("[data-approve-record]");
        const b=document.createElement("button");
        b.className="link-btn";
        b.dataset.managerWaiveVoucher=id;
        b.textContent="免附單據";
        b.title="管理員確認此筆確實不需要核銷附件";
        if(approve) approve.insertAdjacentElement("beforebegin",b); else actions.appendChild(b);
      }
    }

    if(confirmed){
      removeBadge(status,"缺單據");
      removeBadge(status,"未確認金額");
      ensureBadge(status,"免附單據","done");
      actions.querySelectorAll("[data-manager-waive-voucher],[data-waive-voucher]").forEach(x=>x.remove());
      if(!actions.querySelector("[data-require-voucher-clean]")){
        const b=document.createElement("button");
        b.className="link-btn";
        b.dataset.requireVoucherClean=id;
        b.textContent="恢復需單據";
        actions.appendChild(b);
      }
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

function ensurePlanPurgeButton(){
  if(!manager || document.getElementById("purgePlanAttachmentsBtn")) return;
  const after=document.getElementById("deletePlanBtn"); if(!after) return;
  const b=document.createElement("button");
  b.id="purgePlanAttachmentsBtn";
  b.className="ghost-btn manager-only";
  b.style.color="#9a3412";
  b.style.borderColor="#fdba74";
  b.textContent="清除此計畫附件";
  after.insertAdjacentElement("afterend",b);
}

async function refresh(){
  if(!manager || !db) return;
  const planId=document.getElementById("planSelect")?.value||"";
  if(!planId){ records=[]; return; }
  try{
    const snap=await getDocs(query(collection(db,"expenseRecords"),where("planId","==",planId)));
    records=snap.docs.map(d=>({id:d.id,...d.data()}));
    patchCards();
    patchTodoCounts();
    ensurePlanPurgeButton();
  }catch(err){ console.warn("budget admin clean refresh failed",err); }
}
function schedule(ms=100){ clearTimeout(timer); timer=setTimeout(refresh,ms); }

async function approveConfirmed(id){
  const r=records.find(x=>x.id===id); if(!r || !managerConfirmed(r)) return false;
  const user=auth.currentUser; if(!user?.email) return false;
  if(!confirm(`確認「${r.purpose||"此筆"}」核對完成？\n${money(r.amount)}\n\n此筆已由管理員確認免附單據，完成後會鎖定。`)) return true;
  const email=user.email.toLowerCase();
  try{
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
  }catch(err){ alert("核對失敗："+(err?.message||err)); }
  return true;
}

async function restoreRequired(id){
  const r=records.find(x=>x.id===id); if(!r) return;
  if(!confirm(`確定將「${r.purpose||"此筆"}」恢復為需要核銷單據？`)) return;
  const email=(auth.currentUser?.email||"").toLowerCase();
  try{
    await updateDoc(doc(db,"expenseRecords",id),{
      voucherWaiverManagerConfirmed:false,
      voucherNotRequired:false,
      voucherRequirementWaived:false,
      amountConfirmed:false,
      amountConfirmedByManagerWaiver:false,
      updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(db,"auditLogs"),{
      type:"expense-voucher-waiver",targetId:id,planId:r.planId||"",action:"restore-voucher-required",
      actorEmail:email,createdAt:serverTimestamp()
    });
    location.reload();
  }catch(err){ alert("恢復單據要求失敗："+(err?.message||err)); }
}

document.addEventListener("click",async e=>{
  const approve=e.target.closest?.("[data-approve-record]");
  if(approve && manager){
    const id=approve.dataset.approveRecord||"";
    const r=records.find(x=>x.id===id);
    if(r && !hasVoucher(r)){
      e.preventDefault(); e.stopImmediatePropagation();
      if(managerConfirmed(r)){ await approveConfirmed(id); }
      else alert(r.voucherNotRequiredRequested===true
        ? "此筆老師已申報『此單無需附上單據』。請先按『免附單據』由管理員二次確認，再核對完成。"
        : "此筆缺少核銷單據。若確實不需附件，請先按『免附單據』確認。"
      );
      return;
    }
  }
  const restore=e.target.closest?.("[data-require-voucher-clean]");
  if(restore && manager){
    e.preventDefault(); e.stopImmediatePropagation();
    restoreRequired(restore.dataset.requireVoucherClean||"");
  }
},true);

document.getElementById("planSelect")?.addEventListener("change",()=>schedule(120));
["filterIssue","filterReview","filterCategory","filterSemester"].forEach(id=>document.getElementById(id)?.addEventListener("input",()=>schedule(80)));
new MutationObserver(()=>schedule(100)).observe(document.getElementById("recordList")||document.body,{childList:true,subtree:true});

async function init(){
  for(let i=0;i<120;i++){
    const a=app();
    if(a){ auth=getAuth(a); db=getFirestore(a); break; }
    await new Promise(r=>setTimeout(r,50));
  }
  if(!auth||!db) return;
  onAuthStateChanged(auth,async user=>{
    if(!user?.email){ manager=false; return; }
    try{
      const snap=await getDoc(doc(db,"users",user.email.toLowerCase()));
      manager=snap.exists() && snap.data().enabled===true && snap.data().role==="manager";
      if(manager) schedule(120);
    }catch(err){ console.warn(err); }
  });
}
init();
