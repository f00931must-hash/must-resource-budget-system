// Budget UI state + category counts v1.7.2
// 1) Preserve current tab across reload/actions using URL hash.
// 2) Show record counts in the category filter.
// 3) Preserve selected category filter per budget plan.
// 4) When restoring a category, dispatch both input + change so the main app actually rerenders.
// 5) Support manager advance, reminders, trash, and teacher own-allocation views.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import "./budget-manager-usability-v136.js?v=1.7.2";
import "./budget-manager-waiver-fix-v138.js?v=1.7.2";

const PROJECT_ID="must-resource-budget-system";
const VALID_VIEWS=new Set(["dashboard","records","budget","advance","trash","reminders","myAdvance"]);
const FILTER_KEY_PREFIX="must-budget-category-filter-v131:";
let db=null;
let auth=null;
let countTimer=null;
let restoreTimer=null;

function app(){ return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null; }
function hashView(){
  const v=String(location.hash||"").replace(/^#/,"");
  return VALID_VIEWS.has(v)?v:"";
}
function activeView(){ return document.querySelector(".view.active-view")?.id || ""; }
function canShow(view){
  const tab=document.querySelector(`.tab[data-view="${view}"]`);
  const section=document.getElementById(view);
  return !!tab && !!section && !tab.classList.contains("hidden");
}
function applyView(view){
  if(!VALID_VIEWS.has(view)||!canShow(view)) return false;
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active-view",v.id===view));
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===view));
  return true;
}
function enforceHashView(){ const v=hashView(); if(v) applyView(v); }
function setHashView(view){
  if(!VALID_VIEWS.has(view)) return;
  if(location.hash!==`#${view}`) history.replaceState(null,"",`#${view}`);
}

document.addEventListener("click",e=>{
  const tab=e.target.closest?.(".tab[data-view]");
  if(tab){ const view=tab.dataset.view||""; if(VALID_VIEWS.has(view)) setHashView(view); }
},true);
window.addEventListener("hashchange",enforceHashView);
document.addEventListener("DOMContentLoaded",()=>{
  if(!hashView()) setHashView(activeView()||"dashboard");
  [0,80,220,500,900,1500].forEach(ms=>setTimeout(enforceHashView,ms));
});
window.addEventListener("load",()=>[0,150,500,1000].forEach(ms=>setTimeout(enforceHashView,ms)));

function planId(){ return document.getElementById("planSelect")?.value||""; }
function filterKey(id=planId()){ return id?FILTER_KEY_PREFIX+id:""; }
function savedCategory(id=planId()){
  const key=filterKey(id); if(!key) return "";
  try{return sessionStorage.getItem(key)||"";}catch{return "";}
}
function saveCategory(value,id=planId()){
  const key=filterKey(id); if(!key) return;
  try{ sessionStorage.setItem(key,String(value||"")); }catch{}
}
function dispatchFilterChange(select){
  try{ select.dispatchEvent(new Event("input",{bubbles:true})); }catch{}
  try{ select.dispatchEvent(new Event("change",{bubbles:true})); }catch{}
}
function restoreCategoryFilter(){
  const select=document.getElementById("filterCategory");
  const id=planId();
  if(!select||!id) return;
  const wanted=savedCategory(id);
  if(!wanted) return;
  const exists=[...select.options].some(o=>o.value===wanted);
  if(exists){
    if(select.value!==wanted) select.value=wanted;
    dispatchFilterChange(select);
  }
}
function scheduleRestore(delay=80){
  clearTimeout(restoreTimer);
  restoreTimer=setTimeout(restoreCategoryFilter,delay);
}

function cleanOptionLabel(text){ return String(text||"").replace(/（\d+）\s*$/u,"").trim(); }
function setOptionText(option,text){ if((option.textContent||"")!==text) option.textContent=text; }

async function syncCategoryCounts(){
  if(!db || !auth?.currentUser) return;
  const id=planId();
  const select=document.getElementById("filterCategory");
  if(!id || !select) return;
  try{
    const snap=await getDocs(query(collection(db,"expenseRecords"),where("planId","==",id)));
    const rows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.deleted!==true);
    const counts=new Map();
    for(const r of rows) counts.set(r.categoryId,(counts.get(r.categoryId)||0)+1);
    [...select.options].forEach((o,i)=>{
      if(i===0 || !o.value){ setOptionText(o,`全部經費項目（${rows.length}）`); return; }
      const base=cleanOptionLabel(o.textContent||o.value);
      setOptionText(o,`${base}（${counts.get(o.value)||0}）`);
    });
    scheduleRestore(20);
  }catch(err){ console.warn("category count sync failed",err); }
}
function scheduleCounts(delay=220){ clearTimeout(countTimer); countTimer=setTimeout(syncCategoryCounts,delay); }

async function init(){
  for(let i=0;i<120;i++){
    const a=app();
    if(a){ auth=getAuth(a); db=getFirestore(a); break; }
    await new Promise(r=>setTimeout(r,50));
  }
  if(!auth||!db) return;

  const plans=document.getElementById("planSelect");
  plans?.addEventListener("change",()=>{
    scheduleCounts(260);
    [80,220,450,800].forEach(ms=>setTimeout(restoreCategoryFilter,ms));
  });

  const filter=document.getElementById("filterCategory");
  if(filter){
    filter.addEventListener("input",()=>saveCategory(filter.value));
    filter.addEventListener("change",()=>saveCategory(filter.value));
    new MutationObserver(()=>{
      scheduleCounts(260);
      scheduleRestore(100);
    }).observe(filter,{childList:true});
  }

  onAuthStateChanged(auth,user=>{
    if(!user) return;
    [120,320,700,1200].forEach(ms=>setTimeout(enforceHashView,ms));
    [180,420,800,1300].forEach(ms=>setTimeout(restoreCategoryFilter,ms));
    setTimeout(()=>scheduleCounts(320),320);
  });
}
init();
