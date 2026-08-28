// Budget batch-download selector v1.3.4
// Managers can freely combine category + semester scopes.
// Examples:
// - all categories + 114-2
// - one category + all semesters
// - one category + one semester
// - all categories + all semesters

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
    categorySelect.style.cssText="min-width:170px;height:46px;border:1px solid #ddd6ee;border-radius:12px;padding:0 12px;background:white;color:#4b3b66;";
    batchBtn.insertAdjacentElement("beforebegin",categorySelect);
  }

  let semesterSelect=document.getElementById("batchDownloadSemester");
  if(!semesterSelect){
    semesterSelect=document.createElement("select");
    semesterSelect.id="batchDownloadSemester";
    semesterSelect.className="manager-only";
    semesterSelect.style.cssText="min-width:150px;height:46px;border:1px solid #ddd6ee;border-radius:12px;padding:0 12px;background:white;color:#4b3b66;";
    batchBtn.insertAdjacentElement("beforebegin",semesterSelect);
  }

  const currentCategory=categorySelect.value;
  const categoryOptions=[...categoryFilter.options]
    .filter(o=>o.value)
    .map(o=>({value:o.value,text:(o.textContent||o.value).trim()}));
  const categorySignature=JSON.stringify(categoryOptions);
  if(categorySelect.dataset.signature!==categorySignature){
    categorySelect.innerHTML='<option value="">全部經費項目</option>'+categoryOptions.map(o=>`<option value="${escapeAttr(o.value)}">${escapeHtml(o.text)}</option>`).join('');
    if(categoryOptions.some(o=>o.value===currentCategory)) categorySelect.value=currentCategory;
    else categorySelect.value="";
    categorySelect.dataset.signature=categorySignature;
  }

  const currentSemester=semesterSelect.value;
  const semesterOptions=[...semesterFilter.options]
    .filter(o=>o.value)
    .map(o=>({value:o.value,text:(o.textContent||o.value).trim()}));
  const semesterSignature=JSON.stringify(semesterOptions);
  if(semesterSelect.dataset.signature!==semesterSignature){
    semesterSelect.innerHTML='<option value="">全部學期</option>'+semesterOptions.map(o=>`<option value="${escapeAttr(o.value)}">${escapeHtml(o.text)}</option>`).join('');
    if(semesterOptions.some(o=>o.value===currentSemester)) semesterSelect.value=currentSemester;
    else semesterSelect.value="";
    semesterSelect.dataset.signature=semesterSignature;
  }

  // Refresh options again when the user opens either selector. This avoids timing issues
  // when the base app finishes rendering categories/semesters slightly later.
  if(categorySelect.dataset.refreshBound!=="1"){
    categorySelect.dataset.refreshBound="1";
    categorySelect.addEventListener("focus",()=>setTimeout(syncBatchDownloadOptions,0));
    categorySelect.addEventListener("pointerdown",()=>setTimeout(syncBatchDownloadOptions,0));
  }
  if(semesterSelect.dataset.refreshBound!=="1"){
    semesterSelect.dataset.refreshBound="1";
    semesterSelect.addEventListener("focus",()=>setTimeout(syncBatchDownloadOptions,0));
    semesterSelect.addEventListener("pointerdown",()=>setTimeout(syncBatchDownloadOptions,0));
  }

  if(batchBtn.dataset.batchScopeBound!=="1"){
    batchBtn.dataset.batchScopeBound="1";
    batchBtn.addEventListener("click",()=>{
      // Both selectors are valid even when blank: blank means ALL.
      const selectedCategory=document.getElementById("batchDownloadCategory")?.value||"";
      const selectedSemester=document.getElementById("batchDownloadSemester")?.value||"";
      const liveCategoryFilter=document.getElementById("filterCategory");
      const liveSemesterFilter=document.getElementById("filterSemester");
      if(!liveCategoryFilter||!liveSemesterFilter) return;

      const prevCategory=liveCategoryFilter.value;
      const prevSemester=liveSemesterFilter.value;

      // Existing batch downloader calls filteredRecords() synchronously in the click event.
      // Feed it the dedicated batch-download scope, then restore the visible list filters.
      liveCategoryFilter.value=selectedCategory;
      liveSemesterFilter.value=selectedSemester;

      setTimeout(()=>{
        liveCategoryFilter.value=prevCategory;
        liveSemesterFilter.value=prevSemester;
      },0);
    },true);
  }
}

function escapeHtml(v){
  return String(v??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m]));
}
function escapeAttr(v){ return escapeHtml(v).replace(/'/g,"&#39;"); }

let timer=null;
function schedule(){ clearTimeout(timer); timer=setTimeout(syncBatchDownloadOptions,100); }
new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener("DOMContentLoaded",schedule);
window.addEventListener("load",schedule);
[250,600,1200,2200].forEach(ms=>setTimeout(syncBatchDownloadOptions,ms));
