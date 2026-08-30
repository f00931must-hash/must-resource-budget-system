// Budget app stage loader v1.6.5.1
// Safe wrapper around the current stable app-v128-loader.
// Adds an optional estimateStage field while preserving estimated=true compatibility.

const BASE_LOADER = "./app-v128-loader.js?v=1.6.5.1-base";

async function loadStageAwareBudgetApp(){
  const res = await fetch(BASE_LOADER,{cache:"no-store"});
  if(!res.ok) throw new Error(`讀取經費主載入器失敗（${res.status}）`);
  let loader = await res.text();

  const marker = `  if(source.includes('form.append("system","shared")')) throw new Error("經費附件仍指向公開附件庫，已停止載入以保護資料。");`;
  if(!loader.includes(marker)) throw new Error("找不到經費主載入器安全檢查位置，已停止載入。");

  const replacements = [
    [
      `const statusBadge=r.estimated===true\n      ? '<span class="status estimated">預估</span>'`,
      `const statusBadge=r.estimated===true\n      ? (r.estimateStage==="purchasing"?'<span class="status estimated">請購中</span>':'<span class="status estimated">預估</span>')`
    ],
    [
      `$("recordAmount").value=r.amount||0; $("recordSemester").value=r.semester||""; $("recordEstimated").checked=r.estimated===true;`,
      `$("recordAmount").value=r.amount||0; $("recordSemester").value=r.semester||""; $("recordEstimated").checked=r.estimated===true; if($("recordStageEstimated")) $("recordStageEstimated").checked=r.estimated===true&&r.estimateStage!=="purchasing"; if($("recordStagePurchasing")) $("recordStagePurchasing").checked=r.estimated===true&&r.estimateStage==="purchasing";`
    ],
    [
      `const categoryId=$("recordCategory").value, amount=Number($("recordAmount").value||0), semester=$("recordSemester").value.trim(), estimated=$("recordEstimated").checked;`,
      `const categoryId=$("recordCategory").value, amount=Number($("recordAmount").value||0), semester=$("recordSemester").value.trim(), estimated=$("recordEstimated").checked, estimateStage=estimated?($("recordStagePurchasing")?.checked?"purchasing":"estimated"):"";`
    ],
    [
      `const data={planId:state.activePlanId,categoryId,purpose:$("recordPurpose").value.trim(),amount,semester,estimated,`,
      `const data={planId:state.activePlanId,categoryId,purpose:$("recordPurpose").value.trim(),amount,semester,estimated,estimateStage,`
    ],
    [
      `? "預估金額可先不附核銷單據，也不需要勾選金額確認。"`,
      `? "預估／請購中可先不附核銷單據，也不需要勾選金額確認。"`
    ],
    [
      `toast(estimated?"預估紀錄已儲存":"已送出，等待管理員核對");`,
      `toast(estimated?(estimateStage==="purchasing"?"請購中紀錄已儲存":"預估紀錄已儲存"):"已送出，等待管理員核對");`
    ]
  ];

  let patch = "\n  // v1.6.5.1 預估／請購中相容分類\n";
  for(const [from,to] of replacements){
    patch += `  source = source.replace(${JSON.stringify(from)}, ${JSON.stringify(to)});\n`;
  }
  patch += `  if(!source.includes("estimateStage")) throw new Error("預估／請購中分類未正確套用，已停止載入。");\n\n`;

  loader = loader.replace(marker,patch+marker);

  // The stable loader is evaluated from a Blob, so its relative dynamic import
  // must be made absolute before evaluation.
  loader = loader.replace(
    'await import("./budget-trash-plan-restore-v128.js?v=1.3.10");',
    'await import(new URL("./budget-trash-plan-restore-v128.js?v=1.3.10", location.href).href);'
  );

  const blob = new Blob([loader],{type:"text/javascript"});
  const url = URL.createObjectURL(blob);
  try{ await import(url); }
  finally{ URL.revokeObjectURL(url); }
}

loadStageAwareBudgetApp().catch(err=>{
  console.error("Budget stage loader failed:",err);
  alert("經費系統載入失敗："+(err?.message||err));
});
