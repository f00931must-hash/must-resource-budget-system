import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, collection, addDoc, doc, getDoc, getDocs, updateDoc, deleteDoc, query, orderBy, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

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
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const UPLOAD_SERVICE_URL = "https://must-free-upload-service.f00931-must.workers.dev";
const $ = id => document.getElementById(id);
const state = { user:null, profile:null, plans:[], activePlanId:"", categories:[], records:[] };
const money = new Intl.NumberFormat("zh-TW", { style:"currency", currency:"TWD", maximumFractionDigits:0 });

$("loginBtn").addEventListener("click", async()=>{
  try { await signInWithPopup(auth, provider); }
  catch(e) { toast(`登入失敗：${e.message}`, 5000); }
});
$("logoutBtn").addEventListener("click", ()=>signOut(auth));
document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click", ()=>$(b.dataset.close).close()));
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click", ()=>switchView(b.dataset.view)));
$("planSelect").addEventListener("change", async()=>{ state.activePlanId=$("planSelect").value; await loadPlanData(); renderAll(); });
$("newPlanBtn").addEventListener("click", openNewPlan);
$("editPlanBtn").addEventListener("click", openEditPlan);
$("deletePlanBtn").addEventListener("click", deleteCurrentPlan);
$("planForm").addEventListener("submit", savePlan);
$("newRecordBtn").addEventListener("click", openNewRecord);
$("newCategoryBtn").addEventListener("click", openNewCategory);
$("recordForm").addEventListener("submit", saveRecord);
$("categoryForm").addEventListener("submit", saveCategory);
["filterCategory","filterSemester","filterReview","filterIssue","searchInput"].forEach(id=>$(id).addEventListener("input", renderRecords));
$("recordEstimated").addEventListener("change", updateRecordRequirements);
$("recordVoucherFile").addEventListener("change", ()=>{
  if($("recordVoucherFile").files?.[0]) $("recordArchived").checked = true;
  updateRecordRequirements();
});
$("batchDownloadBtn").addEventListener("click", batchDownloadVouchers);

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
    $("recordsHint").textContent="所有已授權老師都可查看全部使用紀錄；待核對資料可由本人修改，管理員核對完成後即鎖定。";
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

function isManager(){ return state.profile?.role === "manager"; }
function currentPlan(){ return state.plans.find(p=>p.id===state.activePlanId); }
function isPlanActive(){ return currentPlan()?.active !== false; }
function planTotal(){ return Number(currentPlan()?.totalBudget||0); }
function allocatedTotal(){ return state.categories.reduce((s,c)=>s+Number(c.budget||0),0); }
function isApproved(r){ return r.estimated!==true && (r.reviewStatus==="approved" || r.reviewed===true); }
function isPending(r){ return r.estimated!==true && !isApproved(r); }
function approvedTotal(records=state.records){ return records.filter(isApproved).reduce((s,r)=>s+Number(r.amount||0),0); }
function pendingTotal(records=state.records){ return records.filter(isPending).reduce((s,r)=>s+Number(r.amount||0),0); }
function estimatedTotal(records=state.records){ return records.filter(r=>r.estimated===true).reduce((s,r)=>s+Number(r.amount||0),0); }
function reservedTotal(records=state.records){ return records.reduce((s,r)=>s+Number(r.amount||0),0); }
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
  const active=isPlanActive(), hasPlan=!!state.activePlanId;
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
  const approved=approvedTotal();
  const pending=pendingTotal();
  const estimated=estimatedTotal();
  const remain=total-reservedTotal();
  const approvedRemain=total-approved;
  const missingVoucher=state.records.filter(r=>r.estimated!==true && !(r.voucherUrl||r.folderUrl)).length;
  const missingConfirm=state.records.filter(r=>r.estimated!==true && r.amountConfirmed!==true && r.amountManuallyConfirmed!==true).length;

  $("summaryCards").innerHTML=[
    ["計畫總核定額度",money.format(total)],
    ["已編列額度",money.format(allocated)],
    ["尚未編列",money.format(total-allocated)],
    ["已核銷",money.format(approved)],
    ["待核對",money.format(pending)],
    ["已預估",money.format(estimated)],
    ["計畫剩餘額度",money.format(remain)],
    ["已核銷餘額",money.format(approvedRemain)]
  ].map(([l,v])=>`<div class="summary-card"><span>${l}</span><strong>${v}</strong></div>`).join("");

  if(isManager()){
    $("adminTodoPanel").classList.remove("hidden");
    $("adminTodoPanel").innerHTML=`
      <div class="panel-head"><h3>管理員待辦檢查</h3><span class="muted">快速找出漏件</span></div>
      <div class="todo-grid">
        <button class="todo-card" data-quick-review="pending"><strong>${state.records.filter(isPending).length}</strong><span>待核對</span></button>
        <button class="todo-card" data-quick-issue="missingVoucher"><strong>${missingVoucher}</strong><span>缺少核銷單據</span></button>
        <button class="todo-card" data-quick-issue="unconfirmed"><strong>${missingConfirm}</strong><span>未確認 Key 金額</span></button>
        <button class="todo-card" data-quick-review="estimated"><strong>${state.records.filter(r=>r.estimated===true).length}</strong><span>預估待追蹤</span></button>
      </div>`;
    document.querySelectorAll("[data-quick-review]").forEach(b=>b.onclick=()=>{ switchView("records"); $("filterReview").value=b.dataset.quickReview; renderRecords(); });
    document.querySelectorAll("[data-quick-issue]").forEach(b=>b.onclick=()=>{ switchView("records"); $("filterIssue").value=b.dataset.quickIssue; renderRecords(); });
  }else $("adminTodoPanel").classList.add("hidden");

  $("categoryCount").textContent=`${state.categories.length} 個項目｜已編列 ${money.format(allocated)} / ${money.format(total)}`;
  if(!state.activePlanId){ $("budgetTableWrap").innerHTML='<div class="empty">尚未建立計畫。</div>'; return; }
  if(!state.categories.length){ $("budgetTableWrap").innerHTML='<div class="empty">此計畫尚未編列經費項目。</div>'; return; }

  const rows=state.categories.filter(c=>c.active!==false).map(c=>{
    const recs=state.records.filter(r=>r.categoryId===c.id);
    const approved=approvedTotal(recs), pending=pendingTotal(recs), estimated=estimatedTotal(recs);
    const rem=Number(c.budget||0)-reservedTotal(recs);
    return `<tr><td><strong>${esc(c.name)}</strong></td><td class="amount">${money.format(c.budget||0)}</td><td class="amount">${money.format(approved)}</td><td class="amount">${money.format(pending)}</td><td class="amount">${money.format(estimated)}</td><td class="amount">${money.format(rem)}</td></tr>`;
  }).join("");
  $("budgetTableWrap").innerHTML=`<table><thead><tr><th>經費項目</th><th class="amount">編列額度</th><th class="amount">已核銷</th><th class="amount">待核對</th><th class="amount">已預估</th><th class="amount">剩餘</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderCategoryOptions(){
  const active=state.categories.filter(c=>c.active!==false);
  const opts=active.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");
  $("recordCategory").innerHTML=`<option value="">請選擇</option>${opts}`;
  const current=$(("filterCategory")).value;
  $("filterCategory").innerHTML=`<option value="">全部經費項目</option>${opts}`;
  if(active.some(c=>c.id===current)) $("filterCategory").value=current;
}

function renderSemesterOptions(){
  const current=$("filterSemester").value;
  const semesters=[...new Set(state.records.map(r=>String(r.semester||"").trim()).filter(Boolean))].sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  $("filterSemester").innerHTML='<option value="">全部學期</option>'+semesters.map(s=>`<option value="${escAttr(s)}">${esc(s)}</option>`).join("");
  if(semesters.includes(current)) $("filterSemester").value=current;
}

function filteredRecords(){
  const cat=$("filterCategory").value;
  const semester=$("filterSemester").value;
  const review=$("filterReview").value;
  const issue=$("filterIssue").value;
  const term=$("searchInput").value.trim().toLowerCase();
  let rows=[...state.records];
  if(cat) rows=rows.filter(r=>r.categoryId===cat);
  if(semester) rows=rows.filter(r=>String(r.semester||"")===semester);
  if(review==="approved") rows=rows.filter(isApproved);
  if(review==="pending") rows=rows.filter(isPending);
  if(review==="estimated") rows=rows.filter(r=>r.estimated===true);
  if(issue==="missingVoucher") rows=rows.filter(r=>r.estimated!==true && !(r.voucherUrl||r.folderUrl));
  if(issue==="unconfirmed") rows=rows.filter(r=>r.estimated!==true && r.amountConfirmed!==true && r.amountManuallyConfirmed!==true);
  if(term) rows=rows.filter(r=>[r.purpose,r.ownerName,r.ownerEmail,r.semester].some(v=>String(v||"").toLowerCase().includes(term)));
  return rows.sort((a,b)=>tsMillis(b.createdAt)-tsMillis(a.createdAt) || String(b.semester||"").localeCompare(String(a.semester||"")));
}

function renderRecords(){
  const rows=filteredRecords();
  $("batchDownloadBtn").classList.toggle("hidden",!isManager());
  $("batchDownloadBtn").disabled=!rows.some(r=>r.voucherUrl||r.folderUrl);
  if(!state.activePlanId){ $("recordList").innerHTML='<div class="panel empty">尚未建立計畫。</div>'; return; }
  if(!rows.length){ $("recordList").innerHTML='<div class="panel empty">目前沒有符合條件的使用紀錄。</div>'; return; }

  $("recordList").innerHTML=rows.map(r=>{
    const c=state.categories.find(x=>x.id===r.categoryId);
    const mine=r.ownerEmail===state.user.email.toLowerCase();
    const approved=isApproved(r);
    const canEdit=!approved && (isManager()||mine);
    const evidenceUrl=r.voucherUrl||r.folderUrl||"";
    const statusBadge=r.estimated===true
      ? '<span class="status estimated">預估</span>'
      : approved ? '<span class="status done">已核銷・已鎖定</span>' : '<span class="status pending">待管理員核對</span>';
    const issues=(r.estimated!==true && !evidenceUrl?'<span class="status danger-badge">缺單據</span>':'')+
      (r.estimated!==true && r.amountConfirmed!==true && r.amountManuallyConfirmed!==true?'<span class="status danger-badge">未確認金額</span>':'');
    let actions="";
    if(canEdit) actions+=`<button class="link-btn" data-edit-record="${r.id}">編輯</button><button class="link-btn danger" data-delete-record="${r.id}">刪除</button>`;
    if(isManager() && !r.estimated && !approved) actions+=`<button class="link-btn approve" data-approve-record="${r.id}">核對完成</button>`;
    if(isManager() && approved) actions+=`<button class="link-btn unlock" data-unlock-record="${r.id}">解鎖</button>`;
    return `<article class="record-card ${approved?'locked':''}">
      <div><div class="title">${esc(r.purpose||"未填用途")}</div><small>${esc(c?.name||"未分類")}｜${esc(r.ownerName||r.ownerEmail||"")}</small></div>
      <div><strong>${money.format(r.amount||0)}</strong><small>學期：${esc(r.semester||"未填")}</small></div>
      <div>${statusBadge}${issues}</div>
      <div><small>核銷單據</small><div>${evidenceUrl?`<a class="text-link" target="_blank" rel="noopener" href="${escAttr(evidenceUrl)}">${esc(r.voucherFileName||"查看附件")}</a>`:"—"}</div></div>
      <div class="record-actions">${actions}</div>
    </article>`;
  }).join("");
  document.querySelectorAll("[data-edit-record]").forEach(b=>b.onclick=()=>openEditRecord(b.dataset.editRecord));
  document.querySelectorAll("[data-delete-record]").forEach(b=>b.onclick=()=>deleteRecord(b.dataset.deleteRecord));
  document.querySelectorAll("[data-approve-record]").forEach(b=>b.onclick=()=>approveRecord(b.dataset.approveRecord));
  document.querySelectorAll("[data-unlock-record]").forEach(b=>b.onclick=()=>unlockRecord(b.dataset.unlockRecord));
}

function renderCategoryAdmin(){
  const total=planTotal(), allocated=allocatedTotal();
  $("allocationSummary").innerHTML=state.activePlanId?`<strong>計畫總額：${money.format(total)}</strong>　已編列：${money.format(allocated)}　尚未編列：${money.format(total-allocated)}`:"請先建立計畫。";
  if(!state.categories.length){ $("categoryAdminList").innerHTML='<div class="empty">此計畫尚未建立經費項目。</div>'; return; }
  $("categoryAdminList").innerHTML=state.categories.map(c=>{
    const recs=state.records.filter(r=>r.categoryId===c.id);
    return `<div class="admin-row">
      <div><strong>${esc(c.name)}</strong><small>${c.active===false?'已停用':'啟用中'}</small></div>
      <div><small>編列額度</small><strong>${money.format(c.budget||0)}</strong></div>
      <div><small>已核銷</small><strong>${money.format(approvedTotal(recs))}</strong></div>
      <div><small>待核對＋預估</small><strong>${money.format(pendingTotal(recs)+estimatedTotal(recs))}</strong></div>
      <div><button class="link-btn" data-edit-category="${c.id}">調整</button> <button class="link-btn danger" data-delete-category="${c.id}">刪除</button></div>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-edit-category]").forEach(b=>b.onclick=()=>openEditCategory(b.dataset.editCategory));
  document.querySelectorAll("[data-delete-category]").forEach(b=>b.onclick=()=>deleteCategory(b.dataset.deleteCategory));
}

function openNewPlan(){
  $("planForm").reset(); $("planId").value=""; $("planYear").value="115"; $("planTotalBudget").value=""; $("planActive").checked=true;
  $("planDialogTitle").textContent="建立計畫"; $("planDialog").showModal();
}
function openEditPlan(){
  const p=currentPlan(); if(!p)return;
  $("planId").value=p.id; $("planName").value=p.name||""; $("planYear").value=p.year||""; $("planTerm").value=p.term||"年度";
  $("planTotalBudget").value=Number(p.totalBudget||0); $("planActive").checked=p.active!==false; $("planDialogTitle").textContent="調整計畫"; $("planDialog").showModal();
}
async function savePlan(e){
  e.preventDefault(); if(!isManager()) return;
  const id=$("planId").value, old=id?state.plans.find(x=>x.id===id):null, totalBudget=Number($("planTotalBudget").value||0);
  if(totalBudget<0) return toast("計畫總額不可小於 0");
  if(id && totalBudget<allocatedTotal()) return toast(`計畫總額不可低於目前已編列的 ${money.format(allocatedTotal())}`,5000);
  const data={name:$("planName").value.trim(),year:$("planYear").value.trim(),term:$("planTerm").value,totalBudget,active:$("planActive").checked,updatedAt:serverTimestamp(),updatedBy:state.user.email.toLowerCase()};
  try{
    let targetId=id;
    if(id) await updateDoc(doc(db,"budgetPlans",id),data);
    else { const ref=await addDoc(collection(db,"budgetPlans"),{...data,createdAt:serverTimestamp(),createdBy:state.user.email.toLowerCase()}); targetId=ref.id; }
    await addDoc(collection(db,"auditLogs"),{type:"budget-plan",targetId,action:id?"update":"create",before:old?{name:old.name||"",year:old.year||"",term:old.term||"",totalBudget:Number(old.totalBudget||0),active:old.active!==false}:null,after:{name:data.name,year:data.year,term:data.term,totalBudget:data.totalBudget,active:data.active},actorEmail:state.user.email.toLowerCase(),createdAt:serverTimestamp()});
    $("planDialog").close(); await loadPlans(); state.activePlanId=targetId; await loadPlanData(); renderAll(); toast("計畫已儲存");
  }catch(err){ console.error(err); toast(`儲存失敗：${err.message}`,5000); }
}
async function deleteCurrentPlan(){
  if(!isManager()||!state.activePlanId)return;
  const p=currentPlan();
  if(state.records.length){ alert("此計畫已有使用紀錄，不能刪除。可改為停用計畫。"); return; }
  if(!confirm(`確定要刪除「${p?.name||"此計畫"}」嗎？`))return;
  try{
    for(const c of state.categories) await deleteDoc(doc(db,"budgetCategories",c.id));
    await deleteDoc(doc(db,"budgetPlans",state.activePlanId)); state.activePlanId=""; await loadPlans(); await loadPlanData(); renderAll(); toast("計畫已刪除");
  }catch(err){ toast(`刪除失敗：${err.message}`,5000); }
}

function openNewRecord(){
  if(!state.activePlanId)return toast("請先建立計畫");
  if(!isPlanActive())return toast("此計畫已停用，無法新增使用紀錄");
  if(!state.categories.some(c=>c.active!==false))return toast("此計畫尚未建立可使用的經費項目");
  $("recordForm").reset(); $("recordId").value=""; $("recordDialogTitle").textContent="新增使用紀錄";
  $("existingVoucherBox").classList.add("hidden"); $("existingVoucherBox").innerHTML=""; updateRecordRequirements(); $("recordDialog").showModal();
}
function openEditRecord(id){
  const r=state.records.find(x=>x.id===id); if(!r)return;
  if(isApproved(r))return toast("此筆已核銷並鎖定，請先由管理員解鎖");
  if(!isManager() && r.ownerEmail!==state.user.email.toLowerCase())return toast("只能修改自己建立的使用紀錄");
  $("recordForm").reset(); $("recordId").value=id; $("recordCategory").value=r.categoryId||""; $("recordPurpose").value=r.purpose||"";
  $("recordAmount").value=r.amount||0; $("recordSemester").value=r.semester||""; $("recordEstimated").checked=r.estimated===true;
  $("recordArchived").checked=r.archived===true || !!(r.voucherUrl||r.folderUrl);
  $("recordAmountConfirm").checked=r.amountConfirmed===true || r.amountManuallyConfirmed===true; $("recordNote").value=r.note||"";
  if(r.voucherUrl||r.folderUrl){
    $("existingVoucherBox").classList.remove("hidden");
    $("existingVoucherBox").innerHTML=`目前附件：<a class="text-link" target="_blank" rel="noopener" href="${escAttr(r.voucherUrl||r.folderUrl)}">${esc(r.voucherFileName||"查看既有核銷單據")}</a><br><small>如重新選擇檔案，儲存後會以新附件取代。</small>`;
  }else { $("existingVoucherBox").classList.add("hidden"); $("existingVoucherBox").innerHTML=""; }
  $("recordDialogTitle").textContent="編輯使用紀錄"; updateRecordRequirements(); $("recordDialog").showModal();
}
function updateRecordRequirements(){
  const estimated=$("recordEstimated").checked;
  $("manualConfirmWrap").classList.toggle("hidden",estimated);
  $("uploadConfirmWrap").classList.toggle("hidden",estimated);
  $("voucherRequirementHint").textContent=estimated
    ? "預估金額可先不附核銷單據，也不需要勾選金額確認。"
    : "正式送核銷前，請上傳核銷單據並確認單據金額與 Key 的金額相同。";
}

async function uploadServiceRequest(path,options={}){
  if(!state.user)throw new Error("尚未登入，請重新登入後再試。");
  const token=await state.user.getIdToken(true);
  const headers=new Headers(options.headers||{}); headers.set("Authorization","Bearer "+token);
  const res=await fetch(UPLOAD_SERVICE_URL+path,{...options,headers});
  const data=await res.json().catch(()=>({}));
  if(!res.ok||data.ok===false)throw new Error(data.error||`上傳服務錯誤（${res.status}）`);
  return data;
}
function githubPathFromUrl(v){
  if(!v)return "";
  if(!/^https?:\/\//.test(v))return String(v).replace(/^\/+/,'');
  try{ const p=new URL(v).pathname.split('/').filter(Boolean),i=p.indexOf('uploads'); if(i!==-1)return p.slice(i).join('/'); }catch{}
  return "";
}
async function githubDeleteFile(pathOrUrl,name="file"){
  const path=githubPathFromUrl(pathOrUrl); if(!path)return false;
  await uploadServiceRequest("/delete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path,name})}); return true;
}
async function uploadVoucherFile(file){
  const form=new FormData(); form.append("file",file); form.append("system","shared");
  form.append("category",file.type.startsWith("image/")?"images":"attachments");
  form.append("referenceId",$("recordId").value||("pending-"+Date.now())); form.append("subfolder","budget/reimbursement-vouchers");
  const data=await uploadServiceRequest("/upload",{method:"POST",body:form}), u=data.file||{};
  return {path:u.path||githubPathFromUrl(u.url),url:u.url||"",name:u.name||file.name,size:Number(u.size||file.size||0),type:u.type||file.type||""};
}

async function saveRecord(e){
  e.preventDefault();
  const id=$("recordId").value, existing=id?state.records.find(x=>x.id===id):null;
  if(!id&&!isPlanActive())return toast("此計畫已停用，無法新增使用紀錄");
  if(existing&&isApproved(existing))return toast("此筆已核銷並鎖定，請先解鎖");
  if(existing&&!isManager()&&existing.ownerEmail!==state.user.email.toLowerCase())return toast("只能修改自己建立的使用紀錄");
  const categoryId=$("recordCategory").value, amount=Number($("recordAmount").value||0), semester=$("recordSemester").value.trim(), estimated=$("recordEstimated").checked;
  const cat=state.categories.find(c=>c.id===categoryId); if(!cat)return toast("請選擇經費項目");
  if(!/^\d{3}-[12]$/.test(semester))return toast("學期請輸入例如 114-2、115-1");
  const other=state.records.filter(r=>r.categoryId===categoryId&&r.id!==id).reduce((s,r)=>s+Number(r.amount||0),0);
  if(other+amount>Number(cat.budget||0))return toast(`此筆會超過「${cat.name}」編列額度`,5000);
  const file=$("recordVoucherFile").files?.[0]||null, oldUrl=existing?.voucherUrl||existing?.folderUrl||"";
  if(file&&file.size>20*1024*1024)return toast("核銷單據檔案不可超過 20 MB",5000);
  if(!estimated){
    if(!file&&!oldUrl)return toast("正式核銷紀錄請先上傳核銷單據");
    if(!$("recordArchived").checked)return toast("請先勾選「我已上傳核銷單據」");
    if(!$("recordAmountConfirm").checked)return toast("請先確認核銷單據是否與 Key 的金額相同",5000);
  }
  let uploaded=null; const oldPath=existing?.voucherPath||existing?.voucherStoragePath||githubPathFromUrl(oldUrl);
  try{
    if(file){ $("recordSaveBtn").disabled=true; $("recordSaveBtn").textContent="附件上傳中…"; uploaded=await uploadVoucherFile(file); }
    const data={planId:state.activePlanId,categoryId,purpose:$("recordPurpose").value.trim(),amount,semester,estimated,
      archived:estimated?false:$("recordArchived").checked,amountConfirmed:estimated?false:$("recordAmountConfirm").checked,
      reviewStatus:estimated?"estimated":"pending",reviewed:false,locked:false,note:$("recordNote").value.trim(),
      ownerEmail:existing?.ownerEmail||state.user.email.toLowerCase(),ownerName:existing?.ownerName||state.profile.name||state.user.displayName||state.user.email,
      createdBy:existing?.createdBy||state.user.email.toLowerCase(),updatedAt:serverTimestamp(),updatedBy:state.user.email.toLowerCase()};
    if(uploaded){ data.voucherFileName=uploaded.name; data.voucherPath=uploaded.path; data.voucherStoragePath=uploaded.path; data.voucherUrl=uploaded.url; data.voucherFileSize=uploaded.size; data.voucherFileType=uploaded.type; }
    if(id)await updateDoc(doc(db,"expenseRecords",id),data); else await addDoc(collection(db,"expenseRecords"),{...data,createdAt:serverTimestamp()});
    if(file&&oldPath&&oldPath!==uploaded.path)await githubDeleteFile(oldPath,existing?.voucherFileName||"voucher").catch(()=>{});
    $("recordDialog").close(); await loadPlanData(); renderAll(); toast(estimated?"預估紀錄已儲存":"已送出，等待管理員核對");
  }catch(err){
    console.error(err); if(uploaded?.path)await githubDeleteFile(uploaded.path,uploaded.name).catch(()=>{}); toast(`儲存失敗：${err.message}`,6000);
  }finally{ $("recordSaveBtn").disabled=false; $("recordSaveBtn").textContent="儲存"; }
}

async function deleteRecord(id){
  const r=state.records.find(x=>x.id===id); if(!r)return;
  if(isApproved(r))return toast("此筆已核銷並鎖定，請先由管理員解鎖");
  if(!isManager()&&r.ownerEmail!==state.user.email.toLowerCase())return toast("只能刪除自己建立的使用紀錄");
  if(!confirm(`確定刪除「${r.purpose||"此筆"}」？\n金額：${money.format(r.amount||0)}\n\n刪除後無法復原。`))return;
  try{
    await deleteDoc(doc(db,"expenseRecords",id));
    const p=r.voucherPath||r.voucherStoragePath||githubPathFromUrl(r.voucherUrl||r.folderUrl||"");
    if(p)await githubDeleteFile(p,r.voucherFileName||"voucher").catch(()=>{});
    await loadPlanData(); renderAll(); toast("使用紀錄已刪除");
  }catch(err){ toast(`刪除失敗：${err.message}`,5000); }
}

async function approveRecord(id){
  if(!isManager())return;
  const r=state.records.find(x=>x.id===id); if(!r||r.estimated===true)return;
  if(!(r.voucherUrl||r.folderUrl))return toast("此筆缺少核銷單據，不能核對完成");
  if(r.amountConfirmed!==true&&r.amountManuallyConfirmed!==true)return toast("此筆尚未確認核銷單據與 Key 金額相同");
  if(!confirm(`確認「${r.purpose||"此筆"}」核對完成？\n${money.format(r.amount||0)}\n\n完成後會鎖定。`))return;
  try{
    await updateDoc(doc(db,"expenseRecords",id),{reviewStatus:"approved",reviewed:true,locked:true,reviewedAt:serverTimestamp(),reviewedBy:state.user.email.toLowerCase(),updatedAt:serverTimestamp(),updatedBy:state.user.email.toLowerCase()});
    await addDoc(collection(db,"auditLogs"),{type:"expense-review",targetId:id,planId:state.activePlanId,action:"approve",actorEmail:state.user.email.toLowerCase(),createdAt:serverTimestamp()});
    await loadPlanData(); renderAll(); toast("已核對完成並鎖定");
  }catch(err){ toast(`核對失敗：${err.message}`,5000); }
}

async function unlockRecord(id){
  if(!isManager())return;
  const r=state.records.find(x=>x.id===id); if(!r||!isApproved(r))return;
  if(!confirm(`確定解鎖「${r.purpose||"此筆"}」？\n解鎖後會回到「待核對」。`))return;
  try{
    await updateDoc(doc(db,"expenseRecords",id),{reviewStatus:"pending",reviewed:false,locked:false,unlockedAt:serverTimestamp(),unlockedBy:state.user.email.toLowerCase(),updatedAt:serverTimestamp(),updatedBy:state.user.email.toLowerCase()});
    await addDoc(collection(db,"auditLogs"),{type:"expense-review",targetId:id,planId:state.activePlanId,action:"unlock",actorEmail:state.user.email.toLowerCase(),createdAt:serverTimestamp()});
    await loadPlanData(); renderAll(); toast("已解鎖，回到待核對");
  }catch(err){ toast(`解鎖失敗：${err.message}`,5000); }
}

async function batchDownloadVouchers(){
  if(!isManager())return;
  const rows=filteredRecords().filter(r=>r.voucherUrl||r.folderUrl);
  if(!rows.length)return toast("目前篩選結果沒有可下載的核銷單據");
  if(!window.JSZip)return toast("批次下載元件尚未載入，請重新整理後再試",5000);
  const btn=$("batchDownloadBtn"), zip=new JSZip(); btn.disabled=true;
  let ok=0, fail=0;
  for(let i=0;i<rows.length;i++){
    btn.textContent=`準備下載 ${i+1}/${rows.length}`;
    const r=rows[i];
    try{
      const res=await fetch(r.voucherUrl||r.folderUrl); if(!res.ok)throw new Error(String(res.status));
      const blob=await res.blob(), safe=s=>String(s||"").replace(/[\\/:*?\"<>|]/g,"_").slice(0,50);
      const ext=(r.voucherFileName||"file.pdf").split('.').pop();
      zip.file(`${safe(r.semester||"未填學期")}_${safe(r.ownerName||r.ownerEmail)}_${safe(r.purpose||"核銷單據")}_${r.id.slice(0,6)}.${ext}`,blob); ok++;
    }catch(e){ console.warn("download failed",r.id,e); fail++; }
  }
  if(ok){
    const out=await zip.generateAsync({type:"blob"}), a=document.createElement("a");
    a.href=URL.createObjectURL(out); a.download=`核銷單據_${currentPlan()?.year||""}_${new Date().toISOString().slice(0,10)}.zip`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),3000);
  }
  btn.disabled=false; btn.textContent="批次下載核銷單據"; toast(`已打包 ${ok} 份${fail?`，${fail} 份下載失敗`:""}`,5000);
}

function openNewCategory(){
  if(!state.activePlanId)return toast("請先建立計畫");
  if(!isPlanActive())return toast("此計畫已停用，無法新增經費項目");
  if(planTotal()<=0)return toast("請先在「調整計畫」設定計畫總核定額度");
  $("categoryForm").reset(); $("categoryId").value=""; $("categoryOrder").value=state.categories.length+1; $("categoryActive").checked=true; $("categoryDialogTitle").textContent="新增經費項目"; $("categoryDialog").showModal();
}
function openEditCategory(id){
  const c=state.categories.find(x=>x.id===id); if(!c)return;
  $("categoryId").value=id; $("categoryName").value=c.name||""; $("categoryBudget").value=c.budget||0; $("categoryOrder").value=c.order||0; $("categoryActive").checked=c.active!==false; $("categoryReason").value=""; $("categoryDialogTitle").textContent="調整經費項目"; $("categoryDialog").showModal();
}
async function saveCategory(e){
  e.preventDefault(); if(!isManager())return;
  const id=$("categoryId").value; if(!id&&!isPlanActive())return toast("此計畫已停用，無法新增經費項目");
  const old=id?state.categories.find(x=>x.id===id):null, budget=Number($("categoryBudget").value||0), other=state.categories.filter(c=>c.id!==id).reduce((s,c)=>s+Number(c.budget||0),0);
  if(other+budget>planTotal())return toast("編列總額不可超過計畫總額",5000);
  const used=id?state.records.filter(r=>r.categoryId===id).reduce((s,r)=>s+Number(r.amount||0),0):0;
  if(budget<used)return toast("編列額度不可低於已登錄金額",5000);
  const data={planId:state.activePlanId,name:$("categoryName").value.trim(),budget,order:Number($("categoryOrder").value||0),active:$("categoryActive").checked,updatedAt:serverTimestamp(),updatedBy:state.user.email.toLowerCase()};
  try{
    let targetId=id;
    if(id)await updateDoc(doc(db,"budgetCategories",id),data);
    else { const ref=await addDoc(collection(db,"budgetCategories"),{...data,createdAt:serverTimestamp(),createdBy:state.user.email.toLowerCase()}); targetId=ref.id; }
    await addDoc(collection(db,"auditLogs"),{type:"budget-category",targetId,planId:state.activePlanId,action:id?"update":"create",before:old?{name:old.name||"",budget:Number(old.budget||0),active:old.active!==false}:null,after:{name:data.name,budget:data.budget,active:data.active},reason:$("categoryReason").value.trim(),actorEmail:state.user.email.toLowerCase(),createdAt:serverTimestamp()});
    $("categoryDialog").close(); await loadPlanData(); renderAll(); toast("經費項目已儲存");
  }catch(err){ toast(`儲存失敗：${err.message}`,5000); }
}
async function deleteCategory(id){
  if(!isManager())return;
  const c=state.categories.find(x=>x.id===id); if(!c)return;
  if(state.records.some(r=>r.categoryId===id)){ alert("此項目已有使用紀錄，不能刪除。可改為停用。"); return; }
  if(!confirm(`確定刪除「${c.name||"此項目"}」？`))return;
  try{ await deleteDoc(doc(db,"budgetCategories",id)); await loadPlanData(); renderAll(); toast("經費項目已刪除"); }
  catch(err){ toast(`刪除失敗：${err.message}`,5000); }
}

function switchView(id){
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active-view",v.id===id));
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===id));
}
function toast(msg,ms=2500){
  const el=$("toast"); el.textContent=msg; el.classList.remove("hidden"); clearTimeout(window.__toastTimer); window.__toastTimer=setTimeout(()=>el.classList.add("hidden"),ms);
}
function esc(v){ return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m])); }
function escAttr(v){ return esc(v).replace(/'/g,"&#39;"); }
