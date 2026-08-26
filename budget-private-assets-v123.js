// Budget private attachments adapter v1.2.3
// Keeps legacy public attachments readable while routing NEW budget vouchers to the private repo through Worker.

import { getApps, getApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

const WORKER_URL = "https://must-free-upload-service.f00931-must.workers.dev";
const PRIVATE_DOWNLOAD_PREFIX = "/download?system=budget";
const MAX_BUDGET_FILE_BYTES = 15 * 1024 * 1024;
const nativeFetch = window.fetch.bind(window);

function currentUser(){
  try{
    if(!getApps().length) return null;
    return getAuth(getApp()).currentUser;
  }catch{
    return null;
  }
}

async function authHeaders(headersInit){
  const user=currentUser();
  if(!user) throw new Error("尚未登入，請重新登入後再試。");
  const token=await user.getIdToken(true);
  const headers=new Headers(headersInit||{});
  headers.set("Authorization","Bearer "+token);
  return headers;
}

function isWorkerRequest(url){
  return typeof url==="string" && url.startsWith(WORKER_URL);
}

function isPrivateDownloadUrl(url){
  if(typeof url!=="string") return false;
  return url.startsWith(PRIVATE_DOWNLOAD_PREFIX) || url.startsWith(WORKER_URL+PRIVATE_DOWNLOAD_PREFIX);
}

function toWorkerUrl(url){
  if(url.startsWith(WORKER_URL)) return url;
  if(url.startsWith("/")) return WORKER_URL+url;
  return url;
}

// Intercept only budget voucher traffic. Existing activity / announcement traffic is untouched.
window.fetch = async function(input, init={}){
  let url = typeof input === "string" ? input : input?.url || "";
  let options = {...init};

  // app-v120 currently posts system=shared. Rewrite ONLY the budget voucher folder to system=budget.
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

  // Private attachment URLs are intentionally relative. Route them back through Worker and attach Firebase ID token.
  if(isPrivateDownloadUrl(url)){
    url=toWorkerUrl(url);
    options.headers=await authHeaders(options.headers);
    return nativeFetch(url,options);
  }

  return nativeFetch(input,options);
};

async function fetchPrivateBlob(pathOrUrl){
  let url=String(pathOrUrl||"");
  if(url.startsWith("uploads/budget/")){
    url=PRIVATE_DOWNLOAD_PREFIX+"&path="+encodeURIComponent(url);
  }
  if(!isPrivateDownloadUrl(url)) throw new Error("不是私密附件路徑");
  const headers=await authHeaders();
  const res=await nativeFetch(toWorkerUrl(url),{headers,cache:"no-store"});
  if(!res.ok){
    const data=await res.json().catch(()=>({}));
    throw new Error(data.error||`附件下載失敗（${res.status}）`);
  }
  return res.blob();
}

async function openPrivateAttachment(pathOrUrl){
  const blob=await fetchPrivateBlob(pathOrUrl);
  const objectUrl=URL.createObjectURL(blob);
  const w=window.open(objectUrl,"_blank","noopener");
  if(!w){
    const a=document.createElement("a");
    a.href=objectUrl;
    a.target="_blank";
    a.rel="noopener";
    a.click();
  }
  setTimeout(()=>URL.revokeObjectURL(objectUrl),60000);
}

function patchPrivateLinks(root=document){
  root.querySelectorAll?.('a[href^="/download?system=budget"],a[href^="'+WORKER_URL+'/download?system=budget"]').forEach(a=>{
    if(a.dataset.privateBound==="1") return;
    a.dataset.privateBound="1";
    const href=a.getAttribute("href")||"";
    a.removeAttribute("target");
    a.href="#";
    a.title="需登入權限，由 Worker 驗證後開啟";
    a.addEventListener("click",async e=>{
      e.preventDefault();
      const old=a.textContent;
      try{
        a.textContent="附件開啟中…";
        await openPrivateAttachment(href);
      }catch(err){
        alert("附件開啟失敗："+(err?.message||err));
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
    const headers=await authHeaders();
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

let statsTimer=null;
function schedulePatch(){
  clearTimeout(statsTimer);
  statsTimer=setTimeout(()=>{
    patchPrivateLinks();
    patchFileLimit();
    loadBudgetStorageStats();
  },180);
}

const observer=new MutationObserver(schedulePatch);
observer.observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener("DOMContentLoaded",schedulePatch);
window.addEventListener("load",schedulePatch);

// Expose for debugging only; does not expose tokens.
window.__budgetPrivateAssets={openPrivateAttachment,fetchPrivateBlob};
