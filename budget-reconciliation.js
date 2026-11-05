const excluded = /助理人員服務費|輔導人員費|課業輔導鐘點費/;
const trim = v => String(v ?? "").normalize("NFKC").trim();
const money = v => {
  const s = trim(v).replace(/[,$\s]/g, "").replace(/^\((.+)\)$/, "-$1");
  if (!s || s === "-") return 0;
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error("報表含無法辨識的金額：" + s);
  return Math.round(Number(s) * 100) / 100;
};
const ids = s => [...new Set(trim(s).toUpperCase().match(/G\d{8,}|\b1\d{9,}\b/g) || [])];
const sum = (rows, f) => Math.round(rows.reduce((n, r) => n + f(r), 0) * 100) / 100;
const by = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    const k = key(row);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
};
const distinct = a => [...new Set(a.filter(Boolean))];
const joined = a => distinct(a).join("／");
const omitted = r => /-001$/.test(r.code) || /助理人員服務費|課業輔導|課輔鐘點|輔導人員.*薪資|薪資.*輔導人員/.test(r.name);
const head = trim;
export function fromGrid(grid, purchase) {
  const required = purchase
    ? [["現況","狀態"],["請購編號","請購單號"],["預算編號"],["使用說明"],["申請金額","請購金額"],["核銷金額"],["核銷編號","核銷單號"]]
    : [["現況","狀態"],["核銷編號","核銷單號"],["預算編號"],["案名","使用說明"],["核銷金額"]];
  let cols;
  const start = grid.findIndex(row => {
    const headers = row.map(head);
    cols = required.map(aliases => headers.findIndex(h => aliases.includes(h)));
    return cols.every(i => i >= 0);
  });
  if (start < 0) throw new Error("找不到" + (purchase ? "請購" : "核銷") + "明細欄位，請確認檔案選對了。");
  const desc = grid[start].map(head).indexOf("使用說明");
  return grid.slice(start + 1).flatMap(row => {
    const [status,id,code,name,a,b,refs] = cols.map(i => trim(row[i]));
    if (!id || !ids(id).includes(id.toUpperCase()) || status === "作廢") return [];
    return [{status,id:id.toUpperCase(),code,name:name || trim(row[desc]),amount:money(a),settled:purchase?money(b):0,refs:ids(refs)}];
  });
}
function xmlGrid(bytes) {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i,i+8192));
  const utf = new TextDecoder("utf-8",{fatal:true}), big = new TextDecoder("big5");
  const decode = str => str.split(/([^\x00-\xff]+)/u).map((part,i) => {
    if(i%2) return part;
    const data = Uint8Array.from(part, c => c.charCodeAt(0));
    try { return utf.decode(data); } catch { return big.decode(data); }
  }).join("");
  const xml = new DOMParser().parseFromString(raw.replace(/^\xef\xbb\xbf/, ""), "application/xml");
  if (xml.querySelector("parsererror") || xml.documentElement.localName !== "Workbook") throw new Error("無法讀取會統的 Excel XML 檔案。");
  return [...xml.getElementsByTagNameNS("*","Row")].map(row => {
    const data = [];
    for (const cell of row.children) {
      if(cell.localName !== "Cell") continue;
      const index = Number(cell.getAttributeNS("urn:schemas-microsoft-com:office:spreadsheet","Index") || cell.getAttribute("ss:Index"));
      const i = index > 0 && index <= 256 ? index - 1 : data.length;
      data[i] = decode(cell.textContent || "");
    }
    return data;
  });
}
let readerPromise;
function reader() {
  if (readerPromise) return readerPromise;
  readerPromise = new Promise((resolve,reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
    const fail = () => { clearTimeout(timer); script.remove(); reject(new Error("Excel 讀取元件未載入，請稍後再試。")); };
    const timer = setTimeout(fail, 15000);
    script.onload = () => { if (!window.XLSX) return fail(); clearTimeout(timer); resolve(window.XLSX); };
    script.onerror = fail;
    document.head.append(script);
  }).catch(e => { readerPromise = null; throw e; });
  return readerPromise;
}
export async function readAccounting(file,purchase) {
  if (!file || file.size > 15*1024*1024) throw new Error("請選擇兩份會統報表，每份最多 15 MB。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/^\s*<\?xml|^\s*<Workbook/.test(new TextDecoder().decode(bytes.subarray(0,64)))) return fromGrid(xmlGrid(bytes),purchase);
  const xlsx = await reader();
  const book = xlsx.read(bytes,{type:"array"});
  const grid = book.SheetNames.flatMap(name => xlsx.utils.sheet_to_json(book.Sheets[name],{header:1,blankrows:false}));
  return fromGrid(grid,purchase);
}
const termIn = text => trim(text).replace(/(\d{3})學?年度?第([一二12])學期/g,(_,y,t)=>y+"-"+(t==="一"?"1":t==="二"?"2":t)).match(/\b\d{3}-[12]\b/)?.[0];
function names(s) {
  s = trim(s).replace(/(\d{3})學?年度?第([一二12])學期/g,"").replace(/\b\d{3}-[12]\b/g,"");
  const normalize = t => t.toLowerCase().replace(/橫桿/g,"橫槓").replace(/[×✕]/g,"x").replace(/資工系/g,"資工").replace(/半材系/g,"半材").replace(/(資源)(?:教室)?手冊/g,"$1手冊").replace(/溼/g,"濕").replace(/計劃/g,"計畫")
    .replace(/特推會/g,"特殊教育推行委員會").replace(/敬請核示|敬請核銷|擬核銷|核銷|資源教室|教補身障|資教|暨體驗/g,"")
    .replace(/[^\p{L}\p{N}]/gu,"");
  const prefixless = s.replace(/^.*?(?:補助款|配合款)\s*[-－—：:]\s*/,"");
  return distinct([normalize(prefixless),...Array.from(s.matchAll(/[「『“](.*?)[」』”]/g),m=>normalize(m[1]))]).filter(t=>t.length>=3);
}
function overlap(a,b) {
  for(let n=Math.min(a.length,b.length,12);n>=3;n--) for(let i=0;i<=a.length-n;i++) if(b.includes(a.slice(i,i+n)))return n;
  return 0;
}
function score(local, entry) {
  const explicit = local.refs.some(id=>entry.ids.includes(id));
  if (explicit) return 200;
  if (local.term && entry.term && local.term!==entry.term) return 0;
  const same = local.amount===entry.compare || local.amount===entry.amount;
  let best=0;
  for(const a of local.names) for(const b of entry.names) {
    if(a===b) best=Math.max(best,80);
    else if(a.includes(b)||b.includes(a)) best=Math.max(best,Math.min(a.length,b.length)>=4?72:63);
    else {
      const common=overlap(a,b), ratio=common/Math.min(a.length,b.length);
      if(common>=5 && ratio>=0.45 && !["合理調整","資源教室","知能研習","工作會議"].some(g=>a.includes(g)&&b.includes(g)&&g.length>=common)) best=Math.max(best,52);
      else if(same && common>=3) best=Math.max(best,common>=5?57:43);
      else if(common>=4 && ratio>=0.55 && !["合理調整","資源教室","知能研習","工作會議"].some(g=>a.includes(g)&&b.includes(g))) best=Math.max(best,40);
    }
  }
  if (!best) return 0;
  if (entry.term && local.term===entry.term) best+=9;
  if (same) best+=12;
  return best;
}
export function reconcile(records, claims, purchases) {
  const local=records.filter(r=>!excluded.test(trim(r.category))).map(r=>({...r,amount:money(r.amount),refs:ids([r.name,r.note,r.accountingId].join(" ")),names:names(r.name),term:termIn(r.name)||termIn(r.semester)}));
  const claimGroups=by(claims,r=>r.id);
  const purchaseGroups=by(purchases,r=>r.id);
  const omittedIds=new Set();
  for (const [id, rows] of claimGroups) if(rows.some(omitted)) omittedIds.add(id);
  for (const rows of purchaseGroups.values()) if(rows.some(omitted)) for(const r of rows) for(const id of r.refs) omittedIds.add(id);
  const allClaimIds=new Set(claimGroups.keys());
  const purchaseEntries=[...purchaseGroups].filter(([,rs])=>!rs.some(omitted)).map(([id,rs])=>({
    id, name:joined(rs.map(r=>r.name)),status:joined(rs.map(r=>r.status)),
    refs:distinct(rs.flatMap(r=>r.refs)),requested:sum(rs,r=>r.amount),settled:sum(rs,r=>r.settled)
  })).filter(p=>!p.refs.length || !p.refs.every(id=>omittedIds.has(id)));
  const linked = by(purchaseEntries.flatMap(p=>p.refs.filter(id=>allClaimIds.has(id)).map(id=>({id,p}))), x=>x.id);
  const claimEntries=[...claimGroups].filter(([id])=>!omittedIds.has(id)).map(([id,rs])=>{
    const amount=sum(rs,r=>r.amount), ps=(linked.get(id)||[]).map(x=>x.p);
    const direct=ps.filter(p=>p.refs.length===1 && p.settled!==0);
    return {ids:[id,...ps.map(p=>p.id)],claim:id,purchase:joined(ps.map(p=>p.id)),
      name:joined(rs.map(r=>r.name)), aliases:ps.map(p=>p.name), status:joined(rs.map(r=>r.status)),
      amount, compare:direct.length===1?direct[0].settled:amount,
      requested:ps.length===1 && ps[0].refs.length===1?ps[0].requested:null};
  });
  const unlinked=purchaseEntries.filter(p=>!p.refs.some(id=>allClaimIds.has(id)));
  const absorbed=new Set();
  for(const p of unlinked.filter(p=>!p.refs.length&&!p.settled)) {
    const pn=names(p.name);
    const candidates=claimEntries.filter(e=>!e.purchase && (e.amount===p.requested || (!p.requested&&p.status==="填寫中"))
      && pn.some(n=>n.length>=6&&names(e.name).includes(n)));
    if(candidates.length!==1)continue;
    const e=candidates[0];
    e.ids.push(p.id);e.purchase=p.id;e.requested=p.requested;e.aliases.push(p.name);
    absorbed.add(p.id);
  }
  const standalone=unlinked.filter(p=>!absorbed.has(p.id));
  const entries=[...claimEntries,...standalone.map(p=>({
    ids:[p.id,...p.refs],claim:joined(p.refs),purchase:p.id,name:p.name,aliases:[],status:p.status,
    amount:p.settled||null,compare:p.settled||p.requested,requested:p.requested,purchaseOnly:true
  }))].map(e=>({...e,names:distinct([e.name,...e.aliases].flatMap(names)),term:termIn(e.name)}));
  const edges=local.map(l=>entries.map((e,j)=>({j,s:score(l,e)})).filter(x=>x.s>=40).sort((a,b)=>b.s-a.s));
  const rank=edges.map((edge,i)=>({i,s:edge[0]?.s||0,margin:(edge[0]?.s||0)-(edge[1]?.s||0)})).sort((a,b)=>b.s-a.s||b.margin-a.margin);
  const used=new Set(), matches=new Map();
  for (const {i} of rank) {
    const options=edges[i].filter(x=>!used.has(x.j));
    if(!options.length)continue;
    const top=options[0];
    // Only remove an entry from the unmatched list if this is also its strongest plausible local match.
    const rivals=edges.map((es,k)=>k===i||matches.has(k)?0:es.find(x=>x.j===top.j)?.s||0);
    if(Math.max(0,...rivals)>=top.s)continue;
    const group=options.filter(x=>x.s>=52 && top.s-x.s<7);
    if(group.length>1) {
      if(group.every(x=>entries[x.j].purchaseOnly && !edges.some((es,k)=>k!==i&&!matches.has(k)&&es.some(y=>y.j===x.j&&y.s>=x.s)))) {
        group.forEach(x=>used.add(x.j));matches.set(i,{group:group.map(x=>entries[x.j]),certain:false});
      }
      continue;
    }
    if(options[1]?.s>=top.s-7)continue;
    used.add(top.j);matches.set(i,{group:[entries[top.j]],certain:top.s>=63});
  }
  const done = e => !e.purchaseOnly && e.status==="已完成";
  const contribution = (l,group) => sum([{amount:l?.stage==="已核銷"?l.amount:0},...group.filter(done).map(e=>({amount:-e.amount}))],x=>x.amount);
  const details=[];
  local.forEach((l,i)=>{
    const match=matches.get(i);
    if(!match){
      const candidates=edges[i].filter(x=>!used.has(x.j)).slice(0,3).map(x=>entries[x.j].ids[0]);
      details.push({type:"資教有，會統待配對",l,group:[],delta:null,net:contribution(l,[]),why:candidates.length?"待確認候選單號："+candidates.join("、"):"未找到候選；請查是否尚未登記會統。"});
      return;
    }
    const {group,certain}=match, e=group[0], net=contribution(l,group);
    const draft=group.length===1 && e.status==="填寫中" && !e.compare;
    const delta=group.length===1&&!draft?sum([{a:l.amount},{a:-e.compare}],x=>x.a):null;
    const differentStatus=(l.stage==="已核銷")!==done(e);
    const differentSource=!!e.claim&&!e.purchaseOnly&&e.amount!==e.compare;
    if(certain && !draft && !delta && !differentStatus && !differentSource) return;
    const type=draft?"會統已建單，金額待確認":!certain?"候選配對，待確認":differentSource?"會統兩表核銷金額不同":delta?"金額不同":"完成狀態待確認";
    const why=draft?"會統填寫中且金額為 0，暫不計差額。":!certain?"依案名及金額列為候選；請核對單號。":differentSource?`比較採請購表核銷金額 ${e.compare}；核銷明細為 ${e.amount}，完成合計仍採核銷明細。`:delta?"請核對兩邊登記金額。":"請核對資教已核銷與會統已完成的差異。";
    details.push({type,l,group,delta,net,why});
  });
  entries.forEach((e,i)=>{
    if(used.has(i))return;
    details.push({type:e.purchaseOnly?"僅見請購，資教待配對":"會統有，資教待配對",group:[e],delta:null,net:contribution(null,[e]),why:"未確認資教對應紀錄；可能合併登記。"});
  });
  const localDone=sum(local.filter(l=>l.stage==="已核銷"),l=>l.amount), accountingDone=sum(claimEntries.filter(done),e=>e.amount);
  const overview=[
    ["已核銷 vs. 已完成",localDone,accountingDone,sum([{a:localDone},{a:-accountingDone}],x=>x.a),"兩邊各依完成狀態比較。"],
    ...["請購中","核銷中","預估","待核對"].map(s=>[s,sum(local.filter(r=>r.stage===s),r=>r.amount),null,null,s==="預估"?"純預估，不含請購中與核銷中。":""]),
    ["會統尚非已完成",null,sum(claimEntries.filter(e=>!done(e)),e=>e.amount),null,"核銷表尚未完成的金額。"],
    ["會統核銷表合計",null,sum(claimEntries,e=>e.amount),null,"依核銷單號加總明細。"],
    ["會統請購表核銷金額",null,sum(purchaseEntries,p=>p.settled),null,"不含原申請金額。"],
    ["扣除重複核銷金額",null,sum(purchaseEntries.filter(p=>p.refs.length&&p.refs.every(id=>allClaimIds.has(id))),p=>p.settled),null,"請購所列核銷單號均已見於核銷表。"],
    ["會統去重核銷合計",null,sum([...claimEntries,...standalone],e=>e.amount??e.settled),null,"核銷表合計加上未連到核銷表的請購核銷金額；部分單號重疊的請購不重複加總。"],
    ["總覽與明細檢核",null,null,Math.round((localDone-accountingDone-sum(details,d=>d.net))*100)/100,"0 表示已核銷淨差與明細一致。"]
  ];
  return {overview,details,count:local.length};
}
function sheet(wb,name,headers,rows,widths,numbers) {
  const ws=wb.addWorksheet(name,{views:[{state:"frozen",ySplit:1}]});
  ws.columns=widths.map(width=>({width}));
  ws.addRow(headers);
  ws.addRows(rows);
  ws.autoFilter={from:{row:1,column:1},to:{row:1,column:headers.length}};
  ws.getRow(1).height=24;
  ws.getRow(1).eachCell(cell=>{
    cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF243B53"}};
    cell.font={bold:true,color:{argb:"FFFFFFFF"}};
  });
  for(const col of numbers)ws.getColumn(col).numFmt='#,##0.##;[Red]-#,##0.##;0';
  rows.forEach((r,i)=>{
    const row=ws.getRow(i+2);
    row.alignment={vertical:"middle",wrapText:true};
    const lines=Math.max(...r.map((v,j)=>Math.ceil(String(v??"").length/Math.max(1,Math.floor(widths[j]*0.52)))));
    row.height=Math.min(120,Math.max(23,lines*16));
    if(r[0]==="會統已建單，金額待確認" || (r[9] && !r[5])){
      row.eachCell({includeEmpty:true},cell=>{cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFFFF29C"}};});
    }
  });
}
async function makeWorkbook(result,plan) {
  if(!window.ExcelJS)throw new Error("Excel 匯出元件未載入，請重新整理後再試。");
  const wb=new window.ExcelJS.Workbook();
  sheet(wb,"金額總覽",["項目","資教金額","會統金額","資教－會統","說明"],[
    ...result.overview,["計畫",null,null,null,plan],["資教納入筆數",result.count,null,null,"排除助理人員服務費、輔導人員費、課業輔導鐘點費；會統排除作廢。"]
  ],[30,17,17,17,75],[2,3,4]);
  sheet(wb,"差異明細",["差異類型","資教科目","資教案名","資教狀態","資教金額","核銷單號","會統案名／使用說明","會統狀態","會統核銷明細金額","請購單號","會統申請金額","候選金額差","已核銷差額貢獻","原因／待查事項"],
    result.details.map(({type,l,group,delta,net,why})=>{
      const e=group.length===1?group[0]:null;
      return [type,l?.category,l?.name,l?.stage,l?.amount,joined(group.map(g=>g.claim)),joined(group.map(g=>g.name)),
        joined(group.map(g=>g.status)),e?.amount,joined(group.map(g=>g.purchase)),e?.requested,delta,net,why];
    }),[32,21,39,13,14,22,52,14,19,22,16,15,17,55],[5,9,11,12,13]);
  return wb.xlsx.writeBuffer();
}
export function openReconciliation({plan,valid,authorized,getRecords,download}) {
  if(document.getElementById("budgetReconciliationDialog"))return;
  const dialog=document.createElement("dialog");
  dialog.id="budgetReconciliationDialog";
  dialog.setAttribute("aria-labelledby","budgetReconciliationTitle");
  Object.assign(dialog.style,{width:"min(520px, calc(100% - 24px))",boxSizing:"border-box",padding:"22px",border:"1px solid #ded6e9",borderRadius:"16px",color:"#243B53"});
  dialog.innerHTML=`<h2 id="budgetReconciliationTitle">會統對帳</h2>
    <p data-plan></p><p>選擇兩份會統報表，系統會與目前計畫的使用紀錄比對。檔案只在此裝置處理。</p>
    <p><label>會統核銷明細表<br><input type="file" accept=".xls,.xlsx" data-claims></label></p>
    <p><label>會統請購明細表<br><input type="file" accept=".xls,.xlsx" data-purchases></label></p>
    <p aria-live="polite" data-status></p>
    <button type="button" class="ghost-btn" data-run disabled>對帳並下載 Excel</button>
    <button type="button" class="ghost-btn" data-close>關閉</button>`;
  const el=key=>dialog.querySelector("[data-"+key+"]");
  el("plan").textContent=plan;
  const inputs=[el("claims"),el("purchases")], button=el("run"), status=el("status");
  let busy=false;
  const sync=()=>{button.disabled=busy||!inputs.every(i=>i.files.length);};
  inputs.forEach(i=>i.addEventListener("change",()=>{status.textContent="";sync();}));
  el("close").addEventListener("click",()=>dialog.close());
  const watcher=setInterval(()=>{if(!valid())dialog.close();},500);
  dialog.addEventListener("close",()=>{clearInterval(watcher); inputs.forEach(i=>i.value=""); dialog.remove();},{once:true});
  button.addEventListener("click",async()=>{
    if(busy||!valid())return;
    busy=true;sync();inputs.forEach(i=>i.disabled=true);status.textContent="正在核對報表…";
    try {
      if(!await authorized())throw new Error("此功能僅限經費管理員使用。");
      if(!dialog.open||!valid())return;
      const [claims,purchases]=await Promise.all(inputs.map((i,n)=>readAccounting(i.files[0],n===1)));
      if(!dialog.open||!valid())return;
      const result=reconcile(await getRecords(),claims,purchases);
      const buffer=await makeWorkbook(result,plan);
      if(!dialog.open||!valid()||!await authorized()||!dialog.open||!valid())return;
      download(new Blob([buffer],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),"經費會統對帳.xlsx");
      status.textContent="已下載 Excel，共 "+result.details.length+" 筆待查或有差異。";
    } catch(error){status.textContent=error.message||"對帳失敗，請重新選擇檔案。";}
    finally {busy=false;inputs.forEach(i=>i.disabled=false);sync();}
  });
  document.body.append(dialog);
  dialog.showModal();
}
