// Budget advance refresh bridge v1.7.2
// No observers, polling, synthetic plan changes, or repeated Firestore reads.
// After a successful allocation write closes its dialog, perform one deterministic
// page reload. The #advance hash is preserved, so the manager returns to the same view.

let allocationSubmitPending=false;

function installPostSaveReload(){
  const form=document.getElementById("advanceAllocationForm");
  const dialog=document.getElementById("advanceAllocationDialog");
  if(!form||!dialog) return false;
  if(form.dataset.postSaveReloadInstalled==="1") return true;
  form.dataset.postSaveReloadInstalled="1";

  form.addEventListener("submit",()=>{ allocationSubmitPending=true; },true);
  dialog.addEventListener("close",()=>{
    if(!allocationSubmitPending) return;
    allocationSubmitPending=false;
    // In the current manager module, a successful save closes the dialog only after
    // Firestore write + audit log complete. Reload once to avoid stale in-memory arrays.
    setTimeout(()=>location.reload(),80);
  });
  return true;
}

for(let i=0;i<40&&!installPostSaveReload();i++){
  await new Promise(r=>setTimeout(r,100));
}

// Regular teachers get a separate allocation view with one action:
// confirm receipt of the allocated amount.
await import("./budget-my-advance-v170.js?v=1.7.2");
