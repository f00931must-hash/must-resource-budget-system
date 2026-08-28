// Budget manager usability patch v1.3.6
// 1) Restore manager "免附單據" action reliably on pending cards with no voucher.
// 2) Show truly flexible plan balance in parentheses after excluding unused fixed 輔導人員費.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, updateDoc, addDoc, collection, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID = "must-resource-budget-system";
const money = new Intl.NumberFormat("zh-TW", { style:"currency", currency:"TWD", maximumFractionDigits:0 });

let auth=null, db=null, currentUser=null, manager=false;
let cachedFlexible=null;
let refreshTimer=null;
let lastPlanId="";

function budgetApp(){ return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function initFirebase(){
  for(let i=0;i<120;i++){
    const app=budgetApp();
    if(app){ auth=getAuth(app); db=getFirestore(app); return true; }
    await sleep(50);
  }
  return false;
}

function recordIdFromCard(card){
  const el=card.querySelector("[data-edit-record],[data-delete-record],[data-approve-record],[data-unlock-record]");
  if(!el) return "";
  return el.dataset.editRecord||el.dataset.deleteRecord||el.dataset.approveRecord||el.dataset.unlockRecord||"";
}

function isMissingVoucherCard(card){
  return [...card.querySelectorAll(".danger-badge")].some(b=>b.textContent.trim()==="缺單據");
}

async function waiveVoucher(id){
  if(!manager || !currentUser || !id) return;
  if(!confirm("確認此筆經費不需要附核銷單據？\n\n設定後會視為單據與金額確認已完成，管理員即可按『核對完成』。")) return;
  const email=(currentUser.email||"").toLowerCase();
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
    try{
      await addDoc(collection(db,"auditLogs"),{
        type:"expense-voucher-waiver",
        targetId:id,
        planId:document.getElementById("planSelect")?.value||"",
        action:"waive-voucher",
        actorEmail:email,
        createdAt:serverTimestamp()
      });
    }catch(err){ console.warn("waiver audit failed",err); }
    location.reload();
  }catch(err){
    alert("設定免附單據失敗："+(err?.message||String(err)));
  }
}

function patchWaiverButtons(){
  if(!manager) return;
  document.querySelectorAll("#recordList .record-card").forEach(card=>{
    // A visible approve button is authoritative evidence that this is a manager pending card.
    const approve=card.querySelector("[data-approve-record]");
    if(!approve || !isMissingVoucherCard(card)) return;
    const actions=card.querySelector(".record-actions");
    if(!actions || actions.querySelector("[data-v136-waive]")) return;
    const id=recordIdFromCard(card);
    if(!id) return;
    const btn=document.createElement("button");
    btn.className="link-btn";
    btn.dataset.v136Waive=id;
    btn.textContent="免附單據";
    btn.title="適用於本來就不需要核銷附件的經費";
    btn.addEventListener("click",()=>waiveVoucher(id));
    actions.insertBefore(btn,approve);
  });
}

function patchFlexibleBalance(){
  if(cachedFlexible==null) return;
  document.querySelectorAll("#summaryCards .summary-card").forEach(card=>{
    const label=card.querySelector("span")?.textContent?.trim()||"";
    if(label!=="計畫剩餘額度") return;
    const strong=card.querySelector("strong");
    if(!strong) return;
    const main=strong.dataset.v136Main||strong.textContent.split("（")[0].trim();
    strong.dataset.v136Main=main;
    const wanted=`${main}（${money.format(cachedFlexible)}）`;
    if(strong.textContent!==wanted) strong.textContent=wanted;
    strong.title="括號內＝扣除輔導人員費尚未使用固定額度後，真正可彈性運用的金額";
  });
}

async function refreshFlexibleBalance(){
  if(!manager || !db || !currentUser) return;
  const planId=document.getElementById("planSelect")?.value||"";
  if(!planId) return;
  lastPlanId=planId;
  try{
    const [planSnap,catSnap,recSnap]=await Promise.all([
      getDoc(doc(db,"budgetPlans",planId)),
      getDocs(query(collection(db,"budgetCategories"),where("planId","==",planId))),
      getDocs(query(collection(db,"expenseRecords"),where("planId","==",planId)))
    ]);
    if(planId!==lastPlanId || !planSnap.exists()) return;
    const plan=planSnap.data();
    const cats=catSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);
    const recs=recSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);
    const total=Number(plan.totalBudget||0);
    const allUsed=recs.reduce((s,r)=>s+Number(r.amount||0),0);
    const planRemaining=total-allUsed;

    const personnel=cats.find(c=>String(c.name||"").trim()==="輔導人員費");
    let unusedFixed=0;
    if(personnel){
      const personnelUsed=recs.filter(r=>r.categoryId===personnel.id).reduce((s,r)=>s+Number(r.amount||0),0);
      unusedFixed=Math.max(Number(personnel.budget||0)-personnelUsed,0);
    }
    cachedFlexible=planRemaining-unusedFixed;
    patchFlexibleBalance();
  }catch(err){
    console.warn("v1.3.6 flexible balance refresh failed",err);
  }
}

function scheduleRefresh(delay=160){
  clearTimeout(refreshTimer);
  refreshTimer=setTimeout(()=>{
    patchWaiverButtons();
    patchFlexibleBalance();
  },delay);
}

async function boot(){
  if(!await initFirebase()) return;
  onAuthStateChanged(auth,async user=>{
    currentUser=user;
    cachedFlexible=null;
    if(!user) return;
    try{
      const snap=await getDoc(doc(db,"users",user.email.toLowerCase()));
      manager=snap.exists() && snap.data().enabled===true && snap.data().role==="manager";
    }catch{ manager=false; }
    scheduleRefresh(250);
    if(manager) setTimeout(refreshFlexibleBalance,350);
  });

  document.getElementById("planSelect")?.addEventListener("change",()=>{
    cachedFlexible=null;
    setTimeout(refreshFlexibleBalance,250);
  });

  const observer=new MutationObserver(()=>scheduleRefresh(80));
  observer.observe(document.body,{childList:true,subtree:true});
  [300,700,1400].forEach(ms=>setTimeout(()=>{ patchWaiverButtons(); patchFlexibleBalance(); },ms));
}

boot();
