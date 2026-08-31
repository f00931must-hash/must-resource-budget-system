// Budget advance auto refresh v1.7.0
// Compatibility placeholder. The main advance module already refreshes on entry,
// plan change, and after writes. Keep only explicit refresh requests to avoid duplicate reads.

let timer=null;
function activeAdvance(){
  return location.hash==="#advance" || document.getElementById("advance")?.classList.contains("active-view");
}
function planSelect(){ return document.getElementById("planSelect"); }
function requestRefresh(ms=120){
  clearTimeout(timer);
  timer=setTimeout(()=>{
    if(!activeAdvance()) return;
    const select=planSelect();
    if(!select?.value) return;
    select.dispatchEvent(new Event("change",{bubbles:true}));
  },ms);
}

// Only explicit post-write requests are handled here.
window.addEventListener("budget-advance-refresh",()=>requestRefresh(120));
