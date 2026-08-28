// Budget stable remaining display v1.3.3
// Prevents old/new dashboard patches from visually fighting over the same cell.
// No Firestore reads: values are derived only from the already-rendered table columns.

const money = new Intl.NumberFormat("zh-TW", { style:"currency", currency:"TWD", maximumFractionDigits:0 });
let timer=null;

function parseMoney(text){
  const raw=String(text||"").replace(/[^0-9.-]/g,"");
  const n=Number(raw);
  return Number.isFinite(n)?n:0;
}

function ensureStyle(){
  if(document.getElementById("stableRemainingStyle")) return;
  const style=document.createElement("style");
  style.id="stableRemainingStyle";
  style.textContent=`
    #budgetTableWrap td[data-stable-remaining]{
      position:relative;
      color:transparent !important;
      white-space:nowrap;
    }
    #budgetTableWrap td[data-stable-remaining]::after{
      content:attr(data-stable-remaining);
      position:absolute;
      inset:0;
      display:flex;
      align-items:center;
      justify-content:flex-end;
      color:inherit;
      color:#2f2640;
      pointer-events:none;
    }
  `;
  document.head.appendChild(style);
}

function patch(){
  ensureStyle();
  const wrap=document.getElementById("budgetTableWrap");
  if(!wrap) return;
  const heads=wrap.querySelectorAll("thead th");
  if(heads.length>=6) heads[5].textContent="剩餘（括號＝未扣預估）";

  wrap.querySelectorAll("tbody tr").forEach(row=>{
    const cells=row.querySelectorAll("td");
    if(cells.length<6) return;
    const budget=parseMoney(cells[1].textContent);
    const approved=parseMoney(cells[2].textContent);
    const pending=parseMoney(cells[3].textContent);
    const estimated=parseMoney(cells[4].textContent);
    const remainingAfterAll=budget-approved-pending-estimated;
    const remainingWithoutEstimate=budget-approved-pending;
    const display=`${money.format(remainingAfterAll)}（${money.format(remainingWithoutEstimate)}）`;
    if(cells[5].dataset.stableRemaining!==display) cells[5].dataset.stableRemaining=display;
    cells[5].title="括號內為尚未扣除預估金額的剩餘額";
  });
}

function schedule(delay=30){
  clearTimeout(timer);
  timer=setTimeout(patch,delay);
}

document.addEventListener("DOMContentLoaded",()=>schedule(40));
window.addEventListener("load",()=>schedule(80));
new MutationObserver(()=>schedule(20)).observe(document.documentElement,{childList:true,subtree:true});
[150,350,700,1200].forEach(ms=>setTimeout(patch,ms));
