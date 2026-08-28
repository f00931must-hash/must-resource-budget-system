// Budget UI state + category counts v1.2.9
// 1) Preserve current tab across refreshes/actions.
// 2) Show record counts in the category filter.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
const VIEW_KEY="must-budget-active-view-v129";
const VALID_VIEWS=new Set(["dashboard","records","budget","trash"]);
let db=null;
let auth=null;
let countTimer=null;
let booting=true;

function app(){ return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null; }
function visibleTab(view){
  const tab=document.querySelector(`.tab[data-view="${view}"]`);
  return tab && !tab.classList.contains("hidden");
}
function saveActiveView(view){
  if(!VALID_VIEWS.has(view)) return;
  try{ sessionStorage.setItem(VIEW_KEY,view); }catch{}
}
function getSavedView(){
  try{
    const v=sessionStorage.getItem(VIEW_KEY)||"";
    return VALID_VIEWS.has(v)?v:"";
  }catch{return "";}
}
function activeView(){ return document.querySelector(".view.active-view")?.id || ""; }
function applyView(view){
  if(!VALID_VIEWS.has(view) || !visibleTab(view)) return false;
  const section=document.getElementById(view);
  if(!section) return false;
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active-view",v.id===view));
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===view));
  saveActiveView(view);
  return true;
}
function restoreView(){
  const saved=getSavedView();
  if(saved) return applyView(saved);
  const current=activeView();
  if(current){ saveActiveView(current); return true; }
  return false;
}

// Capture user tab clicks immediately, before any action can reload the page.
document.addEventListener("click",e=>{
  const tab=e.target.closest?.(".tab[data-view]");
  if(tab){
    saveActiveView(tab.dataset.view||"");
    booting=false;
  }
},true);

let viewMutationTimer=null;
const viewObserver=new MutationObserver(()=>{
  clearTimeout(viewMutationTimer);
  viewMutationTimer=setTimeout(()=>{
    if(booting){
      // During startup do not let the default dashboard overwrite a previously saved tab.
      if(getSavedView()) restoreView();
      return;
    }
    const v=activeView();
    if(v) saveActiveView(v);
  },40);
});
viewObserver.observe(document.documentElement,{subtree:true,attributes:true,attributeFilter:["class"],childList:true});

document.addEventListener("DOMContentLoaded",()=>{
  setTimeout(()=>{ restoreView(); },80);
});
window.addEventListener("load",()=>{
  setTimeout(()=>{ restoreView(); },350);
});

function cleanOptionLabel(text){
  return String(text||"").replace(/（\d+）\s*$/u,"").trim();
}
function setOptionText(option,text){
  if((option.textContent||"")!==text) option.textContent=text;
}

async function syncCategoryCounts(){
  if(!db || !auth?.currentUser) return;
  const planId=document.getElementById("planSelect")?.value||"";
  const select=document.getElementById("filterCategory");
  if(!planId || !select) return;

  try{
    const snap=await getDocs(query(collection(db,"expenseRecords"),where("planId","==",planId)));
    const rows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.deleted!==true);
    const counts=new Map();
    for(const r of rows) counts.set(r.categoryId,(counts.get(r.categoryId)||0)+1);

    [...select.options].forEach((o,i)=>{
      if(i===0 || !o.value){
        setOptionText(o,`全部經費項目（${rows.length}）`);
        return;
      }
      const base=cleanOptionLabel(o.textContent||o.value);
      setOptionText(o,`${base}（${counts.get(o.value)||0}）`);
    });
  }catch(err){
    console.warn("category count sync failed",err);
  }
}

function scheduleCounts(delay=220){
  clearTimeout(countTimer);
  countTimer=setTimeout(syncCategoryCounts,delay);
}

async function init(){
  for(let i=0;i<120;i++){
    const a=app();
    if(a){ auth=getAuth(a); db=getFirestore(a); break; }
    await new Promise(r=>setTimeout(r,50));
  }
  if(!auth||!db) return;

  document.getElementById("planSelect")?.addEventListener("change",()=>scheduleCounts(260));
  const filter=document.getElementById("filterCategory");
  if(filter) new MutationObserver(()=>scheduleCounts(260)).observe(filter,{childList:true});

  onAuthStateChanged(auth,user=>{
    if(!user) return;
    setTimeout(()=>{
      restoreView();
      booting=false;
      scheduleCounts(320);
    },320);
  });
}

init();
