// Teacher own advance allocation view v1.7.6
// Managers keep the existing advance page. Regular users only see their own allocations
// and can perform one action: confirm receipt of the allocated amount.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, updateDoc, collection, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
const $=id=>document.getElementById(id);
const money=new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0});
let auth=null,db=null,currentEmail="",loading=false,receiptBusy=false;

function app(){return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null;}
function esc(v){return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m]));}
function planId(){return $("planSelect")?.value||"";}

function installUI(){
  if($("myAdvance"))return;
  const nav=document.querySelector("nav.tabs"),main=document.querySelector("#appView main");
  if(!nav||!main)return;
  const tab=document.createElement("button");
  tab.id="myAdvanceTab"; tab.className="tab"; tab.dataset.view="myAdvance"; tab.textContent="預支／動支";
  const trash=nav.querySelector('[data-view="trash"]');
  if(trash)nav.insertBefore(tab,trash);else nav.appendChild(tab);

  const section=document.createElement("section");
  section.id="myAdvance"; section.className="view";
  section.innerHTML=`
    <div class="section-head"><div><h2>我的預支／動支分配</h2><p>查看管理員分配給你的預支／動支金額。此頁只能確認是否已收到分配金額；實際核銷仍到「使用紀錄」辦理。</p></div></div>
    <div id="myAdvanceList" class="panel"><div class="empty">讀取中…</div></div>`;
  main.appendChild(section);

  tab.addEventListener("click",()=>{
    document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active-view",v.id==="myAdvance"));
    document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t===tab));
    loadOwn().catch(showError);
  });
}

async function loadOwn(force=false){
  if((loading&&!force)||!db||!currentEmail)return;
  const p=planId(),wrap=$("myAdvanceList");
  if(!wrap)return;
  if(!p){wrap.innerHTML='<div class="empty">請先選擇計畫。</div>';return;}
  loading=true;
  wrap.innerHTML='<div class="empty">正在讀取我的分配…</div>';
  try{
    const snap=await getDocs(query(collection(db,"advanceAllocations"),where("planId","==",p),where("ownerEmail","==",currentEmail)));
    const rows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);
    const batchIds=[...new Set(rows.map(x=>x.batchId).filter(Boolean))];
    const batchEntries=await Promise.all(batchIds.map(async id=>{
      try{const s=await getDoc(doc(db,"advanceBatches",id));return [id,s.exists()?s.data():null];}
      catch{return [id,null];}
    }));
    const batches=new Map(batchEntries);
    if(!rows.length){wrap.innerHTML='<div class="empty">目前沒有分配給你的預支／動支項目。</div>';return;}
    wrap.innerHTML=rows.sort((a,b)=>String(b.createdAt?.seconds||0).localeCompare(String(a.createdAt?.seconds||0))).map(a=>{
      const b=batches.get(a.batchId)||{};
      const confirmed=a.allocationReceivedConfirmed===true;
      return `<div style="display:grid;grid-template-columns:minmax(220px,1.8fr) 1fr 1fr auto;gap:14px;align-items:center;padding:16px 0;border-bottom:1px solid #eee">
        <div><strong>${esc(a.purpose||"未填用途")}</strong><small style="display:block;margin-top:5px;color:#777">${esc(b.semester||"未填學期")}｜${esc(b.categoryName||"預支／動支分配")}</small></div>
        <div><small style="display:block;color:#777">分配金額</small><strong>${money.format(Number(a.estimatedAmount||0))}</strong></div>
        <div><small style="display:block;color:#777">收款狀態</small><strong>${confirmed?'✅ 已確認收到':'尚未確認'}</strong></div>
        <div>${confirmed?'':`<button class="primary-btn" data-confirm-allocation-receipt="${a.id}">確認收到分配金額</button>`}</div>
      </div>`;
    }).join("");
    wrap.querySelectorAll("[data-confirm-allocation-receipt]").forEach(btn=>btn.addEventListener("click",()=>confirmReceipt(btn,rows.find(x=>x.id===btn.dataset.confirmAllocationReceipt))));
  }finally{loading=false;}
}

async function confirmReceipt(btn,item){
  if(receiptBusy||!item||item.allocationReceivedConfirmed===true)return;
  const amount=money.format(Number(item.estimatedAmount||0));
  if(!confirm(`確認你已收到這筆分配金額？\n\n${item.purpose||"此筆分配"}\n金額：${amount}\n\n確認後僅記錄「已收到」，不會進行核銷。`))return;
  receiptBusy=true;
  btn.disabled=true; const old=btn.textContent; btn.textContent="確認中…";
  try{
    await updateDoc(doc(db,"advanceAllocations",item.id),{
      allocationReceivedConfirmed:true,
      allocationReceivedAt:serverTimestamp(),
      allocationReceivedBy:currentEmail,
      updatedAt:serverTimestamp(),
      updatedBy:currentEmail
    });
    loading=false;
    await loadOwn(true);
  }catch(err){btn.disabled=false;btn.textContent=old;showError(err);}
  finally{receiptBusy=false;}
}

function showError(err){console.error(err);alert("預支／動支功能發生錯誤："+(err?.message||err));}

async function init(){
  for(let i=0;i<120;i++){
    const a=app();if(a){auth=getAuth(a);db=getFirestore(a);break;}
    await new Promise(r=>setTimeout(r,50));
  }
  if(!auth||!db)return;
  onAuthStateChanged(auth,async user=>{
    if(!user?.email)return;
    currentEmail=user.email.toLowerCase();
    try{
      const u=await getDoc(doc(db,"users",currentEmail));
      if(!u.exists()||u.data().enabled!==true||u.data().role==="manager")return;
      installUI();
      $("planSelect")?.addEventListener("change",()=>{if($("myAdvance")?.classList.contains("active-view"))loadOwn().catch(showError);});
    }catch(err){showError(err);}
  });
}
init();
