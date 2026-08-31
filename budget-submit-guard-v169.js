// Expense record submit guard v1.6.9
// UI-only protection against duplicate submissions on slow networks.
// No Firestore schema/data changes.

const form=document.getElementById("recordForm");
const dialog=document.getElementById("recordDialog");
const saveBtn=document.getElementById("recordSaveBtn");
const toast=document.getElementById("toast");
let locked=false;

function ensureOverlay(){
  if(document.getElementById("recordSavingOverlay")) return;
  const style=document.createElement("style");
  style.textContent=`
    #recordSavingOverlay{position:absolute;inset:0;background:rgba(255,255,255,.88);display:flex;align-items:center;justify-content:center;z-index:20;border-radius:16px}
    #recordSavingOverlay.hidden{display:none}
    #recordSavingOverlay .saving-box{display:flex;flex-direction:column;align-items:center;gap:12px;padding:24px 30px;border-radius:16px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.12);font-weight:700;color:#34244d}
    #recordSavingOverlay .saving-spinner{width:30px;height:30px;border:4px solid #e8e0f2;border-top-color:#6f42a1;border-radius:50%;animation:recordSavingSpin .8s linear infinite}
    @keyframes recordSavingSpin{to{transform:rotate(360deg)}}
  `;
  document.head.appendChild(style);
  if(dialog){
    dialog.style.position="relative";
    const overlay=document.createElement("div");
    overlay.id="recordSavingOverlay";overlay.className="hidden";
    overlay.innerHTML='<div class="saving-box"><div class="saving-spinner"></div><div>正在儲存，請勿重複點擊</div><small>網路較慢時可能需要幾秒鐘</small></div>';
    dialog.appendChild(overlay);
  }
}

function setLocked(v){
  locked=!!v;
  if(form) form.dataset.submitLocked=locked?"1":"0";
  const overlay=document.getElementById("recordSavingOverlay");
  overlay?.classList.toggle("hidden",!locked);
  if(saveBtn){
    saveBtn.disabled=locked;
    if(locked) saveBtn.textContent="儲存中…";
    else saveBtn.textContent="儲存";
  }
}

ensureOverlay();

window.addEventListener("submit",e=>{
  if(e.target!==form) return;
  if(locked){
    e.preventDefault();e.stopImmediatePropagation();
    return;
  }
  // Lock before the application's submit handler begins.
  setLocked(true);
},true);

// Main saveRecord() closes the dialog on success.
dialog?.addEventListener("close",()=>setLocked(false));

// Main saveRecord() re-enables the save button in finally. Observe that as the reliable completion signal on errors.
if(saveBtn){
  new MutationObserver(()=>{
    if(locked && saveBtn.disabled===false) setLocked(false);
  }).observe(saveBtn,{attributes:true,attributeFilter:["disabled"]});
}

// If validation/toast rejects before an async write starts, release the guard quickly.
if(toast){
  new MutationObserver(()=>{
    if(!locked) return;
    const text=(toast.textContent||"").trim();
    if(/請|不可|無法|超過|失敗|尚未|先/.test(text)) setTimeout(()=>setLocked(false),50);
  }).observe(toast,{childList:true,characterData:true,subtree:true});
}

// Failsafe only; normal paths unlock earlier.
setInterval(()=>{
  if(locked && !dialog?.open) setLocked(false);
},1000);
