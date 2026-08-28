// Budget issue filter compatibility v1.4.4
// Keep issue-filter results consistent with manager todo counts.
// Resolved records (manager-waived / approved / locked) are not outstanding issues.

function activeIssue(){
  return document.getElementById("filterIssue")?.value||"";
}

function statusTexts(card){
  return [...card.querySelectorAll(".status")].map(x=>x.textContent.trim());
}

function isResolvedIssueCard(card){
  const texts=statusTexts(card);
  if(texts.includes("免附單據")) return true;
  if(texts.some(t=>t.includes("已核銷") || t.includes("已鎖定"))) return true;
  if(card.classList.contains("locked")) return true;
  return false;
}

function applyIssueFilterCompatibility(){
  const issue=activeIssue();
  if(issue!=="missingVoucher" && issue!=="unconfirmed") return;
  document.querySelectorAll("#recordList .record-card").forEach(card=>{
    if(isResolvedIssueCard(card)) card.style.display="none";
  });
}

function schedule(){ setTimeout(applyIssueFilterCompatibility,0); }

document.getElementById("filterIssue")?.addEventListener("input",schedule);
document.getElementById("filterIssue")?.addEventListener("change",schedule);

new MutationObserver(schedule).observe(
  document.getElementById("recordList")||document.body,
  {childList:true,subtree:true}
);

window.addEventListener("load",()=>setTimeout(applyIssueFilterCompatibility,150));
