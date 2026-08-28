// Budget advance auto refresh v1.5.4
// The advance module can initialize before #planSelect is populated by the main app.
// When the selected plan becomes available/changes while #advance is active, re-trigger
// the advance tab so its private loadAll() runs with the real plan id.

let timer=null;
let lastPlan="";
let lastRefreshAt=0;

function activeAdvance(){
  return location.hash==="#advance" || document.getElementById("advance")?.classList.contains("active-view");
}
function planValue(){return String(document.getElementById("planSelect")?.value||"").trim();}
function schedule(ms=80,force=false){
  clearTimeout(timer);
  timer=setTimeout(()=>refresh(force),ms);
}
function refresh(force=false){
  if(!activeAdvance())return;
  const plan=planValue();
  if(!plan)return;
  const tab=document.getElementById("advanceTab");
  if(!tab)return;
  const now=Date.now();
  // Avoid loops caused by the advance render itself. Refresh when plan becomes available,
  // when it changes, or when explicitly forced after navigation/load.
  if(!force && plan===lastPlan && now-lastRefreshAt<1200)return;
  lastPlan=plan;
  lastRefreshAt=now;
  tab.click();
}

function observePlan(){
  const select=document.getElementById("planSelect");
  if(!select)return false;
  select.addEventListener("input",()=>schedule(40,true));
  select.addEventListener("change",()=>schedule(40,true));
  new MutationObserver(()=>{
    const plan=planValue();
    if(plan && (plan!==lastPlan || activeAdvance())) schedule(80,plan!==lastPlan);
  }).observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:["selected","value"]});
  return true;
}

// The plan select exists in HTML, but its options/value are populated asynchronously.
if(!observePlan()){
  const bodyObserver=new MutationObserver(()=>{if(observePlan())bodyObserver.disconnect();});
  bodyObserver.observe(document.body,{childList:true,subtree:true});
}

document.addEventListener("click",e=>{
  if(e.target?.closest?.("#advanceTab")) [80,220,500].forEach(ms=>setTimeout(()=>refresh(true),ms));
},true);
window.addEventListener("hashchange",()=>{if(activeAdvance())[80,220,500].forEach(ms=>setTimeout(()=>refresh(true),ms));});
window.addEventListener("load",()=>{if(activeAdvance())[120,350,800,1400].forEach(ms=>setTimeout(()=>refresh(true),ms));});

// Modules can dispatch this after a write when they want an immediate refresh without reload.
window.addEventListener("budget-advance-refresh",()=>[0,100,300].forEach(ms=>setTimeout(()=>refresh(true),ms)));
