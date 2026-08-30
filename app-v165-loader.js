// Budget app stage loader v1.6.5
// Wraps the current stable app-v128-loader without changing existing records.
// Adds an optional estimateStage field while preserving estimated=true compatibility.

const BASE_LOADER = "./app-v128-loader.js?v=1.6.5-base";

async function loadStageAwareBudgetApp(){
  const res = await fetch(BASE_LOADER,{cache:"no-store"});
  if(!res.ok) throw new Error(`讀取經費主載入器失敗（${res.status}）`);
  let loader = await res.text();

  const marker = `  if(source.includes('form.append("system","shared")')) throw new Error("經費附件仍指向公開附件庫，已停止載入以保護資料。");`;
  if(!loader.includes(marker)) throw new Error("找不到經費主載入器安全檢查位置，已停止載入。");

  const patch = `
  // v1.6.5: 預估／請購中共用 estimated=true，僅新增 estimateStage 顯示分類。
  source = source.replace(
    'const statusBadge=r.estimated===true\\n      ? \'<span class="status estimated">預估</span>\'',
    'const statusBadge=r.estimated===true\\n      ? (r.estimateStage==="purchasing"?\'<span class="status estimated">請購中</span>\':\'<span class="status estimated">預估</span>\')'
  );

  source = source.replace(
    '$("recordAmount").value=r.amount||0; $("recordSemester").value=r.semester||""; $("recordEstimated").checked=r.estimated===true;',
    '$("recordAmount").value=r.amount||0; $("recordSemester").value=r.semester||""; $("recordEstimated").checked=r.estimated===true; if($("recordStageEstimated")) $("recordStageEstimated").checked=r.estimated===true&&r.estimateStage!=="purchasing"; if($("recordStagePurchasing")) $("recordStagePurchasing").checked=r.estimated===true&&r.estimateStage==="purchasing";'
  );

  source = source.replace(
    'const categoryId=$("recordCategory").value, amount=Number($("recordAmount").value||0), semester=$("recordSemester").value.trim(), estimated=$("recordEstimated").checked;',
    'const categoryId=$("recordCategory").value, amount=Number($("recordAmount").value||0), semester=$("recordSemester").value.trim(), estimated=$("recordEstimated").checked, estimateStage=estimated?($("recordStagePurchasing")?.checked?"purchasing":"estimated"):"";'
  );

  source = source.replace(
    'const data={planId:state.activePlanId,categoryId,purpose:$("recordPurpose").value.trim(),amount,semester,estimated,',
    'const data={planId:state.activePlanId,categoryId,purpose:$("recordPurpose").value.trim(),amount,semester,estimated,estimateStage,'
  );

  source = source.replace(
    '? "預估金額可先不附核銷單據，也不需要勾選金額確認。"',
    '? "預估／請購中可先不附核銷單據，也不需要勾選金額確認。"'
  );

  source = source.replace(
    'toast(estimated?"預估紀錄已儲存":"已送出，等待管理員核對");',
    'toast(estimated?(estimateStage==="purchasing"?"請購中紀錄已儲存":"預估紀錄已儲存"):"已送出，等待管理員核對");'
  );

  if(!source.includes('estimateStage')) throw new Error("預估／請購中分類未正確套用，已停止載入。");

`;

  loader = loader.replace(marker,patch+marker);

  const blob = new Blob([loader],{type:"text/javascript"});
  const url = URL.createObjectURL(blob);
  try{ await import(url); }
  finally{ URL.revokeObjectURL(url); }
}

loadStageAwareBudgetApp().catch(err=>{
  console.error("Budget stage loader failed:",err);
  alert("經費系統載入失敗："+(err?.message||err));
});
