// Budget advance startup bridge v1.7.3
// No observers, polling, synthetic plan changes, or post-save page reloads.
// The manager advance module already refreshes after successful writes.
// This file only handles the startup race where #advance is restored before
// the main app has populated #planSelect.

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

restoreAdvanceWhenPlanReady().catch(err=>console.warn("advance startup restore failed",err));

// Regular teachers get a separate allocation view with one action:
// confirm receipt of the allocated amount.
await import("./budget-my-advance-v170.js?v=1.7.3");
