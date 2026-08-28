// Budget private attachments adapter v1.2.9
// Private voucher access through Worker with Firebase authentication.
// Keeps legacy public attachments untouched.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

const PROJECT_ID = "must-resource-budget-system";
const WORKER_URL = "https://must-free-upload-service.f00931-must.workers.dev";
const PRIVATE_DOWNLOAD_PREFIX = "/download?system=budget";
const MAX_BUDGET_FILE_BYTES = 15 * 1024 * 1024;
const nativeFetch = window.fetch.bind(window);

function budgetApp(){
  return getApps().find(a=>a.options?.projectId===PROJECT_ID) || null;
}

function currentUser(){
  try{
    const app=budgetApp();
    return app ? getAuth(app).currentUser : null;
  }catch{
    return null;
  }
}

async function authHeaders(headersInit, forceRefresh=false){
  const user=currentUser();
  if(!user) throw new Error("尚未登入，請重新登入後再試。");
  const token=await user.getIdToken(forceRefresh);
  const headers=new Headers(headersInit||{});
  headers.set("Authorization","Bearer "+token);
  return headers;
}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function isWorkerRequest(url){ return typeof url==="string" && url.startsWith(WORKER_URL); }

function privatePathFromUrl(input){
  const raw=String(input||"").trim();
  if(!raw) return "";
  if(raw.startsWith("uploads/budget/")) return raw.replace(/^\/+/,"");
  try{
    const u=new URL(raw, location.href);
    const qp=u.searchParams.get("path");
    if(qp && String(qp).replace(/^\/+/,"").startsWith("uploads/budget/")) return decodeURIComponent(qp).replace(/^\/+/,"");
    const decoded=decodeURIComponent(u.pathname);
    const idx=decoded.indexOf("uploads/budget/");
    if(idx>=0) return decoded.slice(idx).replace(/^\/+/,"");
  }catch{}
  return "";
}

function isPrivateDownloadUrl(url){
  const raw=String(url||"");
  if(raw.startsWith(PRIVATE_DOWNLOAD_PREFIX) || raw.startsWith(WORKER_URL+PRIVATE_DOWNLOAD_PREFIX)) return true;
  if(raw.startsWith("uploads/budget/")) return true;
  if(raw.includes("must-resource-private-assets") && raw.includes("uploads/budget/")) return true;
  return false;
}

function toWorkerUrl(input){
  const raw=String(input||"");
  if(raw.startsWith(WORKER_URL+PRIVATE_DOWNLOAD_PREFIX)) return raw;
  if(raw.startsWith(PRIVATE_DOWNLOAD_PREFIX)) return WORKER_URL+raw;
  const path=privatePathFromUrl(raw);
  if(path) return WORKER_URL+PRIVATE_DOWNLOAD_PREFIX+"&path="+encodeURIComponent(path);
  return raw;
}

// Intercept only budget voucher traffic. Existing activity / announcement traffic is untouched.
window.fetch = async function(input, init={}){
  let url = typeof input === "string" ? input : input?.url || "";
  let options = {...init};

  if(isWorkerRequest(url) && url.endsWith("/upload") && options.body instanceof FormData){
    const subfolder=String(options.body.get("subfolder")||"");
    if(subfolder==="budget/reimbursement-vouchers"){
      const file=options.body.get("file");
      if(file instanceof File && file.size>MAX_BUDGET_FILE_BYTES){
        throw new Error("核銷單據檔案不可超過 15 MB");
      }
      options.body.set("system","budget");
    }
  }

  if(isPrivateDownloadUrl(url)){
    url=toWorkerUrl(url);
    options.headers=await authHeaders(options.headers,false);
    return nativeFetch(url,options);
  }

  return nativeFetch(input,options);
};

async function fetchPrivateBlob(pathOrUrl){
  const url=toWorkerUrl(pathOrUrl);
  if(!url.startsWith(WORKER_URL+PRIVATE_DOWNLOAD_PREFIX)) throw new Error("不是私密附件路徑");

  let lastError=null;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const headers=await authHeaders(null,attempt===1);
      const res=await nativeFetch(url,{headers,cache:"no-store"});
      if(res.status===401 && attempt===0){ await sleep(180); continue; }
      if(!res.ok){
        const data=await res.json().catch(()=>({}));
        throw new Error(data.error||`附件下載失敗（${res.status}）`);
      }
      return await res.blob();
    }catch(err){
      lastError=err;
      if(attempt===0){ await sleep(350); continue; }
    }
  }
  throw lastError || new Error("附件下載失敗");
}

async function openPrivateAttachment(pathOrUrl){
  // Open synchronously during the user's click so browsers do not block the new tab
  // while the authenticated file request is still running.
  let popup=null;
  try{
    popup=window.open("about:blank","_blank");
    if(popup){
      popup.document.title="附件開啟中";
      popup.document.body.innerHTML='<div style="font-family:system-ui,-apple-system,sans-serif;padding:28px;color:#4b3b66">附件開啟中，請稍候…</div>';
    }
  }catch{}

  try{
    const blob=await fetchPrivateBlob(pathOrUrl);
    const objectUrl=URL.createObjectURL(blob);
    if(popup && !popup.closed){
      popup.location.replace(objectUrl);
    }else{
      const a=document.createElement("a");
      a.href=objectUrl; a.target="_blank"; a.rel="noopener"; a.click();
    }
    setTimeout(()=>URL.revokeObjectURL(objectUrl),120000);
  }catch(err){
    try{ if(popup && !popup.closed) popup.close(); }catch{}
    throw err;
  }
}

function patchPrivateLinks(root=document){
  root.querySelectorAll?.('#recordList a, #existingVoucherBox a').forEach(a=>{
    if(a.dataset.privateBound==="1") return;
    const href=a.getAttribute("href")||"";
    if(!isPrivateDownloadUrl(href)) return;
    a.dataset.privateBound="1";
    a.dataset.privateHref=href;
    a.removeAttribute("target");
    a.href="#";
    a.title="需登入權限，由 Worker 驗證後開啟";
    a.addEventListener("click",async e=>{
      e.preventDefault();
      const old=a.textContent;
      try{
        a.textContent="附件開啟中…";
        await openPrivateAttachment(a.dataset.privateHref||href);
      }catch(err){
        const msg=err?.message||String(err);
        alert("附件開啟失敗："+msg+(msg==="Failed to fetch"?"\n\n請重新整理頁面後再試；若仍出現此訊息，表示 Worker 連線被瀏覽器阻擋。":""));
      }finally{
        a.textContent=old;
      }
    });
  });
}

function patchFileLimit(){
  const input=document.getElementById("recordVoucherFile");
  if(!input || input.dataset.limit15Bound==="1") return;
  input.dataset.limit15Bound="1";
  input.addEventListener("change",()=>{
    const file=input.files?.[0];
    if(file && file.size>MAX_BUDGET_FILE_BYTES){
      alert("核銷單據單檔上限為 15 MB，請壓縮後再上傳。");
      input.value="";
      const archived=document.getElementById("recordArchived");
      if(archived) archived.checked=false;
    }
  },true);
}

function formatBytes(bytes){
  const n=Number(bytes||0);
  if(n<1024) return n+" B";
  if(n<1024*1024) return (n/1024).toFixed(1)+" KB";
  if(n<1024*1024*1024) return (n/1024/1024).toFixed(1)+" MB";
  return (n/1024/1024/1024).toFixed(2)+" GB";
}

async function loadBudgetStorageStats(){
  const panel=document.getElementById("adminTodoPanel");
  if(!panel || panel.classList.contains("hidden") || !currentUser()) return;
  try{
    const headers=await authHeaders(null,false);
    const res=await nativeFetch(WORKER_URL+"/stats?system=budget",{headers,cache:"no-store"});
    const data=await res.json().catch(()=>({}));
    if(!res.ok||data.ok===false) throw new Error(data.error||String(res.status));
    const u=data.usage||{};
    let box=document.getElementById("budgetPrivateStorageStats");
    if(!box){
      box=document.createElement("div");
      box.id="budgetPrivateStorageStats";
      box.style.cssText="margin-top:14px;padding-top:14px;border-top:1px solid #eee;";
      panel.appendChild(box);
    }
    const pct=Number(u.percent||0);
    const warn=pct>=95?"⚠ 容量非常接近上限":pct>=85?"⚠ 建議準備清理舊計畫附件":pct>=70?"容量已超過 70%":"容量正常";
    box.innerHTML=`<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center"><div><strong>私密附件容量</strong><div class="muted" style="margin-top:4px">已使用 ${formatBytes(u.usedBytes)} / ${formatBytes(u.limitBytes)}｜剩餘 ${formatBytes(u.remainingBytes)}</div></div><div><strong>${pct.toFixed(1)}%</strong><div class="muted">${warn}</div></div></div>`;
  }catch(err){
    console.warn("budget private storage stats failed",err);
  }
}

let timer=null;
function schedulePatch(){
  clearTimeout(timer);
  timer=setTimeout(()=>{
    patchPrivateLinks();
    patchFileLimit();
    loadBudgetStorageStats();
  },180);
}

const observer=new MutationObserver(schedulePatch);
observer.observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener("DOMContentLoaded",schedulePatch);
window.addEventListener("load",schedulePatch);

window.__budgetPrivateAssets={openPrivateAttachment,fetchPrivateBlob};
