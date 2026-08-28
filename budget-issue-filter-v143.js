// Budget issue filter compatibility v1.4.3
// Keep issue-filter results consistent with manager todo counts.
// Manager-confirmed no-voucher records must not appear under missing-voucher/unconfirmed filters.

function isIssueFilterActive(){
  const v=document.getElementById("filterIssue")?.value||"";
  return v==="missingVoucher" || v==="unconfirmed";
}

function isManagerWaivedCard(card){
  return [...card.querySelectorAll(".status")].some(x=>x.textContent.trim()==="免附單據");
}

function applyIssueFilterCompatibility(){
  if(!isIssueFilterActive()) return;
  document.querySelectorAll("#recordList .record-card").forEach(card=>{
    if(isManagerWaivedCard(card)) card.style.display="none";
  });
}

document.getElementById("filterIssue")?.addEventListener("input",()=>setTimeout(applyIssueFilterCompatibility,0));
document.getElementById("filterIssue")?.addEventListener("change",()=>setTimeout(applyIssueFilterCompatibility,0));

new MutationObserver(()=>applyIssueFilterCompatibility()).observe(
  document.getElementById("recordList")||document.body,
  {childList:true,subtree:true}
);

window.addEventListener("load",()=>setTimeout(applyIssueFilterCompatibility,120));
