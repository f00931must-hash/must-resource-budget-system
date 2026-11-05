function accountingPage(action, expectedSignature="") {
  const clean=s=>String(s??"").normalize("NFKC").trim();
  const visible=e=>e.getClientRects().length>0&&!e.closest("[hidden]");
  const normalize=s=>clean(s).replace(/[\s▼▲▽△↕]/g,"");
  const cellText=cell=>clean(cell.innerText).replace(/\t/g," ").replace(/\r?\n+/g," ");
  const tables=[];
  for(const table of document.querySelectorAll("table")){
    if(!visible(table))continue;
    const rows=Array.from(table.rows).filter(r=>r.closest("table")===table&&visible(r));
    for(let i=0;i<rows.length;i++){
      const h=Array.from(rows[i].cells,cell=>normalize(cell.innerText));
      const id=h.findIndex(s=>/^(?:本核銷單號|核銷單號|申請單號|請購單號)$/.test(s));
      const name=h.indexOf("案名"), amount=h.findIndex(s=>/^(?:金額|核銷金額|請購金額|申請金額)$/.test(s));
      const status=h.indexOf("現況"), applicant=h.indexOf("申請人"), code=h.indexOf("預算來源"), related=h.indexOf("相關編號");
      if([id,name,amount,status,applicant].some(x=>x<0))continue;
      const kind=h[id].includes("核銷")?"claim":"purchase";
      if(kind==="purchase"&&code<0)continue;
      const data=[];
      for(const row of rows.slice(i+1)){
        if(row.cells.length<h.length)continue;
        const c=Array.from(row.cells,cellText);
        const ids=c[id].match(/(?<![A-Z0-9])(?:G\d{11}|1\d{11})(?![A-Z0-9])/gi)||[];
        const primary=ids.find(s=>kind==="claim"?/^G/i.test(s):/^1/.test(s));
        if(!primary)continue;
        if(!c[name]||!c[status]||!c[amount]||(kind==="purchase"&&!c[code]))return {error:"會統有一列欄位不完整，請核對目前頁面。"};
        data.push({primary,cells:[c[status],c[id],...(kind==="claim"?[c[related]||""]:[]),c[name],c[amount],c[applicant],...(kind==="purchase"?[c[code]]:[])]});
      }
      if(data.length)tables.push({table,kind,data,head:["現況",kind==="claim"?"本核銷單號":"申請單號",...(kind==="claim"?["相關編號"]:[]),"案名","金額","申請人",...(kind==="purchase"?["預算來源"]:[])]});
      break;
    }
  }
  if(tables.length!==1)return tables.length?{error:"此頁有多張會統清單，無法確定應讀取哪一張。"}:null;
  const {table,kind,data,head}=tables[0];
  const signature=data.map(x=>x.primary.toUpperCase()).join("|");
  let region=table, totals=[];
  const counts=s=>Array.from(String(s).matchAll(/([\d,]+)\s*(?:筆|單)\s*[，,、]\s*(\d+)\s*頁/g),m=>[Number(m[1].replace(/,/g,"")),Number(m[2])]);
  for(let i=0;region&&i<8;i++,region=region.parentElement){
    totals=counts(region.innerText);
    if(totals.length)break;
  }
  if(!totals.length||!totals.every(a=>a[0]===totals[0][0]&&a[1]===totals[0][1]))return {error:"找不到可確認的會統總筆數和總頁數。"};
  if(action==="next"){
    if(signature!==expectedSignature)return {error:"頁面已改變，請回到第 1 頁重新收集。"};
    const next=Array.from(region.querySelectorAll("a,button,input[type=button],input[type=image],area"))
      .filter(e=>visible(e)&&[e.title,e.getAttribute("aria-label"),e.alt,e.value,e.innerText,e.querySelector("img")?.alt,e.querySelector("img")?.title]
        .some(s=>/^(?:跳至|前往)?下(?:一|1)頁$/.test(normalize(s))));
    if(!next.length)return {error:"找不到「下一頁」按鈕。"};
    setTimeout(() => next[0].click(), 100);
    return {clicked:true};
  }
  return {kind,signature,total:totals[0][0],pages:totals[0][1],ids:data.map(x=>x.primary.toUpperCase()),
    text:[head.join("\t"),...data.map(x=>x.cells.join("\t"))].join("\n")};
}

const $=id=>document.getElementById(id), start=$("start"),stop=$("stop"),copy=$("copy");
let cancelled=false,output="";
const status=s=>{$("status").textContent=s;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function read(tabId,frameId,action,signature=""){
  const target=frameId===null?{tabId,allFrames:true}:{tabId,frameIds:[frameId]};
  const results=await chrome.scripting.executeScript({target,func:accountingPage,args:[action,signature]});
  const found=results.filter(x=>x.result?.signature||x.result?.clicked||x.result?.error);
  if(found.length>1)throw Error("發現多個清單，請在單一會統清單頁面重試。");
  return found[0]||null;
}
start.onclick=async()=>{
  cancelled=false;output="";start.disabled=true;stop.disabled=false;copy.disabled=true;
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw Error("找不到目前的會統分頁。");
    const first=await read(tab.id,null,"read");
    if(!first)throw Error("找不到會統請購或核銷清單。請先登入、查詢並切到第 1 頁。");
    let frame=first.frameId,current=first.result;
    if(current.error)throw Error(current.error);
    const {total,pages,kind}=current;
    if(!Number.isSafeInteger(total)||total<1||total>5000||!Number.isSafeInteger(pages)||pages<1||pages>100)throw Error("清單範圍太大或格式不符，請縮小查詢範圍。");
    const chunks=[], seen=new Set();
    for(let page=1;page<=pages;page++){
      if(cancelled)throw Error("已停止收集，沒有複製不完整資料。");
      if(current.kind!==kind||current.total!==total||current.pages!==pages)throw Error("會統查詢範圍改變，請從第 1 頁重試。");
      if(current.ids.some(id=>seen.has(id))||new Set(current.ids).size!==current.ids.length)throw Error("讀到重複單號或頁面，請從第 1 頁重試。");
      current.ids.forEach(id=>seen.add(id));chunks.push(current.text);
      status("已收集 "+page+" / "+pages+" 頁（"+seen.size+" / "+total+" 筆）。");
      if(page===pages)break;
      const before=current.signature;
      // Schedule the click so the result can return before the page unloads.
      const moved=await read(tab.id,frame,"next",before);
      if(!moved?.result?.clicked)throw Error(moved?.result?.error||"無法翻頁。");
      current=null;
      for(let attempt=0;attempt<25&&!cancelled;attempt++){
        await pause(400);
        const next=await read(tab.id,null,"read").catch(()=>null);
        if(next?.result?.signature&&next.result.signature!==before){current=next.result;frame=next.frameId;break;}
      }
      if(!current)throw Error(cancelled?"已停止收集。":"下一頁未載入；請確認從第 1 頁開始、會統可正常翻頁。");
    }
    if(seen.size!==total)throw Error("會統顯示 "+total+" 筆，實際收集 "+seen.size+" 筆。請回到第 1 頁重試。");
    output=chunks.join("\n\n");
    copy.disabled=false;status("已收齊 "+seen.size+" 筆"+(kind==="claim"?"核銷":"請購")+"。按「複製全部文字」，再到經費系統貼上。");
  }catch(e){status(e.message||"收集失敗。");}
  finally{start.disabled=false;stop.disabled=true;}
};
stop.onclick=()=>{cancelled=true;stop.disabled=true;};
copy.onclick=async()=>{
  if(!output)return;
  try{await navigator.clipboard.writeText(output);status("已複製。請到經費系統貼上並加入對應的表格。");}
  catch{status("無法寫入剪貼簿，請在此視窗再按一次「複製全部文字」。");}
};
