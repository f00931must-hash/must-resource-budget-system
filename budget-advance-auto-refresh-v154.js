// Budget advance refresh bridge v1.7.1
// Keep the advance page lightweight: no MutationObserver and no polling.
// Only refresh once after an explicit write has successfully closed its dialog.

let timer=null;
let allocationSubmitPending=false;

function activeAdvance(){
  return location.hash==="#advance" || document.getElementById("advance")?.classList.contains("active-view");
}

function requestRefresh(ms=120){
  clearTimeout(timer);
  timer=setTimeout(()=>{
    if(!activeAdvance()) return;
    // Re-run the advance tab's existing loadAll() handler once.
    // This preserves the currently selected advance batch and avoids a second observer/query loop.
    document.getElementById("advanceTab")?.click();
  },ms);
}

function installPostSaveRefresh(){
  const form=document.getElementById("advanceAllocationForm");
  const dialog=document.getElementById("advanceAllocationDialog");
  if(!form||!dialog) return false;
  if(form.dataset.postSaveRefreshInstalled==="1") return true;
  form.dataset.postSaveRefreshInstalled="1";

  // A submit only marks a possible write. We refresh only if the dialog later closes,
  // which in the current advance module happens after the write succeeds.
  form.addEventListener("submit",()=>{ allocationSubmitPending=true; },true);
  dialog.addEventListener("close",()=>{
    if(!allocationSubmitPending) return;
    allocationSubmitPending=false;
    requestRefresh(80);
  });
  return true;
}

// The manager advance UI is injected asynchronously after authentication.
// Use a short bounded retry instead of a permanent DOM observer.
for(let i=0;i<40&&!installPostSaveRefresh();i++){
  await new Promise(r=>setTimeout(r,100));
}

// Other advance modules may explicitly request one refresh after a write.
window.addEventListener("budget-advance-refresh",()=>requestRefresh(120));

// Regular teachers get a separate, read-only allocation view with one action:
// confirm receipt of the allocated amount.
await import("./budget-my-advance-v170.js?v=1.7.1");
