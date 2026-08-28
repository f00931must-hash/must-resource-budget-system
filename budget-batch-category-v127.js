// Budget batch-download selector v1.3.3
// Managers can batch download either by budget category or by whole semester.

function syncBatchDownloadOptions(){
  const batchBtn=document.getElementById("batchDownloadBtn");
  const categoryFilter=document.getElementById("filterCategory");
  const semesterFilter=document.getElementById("filterSemester");
  if(!batchBtn||!categoryFilter||!semesterFilter) return;

  let categorySelect=document.getElementById("batchDownloadCategory");
  if(!categorySelect){
    categorySelect=document.createElement("select");
    categorySelect.id="batchDownloadCategory";
    categorySelect.className="manager-only";
    categorySelect.style.cssText="min-width:150px;height:46px;border:1px solid #ddd6ee;border-radius:12px;padding:0 12px;background:white;color:#4b3b66;";
    categorySelect.innerHTML='<option value="">選擇下載科目</option>';
    batchBtn.insertAdjacentElement("beforebegin",categorySelect);
  }

  let semesterSelect=document.getElementById("batchDownloadSemester");
  if(!semesterSelect){
    semesterSelect=document.createElement("select");
    semesterSelect.id="batchDownloadSemester";
    semesterSelect.className="manager-only";
    semesterSelect.style.cssText="min-width:130px;height:46px;border:1px solid #ddd6ee;border-radius:12px;padding:0 12px;background:white;color:#4b3b66;";
    semesterSelect.innerHTML='<option value="">整學期下載</option>';
    batchBtn.insertAdjacentElement("beforebegin",semesterSelect);
  }

  const currentCategory=categorySelect.value;
  const categoryOptions=[...categoryFilter.options]
    .filter(o=>o.value)
    .map(o=>({value:o.value,text:o.textContent||o.value}));
  const categorySignature=JSON.stringify(categoryOptions);
  if(categorySelect.dataset.signature!==categorySignature){
    categorySelect.innerHTML='<option value="">選擇下載科目</option>'+categoryOptions.map(o=>`<option value="${escapeAttr(o.value)}">${escapeHtml(o.text)}</option>`).join('');
    if(categoryOptions.some(o=>o.value===currentCategory)) categorySelect.value=currentCategory;
    categorySelect.dataset.signature=categorySignature;
  }

  const currentSemester=semesterSelect.value;
  const semesterOptions=[...semesterFilter.options]
    .filter(o=>o.value)
    .map(o=>({value:o.value,text:o.textContent||o.value}));
  const semesterSignature=JSON.stringify(semesterOptions);
  if(semesterSelect.dataset.signature!==semesterSignature){
    semesterSelect.innerHTML='<option value="">整學期下載</option>'+semesterOptions.map(o=>`<option value="${escapeAttr(o.value)}">${escapeHtml(o.text)}</option>`).join('');
    if(semesterOptions.some(o=>o.value===currentSemester)) semesterSelect.value=currentSemester;
    semesterSelect.dataset.signature=semesterSignature;
  }

  if(categorySelect.dataset.modeBound!=="1"){
    categorySelect.dataset.modeBound="1";
    categorySelect.addEventListener("change",()=>{
      if(categorySelect.value) semesterSelect.value="";
    });
  }
  if(semesterSelect.dataset.modeBound!=="1"){
    semesterSelect.dataset.modeBound="1";
    semesterSelect.addEventListener("change",()=>{
      if(semesterSelect.value) categorySelect.value="";
    });
  }

  if(batchBtn.dataset.batchScopeBound!=="1"){
    batchBtn.dataset.batchScopeBound="1";
    batchBtn.addEventListener("click",e=>{
      const selectedCategory=categorySelect.value||"";
      const selectedSemester=semesterSelect.value||"";
      if(!selectedCategory && !selectedSemester){
        e.preventDefault();
        e.stopImmediatePropagation();
        alert("請先選擇『下載科目』或『整學期下載』的學期。");
        return;
      }

      const prevCategory=categoryFilter.value;
      const prevSemester=semesterFilter.value;
      if(selectedSemester){
        categoryFilter.value="";
        semesterFilter.value=selectedSemester;
      }else{
        categoryFilter.value=selectedCategory;
      }

      // Existing batch downloader reads filteredRecords synchronously.
      // Restore the visible filters on the next event-loop turn.
      setTimeout(()=>{
        categoryFilter.value=prevCategory;
        semesterFilter.value=prevSemester;
      },0);
    },true);
  }
}

function escapeHtml(v){
  return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m]));
}
function escapeAttr(v){ return escapeHtml(v).replace(/'/g,"&#39;"); }

let timer=null;
function schedule(){ clearTimeout(timer); timer=setTimeout(syncBatchDownloadOptions,120); }
new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener("DOMContentLoaded",schedule);
window.addEventListener("load",schedule);
