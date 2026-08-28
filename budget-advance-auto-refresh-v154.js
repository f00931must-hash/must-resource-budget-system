// Budget advance auto refresh v1.5.5
// Refresh advance data without clicking tabs or changing navigation/hash.
// The main advance module already listens to #planSelect change and calls loadAll().

let timer=null;
let lastPlan="";
let lastDispatchAt=0;

function activeAdvance(){
  return location.hash==="#advance" || document.getElementById("advance")?.classList.contains("active-view");
}
function planSelect(){return document.getElementById("planSelect");}
function planValue(){return String(planSelect()?.value||"").trim();}
function schedule(ms=100,force=false){
  clearTimeout(timer);
  timer=setTimeout(()=>refresh(force),ms);
}
function refresh(force=false){
  if(!activeAdvance())return;
  const select=planSelect();
  const plan=planValue();
  if(!select||!plan)return;

  const now=Date.now();
  // Never click #advanceTab here. That caused repeated hash/navigation work.
  // Dispatch at most once per settled plan unless explicitly requested after a write.
  if(!force && plan===lastPlan)return;
  if(now-lastDispatchAt<250)return;
  lastPlan=plan;
  lastDispatchAt=now;
  select.dispatchEvent(new Event("change",{bubbles:true}));
}

function observePlan(){
  const select=planSelect();
  if(!select)return false;

  // Main app populates/rebuilds this select asynchronously. Observe only until the
  // selected plan value actually changes; do not react to advance-page rendering.
  new MutationObserver(()=>{
    const plan=planValue();
    if(activeAdvance() && plan && plan!==lastPlan) schedule(120,false);
  }).observe(select,{childList:true,subtree:true});

  return true;
}

if(!observePlan()){
  const bodyObserver=new MutationObserver(()=>{
    if(observePlan())bodyObserver.disconnect();
  });
  bodyObserver.observe(document.body,{childList:true,subtree:true});
}

// When entering the advance page, wait for the main plan selector to settle, then
// refresh once. No tab.click(), no hash mutation, no navigation.
document.addEventListener("click",e=>{
  if(e.target?.closest?.("#advanceTab")) schedule(180,false);
},true);
window.addEventListener("hashchange",()=>{
  if(activeAdvance())schedule(180,false);
});
window.addEventListener("load",()=>{
  if(activeAdvance())schedule(250,false);
});

// Writes in advance-related modules may request a pure data refresh.
window.addEventListener("budget-advance-refresh",()=>schedule(120,true));
