// Budget batch-download category selector v1.2.7
// Requires managers to choose a budget category before batch downloading vouchers.

function syncBatchCategoryOptions(){
  const batchBtn=document.getElementById("batchDownloadBtn");
  const filter=document.getElementById("filterCategory");
  if(!batchBtn||!filter) return;

  let select=document.getElementById("batchDownloadCategory");
  if(!select){
    select=document.createElement("select");
    select.id="batchDownloadCategory";
    select.className="manager-only";
    select.style.cssText="min-width:150px;height:46px;border:1px solid #ddd6ee;border-radius:12px;padding:0 12px;background:white;color:#4b3b66;";
    select.innerHTML='<option value="">選擇下載科目</option>';
    batchBtn.insertAdjacentElement("beforebegin",select);
  }

  const current=select.value;
  const options=[...filter.options]
    .filter(o=>o.value)
    .map(o=>({value:o.value,text:o.textContent||o.value}));
  const signature=JSON.stringify(options);
  if(select.dataset.signature!==signature){
    select.innerHTML='<option value="">選擇下載科目</option>'+options.map(o=>`<option value="${escapeAttr(o.value)}">${escapeHtml(o.text)}</option>`).join('');
    if(options.some(o=>o.value===current)) select.value=current;
    select.dataset.signature=signature;
  }

  if(batchBtn.dataset.categoryDownloadBound!=="1"){
    batchBtn.dataset.categoryDownloadBound="1";
    batchBtn.addEventListener("click",e=>{
      const selected=document.getElementById("batchDownloadCategory")?.value||"";
      if(!selected){
        e.preventDefault();
        e.stopImmediatePropagation();
        alert("請先選擇要批次下載的經費科目，例如「人事費」。");
        return;
      }
      const f=document.getElementById("filterCategory");
      if(!f) return;
      const previous=f.value;
      f.value=selected;
      // The existing batch-download handler reads filteredRecords synchronously.
      // Restore the visible list filter on the next event-loop turn.
      setTimeout(()=>{ f.value=previous; },0);
    },true);
  }
}

function escapeHtml(v){
  return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m]));
}
function escapeAttr(v){ return escapeHtml(v).replace(/'/g,"&#39;"); }

let timer=null;
function schedule(){ clearTimeout(timer); timer=setTimeout(syncBatchCategoryOptions,120); }
new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener("DOMContentLoaded",schedule);
window.addEventListener("load",schedule);
