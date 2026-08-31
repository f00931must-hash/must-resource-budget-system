// Budget advance startup + explicit refresh bridge v1.7.5
// No permanent observers, polling, repeated refreshes, or page reloads.
// The manager advance module refreshes after its own successful writes.
// This file only handles:
// 1) startup race when #advance is restored before #planSelect is ready;
// 2) one explicit refresh requested by helper modules after a successful write
//    such as unlink/delete allocation.

let explicitRefreshTimer=null;

function requestExplicitAdvanceRefresh(ms=80){
  clearTimeout(explicitRefreshTimer);
  explicitRefreshTimer=setTimeout(()=>{
    if(location.hash!=="#advance" && !document.getElementById("advance")?.classList.contains("active-view")) return;
    const plan=document.getElementById("planSelect")?.value||"";
    const tab=document.getElementById("advanceTab");
    if(!plan||!tab) return;
    // One synthetic click reuses the manager module's existing loadAll() path.
    // No observer or repeating timer is created.
    tab.click();
  },ms);
}

async function restoreAdvanceWhenPlanReady(){
  if(location.hash!=="#advance") return;

  // Bounded wait only during startup. No permanent observer or polling remains.
  for(let i=0;i<80;i++){
    const plan=document.getElementById("planSelect")?.value||"";
    const tab=document.getElementById("advanceTab");
    if(plan && tab){
      // Let the main app finish its current render, then request one fresh advance load.
      await new Promise(r=>setTimeout(r,80));
      tab.click();
      return;
    }
    await new Promise(r=>setTimeout(r,50));
  }
}

window.addEventListener("budget-advance-refresh",()=>requestExplicitAdvanceRefresh(80));

restoreAdvanceWhenPlanReady().catch(err=>console.warn("advance startup restore failed",err));

// Regular teachers get a separate allocation view with one action:
// confirm receipt of the allocated amount.
await import("./budget-my-advance-v170.js?v=1.7.5");
