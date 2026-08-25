import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, collection, addDoc, doc, getDoc, getDocs, setDoc, updateDoc, query, orderBy, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

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

const $ = (id) => document.getElementById(id);
const state = { user: null, profile: null, categories: [], records: [] };
const money = new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 });

$("loginBtn").addEventListener("click", async () => {
  try { await signInWithPopup(auth, provider); }
  catch (e) { toast(`登入失敗：${e.message}`); }
});
$("logoutBtn").addEventListener("click", () => signOut(auth));

document.querySelectorAll("[data-close]").forEach(btn => btn.addEventListener("click", () => $(btn.dataset.close).close()));
document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => switchView(btn.dataset.view)));
$("newRecordBtn").addEventListener("click", openNewRecord);
$("newCategoryBtn").addEventListener("click", openNewCategory);
$("recordForm").addEventListener("submit", saveRecord);
$("categoryForm").addEventListener("submit", saveCategory);
["filterCategory","filterArchive","searchInput"].forEach(id => $(id).addEventListener("input", renderRecords));

onAuthStateChanged(auth, async user => {
  state.user = user;
  if (!user) {
    $("loginView").classList.remove("hidden");
    $("appView").classList.add("hidden");
    return;
  }
  try {
    const profileSnap = await getDoc(doc(db, "users", user.email.toLowerCase()));
    if (!profileSnap.exists() || profileSnap.data().enabled !== true) {
      await signOut(auth);
      alert("此 Google 帳號尚未獲授權使用經費系統，請洽經費管理員。");
      return;
    }
    state.profile = profileSnap.data();
    $("userName").textContent = state.profile.name || user.displayName || user.email;
    $("userEmail").textContent = user.email;
    $("roleBadge").textContent = isManager() ? "經費管理員" : "經費使用者";
    document.querySelectorAll(".manager-only").forEach(el => el.classList.toggle("hidden", !isManager()));
    $("recordsHint").textContent = isManager() ? "可查看全部老師的使用紀錄。" : "登錄自己已使用並完成學校核銷的經費。";
    $("loginView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    await loadAll();
  } catch (e) {
    console.error(e);
    toast("讀取系統資料失敗，請檢查 Firestore Rules。", 5000);
  }
});

function isManager(){ return state.profile?.role === "manager"; }

async function loadAll(){
  await Promise.all([loadCategories(), loadRecords()]);
  renderAll();
}

async function loadCategories(){
  const snap = await getDocs(query(collection(db,"budgetCategories"), orderBy("order","asc")));
  state.categories = snap.docs.map(d => ({id:d.id, ...d.data()}));
}

async function loadRecords(){
  const snap = await getDocs(collection(db,"expenseRecords"));
  state.records = snap.docs.map(d => ({id:d.id, ...d.data()}));
}

function renderAll(){
  renderDashboard();
  renderCategoryOptions();
  renderRecords();
  if(isManager()) renderCategoryAdmin();
}

function renderDashboard(){
  const activeCategories = state.categories.filter(c => c.active !== false);
  const totalBudget = activeCategories.reduce((s,c)=>s+Number(c.budget||0),0);
  const totalUsed = state.records.reduce((s,r)=>s+Number(r.amount||0),0);
  const pendingArchive = state.records.filter(r=>!r.archived).reduce((s,r)=>s+Number(r.amount||0),0);
  const remaining = totalBudget-totalUsed;
  $("summaryCards").innerHTML = [
    ["核定總額",money.format(totalBudget)],
    ["已登錄使用",money.format(totalUsed)],
    ["尚待憑證歸檔",money.format(pendingArchive)],
    ["剩餘額度",money.format(remaining)]
  ].map(([label,value])=>`<div class="summary-card"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("categoryCount").textContent = `${activeCategories.length} 個項目`;
  if(!activeCategories.length){ $("budgetTableWrap").innerHTML='<div class="empty">尚未建立經費項目。</div>'; return; }
  const rows = activeCategories.map(c=>{
    const used = state.records.filter(r=>r.categoryId===c.id).reduce((s,r)=>s+Number(r.amount||0),0);
    const remain = Number(c.budget||0)-used;
    return `<tr><td><strong>${esc(c.name)}</strong></td><td class="amount">${money.format(c.budget||0)}</td><td class="amount">${money.format(used)}</td><td class="amount">${money.format(remain)}</td></tr>`;
  }).join("");
  $("budgetTableWrap").innerHTML=`<table><thead><tr><th>經費項目</th><th class="amount">核定額度</th><th class="amount">已使用</th><th class="amount">剩餘</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderCategoryOptions(){
  const active = state.categories.filter(c=>c.active!==false);
  const options = active.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");
  $("recordCategory").innerHTML = `<option value="">請選擇</option>${options}`;
  $("filterCategory").innerHTML = `<option value="">全部經費項目</option>${options}`;
}

function renderRecords(){
  const cat = $("filterCategory").value;
  const arch = $("filterArchive").value;
  const term = $("searchInput").value.trim().toLowerCase();
  let rows = [...state.records];
  if(!isManager()) rows = rows.filter(r=>r.ownerEmail===state.user.email.toLowerCase());
  if(cat) rows = rows.filter(r=>r.categoryId===cat);
  if(arch==="done") rows=rows.filter(r=>r.archived===true);
  if(arch==="pending") rows=rows.filter(r=>r.archived!==true);
  if(term) rows=rows.filter(r=>[r.purpose,r.ownerName,r.ownerEmail,r.voucherNo].some(v=>String(v||"").toLowerCase().includes(term)));
  rows.sort((a,b)=>String(b.expenseDate||"").localeCompare(String(a.expenseDate||"")));
  if(!rows.length){ $("recordList").innerHTML='<div class="panel empty">目前沒有符合條件的使用紀錄。</div>'; return; }
  $("recordList").innerHTML = rows.map(r=>{
    const c = state.categories.find(x=>x.id===r.categoryId);
    const canEdit = isManager() || r.ownerEmail===state.user.email.toLowerCase();
    return `<article class="record-card">
      <div><div class="title">${esc(r.purpose||"未填用途")}</div><small>${esc(c?.name||"未分類")}｜${esc(r.ownerName||r.ownerEmail||"")}</small></div>
      <div><strong>${money.format(r.amount||0)}</strong><small>${esc(r.expenseDate||"")}</small></div>
      <div><span class="status ${r.archived?'done':'pending'}">${r.archived?'憑證已歸檔':'待憑證歸檔'}</span></div>
      <div><small>核銷單號</small><div>${esc(r.voucherNo||"—")}</div></div>
      <div class="record-actions">${r.folderUrl?`<a class="link-btn" target="_blank" rel="noopener" href="${escAttr(r.folderUrl)}">資料夾</a>`:""}${canEdit?`<button class="link-btn" data-edit-record="${r.id}">編輯</button>`:""}</div>
    </article>`;
  }).join("");
  document.querySelectorAll("[data-edit-record]").forEach(b=>b.addEventListener("click",()=>openEditRecord(b.dataset.editRecord)));
}

function renderCategoryAdmin(){
  if(!state.categories.length){ $("categoryAdminList").innerHTML='<div class="empty">尚未建立經費項目。</div>'; return; }
  $("categoryAdminList").innerHTML = state.categories.map(c=>{
    const used=state.records.filter(r=>r.categoryId===c.id).reduce((s,r)=>s+Number(r.amount||0),0);
    return `<div class="admin-row"><div><strong>${esc(c.name)}</strong><small>${c.active===false?'已停用':'啟用中'}</small></div><div><small>核定額度</small><strong>${money.format(c.budget||0)}</strong></div><div><small>已使用</small><strong>${money.format(used)}</strong></div><div><button class="link-btn" data-edit-category="${c.id}">調整</button></div></div>`;
  }).join("");
  document.querySelectorAll("[data-edit-category]").forEach(b=>b.addEventListener("click",()=>openEditCategory(b.dataset.editCategory)));
}

function openNewRecord(){
  $("recordForm").reset(); $("recordId").value=""; $("recordDialogTitle").textContent="新增使用紀錄";
  $("recordDate").value = new Date().toISOString().slice(0,10);
  $("recordDialog").showModal();
}
function openEditRecord(id){
  const r=state.records.find(x=>x.id===id); if(!r) return;
  $("recordId").value=id; $("recordCategory").value=r.categoryId||""; $("recordPurpose").value=r.purpose||""; $("recordAmount").value=r.amount||0;
  $("recordDate").value=r.expenseDate||""; $("recordVoucherNo").value=r.voucherNo||""; $("recordFolderUrl").value=r.folderUrl||""; $("recordArchived").checked=r.archived===true; $("recordNote").value=r.note||"";
  $("recordDialogTitle").textContent="編輯使用紀錄"; $("recordDialog").showModal();
}
async function saveRecord(e){
  e.preventDefault();
  const id=$("recordId").value;
  const existing=id?state.records.find(x=>x.id===id):null;
  if(existing && !isManager() && existing.ownerEmail!==state.user.email.toLowerCase()) return toast("無權修改此紀錄");
  const data={
    categoryId:$("recordCategory").value,purpose:$("recordPurpose").value.trim(),amount:Number($("recordAmount").value||0),expenseDate:$("recordDate").value,
    voucherNo:$("recordVoucherNo").value.trim(),folderUrl:$("recordFolderUrl").value.trim(),archived:$("recordArchived").checked,note:$("recordNote").value.trim(),
    ownerEmail:existing?.ownerEmail||state.user.email.toLowerCase(),ownerName:existing?.ownerName||state.profile.name||state.user.displayName||state.user.email,updatedAt:serverTimestamp(),updatedBy:state.user.email.toLowerCase()
  };
  try{
    if(id) await updateDoc(doc(db,"expenseRecords",id),data); else await addDoc(collection(db,"expenseRecords"),{...data,createdAt:serverTimestamp(),createdBy:state.user.email.toLowerCase()});
    $("recordDialog").close(); await loadRecords(); renderAll(); toast("使用紀錄已儲存");
  }catch(err){ console.error(err); toast(`儲存失敗：${err.message}`,5000); }
}

function openNewCategory(){ $("categoryForm").reset(); $("categoryId").value=""; $("categoryActive").checked=true; $("categoryDialogTitle").textContent="新增經費項目"; $("categoryDialog").showModal(); }
function openEditCategory(id){
  const c=state.categories.find(x=>x.id===id); if(!c)return;
  $("categoryId").value=id; $("categoryName").value=c.name||""; $("categoryBudget").value=c.budget||0; $("categoryOrder").value=c.order||0; $("categoryActive").checked=c.active!==false; $("categoryReason").value=""; $("categoryDialogTitle").textContent="調整經費項目"; $("categoryDialog").showModal();
}
async function saveCategory(e){
  e.preventDefault(); if(!isManager()) return;
  const id=$("categoryId").value;
  const old=id?state.categories.find(x=>x.id===id):null;
  const data={name:$("categoryName").value.trim(),budget:Number($("categoryBudget").value||0),order:Number($("categoryOrder").value||0),active:$("categoryActive").checked,updatedAt:serverTimestamp(),updatedBy:state.user.email.toLowerCase()};
  try{
    let targetId=id;
    if(id) await updateDoc(doc(db,"budgetCategories",id),data); else { const ref=await addDoc(collection(db,"budgetCategories"),{...data,createdAt:serverTimestamp()}); targetId=ref.id; }
    await addDoc(collection(db,"auditLogs"),{type:"budget-category",targetId,action:id?"update":"create",before:old?{name:old.name,budget:old.budget,active:old.active}:null,after:{name:data.name,budget:data.budget,active:data.active},reason:$("categoryReason").value.trim(),actorEmail:state.user.email.toLowerCase(),createdAt:serverTimestamp()});
    $("categoryDialog").close(); await loadCategories(); renderAll(); toast("經費項目已儲存");
  }catch(err){ console.error(err); toast(`儲存失敗：${err.message}`,5000); }
}

function switchView(id){
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active-view",v.id===id));
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===id));
}
function toast(msg,ms=2500){ const el=$("toast"); el.textContent=msg; el.classList.remove("hidden"); clearTimeout(window.__toastTimer); window.__toastTimer=setTimeout(()=>el.classList.add("hidden"),ms); }
function esc(v){return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m]));}
function escAttr(v){return esc(v).replace(/'/g,"&#39;");}
