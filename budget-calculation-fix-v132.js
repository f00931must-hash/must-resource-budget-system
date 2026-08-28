// Budget calculation display fix v1.3.2
// Recalculate category remaining amounts from the already-rendered live columns.
// This avoids counting soft-deleted/recycle-bin records and adds no Firestore reads.

const money = new Intl.NumberFormat("zh-TW", { style:"currency", currency:"TWD", maximumFractionDigits:0 });
let patching = false;
let timer = null;

function parseMoney(text){
  const raw = String(text||"").replace(/[^0-9.-]/g,"");
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function patchBudgetRows(){
  if(patching) return;
  const wrap = document.getElementById("budgetTableWrap");
  if(!wrap) return;
  patching = true;
  try{
    const heads = wrap.querySelectorAll("thead th");
    if(heads.length >= 6){
      const h = heads[5];
      const wanted = "剩餘（括號＝未扣預估）";
      if(h.textContent !== wanted) h.textContent = wanted;
    }

    wrap.querySelectorAll("tbody tr").forEach(row=>{
      const cells = row.querySelectorAll("td");
      if(cells.length < 6) return;

      // Base table columns:
      // 0 項目 / 1 編列 / 2 已核銷 / 3 待核對 / 4 已預估 / 5 剩餘
      const budget = parseMoney(cells[1].textContent);
      const approved = parseMoney(cells[2].textContent);
      const pending = parseMoney(cells[3].textContent);
      const estimated = parseMoney(cells[4].textContent);

      const remainingAfterAll = budget - approved - pending - estimated;
      const remainingWithoutEstimate = budget - approved - pending;
      const wanted = `${money.format(remainingAfterAll)}（${money.format(remainingWithoutEstimate)}）`;

      if(cells[5].textContent !== wanted) cells[5].textContent = wanted;
      cells[5].title = "括號內為尚未扣除預估金額的剩餘額";
    });
  } finally {
    patching = false;
  }
}

function schedulePatch(delay=40){
  clearTimeout(timer);
  timer = setTimeout(patchBudgetRows, delay);
}

document.addEventListener("DOMContentLoaded",()=>schedulePatch(50));
window.addEventListener("load",()=>schedulePatch(100));

const observer = new MutationObserver(()=>schedulePatch(30));
observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});

[200,500,1000,1800].forEach(ms=>setTimeout(patchBudgetRows,ms));
