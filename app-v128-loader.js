// Budget app loader v1.3.10
// Keeps stable app-v120 behavior, routes vouchers private, converts data deletion to 10-day soft delete,
// and renders the manager no-voucher action directly with each record card.

const SOURCE_URL = "./app-v120.js?v=1.3.10-base";

async function loadBudgetApp(){
  const res = await fetch(SOURCE_URL, {cache:"no-store"});
  if(!res.ok) throw new Error(`讀取經費主程式失敗（${res.status}）`);
  let source = await res.text();

  const oldUpload = 'const form=new FormData(); form.append("file",file); form.append("system","shared");';
  const newUpload = 'const form=new FormData(); form.append("file",file); form.append("system","budget");';
  if(!source.includes(oldUpload)) throw new Error("找不到經費附件上傳路由，為避免誤傳公開倉庫已停止載入。");
  source = source.replace(oldUpload, newUpload);

  source = source.replace(
    'if(file&&file.size>20*1024*1024)return toast("核銷單據檔案不可超過 20 MB",5000);',
    'if(file&&file.size>15*1024*1024)return toast("核銷單據檔案不可超過 15 MB",5000);'
  );

  source = source.replace(
    'state.plans=snap.docs.map(d=>({id:d.id,...d.data()}));',
    'state.plans=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);'
  );
  source = source.replace(
    'state.categories=catSnap.docs.map(d=>({id:d.id,...d.data()}))',
    'state.categories=catSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true)'
  );
  source = source.replace(
    'state.records=recSnap.docs.map(d=>({id:d.id,...d.data()}));',
    'state.records=recSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.deleted!==true);'
  );

  const oldIssues = `const issues=(r.estimated!==true && !evidenceUrl?'<span class="status danger-badge">缺單據</span>':'')+\n      (r.estimated!==true && r.amountConfirmed!==true && r.amountManuallyConfirmed!==true?'<span class="status danger-badge">未確認金額</span>':'');`;
  const newIssues = `const managerWaiverDone=r.amountConfirmedByManagerWaiver===true;\n    const issues=(r.estimated!==true && !evidenceUrl && !managerWaiverDone?'<span class="status danger-badge">缺單據</span>':'')+\n      (r.estimated!==true && r.amountConfirmed!==true && r.amountManuallyConfirmed!==true && !managerWaiverDone?'<span class="status danger-badge">未確認金額</span>':'');`;
  if(!source.includes(oldIssues)) throw new Error("找不到使用紀錄狀態產生位置，已停止載入以避免免附單據狀態錯誤。");
  source = source.replace(oldIssues,newIssues);

  const oldApproveAction = 'if(isManager() && !r.estimated && !approved) actions+=`<button class="link-btn approve" data-approve-record="${r.id}">核對完成</button>`;';
  const newApproveAction = `if(isManager() && !r.estimated && !approved){\n      const managerWaiverDone=r.amountConfirmedByManagerWaiver===true;\n      if(!evidenceUrl && !managerWaiverDone) actions+=\`<button class="link-btn" data-manager-waive-voucher="\${r.id}">免附單據</button>\`;\n      actions+=\`<button class="link-btn approve" data-approve-record="\${r.id}">核對完成</button>\`;\n    }`;
  if(!source.includes(oldApproveAction)) throw new Error("找不到管理員核對按鈕產生位置，已停止載入以避免免附單據流程失效。");
  source = source.replace(oldApproveAction, newApproveAction);

  source = source.replace(
    /async function deleteCurrentPlan\(\)\{[\s\S]*?\n\}\n\nfunction openNewRecord/,
`async function deleteCurrentPlan(){
  if(!isManager()||!state.activePlanId)return;
  const p=currentPlan();
  if(state.records.length){ alert("此計畫已有使用紀錄，不能刪除。可改為停用計畫。"); return; }
  if(!confirm(\`確定將「\${p?.name||"此計畫"}」移到回收桶嗎？\\n\\n10 天內可由管理員還原。\`))return;
  try{
    const actor=state.user.email.toLowerCase();
    for(const c of state.categories){
      await updateDoc(doc(db,"budgetCategories",c.id),{deleted:true,deletedAt:serverTimestamp(),deletedBy:actor,updatedAt:serverTimestamp(),updatedBy:actor});
    }
    await updateDoc(doc(db,"budgetPlans",state.activePlanId),{deleted:true,deletedAt:serverTimestamp(),deletedBy:actor,updatedAt:serverTimestamp(),updatedBy:actor});
    await addDoc(collection(db,"auditLogs"),{type:"recycle-bin",targetId:state.activePlanId,action:"soft-delete-plan",actorEmail:actor,createdAt:serverTimestamp()});
    state.activePlanId=""; await loadPlans(); await loadPlanData(); renderAll(); toast("計畫已移到回收桶，10 天內可還原");
  }catch(err){ toast(\`刪除失敗：\${err.message}\`,5000); }
}

function openNewRecord`);

  source = source.replace(
    /async function deleteRecord\(id\)\{[\s\S]*?\n\}\n\nasync function approveRecord/,
`async function deleteRecord(id){
  const r=state.records.find(x=>x.id===id); if(!r)return;
  if(isApproved(r))return toast("此筆已核銷並鎖定，請先由管理員解鎖");
  if(!isManager()&&r.ownerEmail!==state.user.email.toLowerCase())return toast("只能刪除自己建立的使用紀錄");
  if(!confirm(\`確定將「\${r.purpose||"此筆"}」移到回收桶？\\n金額：\${money.format(r.amount||0)}\\n\\n10 天內可由管理員還原；附件不會因此刪除。\`))return;
  try{
    const actor=state.user.email.toLowerCase();
    await updateDoc(doc(db,"expenseRecords",id),{deleted:true,deletedAt:serverTimestamp(),deletedBy:actor,updatedAt:serverTimestamp(),updatedBy:actor});
    if(isManager()) await addDoc(collection(db,"auditLogs"),{type:"recycle-bin",targetId:id,planId:state.activePlanId,action:"soft-delete-record",actorEmail:actor,createdAt:serverTimestamp()});
    await loadPlanData(); renderAll(); toast("使用紀錄已移到回收桶，10 天內可由管理員還原");
  }catch(err){ toast(\`刪除失敗：\${err.message}\`,5000); }
}

async function approveRecord`);

  source = source.replace(
    /async function deleteCategory\(id\)\{[\s\S]*?\n\}\n\nfunction switchView/,
`async function deleteCategory(id){
  if(!isManager())return;
  const c=state.categories.find(x=>x.id===id); if(!c)return;
  if(state.records.some(r=>r.categoryId===id)){ alert("此項目已有使用紀錄，不能刪除。可改為停用。"); return; }
  if(!confirm(\`確定將「\${c.name||"此項目"}」移到回收桶嗎？\\n\\n10 天內可由管理員還原。\`))return;
  try{
    const actor=state.user.email.toLowerCase();
    await updateDoc(doc(db,"budgetCategories",id),{deleted:true,deletedAt:serverTimestamp(),deletedBy:actor,updatedAt:serverTimestamp(),updatedBy:actor});
    await addDoc(collection(db,"auditLogs"),{type:"recycle-bin",targetId:id,planId:state.activePlanId,action:"soft-delete-category",actorEmail:actor,createdAt:serverTimestamp()});
    await loadPlanData(); renderAll(); toast("經費項目已移到回收桶，10 天內可還原");
  }catch(err){ toast(\`刪除失敗：\${err.message}\`,5000); }
}

function switchView`);

  if(source.includes('form.append("system","shared")')) throw new Error("經費附件仍指向公開附件庫，已停止載入以保護資料。");
  if(!source.includes('form.append("system","budget")')) throw new Error("經費私密附件路由未正確套用。");
  if(!source.includes('data-manager-waive-voucher')) throw new Error("免附單據管理員按鈕未正確寫入主畫面，已停止載入。");
  if(!source.includes('amountConfirmedByManagerWaiver')) throw new Error("管理員免附單據確認標記未正確套用。");
  if(!source.includes('soft-delete-record') || !source.includes('soft-delete-plan') || !source.includes('soft-delete-category')) throw new Error("回收桶刪除保護未正確套用，已停止載入以避免永久誤刪。");

  const blob = new Blob([source], {type:"text/javascript"});
  const url = URL.createObjectURL(blob);
  try{ await import(url); }
  finally{ URL.revokeObjectURL(url); }

  await import("./budget-trash-plan-restore-v128.js?v=1.3.10");
}

loadBudgetApp().catch(err=>{
  console.error("Budget app loader failed:", err);
  alert("經費系統載入失敗："+(err?.message||err));
});
