// Budget manager usability patch v1.6.9
// 1) Restore manager "免附單據" action reliably on pending cards with no voucher.
// 2) Keep flexible plan balance visible after excluding unused fixed 輔導人員費.
// 3) Avoid a whole-page MutationObserver; only watch the two relevant containers.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, updateDoc, addDoc, collection, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID = "must-resource-budget-system";
const money = new Intl.NumberFormat("zh-TW", { style:"currency", currency:"TWD", maximumFractionDigits:0 });

let auth=null, db=null, currentUser=null, manager=false;
let cachedFlexible=null;
let lastPlanId="";
let summaryObserver=null, recordObserver=null;
let patchTimer=null;

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
      voucherNotRequired:true,voucherRequirementWaived:true,
      voucherRequirementWaivedBy:email,voucherRequirementWaivedAt:serverTimestamp(),
      amountConfirmed:true,amountConfirmedByManagerWaiver:true,
      updatedAt:serverTimestamp(),updatedBy:email
    });
    try{
      await addDoc(collection(db,"auditLogs"),{type:"expense-voucher-waiver",targetId:id,planId:document.getElementById("planSelect")?.value||"",action:"waive-voucher",actorEmail:email,createdAt:serverTimestamp()});
    }catch(err){ console.warn("waiver audit failed",err); }
    location.reload();
  }catch(err){ alert("設定免附單據失敗："+(err?.message||String(err))); }
}

function patchWaiverButtons(){
  if(!manager) return;
  document.querySelectorAll("#recordList .record-card").forEach(card=>{
    const approve=card.querySelector("[data-approve-record]");
    if(!approve || !isMissingVoucherCard(card)) return;
    const actions=card.querySelector(".record-actions");
    if(!actions || actions.querySelector("[data-v136-waive],[data-manager-waive-voucher]")) return;
    const id=recordIdFromCard(card); if(!id) return;
    const btn=document.createElement("button");
    btn.className="link-btn"; btn.dataset.v136Waive=id; btn.textContent="免附單據";
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
    const strong=card.querySelector("strong"); if(!strong) return;
    const main=(strong.textContent||"").split("（")[0].trim();
    if(!main) return;
    const wanted=`${main}（${money.format(cachedFlexible)}）`;
    if(strong.textContent!==wanted) strong.textContent=wanted;
    strong.title="括號內＝扣除輔導人員費尚未使用固定額度後，真正可彈性運用的金額";
  });
}

function schedulePatch(ms=20){
  clearTimeout(patchTimer);
  patchTimer=setTimeout(()=>{ patchWaiverButtons(); patchFlexibleBalance(); },ms);
}

async function refreshFlexibleBalance(){
  if(!manager || !db || !currentUser) return;
  const planId=document.getElementById("planSelect")?.value||"";
  if(!planId){ cachedFlexible=null; return; }
  lastPlanId=planId;
  try{
    const [planSnap,catSnap,recSnap]=await Promise.all([
      getDoc(doc(db,"budgetPlans",planId)),
      getDocs(query(collection(db,"budgetCategories"),where("planId","==",planId))),
      getDocs(query(collection(db,"expenseRecords"),where("planId","==",planId)))
    ]);
    if(planId!==lastPlanId || !planSnap.exists()) return;
    const cats=catSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);
    const recs=recSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);
    const total=Number(planSnap.data().totalBudget||0);
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
    [40,120,300,700].forEach(ms=>setTimeout(patchFlexibleBalance,ms));
  }catch(err){ console.warn("flexible balance refresh failed",err); }
}

function installTargetObservers(){
  const summary=document.getElementById("summaryCards");
  if(summary && !summaryObserver){
    summaryObserver=new MutationObserver(()=>schedulePatch(0));
    summaryObserver.observe(summary,{childList:true,subtree:true,characterData:true});
  }
  const records=document.getElementById("recordList");
  if(records && !recordObserver){
    recordObserver=new MutationObserver(()=>schedulePatch(20));
    recordObserver.observe(records,{childList:true,subtree:true});
  }
}

async function boot(){
  if(!await initFirebase()) return;
  installTargetObservers();
  onAuthStateChanged(auth,async user=>{
    currentUser=user; cachedFlexible=null;
    if(!user) return;
    try{
      const snap=await getDoc(doc(db,"users",user.email.toLowerCase()));
      manager=snap.exists() && snap.data().enabled===true && snap.data().role==="manager";
    }catch{ manager=false; }
    installTargetObservers();
    schedulePatch(30);
    if(manager) setTimeout(refreshFlexibleBalance,120);
  });

  document.getElementById("planSelect")?.addEventListener("change",()=>{
    cachedFlexible=null;
    setTimeout(refreshFlexibleBalance,80);
  });
  document.querySelector('[data-view="dashboard"]')?.addEventListener("click",()=>{
    schedulePatch(10);
    if(cachedFlexible==null) setTimeout(refreshFlexibleBalance,60);
  });
  [100,300,700,1400].forEach(ms=>setTimeout(()=>{ installTargetObservers(); schedulePatch(0); },ms));
}

boot();
