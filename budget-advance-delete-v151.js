// Budget advance manager-only delete controls v1.5.2
// Safe deletion rules:
// 1) Advance batch can be deleted only when it has no active allocations.
// 2) Allocation can be deleted only while its linked expense record is still estimated and unlocked.
// 3) Only manager users can see/use these controls; Firestore rules also enforce manager-only access.
// 4) Dynamic batch selector is created after module load, so selection state is observed through delegated events + mutations.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, collection, query, where, writeBatch, updateDoc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
let auth=null,db=null,currentEmail="",manager=false;
let timer=null;

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
  // Important: the selector is populated dynamically after this module loads.
  // Recalculate disabled state every patch instead of relying on an early event binding.
  const id=String(select.value||"").trim();
  btn.disabled=!id;
  btn.setAttribute("aria-disabled",id?"false":"true");
}

function ensureAllocationDeleteButtons(){
  if(!manager)return;
  document.querySelectorAll("#advanceAllocationList [data-edit-advance-allocation]").forEach(edit=>{
    const id=edit.dataset.editAdvanceAllocation||"";
    if(!id)return;
    const parent=edit.parentElement;
    if(!parent||parent.querySelector(`[data-delete-advance-allocation="${id}"]`))return;
    const btn=document.createElement("button");
    btn.className="link-btn danger";
    btn.dataset.deleteAdvanceAllocation=id;
    btn.textContent="刪除";
    btn.style.marginLeft="6px";
    parent.appendChild(btn);
  });
}

function patch(){
  ensureBatchDeleteButton();
  ensureAllocationDeleteButtons();
}
function schedule(ms=60){clearTimeout(timer);timer=setTimeout(patch,ms);}

async function deleteBatch(){
  try{
    const email=await verifyManager();
    const id=currentBatchId(); if(!id)return alert("請先選擇要刪除的預支／動支批次。");
    const b=await getDoc(doc(db,"advanceBatches",id));
    if(!b.exists())return alert("找不到此預支／動支批次。");
    const aSnap=await getDocs(query(collection(db,"advanceAllocations"),where("batchId","==",id)));
    const active=aSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);
    if(active.length){
      alert(`此批次仍有 ${active.length} 筆活動分配，不能直接刪除。\n\n請先處理／刪除仍在預估中的活動；已進入實際核銷的資料需先完成相關流程。`);
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
    location.reload();
  }catch(err){alert("刪除預支批次失敗："+(err?.message||err));}
}

async function deleteAllocation(id){
  try{
    const email=await verifyManager();
    const aSnap=await getDoc(doc(db,"advanceAllocations",id));
    if(!aSnap.exists())return alert("找不到此活動分配。");
    const a={id,...aSnap.data()};
    if(a.deleted===true)return;
    if(!a.expenseRecordId)return alert("此分配沒有對應的使用紀錄，為避免資料不一致已停止刪除。");
    const rSnap=await getDoc(doc(db,"expenseRecords",a.expenseRecordId));
    if(!rSnap.exists())return alert("找不到對應的使用紀錄，為避免資料不一致已停止刪除。");
    const r=rSnap.data();
    if(r.estimated!==true||approved(r)){
      alert("此活動已轉為實際核銷或已鎖定，不能從預支／動支頁直接刪除。");
      return;
    }
    if(!confirm(`確定刪除「${a.purpose||"此活動"}」的預估分配嗎？\n\n負責老師：${a.ownerName||a.ownerEmail||"—"}\n預估金額：${Number(a.estimatedAmount||0).toLocaleString("zh-TW")} 元\n\n對應的預估使用紀錄也會一併移除。`))return;
    const wb=writeBatch(db);
    wb.update(doc(db,"advanceAllocations",id),{
      deleted:true,deletedAt:serverTimestamp(),deletedBy:email,updatedAt:serverTimestamp(),updatedBy:email
    });
    wb.update(doc(db,"expenseRecords",a.expenseRecordId),{
      deleted:true,deletedAt:serverTimestamp(),deletedBy:email,updatedAt:serverTimestamp(),updatedBy:email
    });
    wb.set(doc(collection(db,"auditLogs")),{
      type:"advance-allocation",targetId:id,expenseRecordId:a.expenseRecordId,planId:a.planId||currentPlanId(),action:"delete-estimated-allocation",actorEmail:email,createdAt:serverTimestamp()
    });
    await wb.commit();
    location.reload();
  }catch(err){alert("刪除活動分配失敗："+(err?.message||err));}
}

window.addEventListener("click",e=>{
  const btn=e.target.closest?.("[data-delete-advance-allocation]");
  if(!btn||!manager)return;
  e.preventDefault();e.stopImmediatePropagation();
  deleteAllocation(btn.dataset.deleteAdvanceAllocation||"");
},true);

// Delegated because #advanceBatchSelect does not exist yet when this module first loads.
document.addEventListener("input",e=>{
  if(e.target?.id==="advanceBatchSelect")schedule(0);
},true);
document.addEventListener("change",e=>{
  if(e.target?.id==="advanceBatchSelect")schedule(0);
},true);
document.addEventListener("click",e=>{
  if(e.target?.closest?.("#advanceTab,#newAdvanceBatchBtn,#editAdvanceBatchBtn")){
    [0,80,220].forEach(ms=>setTimeout(patch,ms));
  }
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
      if(manager){[100,300,700,1200].forEach(ms=>setTimeout(patch,ms));}
    }catch(err){console.warn("advance delete init failed",err);}
  });
}

new MutationObserver(()=>{if(manager)schedule();}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:["disabled","selected"]});
init();
