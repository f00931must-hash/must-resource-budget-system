// Budget advance manager-only delete controls v1.5.6
// 1) Batch deletion is manager-only and blocked while active allocations remain.
// 2) Existing-estimate allocations are unlinked without deleting the original usage record.
// 3) Orphan allocations remain removable even if their source usage record was deleted/recycled.
// 4) Avoid document-wide attribute observers and full-page reloads after delete actions.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, collection, query, where, writeBatch, updateDoc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
let auth=null,db=null,currentEmail="",manager=false;
let timer=null,listObserver=null,selectObserver=null;
let orphanResolveBusy=false;

function app(){return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null;}
function currentPlanId(){return document.getElementById("planSelect")?.value||"";}
function currentBatchId(){return document.getElementById("advanceBatchSelect")?.value||"";}
function approved(r){return r?.reviewStatus==="approved"||r?.reviewed===true||r?.locked===true;}

async function verifyManager(){
  const user=auth?.currentUser;
  if(!user?.email)throw new Error("尚未登入");
  const email=user.email.toLowerCase();
  const snap=await getDoc(doc(db,"users",email));
  if(!snap.exists()||snap.data().enabled!==true||snap.data().role!=="manager")throw new Error("此功能僅限經費管理員使用");
  return email;
}

function requestAdvanceRefresh(){
  window.dispatchEvent(new CustomEvent("budget-advance-refresh"));
}

function ensureBatchDeleteButton(){
  if(!manager)return;
  const select=document.getElementById("advanceBatchSelect");
  const edit=document.getElementById("editAdvanceBatchBtn");
  if(!select||!edit)return;
  let btn=document.getElementById("deleteAdvanceBatchBtn");
  if(!btn){
    btn=document.createElement("button");
    btn.id="deleteAdvanceBatchBtn";
    btn.className="ghost-btn";
    btn.style.color="#b42318";
    btn.style.borderColor="#efb2b2";
    btn.textContent="刪除批次";
    edit.insertAdjacentElement("afterend",btn);
    btn.addEventListener("click",deleteBatch);
  }
  const id=String(select.value||"").trim();
  btn.disabled=!id;
  btn.setAttribute("aria-disabled",id?"false":"true");
}

function addDeleteButton(parent,id,label="解除分配"){
  if(!parent||!id||parent.querySelector(`[data-delete-advance-allocation="${CSS.escape(id)}"]`))return;
  const btn=document.createElement("button");
  btn.className="link-btn danger";
  btn.dataset.deleteAdvanceAllocation=id;
  btn.textContent=label;
  btn.style.marginLeft="6px";
  parent.appendChild(btn);
}

function ensureNormalAllocationDeleteButtons(){
  if(!manager)return;
  document.querySelectorAll("#advanceAllocationList [data-edit-advance-allocation]").forEach(edit=>{
    const id=edit.dataset.editAdvanceAllocation||"";
    addDeleteButton(edit.parentElement,id,"解除分配");
  });
}

function normalizeMoneyText(v){
  return Number(v||0).toLocaleString("zh-TW");
}

async function ensureOrphanDeleteButtons(){
  if(!manager||orphanResolveBusy)return;
  const list=document.getElementById("advanceAllocationList");
  const bid=currentBatchId();
  if(!list||!bid)return;
  const orphanRows=[...list.querySelectorAll(".advance-grid")].filter(row=>
    row.textContent.includes("找不到使用紀錄") && !row.querySelector("[data-delete-advance-allocation]")
  );
  if(!orphanRows.length)return;

  orphanResolveBusy=true;
  try{
    const snap=await getDocs(query(collection(db,"advanceAllocations"),where("batchId","==",bid)));
    const active=snap.docs.map(d=>({id:d.id,...d.data()})).filter(a=>a.deleted!==true);
    const used=new Set([...list.querySelectorAll("[data-delete-advance-allocation]")].map(b=>b.dataset.deleteAdvanceAllocation));

    for(const row of orphanRows){
      const text=row.textContent.replace(/\s+/g," ");
      let match=active.find(a=>{
        if(used.has(a.id))return false;
        const purpose=String(a.purpose||"").trim();
        const owner=String(a.ownerName||a.ownerEmail||"").trim();
        const amount=normalizeMoneyText(a.estimatedAmount);
        return (!purpose||text.includes(purpose)) && (!owner||text.includes(owner)) && text.includes(amount);
      });
      if(!match)match=active.find(a=>!used.has(a.id));
      if(!match)continue;
      used.add(match.id);
      const actionCell=row.lastElementChild;
      addDeleteButton(actionCell,match.id,"解除分配");
    }
  }catch(err){
    console.warn("resolve orphan advance allocations failed",err);
  }finally{
    orphanResolveBusy=false;
  }
}

function patch(){
  ensureBatchDeleteButton();
  ensureNormalAllocationDeleteButtons();
  ensureOrphanDeleteButtons();
  attachLightObservers();
}
function schedule(ms=60){clearTimeout(timer);timer=setTimeout(patch,ms);}

function attachLightObservers(){
  const list=document.getElementById("advanceAllocationList");
  if(list&&!listObserver){
    listObserver=new MutationObserver(()=>schedule(40));
    listObserver.observe(list,{childList:true,subtree:true});
  }
  const select=document.getElementById("advanceBatchSelect");
  if(select&&!selectObserver){
    selectObserver=new MutationObserver(()=>schedule(40));
    selectObserver.observe(select,{childList:true});
  }
}

async function deleteBatch(){
  try{
    const email=await verifyManager();
    const id=currentBatchId(); if(!id)return alert("請先選擇要刪除的預支／動支批次。");
    const b=await getDoc(doc(db,"advanceBatches",id));
    if(!b.exists())return alert("找不到此預支／動支批次。");
    const aSnap=await getDocs(query(collection(db,"advanceAllocations"),where("batchId","==",id)));
    const active=aSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);
    if(active.length){
      alert(`此批次仍有 ${active.length} 筆活動分配，不能直接刪除。\n\n請先解除活動分配；已進入實際核銷的資料需先完成相關流程。`);
      return;
    }
    const title=b.data().title||"此預支批次";
    if(!confirm(`確定刪除「${title}」嗎？\n\n此操作僅限管理員。`))return;
    await updateDoc(doc(db,"advanceBatches",id),{
      deleted:true,deletedAt:serverTimestamp(),deletedBy:email,updatedAt:serverTimestamp(),updatedBy:email
    });
    await addDoc(collection(db,"auditLogs"),{
      type:"advance-batch",targetId:id,planId:b.data().planId||currentPlanId(),action:"delete",actorEmail:email,createdAt:serverTimestamp()
    });
    requestAdvanceRefresh();
  }catch(err){alert("刪除預支批次失敗："+(err?.message||err));}
}

async function deleteAllocation(id){
  try{
    const email=await verifyManager();
    const aSnap=await getDoc(doc(db,"advanceAllocations",id));
    if(!aSnap.exists())return alert("找不到此活動分配。");
    const a={id,...aSnap.data()};
    if(a.deleted===true)return;

    let rSnap=null,r=null;
    if(a.expenseRecordId){
      rSnap=await getDoc(doc(db,"expenseRecords",a.expenseRecordId));
      if(rSnap.exists())r=rSnap.data();
    }

    // If the source usage record was already deleted/recycled, this allocation is an orphan.
    // Manager must still be able to remove it so the reserved amount returns immediately.
    const orphan=!r || r.deleted===true;
    if(orphan){
      if(!confirm(`這筆分配對應的預估使用紀錄已被刪除或不存在。\n\n確定解除「${a.purpose||"此活動"}」的預支分配嗎？\n預估金額：${Number(a.estimatedAmount||0).toLocaleString("zh-TW")} 元\n\n解除後，此金額會回到可重新分配額度。`))return;
      await updateDoc(doc(db,"advanceAllocations",id),{
        deleted:true,deletedAt:serverTimestamp(),deletedBy:email,updatedAt:serverTimestamp(),updatedBy:email,
        orphanSourceRemoved:true
      });
      await addDoc(collection(db,"auditLogs"),{
        type:"advance-allocation",targetId:id,expenseRecordId:a.expenseRecordId||"",planId:a.planId||currentPlanId(),
        action:"unlink-orphan-allocation",actorEmail:email,createdAt:serverTimestamp()
      });
      requestAdvanceRefresh();
      return;
    }

    if(r.estimated!==true||approved(r)){
      alert("此活動已轉為實際核銷或已鎖定，不能從預支／動支頁直接解除。");
      return;
    }

    const legacyCreatedByAdvance = r.source==="advance-allocation" && a.recordOrigin!=="existing-estimate";
    const consequence = legacyCreatedByAdvance
      ? "對應的舊版測試預估使用紀錄也會一併移除。"
      : "只會解除預支分配；原本的預估使用紀錄會保留。";
    if(!confirm(`確定解除「${a.purpose||"此活動"}」的預支分配嗎？\n\n負責老師：${a.ownerName||a.ownerEmail||"—"}\n預估金額：${Number(a.estimatedAmount||0).toLocaleString("zh-TW")} 元\n\n${consequence}`))return;

    const wb=writeBatch(db);
    wb.update(doc(db,"advanceAllocations",id),{
      deleted:true,deletedAt:serverTimestamp(),deletedBy:email,updatedAt:serverTimestamp(),updatedBy:email
    });

    if(legacyCreatedByAdvance){
      wb.update(doc(db,"expenseRecords",a.expenseRecordId),{
        deleted:true,deletedAt:serverTimestamp(),deletedBy:email,updatedAt:serverTimestamp(),updatedBy:email
      });
    }else{
      wb.update(doc(db,"expenseRecords",a.expenseRecordId),{
        advanceBatchId:"",advanceAllocationId:"",advanceLinked:false,
        updatedAt:serverTimestamp(),updatedBy:email
      });
    }

    wb.set(doc(collection(db,"auditLogs")),{
      type:"advance-allocation",targetId:id,expenseRecordId:a.expenseRecordId,planId:a.planId||currentPlanId(),
      action:legacyCreatedByAdvance?"delete-estimated-allocation":"unlink-existing-estimate",
      actorEmail:email,createdAt:serverTimestamp()
    });
    await wb.commit();
    requestAdvanceRefresh();
  }catch(err){alert("解除活動分配失敗："+(err?.message||err));}
}

window.addEventListener("click",e=>{
  const btn=e.target.closest?.("[data-delete-advance-allocation]");
  if(!btn||!manager)return;
  e.preventDefault();e.stopImmediatePropagation();
  deleteAllocation(btn.dataset.deleteAdvanceAllocation||"");
},true);

document.addEventListener("input",e=>{if(e.target?.id==="advanceBatchSelect")schedule(0);},true);
document.addEventListener("change",e=>{if(e.target?.id==="advanceBatchSelect")schedule(0);},true);
document.addEventListener("click",e=>{
  if(e.target?.closest?.("#advanceTab,#newAdvanceBatchBtn,#editAdvanceBatchBtn"))schedule(80);
},true);

async function init(){
  for(let i=0;i<120;i++){
    const a=app(); if(a){auth=getAuth(a);db=getFirestore(a);break;}
    await new Promise(r=>setTimeout(r,50));
  }
  if(!auth||!db)return;
  onAuthStateChanged(auth,async user=>{
    manager=false;
    if(!user?.email)return;
    try{
      const u=await getDoc(doc(db,"users",user.email.toLowerCase()));
      manager=u.exists()&&u.data().enabled===true&&u.data().role==="manager";
      currentEmail=user.email.toLowerCase();
      if(manager){[120,350,700].forEach(ms=>setTimeout(patch,ms));}
    }catch(err){console.warn("advance delete init failed",err);}
  });
}

// Temporary observer only until the dynamically-created advance UI exists.
const bootstrapObserver=new MutationObserver(()=>{
  if(document.getElementById("advanceAllocationList")){
    attachLightObservers();
    schedule(0);
    bootstrapObserver.disconnect();
  }
});
bootstrapObserver.observe(document.body,{childList:true,subtree:true});
init();
