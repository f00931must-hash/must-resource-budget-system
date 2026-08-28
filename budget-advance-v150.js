// Budget advance / disbursement manager module v1.5.0
// First layer: manager creates one advance batch for a semester/category.
// Second layer: manager allocates estimated activity amounts to teachers.
// Allocation creation also creates an estimated expenseRecord owned by that teacher.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, query, where,
  addDoc, updateDoc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
const $=id=>document.getElementById(id);
const money=new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0});
let auth=null,db=null,currentEmail="";
let users=[],categories=[],batches=[],allocations=[],records=[];
let activeBatchId="";

function app(){ return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null; }
function esc(v){return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m]));}
function escAttr(v){return esc(v).replace(/'/g,"&#39;");}
function num(v){return Number(v||0);}
function planId(){return $("planSelect")?.value||"";}
function currentBatch(){return batches.find(x=>x.id===activeBatchId)||null;}
function recordForAllocation(a){return records.find(r=>r.id===a.expenseRecordId)||null;}
function isApproved(r){return !!r&&(r.reviewStatus==="approved"||r.reviewed===true||r.locked===true);}
function isActual(r){return !!r&&r.estimated!==true;}

function ensurePosition(){
  const nav=document.querySelector("nav.tabs"),btn=$("advanceTab");
  if(!nav||!btn)return;
  const trash=nav.querySelector('[data-view="trash"]');
  if(trash&&btn.nextElementSibling!==trash) nav.insertBefore(btn,trash);
}

function installUI(){
  if($("advance"))return;
  const nav=document.querySelector("nav.tabs"),main=document.querySelector("#appView main");
  if(!nav||!main)return;

  const btn=document.createElement("button");
  btn.id="advanceTab";
  btn.className="tab manager-only";
  btn.dataset.view="advance";
  btn.textContent="預支／動支";
  const trash=nav.querySelector('[data-view="trash"]');
  if(trash) nav.insertBefore(btn,trash); else nav.appendChild(btn);

  const section=document.createElement("section");
  section.id="advance";
  section.className="view manager-only";
  section.innerHTML=`
    <div class="section-head responsive-head">
      <div><h2>預支／動支</h2><p>管理員建立整筆預支，再將預估金額分配至各老師活動。老師後續在「使用紀錄」轉為實際核銷。</p></div>
      <button id="newAdvanceBatchBtn" class="primary-btn">＋ 建立預支批次</button>
    </div>
    <div class="panel" style="margin-bottom:16px;display:flex;gap:12px;align-items:end;flex-wrap:wrap">
      <label style="min-width:280px;flex:1">目前預支批次<select id="advanceBatchSelect"><option value="">尚未建立預支批次</option></select></label>
      <button id="editAdvanceBatchBtn" class="ghost-btn" disabled>調整批次</button>
      <button id="newAdvanceAllocationBtn" class="primary-btn" disabled>＋ 分配活動</button>
    </div>
    <div id="advanceSummary" class="summary-grid"></div>
    <div id="advanceBatchInfo" class="panel" style="margin-bottom:16px"></div>
    <div class="panel">
      <div class="panel-head"><h3>活動分配與核銷進度</h3><span id="advanceAllocationCount" class="muted"></span></div>
      <div id="advanceAllocationList"></div>
    </div>`;
  main.appendChild(section);

  const style=document.createElement("style");
  style.textContent=`
    #advance .advance-received{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;background:#edf8f0;color:#216e39;font-weight:700;font-size:12px}
    #advance .advance-not-received{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;background:#fff4e5;color:#9a5b00;font-weight:700;font-size:12px}
    #advance .advance-grid{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr auto;gap:12px;align-items:center;padding:14px 0;border-bottom:1px solid #eee}
    #advance .advance-grid:last-child{border-bottom:0}
    #advance .advance-grid small{display:block;color:#777;margin-top:4px}
    #advance .variance-positive{color:#9a5b00;font-weight:700}
    #advance .variance-negative{color:#b42318;font-weight:700}
    #advance .variance-zero{color:#216e39;font-weight:700}
    @media(max-width:900px){#advance .advance-grid{grid-template-columns:1fr 1fr}#advance .advance-grid>div:first-child{grid-column:1/-1}}
  `;
  document.head.appendChild(style);

  installDialogs();

  btn.addEventListener("click",()=>{
    document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active-view",v.id==="advance"));
    document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t===btn));
    history.replaceState(null,"","#advance");
    loadAll().catch(showError);
  });
  $("advanceBatchSelect").addEventListener("change",()=>{activeBatchId=$("advanceBatchSelect").value;render();});
  $("newAdvanceBatchBtn").addEventListener("click",()=>openBatchDialog());
  $("editAdvanceBatchBtn").addEventListener("click",()=>openBatchDialog(currentBatch()));
  $("newAdvanceAllocationBtn").addEventListener("click",()=>openAllocationDialog());

  new MutationObserver(ensurePosition).observe(nav,{childList:true});
  ensurePosition();
}

function installDialogs(){
  if($("advanceBatchDialog"))return;
  const wrap=document.createElement("div");
  wrap.innerHTML=`
  <dialog id="advanceBatchDialog"><form id="advanceBatchForm" method="dialog" class="dialog-form">
    <div class="dialog-head"><h3 id="advanceBatchDialogTitle">建立預支批次</h3><button type="button" class="icon-btn" data-advance-close="advanceBatchDialog">×</button></div>
    <input type="hidden" id="advanceBatchId" />
    <label>批次名稱<input id="advanceBatchTitle" required maxlength="120" placeholder="例如：115-1 活動經費整筆預支" /></label>
    <div class="two-cols"><label>學期<input id="advanceBatchSemester" required maxlength="5" pattern="\\d{3}-[12]" placeholder="115-1" /></label><label>經費科目<select id="advanceBatchCategory" required></select></label></div>
    <label>本次預支／動支總額<input id="advanceBatchTotal" required type="number" min="0" step="1" /></label>
    <label>承辦人<select id="advanceBatchHandler" required></select></label>
    <label class="check-row"><input id="advanceBatchReceived" type="checkbox" /><span><strong>款項已由中心領得</strong><small>勾選後請填實際領款金額與日期。</small></span></label>
    <div id="advanceReceivedFields" class="two-cols hidden"><label>實際領款金額<input id="advanceBatchReceivedAmount" type="number" min="0" step="1" /></label><label>領款日期<input id="advanceBatchReceivedDate" type="date" /></label></div>
    <label>備註<textarea id="advanceBatchNote" rows="3" maxlength="500"></textarea></label>
    <div class="dialog-actions"><button type="button" class="ghost-btn" data-advance-close="advanceBatchDialog">取消</button><button id="advanceBatchSaveBtn" class="primary-btn" value="default">儲存</button></div>
  </form></dialog>

  <dialog id="advanceAllocationDialog"><form id="advanceAllocationForm" method="dialog" class="dialog-form">
    <div class="dialog-head"><h3 id="advanceAllocationDialogTitle">分配活動</h3><button type="button" class="icon-btn" data-advance-close="advanceAllocationDialog">×</button></div>
    <input type="hidden" id="advanceAllocationId" />
    <label>負責老師<select id="advanceAllocationOwner" required></select></label>
    <label>活動／用途<input id="advanceAllocationPurpose" required maxlength="120" placeholder="例如：戶外教育活動" /></label>
    <label>預估分配金額<input id="advanceAllocationAmount" required type="number" min="0" step="1" /></label>
    <label>備註<textarea id="advanceAllocationNote" rows="3" maxlength="300"></textarea></label>
    <div class="dialog-actions"><button type="button" class="ghost-btn" data-advance-close="advanceAllocationDialog">取消</button><button id="advanceAllocationSaveBtn" class="primary-btn" value="default">建立預估使用紀錄</button></div>
  </form></dialog>`;
  document.body.appendChild(wrap);

  document.querySelectorAll("[data-advance-close]").forEach(b=>b.addEventListener("click",()=>$(b.dataset.advanceClose)?.close()));
  $("advanceBatchReceived").addEventListener("change",toggleReceivedFields);
  $("advanceBatchForm").addEventListener("submit",saveBatch);
  $("advanceAllocationForm").addEventListener("submit",saveAllocation);
}

function toggleReceivedFields(){
  const received=$("advanceBatchReceived").checked;
  $("advanceReceivedFields").classList.toggle("hidden",!received);
  $("advanceBatchReceivedAmount").required=received;
  $("advanceBatchReceivedDate").required=received;
}

function populateSelectors(){
  const activeCats=categories.filter(c=>c.active!==false&&c.deleted!==true);
  $("advanceBatchCategory").innerHTML='<option value="">請選擇</option>'+activeCats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");
  const enabled=users.filter(u=>u.enabled===true);
  const opts=enabled.map(u=>`<option value="${escAttr(u.id)}">${esc(u.name||u.id)}｜${esc(u.id)}</option>`).join("");
  $("advanceBatchHandler").innerHTML='<option value="">請選擇</option>'+opts;
  $("advanceAllocationOwner").innerHTML='<option value="">請選擇</option>'+opts;
}

function openBatchDialog(item=null){
  populateSelectors();
  $("advanceBatchForm").reset();
  $("advanceBatchId").value=item?.id||"";
  $("advanceBatchDialogTitle").textContent=item?"調整預支批次":"建立預支批次";
  if(item){
    $("advanceBatchTitle").value=item.title||"";
    $("advanceBatchSemester").value=item.semester||"";
    $("advanceBatchCategory").value=item.categoryId||"";
    $("advanceBatchTotal").value=num(item.totalAmount);
    $("advanceBatchHandler").value=item.handlerEmail||"";
    $("advanceBatchReceived").checked=item.received===true;
    $("advanceBatchReceivedAmount").value=item.receivedAmount??item.totalAmount??"";
    $("advanceBatchReceivedDate").value=item.receivedDate||"";
    $("advanceBatchNote").value=item.note||"";
  }else{
    const p=$("planSelect")?.selectedOptions?.[0]?.textContent||"";
    const m=p.match(/(\d{3})/);
    $("advanceBatchSemester").value=m?`${m[1]}-1`:"";
  }
  toggleReceivedFields();
  $("advanceBatchDialog").showModal();
}

function openAllocationDialog(item=null){
  if(!currentBatch())return alert("請先建立並選擇預支批次。");
  populateSelectors();
  $("advanceAllocationForm").reset();
  $("advanceAllocationId").value=item?.id||"";
  $("advanceAllocationDialogTitle").textContent=item?"調整活動分配":"分配活動";
  $("advanceAllocationSaveBtn").textContent=item?"儲存調整":"建立預估使用紀錄";
  if(item){
    $("advanceAllocationOwner").value=item.ownerEmail||"";
    $("advanceAllocationPurpose").value=item.purpose||"";
    $("advanceAllocationAmount").value=num(item.estimatedAmount);
    $("advanceAllocationNote").value=item.note||"";
  }
  $("advanceAllocationDialog").showModal();
}

async function saveBatch(e){
  e.preventDefault();
  const id=$("advanceBatchId").value;
  const categoryId=$("advanceBatchCategory").value;
  const category=categories.find(c=>c.id===categoryId);
  const handlerEmail=$("advanceBatchHandler").value;
  const handler=users.find(u=>u.id===handlerEmail);
  const total=num($("advanceBatchTotal").value);
  const semester=$("advanceBatchSemester").value.trim();
  if(!/^\d{3}-[12]$/.test(semester))return alert("學期格式請輸入例如 115-1。");
  if(!category)return alert("請選擇經費科目。");
  if(total<=0)return alert("預支總額必須大於 0。");
  const existingAlloc=id?allocations.filter(a=>a.batchId===id&&a.deleted!==true).reduce((s,a)=>s+num(a.estimatedAmount),0):0;
  if(id&&total<existingAlloc)return alert(`批次總額不可低於目前已分配的 ${money.format(existingAlloc)}。`);
  const received=$("advanceBatchReceived").checked;
  const data={
    planId:planId(),title:$("advanceBatchTitle").value.trim(),semester,
    categoryId,categoryName:category.name||"",totalAmount:total,
    handlerEmail,handlerName:handler?.name||handlerEmail,
    received,receivedAmount:received?num($("advanceBatchReceivedAmount").value):0,
    receivedDate:received?$("advanceBatchReceivedDate").value:"",
    note:$("advanceBatchNote").value.trim(),updatedAt:serverTimestamp(),updatedBy:currentEmail
  };
  try{
    let target=id;
    if(id) await updateDoc(doc(db,"advanceBatches",id),data);
    else{
      const ref=await addDoc(collection(db,"advanceBatches"),{...data,createdAt:serverTimestamp(),createdBy:currentEmail,deleted:false});
      target=ref.id;
    }
    await addDoc(collection(db,"auditLogs"),{type:"advance-batch",targetId:target,planId:planId(),action:id?"update":"create",actorEmail:currentEmail,createdAt:serverTimestamp()});
    $("advanceBatchDialog").close(); activeBatchId=target; await loadAll();
  }catch(err){showError(err);}
}

async function saveAllocation(e){
  e.preventDefault();
  const batchItem=currentBatch(); if(!batchItem)return;
  const editId=$("advanceAllocationId").value;
  const ownerEmail=$("advanceAllocationOwner").value;
  const owner=users.find(u=>u.id===ownerEmail);
  const purpose=$("advanceAllocationPurpose").value.trim();
  const estimatedAmount=num($("advanceAllocationAmount").value);
  if(!owner||owner.enabled!==true)return alert("請選擇有效的負責老師。");
  if(estimatedAmount<=0)return alert("預估分配金額必須大於 0。");
  const same=allocations.filter(a=>a.batchId===batchItem.id&&a.deleted!==true&&a.id!==editId);
  const afterTotal=same.reduce((s,a)=>s+num(a.estimatedAmount),0)+estimatedAmount;
  if(afterTotal>num(batchItem.totalAmount))return alert(`分配後會超過本批次總額 ${money.format(batchItem.totalAmount)}。`);

  const cat=categories.find(c=>c.id===batchItem.categoryId);
  if(!cat)return alert("找不到此批次的經費科目。");

  try{
    if(editId){
      const old=allocations.find(a=>a.id===editId); if(!old)return;
      const r=recordForAllocation(old);
      if(!r)return alert("找不到對應的預估使用紀錄，請先不要調整並通知管理員檢查資料。");
      if(r.estimated!==true||isApproved(r))return alert("這筆已進入實際核銷或已鎖定，不能再從預支分配頁修改原預估。請在使用紀錄處理實際核銷。");
      const wb=writeBatch(db);
      wb.update(doc(db,"advanceAllocations",editId),{
        ownerEmail,ownerName:owner.name||ownerEmail,purpose,estimatedAmount,
        note:$("advanceAllocationNote").value.trim(),updatedAt:serverTimestamp(),updatedBy:currentEmail
      });
      wb.update(doc(db,"expenseRecords",old.expenseRecordId),{
        ownerEmail,ownerName:owner.name||ownerEmail,purpose,amount:estimatedAmount,
        originalEstimatedAmount:estimatedAmount,updatedAt:serverTimestamp(),updatedBy:currentEmail
      });
      await wb.commit();
      await addDoc(collection(db,"auditLogs"),{type:"advance-allocation",targetId:editId,planId:planId(),action:"update",actorEmail:currentEmail,createdAt:serverTimestamp()});
    }else{
      const allocationRef=doc(collection(db,"advanceAllocations"));
      const recordRef=doc(collection(db,"expenseRecords"));
      const now=serverTimestamp();
      const wb=writeBatch(db);
      wb.set(allocationRef,{
        planId:planId(),batchId:batchItem.id,ownerEmail,ownerName:owner.name||ownerEmail,
        purpose,estimatedAmount,note:$("advanceAllocationNote").value.trim(),expenseRecordId:recordRef.id,
        deleted:false,createdAt:now,createdBy:currentEmail,updatedAt:now,updatedBy:currentEmail
      });
      wb.set(recordRef,{
        planId:planId(),categoryId:batchItem.categoryId,purpose,amount:estimatedAmount,semester:batchItem.semester,
        estimated:true,ownerEmail,ownerName:owner.name||ownerEmail,createdBy:currentEmail,createdAt:now,
        updatedAt:now,updatedBy:currentEmail,reviewStatus:"pending",reviewed:false,locked:false,
        archived:false,amountConfirmed:false,amountManuallyConfirmed:false,
        advanceBatchId:batchItem.id,advanceAllocationId:allocationRef.id,
        originalEstimatedAmount:estimatedAmount,source:"advance-allocation"
      });
      await wb.commit();
      await addDoc(collection(db,"auditLogs"),{type:"advance-allocation",targetId:allocationRef.id,planId:planId(),action:"create-estimated-record",expenseRecordId:recordRef.id,actorEmail:currentEmail,createdAt:serverTimestamp()});
    }
    $("advanceAllocationDialog").close(); await loadAll();
  }catch(err){showError(err);}
}

async function loadAll(){
  const p=planId();
  if(!p){batches=[];allocations=[];records=[];categories=[];render();return;}
  const [uSnap,cSnap,bSnap,aSnap,rSnap]=await Promise.all([
    getDocs(collection(db,"users")),
    getDocs(query(collection(db,"budgetCategories"),where("planId","==",p))),
    getDocs(query(collection(db,"advanceBatches"),where("planId","==",p))),
    getDocs(query(collection(db,"advanceAllocations"),where("planId","==",p))),
    getDocs(query(collection(db,"expenseRecords"),where("planId","==",p)))
  ]);
  users=uSnap.docs.map(d=>({id:d.id,...d.data()}));
  categories=cSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);
  batches=bSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);
  allocations=aSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);
  records=rSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);
  if(!activeBatchId||!batches.some(b=>b.id===activeBatchId))activeBatchId=batches[0]?.id||"";
  render();
}

function render(){
  if(!$("advanceBatchSelect"))return;
  $("advanceBatchSelect").innerHTML=batches.length
    ? batches.map(b=>`<option value="${b.id}" ${b.id===activeBatchId?"selected":""}>${esc(b.semester)}｜${esc(b.title||b.categoryName||"預支批次")}</option>`).join("")
    : '<option value="">尚未建立預支批次</option>';
  const b=currentBatch();
  $("editAdvanceBatchBtn").disabled=!b;
  $("newAdvanceAllocationBtn").disabled=!b;
  if(!b){
    $("advanceSummary").innerHTML="";
    $("advanceBatchInfo").innerHTML='<div class="empty">此計畫尚未建立預支／動支批次。</div>';
    $("advanceAllocationCount").textContent="";
    $("advanceAllocationList").innerHTML='<div class="empty">尚無活動分配。</div>';
    return;
  }

  const aa=allocations.filter(a=>a.batchId===b.id&&a.deleted!==true);
  let estimateTotal=0,actualTotal=0,projectedTotal=0,actualCount=0;
  for(const a of aa){
    estimateTotal+=num(a.estimatedAmount);
    const r=recordForAllocation(a);
    if(r&&isActual(r)){actualTotal+=num(r.amount);projectedTotal+=num(r.amount);actualCount++;}
    else projectedTotal+=num(a.estimatedAmount);
  }
  const total=num(b.totalAmount);
  const unallocated=total-estimateTotal;
  const mustSpend=total-actualTotal;
  const realloc=total-projectedTotal;
  $("advanceSummary").innerHTML=[
    ["預支／動支總額",money.format(total)],
    ["已分配預估",money.format(estimateTotal)],
    ["已實際支用",money.format(actualTotal)],
    ["尚須支用",money.format(mustSpend)],
    ["待重新分配",money.format(realloc)]
  ].map(([l,v])=>`<div class="summary-card"><span>${l}</span><strong>${v}</strong></div>`).join("");

  const received=b.received===true;
  $("advanceBatchInfo").innerHTML=`
    <div class="panel-head"><h3>${esc(b.title||"預支批次")}</h3><span class="${received?'advance-received':'advance-not-received'}">${received?'✓ 已領錢':'尚未領錢'}</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
      <div><small class="muted">學期</small><strong style="display:block">${esc(b.semester||"—")}</strong></div>
      <div><small class="muted">經費科目</small><strong style="display:block">${esc(b.categoryName||"—")}</strong></div>
      <div><small class="muted">承辦人</small><strong style="display:block">${esc(b.handlerName||b.handlerEmail||"—")}</strong></div>
      <div><small class="muted">領款</small><strong style="display:block">${received?`${money.format(b.receivedAmount||0)}｜${esc(b.receivedDate||"未填日期")}`:"尚未領款"}</strong></div>
      <div><small class="muted">尚未分配</small><strong style="display:block">${money.format(unallocated)}</strong></div>
      <div><small class="muted">完成實際核銷活動</small><strong style="display:block">${actualCount} / ${aa.length}</strong></div>
    </div>${b.note?`<p class="muted" style="margin:12px 0 0">備註：${esc(b.note)}</p>`:""}`;

  $("advanceAllocationCount").textContent=`${aa.length} 個活動`;
  if(!aa.length){$("advanceAllocationList").innerHTML='<div class="empty">尚未分配活動。</div>';return;}
  $("advanceAllocationList").innerHTML=aa.map(a=>{
    const r=recordForAllocation(a);
    const actual=r&&isActual(r)?num(r.amount):null;
    const variance=actual===null?null:num(a.estimatedAmount)-actual;
    const status=!r?'找不到使用紀錄':r.estimated===true?'預估中':isApproved(r)?'已核銷・已鎖定':'已轉實際・待核對';
    const varianceHtml=variance===null?'—':variance===0?'<span class="variance-zero">剛好</span>':variance>0?`<span class="variance-positive">多估 ${money.format(variance)}</span>`:`<span class="variance-negative">少估 ${money.format(Math.abs(variance))}</span>`;
    const canEdit=!!r&&r.estimated===true&&!isApproved(r);
    return `<div class="advance-grid">
      <div><strong>${esc(a.purpose||"未填活動")}</strong><small>${esc(a.ownerName||a.ownerEmail||"")}</small></div>
      <div><small>原預估</small><strong>${money.format(a.estimatedAmount)}</strong></div>
      <div><small>實際核銷</small><strong>${actual===null?'尚未':money.format(actual)}</strong></div>
      <div><small>差額</small>${varianceHtml}<small>${esc(status)}</small></div>
      <div>${canEdit?`<button class="link-btn" data-edit-advance-allocation="${a.id}">調整</button>`:""}</div>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-edit-advance-allocation]").forEach(x=>x.onclick=()=>openAllocationDialog(allocations.find(a=>a.id===x.dataset.editAdvanceAllocation)));
}

function showError(err){
  console.error(err);
  alert("預支／動支功能發生錯誤："+(err?.message||err));
}

async function init(){
  for(let i=0;i<120;i++){
    const a=app(); if(a){auth=getAuth(a);db=getFirestore(a);break;}
    await new Promise(r=>setTimeout(r,50));
  }
  if(!auth||!db)return;
  onAuthStateChanged(auth,async user=>{
    if(!user?.email)return;
    currentEmail=user.email.toLowerCase();
    try{
      const u=await getDoc(doc(db,"users",currentEmail));
      if(!u.exists()||u.data().enabled!==true||u.data().role!=="manager")return;
      installUI();
      $("planSelect")?.addEventListener("change",()=>{activeBatchId="";loadAll().catch(showError);});
      await loadAll();
      if(location.hash==="#advance") $("advanceTab")?.click();
    }catch(err){showError(err);}
  });
}
init();
