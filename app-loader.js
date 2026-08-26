const SOURCE_URL = "./app.js?v=1.1.0";
const UPLOAD_SERVICE_URL = "https://must-free-upload-service.f00931-must.workers.dev";

async function loadBudgetApp(){
  const res = await fetch(SOURCE_URL, {cache:"no-store"});
  if(!res.ok) throw new Error("讀取主程式失敗（" + res.status + "）");
  let source = await res.text();

  source = source.replace(
    'import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-storage.js";\n',
    ''
  );
  source = source.replace('const storage = getStorage(app);\n', '');

  const helper = [
    'const UPLOAD_SERVICE_URL = "' + UPLOAD_SERVICE_URL + '";',
    '',
    'async function uploadServiceRequest(path, options={}){',
    '  if(!state.user) throw new Error("尚未登入，請重新登入後再試。");',
    '  const idToken = await state.user.getIdToken(true);',
    '  const headers = new Headers(options.headers || {});',
    '  headers.set("Authorization", "Bearer " + idToken);',
    '  const response = await fetch(UPLOAD_SERVICE_URL + path, {...options, headers});',
    '  const data = await response.json().catch(()=>({}));',
    '  if(!response.ok || data.ok === false){',
    '    throw new Error(data.error || ("上傳服務錯誤（" + response.status + "）"));',
    '  }',
    '  return data;',
    '}',
    '',
    'function githubPathFromUrl(urlOrPath){',
    '  if(!urlOrPath) return "";',
    '  if(!/^https?:\\/\\//.test(urlOrPath)) return String(urlOrPath).replace(/^\\/+/, "");',
    '  try{',
    '    const u = new URL(urlOrPath);',
    '    const parts = u.pathname.split("/").filter(Boolean);',
    '    const uploadIndex = parts.indexOf("uploads");',
    '    if(uploadIndex !== -1) return parts.slice(uploadIndex).join("/");',
    '  }catch(e){}',
    '  return "";',
    '}',
    '',
    'async function githubDeleteFile(pathOrUrl, name="file"){',
    '  const path = githubPathFromUrl(pathOrUrl);',
    '  if(!path) return false;',
    '  await uploadServiceRequest("/delete", {',
    '    method:"POST",',
    '    headers:{"content-type":"application/json"},',
    '    body:JSON.stringify({path, name})',
    '  });',
    '  return true;',
    '}',
    ''
  ].join("\n");

  source = source.replace(
    'const provider = new GoogleAuthProvider();\nprovider.setCustomParameters({ prompt: "select_account" });\n',
    'const provider = new GoogleAuthProvider();\nprovider.setCustomParameters({ prompt: "select_account" });\n' + helper
  );

  const uploadReplacement = [
    'async function uploadVoucherFile(file){',
    '  const form = new FormData();',
    '  form.append("file", file);',
    '  form.append("system", "shared");',
    '  form.append("category", file.type.startsWith("image/") ? "images" : "attachments");',
    '  form.append("referenceId", $("recordId").value || ("pending-" + Date.now()));',
    '  form.append("subfolder", "budget/reimbursement-vouchers");',
    '  const data = await uploadServiceRequest("/upload", {method:"POST", body:form});',
    '  const uploaded = data.file || {};',
    '  return {',
    '    path: uploaded.path || githubPathFromUrl(uploaded.url),',
    '    url: uploaded.url || "",',
    '    name: uploaded.name || file.name,',
    '    size: Number(uploaded.size || file.size || 0),',
    '    type: uploaded.type || file.type || "application/octet-stream"',
    '  };',
    '}',
    '',
    'async function saveRecord'
  ].join("\n");

  source = source.replace(
    /async function uploadVoucherFile\(file\)\{[\s\S]*?\n\}\n\nasync function saveRecord/,
    uploadReplacement
  );

  const amountParserReplacement = [
    'function parseVoucherAmount(text){',
    '  const raw=String(text||"").replace(/[，]/g,",");',
    '  const cleaned=raw',
    '    .replace(/\\b(?:19|20)\\d{2}\\s*(?:[-\\/.年]|\\s)\\s*\\d{1,2}\\s*(?:[-\\/.月]|\\s)\\s*\\d{1,2}(?:\\s*日)?\\b/g," ")',
    '    .replace(/\\b1\\d{2}\\s*(?:[-\\/.年]|\\s)\\s*\\d{1,2}\\s*(?:[-\\/.月]|\\s)\\s*\\d{1,2}(?:\\s*日)?\\b/g," ");',
    '  const compact=cleaned.replace(/\\s+/g," ");',
    '  const candidates=[];',
    '',
    '  const pushCandidate=(value,score,reason)=>{',
    '    const n=Number(String(value||"").replace(/[,\\s$]/g,""));',
    '    if(!Number.isFinite(n)||n<=0||n>99999999) return;',
    '    candidates.push({n,score,reason});',
    '  };',
    '',
    '  for(const key of compact.matchAll(/合\\s*計|總\\s*計/g)){',
    '    const start=Math.max(0,(key.index||0)-18);',
    '    const windowText=compact.slice(start,(key.index||0)+120);',
    '    const keyPos=Math.max(0,(key.index||0)-start);',
    '    for(const m of windowText.matchAll(/\\$?\\s*(\\d{1,3}(?:,\\d{3})+|\\d{1,8})/g)){',
    '      const token=m[1];',
    '      const pos=m.index||0;',
    '      const distance=Math.abs(pos-keyPos);',
    '      let score=60-Math.min(distance,50);',
    '      if(token.includes(",")) score+=18;',
    '      if(pos>=keyPos) score+=12;',
    '      pushCandidate(token,score,"合計附近");',
    '    }',
    '  }',
    '',
    '  const amountLabelIndex=compact.search(/金\\s*額/);',
    '  if(amountLabelIndex>=0){',
    '    const zone=compact.slice(amountLabelIndex,amountLabelIndex+260);',
    '    for(const m of zone.matchAll(/(?:^|[^0-9])((?:\\d\\s+){2,7}\\d)(?=$|[^0-9])/g)){',
    '      const digits=m[1].replace(/\\s+/g,"");',
    '      if(digits.length>=3&&digits.length<=8) pushCandidate(digits,58,"上方金額格");',
    '    }',
    '  }',
    '',
    '  if(!candidates.length) return null;',
    '  const frequency=new Map();',
    '  for(const c of candidates) frequency.set(c.n,(frequency.get(c.n)||0)+1);',
    '  for(const c of candidates){',
    '    c.score+=(frequency.get(c.n)-1)*25;',
    '  }',
    '  candidates.sort((a,b)=>b.score-a.score);',
    '  return candidates[0].n;',
    '}'
  ].join("\n");

  source = source.replace(
    /function parseVoucherAmount\(text\)\{[\s\S]*?\n\}\n\nasync function ocrImageSource/,
    amountParserReplacement + '\n\nasync function ocrImageSource'
  );

  source = source.replace(
    '    if(r.voucherStoragePath){\n      await deleteObject(storageRef(storage,r.voucherStoragePath)).catch(()=>{});\n    }',
    '    const oldVoucherPath=r.voucherStoragePath||r.voucherPath||githubPathFromUrl(r.voucherUrl||"");\n    if(oldVoucherPath){\n      await githubDeleteFile(oldVoucherPath,r.voucherFileName||"voucher").catch(()=>{});\n    }'
  );

  source = source.replace(
    '  const oldStoragePath=existing?.voucherStoragePath||"";',
    '  const oldStoragePath=existing?.voucherStoragePath||existing?.voucherPath||githubPathFromUrl(existing?.voucherUrl||"");'
  );

  source = source.replace(
    '      data.voucherStoragePath=uploaded.path;\n      data.voucherUrl=uploaded.url;',
    '      data.voucherStoragePath=uploaded.path;\n      data.voucherPath=uploaded.path;\n      data.voucherUrl=uploaded.url;\n      data.voucherFileSize=uploaded.size||0;\n      data.voucherFileType=uploaded.type||"";'
  );

  source = source.replace(
    '    if(selectedFile && oldStoragePath && oldStoragePath!==uploaded?.path){\n      await deleteObject(storageRef(storage,oldStoragePath)).catch(()=>{});\n    }',
    '    if(selectedFile && oldStoragePath && oldStoragePath!==uploaded?.path){\n      await githubDeleteFile(oldStoragePath,existing?.voucherFileName||"voucher").catch(()=>{});\n    }'
  );

  source = source.replace(
    '    if(uploaded?.path) await deleteObject(storageRef(storage,uploaded.path)).catch(()=>{});',
    '    if(uploaded?.path) await githubDeleteFile(uploaded.path,uploaded.name||"voucher").catch(()=>{});'
  );

  if(source.includes("getStorage(") || source.includes("uploadBytes(") || source.includes("deleteObject(")){
    throw new Error("免費附件模式載入失敗：仍偵測到 Firebase Storage 程式。");
  }
  if(!source.includes('form.append("subfolder", "budget/reimbursement-vouchers")')){
    throw new Error("免費附件模式載入失敗：上傳模組未正確套用。");
  }
  if(!source.includes('上方金額格')){
    throw new Error("核銷金額辨識修正版未正確套用。");
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
  console.error("Budget app loader failed:",err);
  alert("經費系統載入失敗："+(err?.message||"請重新整理後再試"));
});
