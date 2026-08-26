import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, collection, addDoc, doc, getDoc, getDocs, updateDoc, deleteDoc, query, orderBy, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-storage.js";
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const firebaseConfig = {
  apiKey: "AIzaSyCsApWkpnJiwCsQsiPK14pgFQdqb88UJjQ",
  authDomain: "must-resource-budget-system.firebaseapp.com",
  projectId: "must-resource-budget-system",
  storageBucket: "must-resource-budget-system.firebasestorage.app",
  messagingSenderId: "1044795970310",
  appId: "1:1044795970310:web:3939115211f2890c280487"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const $ = id => document.getElementById(id);
const state = {
  user:null, profile:null, plans:[], activePlanId:"", categories:[], records:[],
  aiVoucher:{ status:"idle", detectedAmount:null, page:null, message:"", file:null }
};
const money = new Intl.NumberFormat("zh-TW", { style:"currency", currency:"TWD", maximumFractionDigits:0 });

$("loginBtn").addEventListener("click", async()=>{ try{ await signInWithPopup(auth,provider); }catch(e){ toast(`登入失敗：${e.message}`,5000); } });
$("logoutBtn").addEventListener("click",()=>signOut(auth));
document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>$(b.dataset.close).close()));
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.view)));
$("planSelect").addEventListener("change", async()=>{ state.activePlanId=$("planSelect").value; await loadPlanData(); renderAll(); });
$("newPlanBtn").addEventListener("click",openNewPlan);
$("editPlanBtn").addEventListener("click",openEditPlan);
$("deletePlanBtn").addEventListener("click",deleteCurrentPlan);
$("planForm").addEventListener("submit",savePlan);
$("newRecordBtn").addEventListener("click",openNewRecord);
$("newCategoryBtn").addEventListener("click",openNewCategory);
$("recordForm").addEventListener("submit",saveRecord);
$("categoryForm").addEventListener("submit",saveCategory);
["filterCategory","filterArchive","filterSemester","searchInput"].forEach(id=>$(id).addEventListener("input",renderRecords));
$("recordVoucherFile").addEventListener("change",handleVoucherFileChange);
$("recordAmount").addEventListener("input",()=>refreshAmountCheck());

onAuthStateChanged(auth, async user=>{
  state.user=user;
  if(!user){
    $("loginView").classList.remove("hidden");
    $("appView").classList.add("hidden");
    return;
  }
  try{
    const email=user.email.toLowerCase();
    const snap=await getDoc(doc(db,"users",email));
    if(!snap.exists() || snap.data().enabled!==true){
      await signOut(auth);
      alert("此 Google 帳號尚未獲授權使用經費系統，請洽經費管理員。");
      return;
    }
    state.profile=snap.data();
    $("userName").textContent=state.profile.name||user.displayName||user.email;
    $("userEmail").textContent=user.email;
    $("roleBadge").textContent=isManager()?"經費管理員":"經費使用者";
    document.querySelectorAll(".manager-only").forEach(el=>el.classList.toggle("hidden",!isManager()));
    $("recordsHint").textContent="所有已授權老師都可查看全部使用紀錄；只能修改或刪除自己建立的資料。";
    $("loginView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    await loadPlans();
    await loadPlanData();
    renderAll();
  }catch(e){
    console.error(e);
    toast("讀取系統資料失敗，請檢查 Firestore Rules。",5000);
  }
});

function isManager(){ return state.profile?.role==="manager"; }
function currentPlan(){ return state.plans.find(p=>p.id===state.activePlanId); }
function isPlanActive(){ return currentPlan()?.active!==false; }
function planTotal(){ return Number(currentPlan()?.totalBudget||0); }
function allocatedTotal(){ return state.categories.reduce((s,c)=>s+Number(c.budget||0),0); }
function actualTotal(records=state.records){ return records.filter(r=>r.estimated!==true).reduce((s,r)=>s+Number(r.amount||0),0); }
function estimatedTotal(records=state.records){ return records.filter(r=>r.estimated===true).reduce((s,r)=>s+Number(r.amount||0),0); }
function usedTotal(records=state.records){ return actualTotal(records)+estimatedTotal(records); }
function tsMillis(v){
  if(!v) return 0;
  if(typeof v.toMillis==="function") return v.toMillis();
  if(typeof v.seconds==="number") return v.seconds*1000;
  const n=Date.parse(v); return Number.isFinite(n)?n:0;
}

async function loadPlans(){
  const snap=await getDocs(query(collection(db,"budgetPlans"),orderBy("year","desc")));
  state.plans=snap.docs.map(d=>({id:d.id,...d.data()}));
  if(!state.activePlanId || !state.plans.some(p=>p.id===state.activePlanId)){
    state.activePlanId=state.plans.find(p=>p.active!==false)?.id || state.plans[0]?.id || "";
  }
}

async function loadPlanData(){
  if(!state.activePlanId){ state.categories=[]; state.records=[]; return; }
  const catSnap=await getDocs(query(collection(db,"budgetCategories"),where("planId","==",state.activePlanId)));
  state.categories=catSnap.docs.map(d=>({id:d.id,...d.data()}))
    .sort((a,b)=>Number(a.order||0)-Number(b.order||0) || String(a.name||"").localeCompare(String(b.name||""),"zh-Hant"));
  const recSnap=await getDocs(query(collection(db,"expenseRecords"),where("planId","==",state.activePlanId)));
  state.records=recSnap.docs.map(d=>({id:d.id,...d.data()}));
}

function renderAll(){
  renderPlanSelect();
  renderDashboard();
  renderCategoryOptions();
  renderSemesterOptions();
  renderRecords();
  updatePlanLocks();
  if(isManager()) renderCategoryAdmin();
}

function renderPlanSelect(){
  $("planSelect").innerHTML=state.plans.length
    ? state.plans.map(p=>`<option value="${p.id}" ${p.id===state.activePlanId?"selected":""}>${esc(p.year||"")} ${esc(p.term||"")}｜${esc(p.name||"")}${p.active===false?"（停用）":""}</option>`).join("")
    : '<option value="">尚未建立計畫</option>';
  const disabled=!state.activePlanId;
  $("editPlanBtn").disabled=disabled;
  $("deletePlanBtn").disabled=disabled;
}

function updatePlanLocks(){
  const active=isPlanActive();
  const hasPlan=!!state.activePlanId;
  $("newRecordBtn").disabled=!hasPlan||!active;
  $("newCategoryBtn").disabled=!hasPlan||!active;
  $("newRecordBtn").title=!active&&hasPlan?"此計畫已停用，無法新增使用紀錄":"";
  $("newCategoryBtn").title=!active&&hasPlan?"此計畫已停用，無法新增經費項目":"";
  $("inactivePlanNotice").classList.toggle("hidden",!hasPlan||active);
}

function renderDashboard(){
  const plan=currentPlan();
  $("planSummary").textContent=plan
    ? `${plan.year||""} ${plan.term||""}｜${plan.name||""}${plan.active===false?"（已停用）":""}`
    : "請先由經費管理員建立計畫。";

  const total=planTotal();
  const allocated=allocatedTotal();
  const unallocated=total-allocated;
  const actual=actualTotal();
  const estimated=estimatedTotal();
  const pending=state.records.filter(r=>r.estimated!==true && r.archived!==true).reduce((s,r)=>s+Number(r.amount||0),0);
  const remain=total-actual-estimated;
  const actualRemain=total-actual;

  $("summaryCards").innerHTML=[
    ["計畫總核定額度",money.format(total)],
    ["已編列額度",money.format(allocated)],
    ["尚未編列",money.format(unallocated)],
    ["已核銷",money.format(actual)],
    ["已預估",money.format(estimated)],
    ["尚待憑證歸檔",money.format(pending)],
    ["計畫剩餘額度",money.format(remain)],
    ["已核銷餘額",money.format(actualRemain)]
  ].map(([l,v])=>`<div class="summary-card"><span>${l}</span><strong>${v}</strong></div>`).join("");

  $("categoryCount").textContent=`${state.categories.length} 個項目｜已編列 ${money.format(allocated)} / ${money.format(total)}`;

  if(!state.activePlanId){ $("budgetTableWrap").innerHTML='<div class="empty">尚未建立計畫。</div>'; return; }
  if(!state.categories.length){ $("budgetTableWrap").innerHTML='<div class="empty">此計畫尚未編列經費項目。</div>'; return; }

  const rows=state.categories.filter(c=>c.active!==false).map(c=>{
    const recs=state.records.filter(r=>r.categoryId===c.id);
    const actual=actualTotal(recs), estimated=estimatedTotal(recs);
    const rem=Number(c.budget||0)-actual-estimated;
    return `<tr><td><strong>${esc(c.name)}</strong></td><td class="amount">${money.format(c.budget||0)}</td><td class="amount">${money.format(actual)}</td><td class="amount">${money.format(estimated)}</td><td class="amount">${money.format(rem)}</td></tr>`;
  }).join("");
  $("budgetTableWrap").innerHTML=`<table><thead><tr><th>經費項目</th><th class="amount">編列額度</th><th class="amount">已核銷</th><th class="amount">已預估</th><th class="amount">剩餘</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderCategoryOptions(){
  const active=state.categories.filter(c=>c.active!==false);
  const opts=active.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");
  $("recordCategory").innerHTML=`<option value="">請選擇</option>${opts}`;
  const currentFilter=$("filterCategory").value;
  $("filterCategory").innerHTML=`<option value="">全部經費項目</option>${opts}`;
  if(active.some(c=>c.id===currentFilter)) $("filterCategory").value=currentFilter;
}

function renderSemesterOptions(){
  const current=$("filterSemester").value;
  const semesters=[...new Set(state.records.map(r=>String(r.semester||"").trim()).filter(Boolean))]
    .sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  $("filterSemester").innerHTML='<option value="">全部學期</option>'+semesters.map(s=>`<option value="${escAttr(s)}">${esc(s)}</option>`).join("");
  if(semesters.includes(current)) $("filterSemester").value=current;
}

function renderRecords(){
  const cat=$("filterCategory").value;
  const arch=$("filterArchive").value;
  const semester=$("filterSemester").value;
  const term=$("searchInput").value.trim().toLowerCase();
  let rows=[...state.records];
  if(cat) rows=rows.filter(r=>r.categoryId===cat);
  if(arch==="done") rows=rows.filter(r=>r.archived===true);
  if(arch==="pending") rows=rows.filter(r=>r.archived!==true);
  if(semester) rows=rows.filter(r=>String(r.semester||"")===semester);
  if(term) rows=rows.filter(r=>[r.purpose,r.ownerName,r.ownerEmail,r.semester].some(v=>String(v||"").toLowerCase().includes(term)));
  rows.sort((a,b)=>{
    const diff=tsMillis(b.createdAt)-tsMillis(a.createdAt);
    if(diff) return diff;
    return String(b.semester||b.expenseDate||"").localeCompare(String(a.semester||a.expenseDate||""));
  });

  if(!state.activePlanId){ $("recordList").innerHTML='<div class="panel empty">尚未建立計畫。</div>'; return; }
  if(!rows.length){ $("recordList").innerHTML='<div class="panel empty">目前沒有符合條件的使用紀錄。</div>'; return; }

  $("recordList").innerHTML=rows.map(r=>{
    const c=state.categories.find(x=>x.id===r.categoryId);
    const mine=r.ownerEmail===state.user.email.toLowerCase();
    const canEdit=isManager()||mine;
    const evidenceUrl=r.voucherUrl||r.folderUrl||"";
    const typeBadge=r.estimated===true?'<span class="status estimated">預估</span>':'<span class="status actual">已核銷</span>';
    return `<article class="record-card">
      <div><div class="title">${esc(r.purpose||"未填用途")}</div><small>${esc(c?.name||"未分類")}｜${esc(r.ownerName||r.ownerEmail||"")}</small></div>
      <div><strong>${money.format(r.amount||0)}</strong><small>學期：${esc(r.semester||"未填")}</small></div>
      <div>${typeBadge}<span class="status ${r.archived?'done':'pending'}">${r.archived?'憑證已歸檔':'待憑證歸檔'}</span></div>
      <div><small>核銷單據</small><div>${evidenceUrl?`<a class="text-link" target="_blank" rel="noopener" href="${escAttr(evidenceUrl)}">${esc(r.voucherFileName||"查看附件")}</a>`:"—"}</div></div>
      <div class="record-actions">${canEdit?`<button class="link-btn" data-edit-record="${r.id}">編輯</button><button class="link-btn danger" data-delete-record="${r.id}">刪除</button>`:""}</div>
    </article>`;
  }).join("");
  document.querySelectorAll("[data-edit-record]").forEach(b=>b.addEventListener("click",()=>openEditRecord(b.dataset.editRecord)));
  document.querySelectorAll("[data-delete-record]").forEach(b=>b.addEventListener("click",()=>deleteRecord(b.dataset.deleteRecord)));
}

function renderCategoryAdmin(){
  const total=planTotal();
  const allocated=allocatedTotal();
  $("allocationSummary").innerHTML=state.activePlanId
    ? `<strong>計畫總額：${money.format(total)}</strong>　已編列：${money.format(allocated)}　尚未編列：${money.format(total-allocated)}`
    : "請先建立計畫。";

  if(!state.activePlanId){ $("categoryAdminList").innerHTML='<div class="empty">請先建立計畫。</div>'; return; }
  if(!state.categories.length){ $("categoryAdminList").innerHTML='<div class="empty">此計畫尚未建立經費項目。</div>'; return; }

  $("categoryAdminList").innerHTML=state.categories.map(c=>{
    const recs=state.records.filter(r=>r.categoryId===c.id);
    const actual=actualTotal(recs), estimated=estimatedTotal(recs);
    return `<div class="admin-row">
      <div><strong>${esc(c.name)}</strong><small>${c.active===false?'已停用':'啟用中'}</small></div>
      <div><small>編列額度</small><strong>${money.format(c.budget||0)}</strong></div>
      <div><small>已核銷</small><strong>${money.format(actual)}</strong></div>
      <div><small>已預估</small><strong>${money.format(estimated)}</strong></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
        <button class="link-btn" data-edit-category="${c.id}">調整</button>
        <button class="link-btn danger" data-delete-category="${c.id}">刪除</button>
      </div>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-edit-category]").forEach(b=>b.addEventListener("click",()=>openEditCategory(b.dataset.editCategory)));
  document.querySelectorAll("[data-delete-category]").forEach(b=>b.addEventListener("click",()=>deleteCategory(b.dataset.deleteCategory)));
}

function openNewPlan(){
  $("planForm").reset();
  $("planId").value="";
  $("planYear").value="115";
  $("planTotalBudget").value="";
  $("planActive").checked=true;
  $("planDialogTitle").textContent="建立計畫";
  $("planDialog").showModal();
}

function openEditPlan(){
  const p=currentPlan(); if(!p)return;
  $("planId").value=p.id;
  $("planName").value=p.name||"";
  $("planYear").value=p.year||"";
  $("planTerm").value=p.term||"年度";
  $("planTotalBudget").value=Number(p.totalBudget||0);
  $("planActive").checked=p.active!==false;
  $("planDialogTitle").textContent="調整計畫";
  $("planDialog").showModal();
}

async function savePlan(e){
  e.preventDefault();
  if(!isManager()) return;
  const id=$("planId").value;
  const old=id?state.plans.find(x=>x.id===id):null;
  const totalBudget=Number($("planTotalBudget").value||0);
  if(totalBudget<0) return toast("計畫總額不可小於 0");
  if(id && totalBudget<allocatedTotal()) return toast(`計畫總額不可低於目前已編列的 ${money.format(allocatedTotal())}`,5000);

  const data={
    name:$("planName").value.trim(),
    year:$("planYear").value.trim(),
    term:$("planTerm").value,
    totalBudget,
    active:$("planActive").checked,
    updatedAt:serverTimestamp(),
    updatedBy:state.user.email.toLowerCase()
  };
  try{
    let targetId=id;
    if(id) await updateDoc(doc(db,"budgetPlans",id),data);
    else{
      const ref=await addDoc(collection(db,"budgetPlans"),{...data,createdAt:serverTimestamp(),createdBy:state.user.email.toLowerCase()});
      targetId=ref.id;
    }
    await addDoc(collection(db,"auditLogs"),{
      type:"budget-plan",targetId,action:id?"update":"create",
      before:old?{name:old.name||"",year:old.year||"",term:old.term||"",totalBudget:Number(old.totalBudget||0),active:old.active!==false}:null,
      after:{name:data.name,year:data.year,term:data.term,totalBudget:data.totalBudget,active:data.active},
      actorEmail:state.user.email.toLowerCase(),createdAt:serverTimestamp()
    });
    $("planDialog").close();
    await loadPlans();
    state.activePlanId=targetId;
    await loadPlanData();
    renderAll();
    toast("計畫已儲存");
  }catch(err){ console.error(err); toast(`儲存失敗：${err.message}`,5000); }
}

async function deleteCurrentPlan(){
  if(!isManager() || !state.activePlanId) return;
  const plan=currentPlan();
  if(state.records.length>0){
    alert("此計畫已經有使用紀錄，為避免誤刪正式經費資料，不能刪除。可改為停用計畫。");
    return;
  }
  if(!confirm(`確定要刪除「${plan?.name||"此計畫"}」嗎？\n\n此動作會同時刪除該計畫底下尚未使用的經費項目。`)) return;
  if(!confirm("再次確認：刪除後無法復原。確定永久刪除？")) return;
  try{
    await addDoc(collection(db,"auditLogs"),{
      type:"budget-plan",targetId:state.activePlanId,action:"delete",
      before:{name:plan?.name||"",year:plan?.year||"",term:plan?.term||"",totalBudget:Number(plan?.totalBudget||0)},
      actorEmail:state.user.email.toLowerCase(),createdAt:serverTimestamp()
    });
    for(const c of state.categories) await deleteDoc(doc(db,"budgetCategories",c.id));
    await deleteDoc(doc(db,"budgetPlans",state.activePlanId));
    state.activePlanId="";
    state.categories=[];
    state.records=[];
    await loadPlans();
    await loadPlanData();
    renderAll();
    toast("計畫已刪除");
  }catch(err){ console.error(err); toast(`刪除失敗：${err.message}`,5000); }
}

function resetVoucherCheck(){
  state.aiVoucher={status:"idle",detectedAmount:null,page:null,message:"",file:null};
  $("recordVoucherFile").value="";
  $("aiAmountCheck").className="ai-check hidden";
  $("aiAmountCheck").innerHTML="";
  $("amountConfirmWrap").classList.add("hidden");
  $("recordAmountConfirm").checked=false;
  $("existingVoucherBox").classList.add("hidden");
  $("existingVoucherBox").innerHTML="";
}

function openNewRecord(){
  if(!state.activePlanId)return toast("請先建立計畫");
  if(!isPlanActive())return toast("此計畫已停用，無法新增使用紀錄");
  if(!state.categories.some(c=>c.active!==false))return toast("此計畫尚未建立可使用的經費項目");
  $("recordForm").reset();
  resetVoucherCheck();
  $("recordId").value="";
  $("recordDialogTitle").textContent="新增使用紀錄";
  $("recordEstimated").checked=false;
  $("recordDialog").showModal();
}

function openEditRecord(id){
  const r=state.records.find(x=>x.id===id); if(!r)return;
  const canEdit=isManager()||r.ownerEmail===state.user.email.toLowerCase();
  if(!canEdit)return toast("只能修改自己建立的使用紀錄");
  $("recordForm").reset();
  resetVoucherCheck();
  $("recordId").value=id;
  $("recordCategory").value=r.categoryId||"";
  $("recordPurpose").value=r.purpose||"";
  $("recordAmount").value=r.amount||0;
  $("recordSemester").value=r.semester||"";
  $("recordEstimated").checked=r.estimated===true;
  $("recordArchived").checked=r.archived===true;
  $("recordNote").value=r.note||"";
  if(r.voucherUrl||r.folderUrl){
    $("existingVoucherBox").classList.remove("hidden");
    $("existingVoucherBox").innerHTML=`目前附件：<a class="text-link" target="_blank" rel="noopener" href="${escAttr(r.voucherUrl||r.folderUrl)}">${esc(r.voucherFileName||"查看既有核銷單據")}</a><br><small>如重新選擇檔案，儲存後會以新附件取代。</small>`;
  }
  if(Number.isFinite(Number(r.aiVoucherAmount))){
    state.aiVoucher.detectedAmount=Number(r.aiVoucherAmount);
    state.aiVoucher.page=r.aiVoucherPage||null;
    state.aiVoucher.status="done";
    state.aiVoucher.message="使用上次 AI 辨識結果";
    refreshAmountCheck();
  }
  $("recordDialogTitle").textContent="編輯使用紀錄";
  $("recordDialog").showModal();
}

async function deleteRecord(id){
  const r=state.records.find(x=>x.id===id); if(!r)return;
  const mine=r.ownerEmail===state.user.email.toLowerCase();
  if(!isManager()&&!mine)return toast("只能刪除自己建立的使用紀錄");
  if(!confirm(`確定刪除「${r.purpose||"此筆使用紀錄"}」？\n金額：${money.format(r.amount||0)}\n\n刪除後無法復原。`))return;
  try{
    await deleteDoc(doc(db,"expenseRecords",id));
    if(r.voucherStoragePath){
      await deleteObject(storageRef(storage,r.voucherStoragePath)).catch(()=>{});
    }
    await loadPlanData();
    renderAll();
    toast("使用紀錄已刪除");
  }catch(err){ console.error(err); toast(`刪除失敗：${err.message}`,5000); }
}

async function handleVoucherFileChange(){
  const file=$("recordVoucherFile").files?.[0];
  state.aiVoucher={status:"idle",detectedAmount:null,page:null,message:"",file:file||null};
  $("recordAmountConfirm").checked=false;
  $("amountConfirmWrap").classList.add("hidden");
  if(!file){
    $("aiAmountCheck").className="ai-check hidden";
    $("aiAmountCheck").innerHTML="";
    return;
  }
  if(file.size>15*1024*1024){
    $("recordVoucherFile").value="";
    return toast("核銷單據檔案不可超過 15 MB",5000);
  }
  await analyzeVoucherFile(file);
}

async function analyzeVoucherFile(file){
  const box=$("aiAmountCheck");
  box.className="ai-check checking";
  box.innerHTML="✨ AI 正在辨識核銷單據金額…";
  state.aiVoucher.status="checking";
  try{
    const result=await extractVoucherAmountFromFile(file);
    state.aiVoucher.status=result.amount!=null?"done":"uncertain";
    state.aiVoucher.detectedAmount=result.amount;
    state.aiVoucher.page=result.page||null;
    state.aiVoucher.message=result.message||"";
    refreshAmountCheck();
  }catch(err){
    console.error(err);
    state.aiVoucher.status="error";
    state.aiVoucher.detectedAmount=null;
    state.aiVoucher.message=err.message||"辨識失敗";
    refreshAmountCheck();
  }
}

function refreshAmountCheck(){
  const box=$("aiAmountCheck");
  const confirmWrap=$("amountConfirmWrap");
  const confirm=$("recordAmountConfirm");
  if(state.aiVoucher.status==="idle"){
    box.className="ai-check hidden";
    confirmWrap.classList.add("hidden");
    return;
  }
  if(state.aiVoucher.status==="checking"){
    box.className="ai-check checking";
    box.innerHTML="✨ AI 正在辨識核銷單據金額…";
    confirmWrap.classList.add("hidden");
    return;
  }
  const entered=Number($("recordAmount").value||0);
  const detected=state.aiVoucher.detectedAmount;
  if(Number.isFinite(detected)){
    if(entered===detected){
      box.className="ai-check ok";
      box.innerHTML=`✓ AI 辨識：${money.format(detected)}${state.aiVoucher.page?`（第 ${state.aiVoucher.page} 頁）`:""}，與輸入金額一致。`;
      confirmWrap.classList.add("hidden");
      confirm.checked=false;
    }else{
      box.className="ai-check warning";
      box.innerHTML=`⚠ AI 辨識：${money.format(detected)}${state.aiVoucher.page?`（第 ${state.aiVoucher.page} 頁）`:""}，與目前輸入的 ${money.format(entered)} 不一致。`;
      confirmWrap.classList.remove("hidden");
    }
  }else{
    box.className="ai-check warning";
    box.innerHTML=`⚠ AI 無法可靠辨識此核銷單據的「粘貼憑證用紙」合計金額。請人工確認輸入金額。`;
    confirmWrap.classList.remove("hidden");
  }
}

async function extractVoucherAmountFromFile(file){
  if(file.type.startsWith("image/")){
    const text=await ocrImageSource(file);
    const amount=parseVoucherAmount(text);
    return {amount,page:1,message:"圖片辨識"};
  }
  if(file.type!=="application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) throw new Error("目前核銷單據僅支援 PDF 或圖片");
  const bytes=await file.arrayBuffer();
  const pdf=await pdfjsLib.getDocument({data:bytes}).promise;
  const maxPages=Math.min(pdf.numPages,3);
  let fallback=null;
  for(let i=1;i<=maxPages;i++){
    const page=await pdf.getPage(i);
    let text="";
    try{
      const content=await page.getTextContent();
      text=content.items.map(x=>x.str||"").join(" ");
    }catch{}
    if(!looksLikeVoucherPage(text)){
      const canvas=document.createElement("canvas");
      const viewport=page.getViewport({scale:1.55});
      canvas.width=Math.ceil(viewport.width);
      canvas.height=Math.ceil(viewport.height);
      const ctx=canvas.getContext("2d",{willReadFrequently:true});
      await page.render({canvasContext:ctx,viewport}).promise;
      text=await ocrImageSource(canvas);
    }
    const amount=parseVoucherAmount(text);
    if(looksLikeVoucherPage(text) && amount!=null) return {amount,page:i,message:"找到粘貼憑證用紙"};
    if(amount!=null && fallback==null) fallback={amount,page:i,message:"未完整辨識表頭，採合計金額"};
  }
  return fallback||{amount:null,page:null,message:"找不到可辨識的粘貼憑證用紙合計"};
}

function looksLikeVoucherPage(text){
  const t=String(text||"").replace(/\s+/g,"");
  return t.includes("粘貼憑證用紙") || (t.includes("部門單位") && t.includes("健康與諮商中心") && t.includes("合計"));
}

function parseVoucherAmount(text){
  const raw=String(text||"").replace(/[，]/g,",");
  const compact=raw.replace(/\s+/g," ");
  const idx=Math.max(compact.lastIndexOf("合計"),compact.lastIndexOf("總計"));
  if(idx>=0){
    const tail=compact.slice(idx,idx+120);
    const nums=[...tail.matchAll(/(?:\$?\s*)?(\d{1,3}(?:[,\s]\d{3})+|\d{3,8})/g)]
      .map(m=>Number(m[1].replace(/[,\s]/g,""))).filter(n=>Number.isFinite(n)&&n>0);
    if(nums.length) return nums[nums.length-1];
  }
  const lines=raw.split(/\r?\n/).reverse();
  for(const line of lines){
    if(/合\s*計|總\s*計/.test(line)){
      const nums=[...line.matchAll(/(\d{1,3}(?:[,\s]\d{3})+|\d{3,8})/g)]
        .map(m=>Number(m[1].replace(/[,\s]/g,""))).filter(n=>Number.isFinite(n)&&n>0);
      if(nums.length) return nums[nums.length-1];
    }
  }
  return null;
}

async function ocrImageSource(source){
  if(!window.Tesseract) throw new Error("AI OCR 元件尚未載入，請重新整理後再試");
  const result=await window.Tesseract.recognize(source,"chi_tra+eng",{
    logger:m=>{
      if(m.status==="recognizing text"){
        const p=Math.round((m.progress||0)*100);
        $("aiAmountCheck").innerHTML=`✨ AI 正在辨識核銷單據金額… ${p}%`;
      }
    }
  });
  return result?.data?.text||"";
}

async function uploadVoucherFile(file){
  const email=state.user.email.toLowerCase();
  const safeName=file.name.replace(/[^\w.\-()（）一-龥]/g,"_");
  const unique=`${Date.now()}-${crypto.randomUUID?.()||Math.random().toString(36).slice(2)}`;
  const path=`vouchers/${state.activePlanId}/${email}/${unique}/${safeName}`;
  const ref=storageRef(storage,path);
  await uploadBytes(ref,file,{contentType:file.type||"application/octet-stream"});
  return {path,url:await getDownloadURL(ref),name:file.name};
}

async function saveRecord(e){
  e.preventDefault();
  const id=$("recordId").value;
  const existing=id?state.records.find(x=>x.id===id):null;
  if(!id && !isPlanActive()) return toast("此計畫已停用，無法新增使用紀錄",5000);
  if(existing && !isManager() && existing.ownerEmail!==state.user.email.toLowerCase()) return toast("只能修改自己建立的使用紀錄");

  const categoryId=$("recordCategory").value;
  const amount=Number($("recordAmount").value||0);
  const semester=$("recordSemester").value.trim();
  const estimated=$("recordEstimated").checked;
  const category=state.categories.find(c=>c.id===categoryId);
  if(!category) return toast("請選擇經費項目");
  if(!/^\d{3}-[12]$/.test(semester)) return toast("學期請輸入例如 114-2、115-1");
  const categoryUsedOther=state.records.filter(r=>r.categoryId===categoryId && r.id!==id).reduce((s,r)=>s+Number(r.amount||0),0);
  if(categoryUsedOther+amount>Number(category.budget||0)){
    return toast(`此筆會超過「${category.name}」編列額度，目前最多可登錄 ${money.format(Number(category.budget||0)-categoryUsedOther)}`,6000);
  }

  const selectedFile=$("recordVoucherFile").files?.[0]||null;
  const aiRequiresConfirm=selectedFile && (
    !Number.isFinite(state.aiVoucher.detectedAmount) ||
    Number(state.aiVoucher.detectedAmount)!==amount
  );
  if(state.aiVoucher.status==="checking") return toast("AI 尚在辨識核銷單據，請稍候");
  if(aiRequiresConfirm && !$("recordAmountConfirm").checked){
    return toast("AI 辨識金額有疑義，請先勾選「我已人工確認金額正確」",6000);
  }

  let uploaded=null;
  const oldStoragePath=existing?.voucherStoragePath||"";
  try{
    if(selectedFile){
      $("recordSaveBtn").disabled=true;
      $("recordSaveBtn").textContent="上傳中…";
      uploaded=await uploadVoucherFile(selectedFile);
    }
    const data={
      planId:state.activePlanId,
      categoryId,
      purpose:$("recordPurpose").value.trim(),
      amount,
      semester,
      estimated,
      archived:$("recordArchived").checked,
      note:$("recordNote").value.trim(),
      ownerEmail:existing?.ownerEmail||state.user.email.toLowerCase(),
      ownerName:existing?.ownerName||state.profile.name||state.user.displayName||state.user.email,
      createdBy:existing?.createdBy||state.user.email.toLowerCase(),
      updatedAt:serverTimestamp(),
      updatedBy:state.user.email.toLowerCase()
    };
    if(selectedFile && uploaded){
      data.voucherFileName=uploaded.name;
      data.voucherStoragePath=uploaded.path;
      data.voucherUrl=uploaded.url;
      data.aiVoucherAmount=Number.isFinite(state.aiVoucher.detectedAmount)?Number(state.aiVoucher.detectedAmount):null;
      data.aiVoucherPage=state.aiVoucher.page||null;
      data.amountManuallyConfirmed=aiRequiresConfirm;
    }
    if(id) await updateDoc(doc(db,"expenseRecords",id),data);
    else await addDoc(collection(db,"expenseRecords"),{...data,createdAt:serverTimestamp()});
    if(selectedFile && oldStoragePath && oldStoragePath!==uploaded?.path){
      await deleteObject(storageRef(storage,oldStoragePath)).catch(()=>{});
    }
    $("recordDialog").close();
    await loadPlanData();
    renderAll();
    toast("使用紀錄已儲存");
  }catch(err){
    console.error(err);
    if(uploaded?.path) await deleteObject(storageRef(storage,uploaded.path)).catch(()=>{});
    toast(`儲存失敗：${err.message}`,6000);
  }finally{
    $("recordSaveBtn").disabled=false;
    $("recordSaveBtn").textContent="儲存";
  }
}

function openNewCategory(){
  if(!state.activePlanId)return toast("請先建立計畫");
  if(!isPlanActive())return toast("此計畫已停用，無法新增經費項目");
  if(planTotal()<=0)return toast("請先在「調整計畫」設定計畫總核定額度");
  $("categoryForm").reset();
  $("categoryId").value="";
  $("categoryOrder").value=state.categories.length+1;
  $("categoryActive").checked=true;
  $("categoryDialogTitle").textContent="新增經費項目";
  $("categoryDialog").showModal();
}

function openEditCategory(id){
  const c=state.categories.find(x=>x.id===id); if(!c)return;
  $("categoryId").value=id;
  $("categoryName").value=c.name||"";
  $("categoryBudget").value=c.budget||0;
  $("categoryOrder").value=c.order||0;
  $("categoryActive").checked=c.active!==false;
  $("categoryReason").value="";
  $("categoryDialogTitle").textContent="調整經費項目";
  $("categoryDialog").showModal();
}

async function saveCategory(e){
  e.preventDefault();
  if(!isManager()) return;
  const id=$("categoryId").value;
  if(!id && !isPlanActive()) return toast("此計畫已停用，無法新增經費項目");
  const old=id?state.categories.find(x=>x.id===id):null;
  const budget=Number($("categoryBudget").value||0);
  const otherAllocated=state.categories.filter(c=>c.id!==id).reduce((s,c)=>s+Number(c.budget||0),0);
  const total=planTotal();
  if(total<=0) return toast("請先設定計畫總核定額度");
  if(otherAllocated+budget>total){
    return toast(`編列總額不可超過計畫總額 ${money.format(total)}；此項目最多可編列 ${money.format(total-otherAllocated)}`,6000);
  }
  const used=id?state.records.filter(r=>r.categoryId===id).reduce((s,r)=>s+Number(r.amount||0),0):0;
  if(budget<used) return toast(`此項目已登錄 ${money.format(used)}，編列額度不可低於已登錄金額`,5000);

  const data={
    planId:state.activePlanId,
    name:$("categoryName").value.trim(),
    budget,
    order:Number($("categoryOrder").value||0),
    active:$("categoryActive").checked,
    updatedAt:serverTimestamp(),
    updatedBy:state.user.email.toLowerCase()
  };
  try{
    let targetId=id;
    if(id) await updateDoc(doc(db,"budgetCategories",id),data);
    else {
      const ref=await addDoc(collection(db,"budgetCategories"),{...data,createdAt:serverTimestamp(),createdBy:state.user.email.toLowerCase()});
      targetId=ref.id;
    }
    await addDoc(collection(db,"auditLogs"),{
      type:"budget-category",targetId,planId:state.activePlanId,action:id?"update":"create",
      before:old?{name:old.name||"",budget:Number(old.budget||0),active:old.active!==false}:null,
      after:{name:data.name,budget:data.budget,active:data.active},
      reason:$("categoryReason").value.trim(),actorEmail:state.user.email.toLowerCase(),createdAt:serverTimestamp()
    });
    $("categoryDialog").close();
    await loadPlanData();
    renderAll();
    toast("經費項目已儲存");
  }catch(err){ console.error(err); toast(`儲存失敗：${err.message}`,5000); }
}

async function deleteCategory(id){
  if(!isManager()) return;
  const c=state.categories.find(x=>x.id===id); if(!c)return;
  const usedRecords=state.records.filter(r=>r.categoryId===id);
  if(usedRecords.length>0){
    alert(`「${c.name}」已有 ${usedRecords.length} 筆使用紀錄，不能刪除。可以改為停用。`);
    return;
  }
  if(!confirm(`確定刪除經費項目「${c.name}」？`)) return;
  try{
    await addDoc(collection(db,"auditLogs"),{
      type:"budget-category",targetId:id,planId:state.activePlanId,action:"delete",
      before:{name:c.name||"",budget:Number(c.budget||0),active:c.active!==false},
      actorEmail:state.user.email.toLowerCase(),createdAt:serverTimestamp()
    });
    await deleteDoc(doc(db,"budgetCategories",id));
    await loadPlanData();
    renderAll();
    toast("經費項目已刪除");
  }catch(err){ console.error(err); toast(`刪除失敗：${err.message}`,5000); }
}

function switchView(id){
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active-view",v.id===id));
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===id));
}

function toast(msg,ms=2500){
  const el=$("toast");
  el.textContent=msg;
  el.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer=setTimeout(()=>el.classList.add("hidden"),ms);
}

function esc(v){ return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m])); }
function escAttr(v){ return esc(v).replace(/'/g,"&#39;"); }
