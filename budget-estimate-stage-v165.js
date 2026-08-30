// Budget estimate stage controls v1.6.6
// UI-only compatibility layer. Keeps the existing hidden #recordEstimated checkbox
// as the canonical bypass flag, while allowing two visible stages: 預估 / 請購中.

const $=id=>document.getElementById(id);

function syncFromVisible(changed){
  const estimated=$("recordStageEstimated");
  const purchasing=$("recordStagePurchasing");
  const hidden=$("recordEstimated");
  if(!estimated||!purchasing||!hidden)return;

  if(changed===estimated && estimated.checked) purchasing.checked=false;
  if(changed===purchasing && purchasing.checked) estimated.checked=false;

  hidden.checked=estimated.checked||purchasing.checked;
  hidden.dispatchEvent(new Event("change",{bubbles:true}));
}

function clearVisibleOnNew(){
  const id=$("recordId")?.value||"";
  if(id)return;
  const estimated=$("recordStageEstimated");
  const purchasing=$("recordStagePurchasing");
  if(estimated)estimated.checked=false;
  if(purchasing)purchasing.checked=false;
  const hidden=$("recordEstimated");
  if(hidden)hidden.checked=false;
}

function install(){
  const estimated=$("recordStageEstimated");
  const purchasing=$("recordStagePurchasing");
  const dialog=$("recordDialog");
  if(!estimated||!purchasing)return false;

  estimated.addEventListener("change",()=>syncFromVisible(estimated));
  purchasing.addEventListener("change",()=>syncFromVisible(purchasing));

  dialog?.addEventListener("close",()=>{
    if($("recordId")?.value==="") clearVisibleOnNew();
  });

  $("newRecordBtn")?.addEventListener("click",()=>queueMicrotask(clearVisibleOnNew));
  return true;
}

for(let i=0;i<40&&!install();i++) await new Promise(r=>setTimeout(r,50));

// Load the safe end-to-end automatic notification test button.
await import("./budget-reminder-auto-test-v166.js?v=1.6.6");
