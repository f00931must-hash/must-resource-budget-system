// Budget private attachment open fix v1.3.2
// Force correct MIME when opening authenticated private attachments.
// This prevents Chrome from rendering raw %PDF bytes as text.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

const PROJECT_ID="must-resource-budget-system";
const WORKER_URL="https://must-free-upload-service.f00931-must.workers.dev";

function app(){ return getApps().find(a=>a.options?.projectId===PROJECT_ID)||null; }
function user(){ const a=app(); return a ? getAuth(a).currentUser : null; }

function pathFromInput(input){
  const raw=String(input||"").trim();
  if(!raw) return "";
  if(raw.startsWith("uploads/budget/")) return raw.replace(/^\/+/,"");
  try{
    const u=new URL(raw,location.href);
    const qp=u.searchParams.get("path");
    if(qp) return decodeURIComponent(qp).replace(/^\/+/,"");
    const decoded=decodeURIComponent(u.pathname);
    const i=decoded.indexOf("uploads/budget/");
    if(i>=0) return decoded.slice(i).replace(/^\/+/,"");
  }catch{}
  return "";
}

function mimeFromPath(path){
  const ext=String(path||"").toLowerCase().split(".").pop();
  return {
    pdf:"application/pdf",
    jpg:"image/jpeg",
    jpeg:"image/jpeg",
    png:"image/png",
    webp:"image/webp"
  }[ext] || "application/octet-stream";
}

async function openCorrectly(raw){
  const current=user();
  if(!current) throw new Error("尚未登入，請重新登入後再試。");
  const path=pathFromInput(raw);
  if(!path.startsWith("uploads/budget/")) throw new Error("無效的私密附件路徑。");

  let popup=null;
  try{
    popup=window.open("about:blank","_blank");
    if(popup){
      popup.document.title="附件開啟中";
      popup.document.body.innerHTML='<div style="font-family:system-ui,-apple-system,sans-serif;padding:28px;color:#4b3b66">附件下載中，較大的 PDF 可能需要幾秒鐘…</div>';
    }
  }catch{}

  try{
    const token=await current.getIdToken(false);
    const url=WORKER_URL+"/download?system=budget&path="+encodeURIComponent(path);
    const res=await fetch(url,{headers:{Authorization:"Bearer "+token},cache:"no-store"});
    if(!res.ok){
      const d=await res.json().catch(()=>({}));
      throw new Error(d.error||`附件下載失敗（${res.status}）`);
    }
    const buf=await res.arrayBuffer();
    const blob=new Blob([buf],{type:mimeFromPath(path)});
    const objectUrl=URL.createObjectURL(blob);
    if(popup && !popup.closed) popup.location.replace(objectUrl);
    else window.open(objectUrl,"_blank","noopener");
    setTimeout(()=>URL.revokeObjectURL(objectUrl),180000);
  }catch(err){
    try{ if(popup && !popup.closed) popup.close(); }catch{}
    throw err;
  }
}

// Existing adapter binds private links in bubble phase.
// Capture first and replace only those already marked as private links.
document.addEventListener("click",async e=>{
  const a=e.target.closest?.('a[data-private-bound="1"]');
  if(!a) return;
  const raw=a.dataset.privateHref||"";
  if(!raw) return;

  e.preventDefault();
  e.stopImmediatePropagation();
  const old=a.textContent;
  try{
    a.textContent="附件開啟中…";
    await openCorrectly(raw);
  }catch(err){
    alert("附件開啟失敗："+(err?.message||String(err)));
  }finally{
    a.textContent=old;
  }
},true);
