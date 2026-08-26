// Budget app loader v1.2.3
// Loads the stable app-v120 source, but hard-routes NEW reimbursement vouchers to the budget private repo.

const SOURCE_URL = "./app-v120.js?v=1.2.3-base";

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

  if(source.includes('form.append("system","shared")')){
    throw new Error("經費附件仍指向公開附件庫，已停止載入以保護資料。");
  }
  if(!source.includes('form.append("system","budget")')){
    throw new Error("經費私密附件路由未正確套用。");
  }

  const blob = new Blob([source], {type:"text/javascript"});
  const url = URL.createObjectURL(blob);
  try{
    await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

loadBudgetApp().catch(err=>{
  console.error("Budget app loader failed:", err);
  alert("經費系統載入失敗："+(err?.message||err));
});
