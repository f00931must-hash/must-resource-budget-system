// Budget advance allocation -> existing estimated usage record v1.5.3
// New allocation flow: manager selects an existing estimated expense record.
// No duplicate expense record is created. The allocation only links to the selected record.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, query, where,
  addDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
const $=id=>document.getElementById(id);
const money=new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0});
let auth=null,db=null,currentEmail="",isManager=false;
let dialogInstalled=false;
let availableRecords=[];
let currentEditAllocation=null;

function app(){return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null;}
function planId(){return $("planSelect")?.value||"";}
function batchId(){return $("advanceBatchSelect")?.value||"";}
function esc(v){return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m]));}
function num(v){return Number(v||0);}
function approved(r){return r?.reviewStatus==="approved"||r?.reviewed===true||r?.locked===true;}

async function verifyManager(){
  const user=auth?.currentUser;
  if(!user?.email)throw new Error("尚未登入");
  const email=user.email.toLowerCase();
  const snap=await getDoc(doc(db,"users",email));
  if(!snap.exists()||snap.data().enabled!==true||snap.data().role!=="manager")throw new Error("此功能僅限經費管理員使用");
  return email;
}

function installDialog(){
  if(dialogInstalled||$("advanceExistingEstimateDialog"))return;
  dialogInstalled=true;
  const wrap=document.createElement("div");
  wrap.innerHTML=`
  <dialog id="advanceExistingEstimateDialog"><form id="advanceExistingEstimateForm" method="dialog" class="dialog-form">
    <div class="dialog-head"><h3 id="advanceExistingEstimateTitle">分配既有預估</h3><button type="button" class="icon-btn" id="advanceExistingEstimateClose">×</button></div>
    <input type="hidden" id="advanceExistingAllocationId" />
    <label>選擇使用紀錄中的預估
      <select id="advanceExistingRecordSelect" required><option value="">讀取中…</option></select>
      <small id="advanceExistingRecordHint" class="muted">只會顯示目前批次同學期、同經費科目，且尚未被其他預支批次綁定的預估紀錄。</small>
    </label>
    <div id="advanceExistingRecordPreview" class="panel" style="margin:0;padding:14px"><div class="muted">請先選擇一筆預估紀錄。</div></div>
    <label>備註<textarea id="advanceExistingNote" rows="3" maxlength="300"></textarea></label>
    <div class="dialog-actions"><button type="button" class="ghost-btn" id="advanceExistingCancel">取消</button><button id="advanceExistingSave" class="primary-btn" value="default">加入預支分配</button></div>
  </form></dialog>`;
  document.body.appendChild(wrap);
  $("advanceExistingEstimateClose").onclick=()=>$("advanceExistingEstimateDialog").close();
  $("advanceExistingCancel").onclick=()=>$("advanceExistingEstimateDialog").close();
  $("advanceExistingRecordSelect").addEventListener("change",renderPreview);
  $("advanceExistingEstimateForm").addEventListener("submit",saveLink);
}

function renderPreview(){
  const id=$("advanceExistingRecordSelect")?.value||"";
  const r=availableRecords.find(x=>x.id===id);
  const box=$("advanceExistingRecordPreview");
  if(!box)return;
  if(!r){box.innerHTML='<div class="muted">請先選擇一筆預估紀錄。</div>';return;}
  box.innerHTML=`
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
      <div><small class="muted">負責老師</small><strong style="display:block">${esc(r.ownerName||r.ownerEmail||"—")}</strong></div>
      <div><small class="muted">活動／用途</small><strong style="display:block">${esc(r.purpose||"—")}</strong></div>
      <div><small class="muted">預估金額</small><strong style="display:block">${money.format(num(r.amount))}</strong></div>
      <div><small class="muted">學期</small><strong style="display:block">${esc(r.semester||"—")}</strong></div>
    </div>`;
}

async function loadCandidates(editAllocation=null){
  const p=planId(),bid=batchId();
  if(!p||!bid)throw new Error("請先選擇預支批次");
  const bSnap=await getDoc(doc(db,"advanceBatches",bid));
  if(!bSnap.exists()||bSnap.data().deleted===true)throw new Error("找不到目前預支批次");
  const batch={id:bid,...bSnap.data()};
  const [rSnap,aSnap]=await Promise.all([
    getDocs(query(collection(db,"expenseRecords"),where("planId","==",p))),
    getDocs(query(collection(db,"advanceAllocations"),where("planId","==",p)))
  ]);
  const activeAllocations=aSnap.docs.map(d=>({id:d.id,...d.data()})).filter(a=>a.deleted!==true);
  const usedRecordIds=new Set(activeAllocations.filter(a=>!editAllocation||a.id!==editAllocation.id).map(a=>a.expenseRecordId).filter(Boolean));
  const all=rSnap.docs.map(d=>({id:d.id,...d.data()}));
  availableRecords=all.filter(r=>
    r.deleted!==true &&
    r.estimated===true &&
    !approved(r) &&
    r.categoryId===batch.categoryId &&
    r.semester===batch.semester &&
    !usedRecordIds.has(r.id)
  );
  if(editAllocation?.expenseRecordId){
    const current=all.find(r=>r.id===editAllocation.expenseRecordId&&r.deleted!==true&&r.estimated===true&&!approved(r));
    if(current&&!availableRecords.some(r=>r.id===current.id))availableRecords.unshift(current);
  }
  return batch;
}

async function openLinkDialog(editAllocation=null){
  try{
    await verifyManager();
    installDialog();
    currentEditAllocation=editAllocation||null;
    const batch=await loadCandidates(editAllocation);
    const select=$("advanceExistingRecordSelect");
    $("advanceExistingEstimateForm").reset();
    $("advanceExistingAllocationId").value=editAllocation?.id||"";
    $("advanceExistingEstimateTitle").textContent=editAllocation?"調整活動分配":"分配既有預估";
    $("advanceExistingSave").textContent=editAllocation?"儲存調整":"加入預支分配";
    $("advanceExistingNote").value=editAllocation?.note||"";
    select.disabled=!!editAllocation;
    if(availableRecords.length){
      select.innerHTML='<option value="">請選擇預估紀錄</option>'+availableRecords.map(r=>`<option value="${r.id}">${esc(r.ownerName||r.ownerEmail||"未填老師")}｜${esc(r.purpose||"未填用途")}｜${money.format(num(r.amount))}</option>`).join("");
      if(editAllocation?.expenseRecordId)select.value=editAllocation.expenseRecordId;
      $("advanceExistingRecordHint").textContent=editAllocation
        ? "已綁定的使用紀錄不在此處更換；若要調整預估金額，請回到「使用紀錄」修改該筆預估。"
        : `目前批次：${batch.semester}｜${batch.categoryName||"經費科目"}。只顯示尚未被其他預支批次綁定的預估。`;
    }else{
      select.innerHTML='<option value="">目前沒有可分配的預估紀錄</option>';
      $("advanceExistingRecordHint").textContent=`目前批次：${batch.semester}｜${batch.categoryName||"經費科目"}。請先到「使用紀錄」建立預估。`;
    }
    renderPreview();
    $("advanceExistingEstimateDialog").showModal();
  }catch(err){alert("開啟分配失敗："+(err?.message||err));}
}

async function saveLink(e){
  e.preventDefault();
  try{
    const email=await verifyManager();
    const bid=batchId(),p=planId();
    if(!bid||!p)throw new Error("請先選擇預支批次");
    const editId=$("advanceExistingAllocationId").value;
    if(editId){
      const aSnap=await getDoc(doc(db,"advanceAllocations",editId));
      if(!aSnap.exists()||aSnap.data().deleted===true)throw new Error("找不到此活動分配");
      const a=aSnap.data();
      const rSnap=await getDoc(doc(db,"expenseRecords",a.expenseRecordId));
      if(!rSnap.exists())throw new Error("找不到已綁定的使用紀錄");
      const r={id:rSnap.id,...rSnap.data()};
      if(r.estimated!==true||approved(r))throw new Error("此筆已轉為實際核銷，不能再從預支頁調整預估");
      await updateDoc(doc(db,"advanceAllocations",editId),{
        ownerEmail:r.ownerEmail||"",ownerName:r.ownerName||r.ownerEmail||"",purpose:r.purpose||"",
        estimatedAmount:num(r.amount),note:$("advanceExistingNote").value.trim(),
        updatedAt:serverTimestamp(),updatedBy:email
      });
      await addDoc(collection(db,"auditLogs"),{type:"advance-allocation",targetId:editId,planId:p,action:"update-linked-estimate",expenseRecordId:r.id,actorEmail:email,createdAt:serverTimestamp()});
    }else{
      const rid=$("advanceExistingRecordSelect").value;
      const r=availableRecords.find(x=>x.id===rid);
      if(!r)throw new Error("請選擇一筆預估使用紀錄");
      const bSnap=await getDoc(doc(db,"advanceBatches",bid));
      if(!bSnap.exists()||bSnap.data().deleted===true)throw new Error("找不到目前預支批次");
      const b=bSnap.data();
      if(r.categoryId!==b.categoryId||r.semester!==b.semester)throw new Error("此預估與目前預支批次的學期或經費科目不一致");
      const aRef=await addDoc(collection(db,"advanceAllocations"),{
        planId:p,batchId:bid,expenseRecordId:r.id,
        ownerEmail:r.ownerEmail||"",ownerName:r.ownerName||r.ownerEmail||"",purpose:r.purpose||"",
        estimatedAmount:num(r.amount),note:$("advanceExistingNote").value.trim(),
        recordOrigin:"existing-estimate",deleted:false,
        createdAt:serverTimestamp(),createdBy:email,updatedAt:serverTimestamp(),updatedBy:email
      });
      await updateDoc(doc(db,"expenseRecords",r.id),{
        advanceBatchId:bid,advanceAllocationId:aRef.id,advanceLinked:true,
        originalEstimatedAmount:r.originalEstimatedAmount??num(r.amount),
        updatedAt:serverTimestamp(),updatedBy:email
      });
      await addDoc(collection(db,"auditLogs"),{type:"advance-allocation",targetId:aRef.id,planId:p,action:"link-existing-estimate",expenseRecordId:r.id,actorEmail:email,createdAt:serverTimestamp()});
    }
    $("advanceExistingEstimateDialog").close();
    location.reload();
  }catch(err){alert("儲存活動分配失敗："+(err?.message||err));}
}

window.addEventListener("click",async e=>{
  if(!isManager)return;
  const newBtn=e.target.closest?.("#newAdvanceAllocationBtn");
  if(newBtn){e.preventDefault();e.stopImmediatePropagation();await openLinkDialog();return;}
  const editBtn=e.target.closest?.("[data-edit-advance-allocation]");
  if(editBtn){
    e.preventDefault();e.stopImmediatePropagation();
    try{
      const id=editBtn.dataset.editAdvanceAllocation;
      const aSnap=await getDoc(doc(db,"advanceAllocations",id));
      if(!aSnap.exists())return alert("找不到此活動分配。");
      await openLinkDialog({id,...aSnap.data()});
    }catch(err){alert("讀取活動分配失敗："+(err?.message||err));}
  }
},true);

async function init(){
  for(let i=0;i<120;i++){
    const a=app();if(a){auth=getAuth(a);db=getFirestore(a);break;}
    await new Promise(r=>setTimeout(r,50));
  }
  if(!auth||!db)return;
  onAuthStateChanged(auth,async user=>{
    isManager=false;
    if(!user?.email)return;
    currentEmail=user.email.toLowerCase();
    try{
      const u=await getDoc(doc(db,"users",currentEmail));
      isManager=u.exists()&&u.data().enabled===true&&u.data().role==="manager";
      if(isManager)installDialog();
    }catch(err){console.warn("advance existing-estimate link init failed",err);}
  });
}
init();
