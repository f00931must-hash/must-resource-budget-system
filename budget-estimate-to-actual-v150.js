// Advance allocation: teacher-facing estimated -> actual reimbursement helper v1.5.6
// Patches linked estimated records with a "轉實際核銷" action.
// Performance: DOM mutations only repatch cached data; Firestore is refreshed only on meaningful events.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
let auth=null,db=null,email="",rows=[];
let timer=null;
function app(){return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null;}
function money(n){return new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0}).format(Number(n||0));}
function planId(){return document.getElementById("planSelect")?.value||"";}
function recordId(card){
  const el=card.querySelector("[data-edit-record],[data-delete-record],[data-approve-record],[data-unlock-record]");
  return el?.dataset.editRecord||el?.dataset.deleteRecord||el?.dataset.approveRecord||el?.dataset.unlockRecord||"";
}
function linked(r){return r?.source==="advance-allocation"||!!r?.advanceAllocationId||r?.advanceLinked===true;}
function approved(r){return r?.reviewStatus==="approved"||r?.reviewed===true||r?.locked===true;}

function patchCards(){
  document.querySelectorAll("#recordList .record-card").forEach(card=>{
    card.querySelectorAll("[data-convert-advance-record]").forEach(x=>x.remove());
    const id=recordId(card); if(!id)return;
    const r=rows.find(x=>x.id===id);
    if(!r||!linked(r)||r.estimated!==true||approved(r)||String(r.ownerEmail||"").toLowerCase()!==email)return;
    const actions=card.querySelector(".record-actions"); if(!actions)return;
    const b=document.createElement("button");
    b.className="link-btn approve";
    b.dataset.convertAdvanceRecord=id;
    b.textContent="轉實際核銷";
    b.title="保留原預估金額，改填實際支出並上傳核銷單據";
    actions.insertBefore(b,actions.firstChild);
  });
}

function addDialogHint(r){
  const form=document.getElementById("recordForm"); if(!form)return;
  form.querySelectorAll("[data-advance-convert-hint]").forEach(x=>x.remove());
  const hint=document.createElement("div");
  hint.dataset.advanceConvertHint="1";
  hint.className="panel";
  hint.style.cssText="margin:0 0 12px;padding:12px;background:#f7f4ff;border:1px solid #ddd3ff";
  hint.innerHTML=`<strong>此筆已連結預支／動支</strong><div style="margin-top:4px">原預估：${money(r.originalEstimatedAmount??r.amount)}</div><small>請將金額改為實際支出，並完成核銷單據上傳與金額確認。原預估金額會保留供差額計算。</small>`;
  const title=form.querySelector(".dialog-head");
  title?.insertAdjacentElement("afterend",hint);
}

function beginConvert(id){
  const r=rows.find(x=>x.id===id); if(!r)return;
  const edit=document.querySelector(`[data-edit-record="${CSS.escape(id)}"]`);
  if(!edit)return alert("找不到這筆紀錄的編輯按鈕，請重新整理後再試。");
  edit.click();
  setTimeout(()=>{
    const dialog=document.getElementById("recordDialog");
    if(!dialog?.open)return;
    const estimated=document.getElementById("recordEstimated");
    if(estimated){estimated.checked=false;estimated.dispatchEvent(new Event("change",{bubbles:true}));}
    const category=document.getElementById("recordCategory");
    const semester=document.getElementById("recordSemester");
    if(category){category.disabled=true;category.dataset.advanceLocked="1";}
    if(semester){semester.readOnly=true;semester.dataset.advanceLocked="1";}
    const title=document.getElementById("recordDialogTitle");
    if(title)title.textContent="轉為實際核銷";
    addDialogHint(r);
  },80);
}

function cleanupDialog(){
  const category=document.getElementById("recordCategory");
  const semester=document.getElementById("recordSemester");
  if(category?.dataset.advanceLocked){category.disabled=false;delete category.dataset.advanceLocked;}
  if(semester?.dataset.advanceLocked){semester.readOnly=false;delete semester.dataset.advanceLocked;}
  document.querySelectorAll("[data-advance-convert-hint]").forEach(x=>x.remove());
}

async function refresh(){
  if(!db||!email)return;
  const p=planId(); if(!p){rows=[];patchCards();return;}
  try{
    const snap=await getDocs(query(collection(db,"expenseRecords"),where("planId","==",p)));
    rows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.deleted!==true);
    patchCards();
  }catch(e){console.warn("advance actual helper refresh failed",e);}
}
function schedule(ms=120){clearTimeout(timer);timer=setTimeout(refresh,ms);}

document.addEventListener("click",e=>{
  const b=e.target.closest?.("[data-convert-advance-record]");
  if(!b)return;
  e.preventDefault();e.stopImmediatePropagation();
  beginConvert(b.dataset.convertAdvanceRecord||"");
},true);

const recordDialog=document.getElementById("recordDialog");
recordDialog?.addEventListener("close",()=>{cleanupDialog();schedule(160);});
document.getElementById("planSelect")?.addEventListener("change",()=>schedule(180));

// Important: rendering record cards should not trigger another Firestore query.
// Reuse cached rows and only re-apply the action buttons.
const recordList=document.getElementById("recordList");
if(recordList){
  new MutationObserver(()=>patchCards()).observe(recordList,{childList:true,subtree:true});
}

window.addEventListener("budget-advance-refresh",()=>schedule(160));

async function init(){
  for(let i=0;i<120;i++){
    const a=app();if(a){auth=getAuth(a);db=getFirestore(a);break;}
    await new Promise(r=>setTimeout(r,50));
  }
  if(!auth||!db)return;
  onAuthStateChanged(auth,user=>{
    email=String(user?.email||"").toLowerCase();
    if(email) schedule(180);
  });
}
init();
