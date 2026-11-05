const excluded=/助理人員服務費|輔導人員費|課業輔導鐘點費/;
const norm=v=>String(v??"").normalize("NFKC").trim();
const termPattern=/(?:\d{3})\s*(?:[-－]\s*[12](?!\d)|學年度第\s*[12一二]\s*學期)/;
const termKey=v=>norm(v).match(termPattern)?.[0].replace(/學年度第\s*([12一二])\s*學期/,"-$1").replace(/一/g,"1").replace(/二/g,"2").replace(/\s/g,"")||"";
const nameKey=v=>norm(v).toLowerCase().replace(termPattern,"").replace(/^\d{3}年度\s*/,"")
  .replace(/^(?:(?:申請|擬?請購|擬?核銷|擬?辦(?:理)?|健康與諮商中心|資源教室|教補身障|資教|身心障礙學生|特殊教育學生|購買|雜支|學年度|\d{3}年度)[\s\p{P}\p{S}]*)+/u,"")
  .replace(/[×✕]/g,"x").replace(/戶外暨體驗/g,"戶外體驗").replace(/溼/g,"濕").replace(/橫桿/g,"橫槓").replace(/特推會/g,"特殊教育推行委員會")
  .replace(/敬請(?:核示|核銷)[\s\p{P}]*$/u,"")
  .replace(/[^\p{L}\p{N}]/gu,"");
const core=v=>v.replace(/座談會議$/u,"座談會").replace(/(?:工作坊|活動|講座|會議|研討會|等|暨體驗)+$/u,"");
const applicantKey=v=>norm(v).replace(/\s+/g,"");
function samePerson(a,b){
  a=applicantKey(a);b=applicantKey(b);
  return a.length>=2&&b.length>=2&&(a===b||
    (Math.abs(a.length-b.length)===1&&(a.endsWith(b)||b.endsWith(a))));
}
const itemKey=s=>s.includes("及")?s.split("及").sort().join("及"):s;
function titleRank(a,b,person,truncated){
  if(a.length>b.length)[a,b]=[b,a];
  if(a.length<4)return 0;
  if(a===b&&!truncated)return 3;
  const numbers=s=>s.match(/\d+/g)?.join(',')||'';
  if(numbers(a)&&numbers(b)&&numbers(a)!==numbers(b))return 0;
  const x=core(a),y=core(b);
  if(x.length>=4&&!truncated&&(x===y||itemKey(x)===itemKey(y)))return 3;
  if(truncated&&person&&a.length>=8&&a.length*2>=b.length&&b.startsWith(a))return 2;
  if(truncated)return 0;
  if(x.length>=4&&y.length>=4&&(x.includes(y)||y.includes(x))&&Math.min(x.length,y.length)*2>=Math.max(x.length,y.length))return 2;
  if(!person||a.length<5||a.length*2<b.length)return 0;
  let i=0;for(const ch of b)if(ch===a[i])i++;
  const meaningful=s=>s.replace(/合理調整|推廣文宣品|宣導品|資源教室|會議|工作坊|研習|活動|費用|經費|年度|學期|採購|用品|耗材/g,"");
  const m=meaningful(a),n=meaningful(b);
  if(i===a.length&&m.length>=3&&Array.from({length:m.length-2},(_,j)=>m.slice(j,j+3)).some(k=>n.includes(k)))return 2;
  return 0;
}
const cash=n=>Number(n).toLocaleString("zh-TW",{maximumFractionDigits:2});
const num=v=>{const raw=norm(v),s=raw.replace(/,/g,"");return /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(\.\d{1,2})?$/.test(raw)&&Number.isSafeInteger(Math.round(Number(s)*100))?Number(s):null;};
const sum=(rs,f)=>rs.reduce((n,r)=>n+Math.round(f(r)*100),0)/100;
const unique=a=>[...new Set(a.filter(Boolean))];
const refs=s=>unique(norm(s).toUpperCase().match(/(?<![A-Z0-9])(?:G\d{11}|1\d{11})(?![A-Z0-9])/g)||[]);
const sourceExcluded=r=>/(?:^|\s)[\w-]+-001\b/.test(r.code)||/助理人員服務費|課業輔導|課輔鐘點|輔導人員.*薪資|薪資.*輔導人員/.test(r.name);
export function calculateShots(rows,records){
  const map=new Map();
  let duplicates=0;
  for(const r of rows){
    const id=norm(r.id).toUpperCase(), amount=num(r.amount), status=norm(r.status);
    if(!status||!norm(r.name)||(r.kind==="purchase"&&!norm(r.code))||amount===null||!(r.kind==="purchase"?/^1\d{11}$/:/^G\d{11}$/).test(id))throw Error("請補齊有效的單號、案名、狀態及金額（請購另需預算來源）："+(id||r.page));
    const related=norm(r.related).toUpperCase().split(/[\s、,，;；／/]+/).filter(Boolean);
    if(related.some(x=>!(r.kind==="purchase"?/^G\d{11}$/:/^1\d{11}$/).test(x)))throw Error("關聯單號格式不正確："+id);
    const row={...r,id,amount,status,related:unique(related).sort()};
    const prev=map.get(id);
    if(prev){
      if(["amount","status","name","code","applicant"].some(k=>norm(prev[k])!==norm(row[k]))||prev.related.join()!==row.related.join())throw Error("同一單號資料不同："+id+"。請確認後只保留正確的列。");
      duplicates++;continue;
    }
    map.set(id,row);
  }
  const active=[...map.values()].filter(r=>!/^(?:已)?作廢$/.test(r.status)&&!sourceExcluded(r));
  const kept=new Map(active.map(r=>[r.id,r])), links=new Map(active.map(r=>[r.id,new Set()]));
  const missing=new Set();
  for(const r of active)for(const id of r.related){
    if(kept.has(id)){links.get(r.id).add(id);links.get(id).add(r.id);}
    else if(!map.has(id))missing.add(id);
  }
  // A purchase with a listed claim is transferred even if the claim data is missing.
  const transferred=r=>r.related.some(id=>!map.has(id)||kept.has(id))||links.get(r.id).size>0;
  const claims=active.filter(r=>r.kind==="claim"), pending=active.filter(r=>r.kind==="purchase"&&!transferred(r));
  const pendingAmount=sum(pending,r=>r.amount), claimAmount=sum(claims,r=>r.amount);
  const accounting=sum([pendingAmount,claimAmount],x=>x);
  const budgetRecords=records.filter(r=>!excluded.test(r.category)&&["已核銷","預估","請購中","核銷中"].includes(r.stage));
  const budget=sum(budgetRecords,r=>Number(r.amount||0));
  const budgetClaimed=sum(budgetRecords.filter(r=>r.stage==="已核銷"),r=>Number(r.amount||0));
  // The purchase is a reference for each claim, not the unit of reconciliation.
  const purchaseClaimCount=p=>new Set([...p.related,...links.get(p.id)]).size;
  const groups=[
    ...claims.map(claim=>{
      const parents=[...links.get(claim.id)].map(id=>kept.get(id)).filter(r=>r.kind==="purchase");
      const singleParents=parents.filter(p=>purchaseClaimCount(p)===1);
      return {group:[...parents,claim],matchRows:[claim,...singleParents],
        sharedParentIds:parents.filter(p=>!singleParents.includes(p)).map(p=>p.id),amount:claim.amount};
    }),
    ...active.filter(p=>p.kind==="purchase"&&!links.get(p.id).size).map(p=>({
      group:[p],matchRows:[p],sharedParentIds:[],amount:transferred(p)?null:p.amount
    }))
  ];
  const recordsForMatch=records.filter(r=>!excluded.test(r.category));
  const candidates=groups.map(g=>recordsForMatch.map((r,i)=>{
    const id=refs([r.accountingId,r.note,r.name].join(" "));
    if(g.matchRows.some(s=>id.includes(s.id)))return {i,rank:100};
    if(id.some(n=>!g.sharedParentIds.includes(n)))return null;
    const n=nameKey(r.name), term=termKey(r.name);
    const sameAmount=g.amount!==null&&Number(r.amount)===g.amount;
    let rank=0;
    for(const s of g.matchRows){
      const sourceTerm=termKey(s.name);
      if(term&&sourceTerm&&term!==sourceTerm)continue;
      const person=samePerson(r.applicant,s.applicant), truncated=/(?:…|\.{2,})/.test(s.name);
      const match=titleRank(n,nameKey(s.name),person,truncated);
      const termBonus=term&&term===sourceTerm?2:0;
      if(sameAmount&&match)rank=Math.max(rank,match*10+termBonus+(person?1:0));
      else if(match===3){
        const key=nameKey(s.name), distinctive=core(n)===core(key)&&core(n).length>=10;
        if(person||distinctive)rank=Math.max(rank,5+termBonus+(person?1:0));
      }
    }
    return rank?{i,rank}:null;
  }).filter(Boolean));
  const used=new Set(), details=[];
  groups.forEach((g,k)=>{
    const cs=candidates[k],rank=Math.max(0,...cs.map(c=>c.rank));
    const best=cs.filter(c=>c.rank===rank);
    const match=best.length===1&&candidates.filter(v=>v.some(c=>c.i===best[0].i&&c.rank>=rank)).length===1?best[0]:null;
    const r=match?recordsForMatch[match.i]:null;
    if(r)used.add(match.i);
    const difference=r&&g.amount!==null?sum([Number(r.amount),-g.amount],x=>x):null;
    const type=!r?(cs.length?"待人工確認":"會統有，資教待配對"):g.amount===null?"待核銷資料":difference!==0?"金額不同":"相符";
    details.push({type,r,group:g.group,amount:g.amount,difference});
  });
  recordsForMatch.forEach((r,i)=>{if(!used.has(i))details.push({type:candidates.some(c=>c.some(x=>x.i===i))?"待人工確認":"資教有，本次會統未配對",r,group:[],amount:null,difference:null});});
  return {accounting,budget,delta:sum([budget,-accounting],x=>x),claimAmount,pendingAmount,budgetClaimed,estimated:sum([budget,-budgetClaimed],x=>x),missing:[...missing],duplicates,details,purchases:[...map.values()].filter(r=>r.kind==="purchase").length,claims:[...map.values()].filter(r=>r.kind==="claim").length};
}
export function readCopiedTable(text,kind,page){
  const lines=String(text).replace(/\r\n?/g,"\n").split("\n"), rows=[];
  let columns=null, pending=null, tables=0;
  const flush=()=>{
    if(!pending||!columns)return;
    let joined=pending[0];
    for(const line of pending.slice(1)){
      const left=joined.split("\t"), right=line.split("\t");
      // The claim page sometimes copies the boundary after the related IDs as a line break.
      const missingTab=kind==="claim"&&columns.related>=0&&columns.related+1===columns.name
        &&left.length===columns.name&&/^(?:申請|請購)單號\s*[:：]/.test(norm(left.at(-1)))
        &&norm(right[0])&&!/^(?:(?:申請|請購)單號|傳票編號)\s*[:：]/.test(norm(right[0]))
        &&num(right[columns.amount-columns.name])!==null;
      joined+=(missingTab?"\t":"\n")+line;
    }
    const cols=joined.split("\t").map(norm), at=k=>cols[columns[k]]||"";
    const numbers=refs(columns.documents.map(i=>cols[i]||"").join(" "));
    const primary=numbers.filter(id=>kind==="claim"?id.startsWith("G"):!id.startsWith("G"));
    if(primary.length!==1||num(at("amount"))===null||!at("name")||(kind==="purchase"&&!at("code")))
      throw Error("第 "+(rows.length+1)+" 筆"+(primary[0]?"（"+primary[0]+"）":"")+"缺少完整的單號、案名或金額"+(kind==="purchase"?"（請購另需預算來源）":"")+"，請檢查這一列。");
    rows.push({kind,page,id:primary[0],related:numbers.filter(id=>id!==primary[0]).join("、"),
      name:at("name"),status:at("status"),amount:at("amount"),code:at("code").replace(/\n+/g," "),applicant:at("applicant")});
    pending=null;
  };
  for(let i=0;i<lines.length;i++){
    const line=lines[i], normalized=norm(line), cells=line.split("\t").map(norm);
    if(cells.includes("案名")&&(cells.includes("金額")||cells.some(v=>/^(核銷|請購|申請|報支)金額$/.test(v)))){
      const header=(/^\s*維護\t/.test(lines[i-1]||"")?lines[i-1]+"\n"+line:line).split("\t").map(v=>norm(v).replace(/[\s▼▲▽△↕]+/g,""));
      const index=re=>header.findIndex(v=>re.test(v));
      const next={related:index(/^相關編號$/),status:index(/^(現況|表單狀態|狀態)$/),name:index(/^案名$/),code:index(/^(預算來源|經費來源|預算編號)$/),
        amount:index(kind==="claim"?/^(核銷金額|報支金額|金額)$/:/^(請購金額|申請金額|金額)$/),applicant:index(/^(申請人|承辦人|經辦人)$/),
        documents:header.map((v,j)=>/^(單號|申請單號|本核銷單號|核銷單號|請購單號|申請編號|核銷編號|請購編號|報支單號|相關編號)$/.test(v)?j:-1).filter(j=>j>=0)};
      if([next.status,next.name,next.amount,...(kind==="purchase"?[next.code]:[])].some(j=>j<0)||!next.documents.length)throw Error("表頭缺少必要欄位，請連同欄位標題一起複製。");
      flush();columns=next;tables++;continue;
    }
    if(!columns)continue;
    if(/^(?:新增紀錄|Copyright|表單現況說明|維護\t)/i.test(normalized)){flush();continue;}
    const status=cells[columns.status]||"";
    if(cells.length>columns.status&&/^(?:填寫中|簽核中|已決行|已完成|退回|已退回|作廢|已作廢|核銷中|待簽核|審核中|已核銷)$/.test(status)){
      flush();pending=[line];
    }else if(pending&&normalized&&!/^表單現況/.test(normalized))pending.push(line);
  }
  flush();
  if(!tables||!rows.length)throw Error("未讀到"+kindName(kind)+"表格。請從會統複製包含表頭、完整資料列及金額的文字。");
  return rows;
}
const fields=[["id","單號"],["related","關聯單號"],["name","案名"],["applicant","申請人"],["status","現況"],["amount","金額"],["code","預算來源"]];
const kindName=k=>k==="purchase"?"請購":"核銷";
function node(tag,text,attrs={}){
  const e=document.createElement(tag);e.textContent=text??"";
  for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);
  return e;
}
function book(result){
  if(!window.ExcelJS)throw Error("Excel 匯出元件尚未載入。");
  const wb=new window.ExcelJS.Workbook();
  const totals=wb.addWorksheet("對帳摘要"), ws=wb.addWorksheet("差異明細",{views:[{state:"frozen",ySplit:1}]});
  totals.columns=[{width:42},{width:58}];
  totals.addRows([["項目","結果"],["會統：未轉入核銷的請購",result.pendingAmount],["會統：核銷",result.claimAmount],["會統合計（已去重）",result.accounting],["資教：已核銷",result.budgetClaimed],["資教：已預估（含請購中、核銷中）",result.estimated],["資教合計",result.budget],["差額（資教－會統）",result.delta],["未找到的關聯單號",result.missing.join("、")]]);
  ws.columns=[23,22,37,15,17,23,24,43,17,16].map(width=>({width}));
  ws.addRow(["結果","申請人","資教案名","資教狀態","資教金額","請購單號","核銷單號","會統案名","會統計入金額","差額"]);
  for(const {type,r,group,amount,difference} of result.details)if(type!=="相符"){
    const row=ws.addRow([type,unique(group.map(g=>g.applicant)).join("／")||r?.applicant,r?.name,r?.stage,r?.amount,
      group.filter(g=>g.kind==="purchase").map(g=>g.id).join("、"),group.filter(g=>g.kind==="claim").map(g=>g.id).join("、"),unique(group.map(g=>g.name)).join("／"),amount,difference]);
    if(typeof difference==="number"&&difference!==0)row.getCell(10).font={color:{argb:"FFC00000"},bold:true};
  }
  ws.autoFilter={from:"A1",to:"J1"};
  for(const col of [5,9,10])ws.getColumn(col).numFmt='#,##0.##;[Red]-#,##0.##;0';
  for(const s of [totals,ws]){s.getRow(1).font={bold:true,color:{argb:"FFFFFFFF"}};s.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF513681"}};}
  return wb.xlsx.writeBuffer();
}
export function openShots({plan,draftKey,valid,authorized,getRecords,saveSummary,download}){
  if(document.getElementById("budgetShotsDialog"))return;
  const dlg=node("dialog","",{id:"budgetShotsDialog","aria-labelledby":"budgetShotsTitle"});
  dlg.style.cssText="position:fixed;inset:0;margin:auto;transform:none;width:min(1150px,calc(100vw - 24px));max-width:calc(100vw - 24px);height:fit-content;max-height:88vh;overflow:auto;box-sizing:border-box;padding:clamp(12px,2vw,20px)";
  dlg.innerHTML=`<h2 id="budgetShotsTitle">會統對帳｜貼上表格</h2><p data-plan></p>
    <p>在會統逐頁按 Ctrl+A、Ctrl+C，再貼到這裡加入。系統會自動統計去重後的筆數。</p>
    <label>會統表格文字<textarea data-copy rows="5" style="display:block;width:100%;box-sizing:border-box" placeholder="在會統選取含表頭的表格，複製後貼在這裡"></textarea></label>
    <p><button type="button" data-copy-p>加入請購表格</button> <button type="button" data-copy-c>加入核銷表格</button></p>
    <p><button type="button" data-close>關閉</button> <button type="button" data-clear>清除草稿</button></p>
    <p data-draft role="status">草稿會自動保留在這台裝置的瀏覽器。</p>
    <p data-status role="status" style="white-space:pre-wrap"></p>
    <p data-counts aria-live="polite">已加入：請購 0 筆、核銷 0 筆</p><div data-pages></div>
    <div style="margin-top:16px;padding:14px;background:#f5effa;border:1px solid #ddcce9;border-radius:10px">
      <label style="display:grid!important;grid-template-columns:22px minmax(0,1fr);align-items:center;gap:10px;cursor:pointer;font-weight:700;margin:0 0 12px">
        <input data-verified type="checkbox" style="width:22px!important;min-width:22px!important;max-width:22px!important;height:22px!important;margin:0!important;padding:0!important;justify-self:start;accent-color:#7653a6">
        <span>我已核對全部頁面，確認單號、關聯單號、金額與狀態正確</span>
      </label>
      <button type="button" class="primary-btn" data-calc>計算並儲存本次對帳</button>
      <button type="button" data-export disabled>下載本次明細</button>
    </div><div data-result></div>`;
  const el=k=>dlg.querySelector("[data-"+k+"]");
  el("plan").textContent=plan;
  const pages=[];let busy=false,result=null;
  const say=s=>el("status").textContent=s;
  const saveDraft=()=>{
    if(!valid()||!draftKey)return;
    try{
      const copy=el("copy").value;
      if(!pages.length&&!copy){
        localStorage.removeItem(draftKey);
        el("draft").textContent="草稿會自動保留在這台裝置的瀏覽器。";
        return;
      }
      localStorage.setItem(draftKey,JSON.stringify({copy,sequence:copySequence,pages:pages.map(({kind,label,rows})=>({kind,label,rows}))}));
      el("draft").textContent="草稿已儲存在這台裝置的瀏覽器，下次可繼續。";
    }catch{
      el("draft").textContent="這次草稿未能寫入瀏覽器。請先保留此視窗。";
    }
  };
  const refreshCounts=()=>{
    const rows=pages.flatMap(p=>p.rows), count=(kind,re)=>unique(rows.filter(r=>r.kind===kind).map(r=>norm(r.id).toUpperCase()).filter(id=>re.test(id))).length;
    el("counts").textContent="已加入（同單號只計一次）：請購 "+count("purchase",/^1\d{11}$/)+" 筆、核銷 "+count("claim",/^G\d{11}$/)+" 筆";
  };
  const invalidate=()=>{saveDraft();refreshCounts();el("verified").checked=false;el("export").disabled=true;el("result").replaceChildren();result=null;};
  const lock=v=>{busy=v;dlg.querySelectorAll("input, textarea, button").forEach(e=>{if(!e.matches("[data-close]"))e.disabled=v;});el("export").disabled=v||!result;};
  function blank(page){return Object.fromEntries([["kind",page.kind],["page",page.label],...fields.map(([k])=>[k,""])]);}
  function renderPage(page){
    const pane=page.pane??node("details");
    pane.style.cssText="margin:8px 0;border:1px solid #ded6e9;border-radius:8px;padding:8px";
    if(!page.pane){el("pages").append(pane);page.pane=pane;}
    const title=node("summary",page.label+"｜"+page.rows.length+" 列");
    const wrap=node("div");wrap.style.overflowX="auto";
    const table=node("table");table.style.cssText="width:100%;min-width:1000px";
    const header=node("tr");for(const [,l] of fields)header.append(node("th",l));header.append(node("th","移除"));table.append(header);
    page.rows.forEach((row,i)=>{
      const tr=node("tr");
      for(const [k,l] of fields){
        const td=node("td"),input=node("input","",{"aria-label":l+" 第 "+(i+1)+" 列",type:"text"});
        input.value=row[k];input.style.cssText="width:100%;min-width:"+(k==="name"||k==="code"?150:k==="id"||k==="related"?115:65)+"px;padding:5px";
        if(!row[k]&&(["id","amount","status","name"].includes(k)||(k==="code"&&row.kind==="purchase")))input.style.background="#fff4c2";
        input.addEventListener("input",()=>{row[k]=input.value;invalidate();});td.append(input);tr.append(td);
      }
      const td=node("td"),remove=node("button","×",{type:"button","aria-label":"移除第 "+(i+1)+" 列"});
      remove.onclick=()=>{page.rows.splice(i,1);invalidate();renderPage(page);};td.append(remove);tr.append(td);table.append(tr);
    });
    wrap.append(table);
    const add=node("button","新增一列",{type:"button"});add.onclick=()=>{page.rows.push(blank(page));invalidate();renderPage(page);};
    const removePage=node("button","移除此頁",{type:"button"});
    removePage.onclick=()=>{pages.splice(pages.indexOf(page),1);pane.remove();invalidate();};
    pane.replaceChildren(title,wrap,add,removePage);
  }
  let copySequence=0;
  for(const [key,kind] of [["copy-p","purchase"],["copy-c","claim"]]){
    el(key).onclick=()=>{
      if(busy||!valid())return;
      if(el("copy").value.length>500000||pages.length>=60)return say("這批資料太多，請分批對帳。");
      try{
        const label=kindName(kind)+"｜貼上表格 "+(copySequence+1);
        const rows=readCopiedTable(el("copy").value,kind,label);
        const page={kind,label,rows};copySequence++;
        pages.push(page);renderPage(page);el("copy").value="";invalidate();
        say("已加入 "+rows.length+" 筆"+kindName(kind)+"資料。可以接著貼下一頁。");
      }catch(e){say(e.message);}
    };
  }
  el("copy").addEventListener("input",saveDraft);
  el("clear").onclick=()=>{
    if(busy||!valid()||(!pages.length&&!el("copy").value))return;
    if(!window.confirm("清除目前計畫的對帳草稿？已儲存的對帳結果不受影響。"))return;
    pages.length=0;copySequence=0;el("copy").value="";el("pages").replaceChildren();
    invalidate();say("已清除草稿。");
  };
  if(draftKey){
    try{
      const draft=JSON.parse(localStorage.getItem(draftKey)||"null");
      if(draft&&Array.isArray(draft.pages)&&draft.pages.every(p=>["purchase","claim"].includes(p.kind)&&typeof p.label==="string"&&Array.isArray(p.rows))){
        pages.push(...draft.pages);
        copySequence=Math.max(pages.length,Number.isSafeInteger(draft.sequence)?draft.sequence:0);
        if(typeof draft.copy==="string")el("copy").value=draft.copy;
        pages.forEach(renderPage);refreshCounts();
        if(pages.length||el("copy").value)el("draft").textContent="已接續上次草稿，請確認資料後再勾選核對。";
      }
    }catch{
      el("draft").textContent="無法讀取瀏覽器中的對帳草稿。";
    }
  }
  const monitor=setInterval(()=>{if(!valid()&&dlg.open)dlg.close();},500);
  const active=()=>dlg.open&&valid();
  el("close").onclick=()=>dlg.close();
  dlg.addEventListener("close",()=>{clearInterval(monitor);dlg.remove();},{once:true});
  el("calc").onclick=async()=>{
    if(busy||!active())return;
    invalidateResult();
    if(!pages.length)return say("請先加入會統表格。");
    if(!el("verified").checked)return say("請先核對匯入結果並勾選確認。");
    lock(true);say("正在讀取目前計畫並對帳…");
    try{
      if(!await authorized()||!active())return;
      const rows=pages.flatMap(p=>p.rows),records=await getRecords();
      if(!active())return;
      const calculated=calculateShots(rows,records);
      result=calculated;
      const text="會統 "+cash(result.accounting)+" 元 ｜ 資教 "+cash(result.budget)+" 元 ｜ 差額 "+cash(result.delta)+" 元";
      el("result").append(node("p",text),node("p","已對上 "+result.details.filter(d=>d.type==="相符").length+" 組；其餘 "+result.details.filter(d=>d.type!=="相符").length+" 列請查看明細。"));
      if(result.missing.length){say("本批缺少關聯單號，僅可下載暫算明細，未更新最新對帳："+result.missing.join("、"));return;}
      if(!await authorized()||!active())return;
      await saveSummary(result);
      if(active())say("已儲存最新對帳摘要。");
    }catch(e){say(e.message||"對帳失敗。");}
    finally{lock(false);}
  };
  function invalidateResult(){result=null;el("result").replaceChildren();el("export").disabled=true;}
  el("export").onclick=async()=>{
    if(!result||busy||!active())return;
    lock(true);
    try{if(!await authorized()||!active())return;const data=await book(result);if(active())download(new Blob([data],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),"會統對帳.xlsx");}
    catch(e){say(e.message);}finally{lock(false);}
  };
  document.body.append(dlg);dlg.showModal();
}
