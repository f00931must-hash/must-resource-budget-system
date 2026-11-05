const excluded=/助理人員服務費|輔導人員費|課業輔導鐘點費/;
const norm=v=>String(v??"").normalize("NFKC").trim();
const nameKey=v=>norm(v).toLowerCase().replace(/^(?:擬?辦理|請購|擬核銷|核銷)*(?:資源教室)?/,"").replace(/[^\p{L}\p{N}]/gu,"");
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
  // A purchase with a listed claim is transferred even if the claim screenshot is missing.
  const transferred=r=>r.related.some(id=>!map.has(id)||kept.has(id))||links.get(r.id).size>0;
  const claims=active.filter(r=>r.kind==="claim"), pending=active.filter(r=>r.kind==="purchase"&&!transferred(r));
  const pendingAmount=sum(pending,r=>r.amount), claimAmount=sum(claims,r=>r.amount);
  const accounting=sum([pendingAmount,claimAmount],x=>x);
  const budgetRecords=records.filter(r=>!excluded.test(r.category)&&["已核銷","預估","請購中","核銷中"].includes(r.stage));
  const budget=sum(budgetRecords,r=>Number(r.amount||0));
  const budgetClaimed=sum(budgetRecords.filter(r=>r.stage==="已核銷"),r=>Number(r.amount||0));
  const seen=new Set();
  const groups=active.flatMap(r=>{
    if(seen.has(r.id))return [];
    const queue=[r], group=[];seen.add(r.id);
    for(const s of queue){
      group.push(s);
      for(const id of links.get(s.id))if(!seen.has(id)){seen.add(id);queue.push(kept.get(id));}
    }
    const counted=group.filter(s=>s.kind==="claim"||!transferred(s));
    return [{group,amount:counted.length?sum(counted,s=>s.amount):null}];
  });
  const recordsForMatch=records.filter(r=>!excluded.test(r.category));
  const candidates=groups.map(g=>recordsForMatch.map((r,i)=>{
    const id=refs([r.accountingId,r.note,r.name].join(" "));
    if(g.group.some(s=>id.includes(s.id)))return {i,rank:2};
    const n=nameKey(r.name);
    return n.length>=4&&g.group.some(s=>!/(?:…|\.{2,})/.test(s.name)&&nameKey(s.name)===n&&
      (Number(r.amount)===g.amount||norm(r.applicant)&&norm(r.applicant)===norm(s.applicant)))?{i,rank:1}:null;
  }).filter(Boolean));
  const used=new Set(), details=[];
  groups.forEach((g,k)=>{
    const cs=candidates[k],rank=Math.max(0,...cs.map(c=>c.rank));
    const best=cs.filter(c=>c.rank===rank);
    const match=best.length===1&&candidates.filter(v=>v.some(c=>c.i===best[0].i&&c.rank>=rank)).length===1?best[0]:null;
    const r=match?recordsForMatch[match.i]:null;
    if(r)used.add(match.i);
    const difference=r&&g.amount!==null?sum([Number(r.amount),-g.amount],x=>x):null;
    const done=g.group.some(s=>s.kind==="claim"&&s.status==="已完成");
    const type=!r?(cs.length?"待人工確認":"會統有，資教待配對"):g.amount===null?"待核銷畫面":difference!==0?"金額不同":(r.stage==="已核銷")!==done?"完成狀態不同":"相符";
    details.push({type,r,group:g.group,amount:g.amount,difference});
  });
  recordsForMatch.forEach((r,i)=>{if(!used.has(i))details.push({type:candidates.some(c=>c.some(x=>x.i===i))?"待人工確認":"資教有，本次會統未配對",r,group:[],amount:null,difference:null});});
  return {accounting,budget,delta:sum([budget,-accounting],x=>x),claimAmount,pendingAmount,budgetClaimed,estimated:sum([budget,-budgetClaimed],x=>x),missing:[...missing],duplicates,details,purchases:[...map.values()].filter(r=>r.kind==="purchase").length,claims:[...map.values()].filter(r=>r.kind==="claim").length};
}
const OCR="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/";
let loader;
async function worker(){
  loader??=new Promise((resolve,reject)=>{
    const s=document.createElement("script"), t=setTimeout(()=>fail(),15000);
    const fail=()=>{clearTimeout(t);s.remove();reject(Error("辨識元件無法載入，可先手動輸入。"));};
    s.src=OCR+"tesseract.min.js";s.onload=()=>{clearTimeout(t);resolve(window.Tesseract);};s.onerror=fail;document.head.append(s);
  }).catch(e=>{loader=null;throw e;});
  const api=await loader;
  const w=await api.createWorker("chi_tra+eng",1,{workerPath:OCR+"worker.min.js"});
  try{await w.setParameters({tessedit_pageseg_mode:"11",preserve_interword_spaces:"1"});return w;}
  catch(e){await w.terminate();throw e;}
}
export function grid(pixels,w,h){
  const mask=new Uint8Array(w*h);
  for(let i=0;i<mask.length;i++)mask[i]=Math.abs(pixels[4*i]-182)<=4&&Math.abs(pixels[4*i+1]-203)<=4&&Math.abs(pixels[4*i+2]-208)<=4;
  const ys=[];
  for(let y=0;y<h;y++){
    let n=0;for(let x=0;x<w;x+=3)n+=mask[y*w+x];
    if(n>w*.24){if(ys.at(-1)===y-1)ys[ys.length-1]=y;else ys.push(y);}
  }
  const bands=[];
  for(let k=1;k<ys.length;k++){
    const a=ys[k-1], b=ys[k];
    if(b-a<15||b-a>Math.min(h,400))continue;
    const xs=[];
    for(let x=0;x<w;x++){
      let n=0,t=0;for(let y=a+3;y<b-2;y+=3){t++;n+=mask[y*w+x];}
      if(n>=.8*t){if(xs.at(-1)===x-1)xs[xs.length-1]=x;else xs.push(x);}
    }
    if(xs.length>=5)bands.push({a,b,xs});
  }
  const runs=[];
  for(const band of bands){
    const run=runs.at(-1);
    if(run?.at(-1).b===band.a)run.push(band);else runs.push([band]);
  }
  const run=runs.sort((a,b)=>b.length-a.length)[0];
  if(!run||run.length<2)throw Error("無法定位表格，請保留欄位標題與格線，或手動補登。");
  const xs=[...new Set([0,...run[0].xs,w])];
  return {ys:[run[0].a,...run.map(b=>b.b)],xs};
}
export function purchaseColumns(xs){
  // Identify the known form by the widths of ten consecutive columns, independent of crop or zoom.
  const widths=[86,52,51,172,172,241,344,86,172,86];
  for(let s=0;s+widths.length<xs.length;s++){
    const scale=(xs[s+7]-xs[s+6])/widths[6];
    if(scale<0.45||scale>3.5)continue;
    if(widths.every((w,i)=>Math.abs(xs[s+i+1]-xs[s+i]-w*scale)<=Math.max(4,w*scale*0.09)))
      return {status:s,documentCols:[s+3],name:s+5,code:s+6,amount:s+7,applicant:s+9};
  }
  return null;
}
function words(tsv,scale){
  return String(tsv||"").split("\n").slice(1).flatMap(s=>{
    const c=s.split("\t");return c[0]==="5"&&c[11]?[{x:(+c[6]+ +c[8]/2)/scale,y:(+c[7]+ +c[9]/2)/scale,t:c.slice(11).join("\t"),conf:+c[10]}]:[];
  }).sort((a,b)=>Math.abs(a.y-b.y)<4?a.x-b.x:a.y-b.y);
}
async function readPage(w,file,kind,page){
  const img=await createImageBitmap(file);
  try {
    if(img.width*img.height>16000000)throw Error("圖片尺寸過大，請截取會統表格。");
    const canvas=document.createElement("canvas"), ctx=canvas.getContext("2d",{willReadFrequently:true});
    const width=canvas.width=img.width,height=canvas.height=img.height;ctx.drawImage(img,0,0);
    const im=ctx.getImageData(0,0,width,height), {xs,ys}=grid(im.data,width,height);
    for(let i=0;i<im.data.length;i+=4){
      const [r,g,b]=[im.data[i],im.data[i+1],im.data[i+2]];
      const v=Math.min(r,g,b)<155?Math.min(r,g,b):255;
      im.data[i]=im.data[i+1]=im.data[i+2]=v;im.data[i+3]=255;
    }
    ctx.putImageData(im,0,0);
    const enlarged=document.createElement("canvas"), scale=width>2300?1.5:2;
    enlarged.width=Math.round(width*scale);enlarged.height=Math.round(height*scale);
    enlarged.getContext("2d").drawImage(canvas,0,0,enlarged.width,enlarged.height);
    const {data}=await w.recognize(enlarged,{}, {tsv:true});
    const tokens=words(data.tsv,scale), cells=ys.slice(1).map((y,i)=>xs.slice(1).map((x,j)=>{
      const cell=tokens.filter(t=>t.x>=xs[j]&&t.x<x&&t.y>=ys[i]&&t.y<y);
      return cell.map(t=>t.t).join(" ").replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g,"$1");
    }));
    const headers=cells.shift().map(s=>s.replace(/\s/g,""));
    const col=(rx)=>headers.findIndex(x=>rx.test(x));
    const codeCol=col(/預算來源|預算編號|經費來源|經費科目/);
    const fallback={status:col(/現況|狀態/),name:col(/案名|用途|摘要/),
      amount:col(kind==="claim"?/核銷金額|^金額$|報支金額|報銷金額/:/^金額$|申請金額|請購金額/),
      applicant:col(/申請人|承辦人|經辦人/),code:codeCol,
      documentCols:headers.map((h,i)=>/單號|編號/.test(h)&&i!==codeCol?i:-1).filter(i=>i>=0)};
    const {status,name,amount,applicant,code,documentCols}=(kind==="purchase"?purchaseColumns(xs):null)||fallback;
    if([status,name,amount,code].some(i=>i<0)||!documentCols.length)throw Error("未能辨識會統表頭；請確認截圖類別正確，並保留表格左右兩側及欄位標題。");
    return cells.map(c=>{
      const numbers=refs(documentCols.map(i=>(c[i]||"").replace(/(?<=\d)\s+(?=\d)|(?<=\bG)\s+(?=\d)/gi,"")).join(" "));
      const id=numbers.find(x=>kind==="claim"?x.startsWith("G"):!x.startsWith("G"))||"";
      const related=numbers.filter(x=>kind==="claim"?!x.startsWith("G"):x.startsWith("G")).join("、");
      return {kind,page,id,related,name:c[name],status:c[status],amount:c[amount].replace(/\s/g,""),code:c[code],applicant:c[applicant]||""};
    });
  }finally{img.close();}
}
export function readCopiedTable(text,kind,page){
  const lines=String(text).replace(/\r\n?/g,"\n").split("\n"), rows=[];
  let columns=null, pending=null, tables=0;
  const flush=()=>{
    if(!pending||!columns)return;
    const cols=pending.join("\n").split("\t").map(norm), at=k=>cols[columns[k]]||"";
    const numbers=refs(columns.documents.map(i=>cols[i]||"").join(" "));
    const primary=numbers.filter(id=>kind==="claim"?id.startsWith("G"):!id.startsWith("G"));
    if(primary.length!==1||num(at("amount"))===null||!at("name")||(kind==="purchase"&&!at("code")))
      throw Error("有一列缺少完整的單號、案名或金額（請購另需預算來源），請重新複製完整表格。");
    rows.push({kind,page,id:primary[0],related:numbers.filter(id=>id!==primary[0]).join("、"),
      name:at("name"),status:at("status"),amount:at("amount"),code:at("code").replace(/\n+/g," "),applicant:at("applicant")});
    pending=null;
  };
  for(let i=0;i<lines.length;i++){
    const line=lines[i], normalized=norm(line), cells=line.split("\t").map(norm);
    if(cells.includes("案名")&&(cells.includes("金額")||cells.some(v=>/^(核銷|請購|申請|報支)金額$/.test(v)))){
      const header=(/^\s*維護\t/.test(lines[i-1]||"")?lines[i-1]+"\n"+line:line).split("\t").map(v=>norm(v).replace(/[\s▼▲▽△↕]+/g,""));
      const index=re=>header.findIndex(v=>re.test(v));
      const next={status:index(/^(現況|表單狀態|狀態)$/),name:index(/^案名$/),code:index(/^(預算來源|經費來源|預算編號)$/),
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
    ws.addRow([type,unique(group.map(g=>g.applicant)).join("／")||r?.applicant,r?.name,r?.stage,r?.amount,
      group.filter(g=>g.kind==="purchase").map(g=>g.id).join("、"),group.filter(g=>g.kind==="claim").map(g=>g.id).join("、"),unique(group.map(g=>g.name)).join("／"),amount,difference]);
  }
  ws.autoFilter={from:"A1",to:"J1"};
  for(const col of [5,9,10])ws.getColumn(col).numFmt='#,##0.##;[Red]-#,##0.##;0';
  for(const s of [totals,ws]){s.getRow(1).font={bold:true,color:{argb:"FFFFFFFF"}};s.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF513681"}};}
  return wb.xlsx.writeBuffer();
}
export function openShots({plan,valid,authorized,getRecords,saveSummary,download}){
  if(document.getElementById("budgetShotsDialog"))return;
  const dlg=node("dialog","",{id:"budgetShotsDialog","aria-labelledby":"budgetShotsTitle"});
  dlg.style.cssText="width:min(1150px,calc(100% - 24px));max-height:88vh;box-sizing:border-box;padding:20px";
  dlg.innerHTML=`<h2 id="budgetShotsTitle">會統對帳｜貼上表格或截圖</h2><p data-plan></p>
    <p>建議從會統複製表格文字，保留表頭。可逐頁貼上、逐頁加入；圖片也可辨識。</p>
    <label>會統表格文字<textarea data-copy rows="5" style="display:block;width:100%;box-sizing:border-box" placeholder="在會統選取含表頭的表格，複製後貼在這裡"></textarea></label>
    <p><button type="button" data-copy-p>加入請購表格</button> <button type="button" data-copy-c>加入核銷表格</button></p>
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      <div><label>請購截圖 <input data-purchase type="file" multiple accept="image/png,image/jpeg,image/webp"></label><button type="button" data-paste-p>在此貼上請購截圖</button></div>
      <div><label>核銷截圖 <input data-claim type="file" multiple accept="image/png,image/jpeg,image/webp"></label><button type="button" data-paste-c>在此貼上核銷截圖</button></div>
    </div>
    <p><button type="button" data-scan>辨識選取的圖片</button> <button type="button" data-close>關閉</button></p>
    <p data-status role="status" style="white-space:pre-wrap"></p><div data-pages></div>
    <p><label>會統請購總筆數 <input data-count-p type="number" min="0" step="1" style="width:90px"></label>
    <label>會統核銷總筆數 <input data-count-c type="number" min="0" step="1" style="width:90px"></label></p>
    <p><label><input data-verified type="checkbox"> 我已核對全部頁面，確認單號、關聯單號、金額與狀態正確</label></p>
    <button type="button" class="primary-btn" data-calc>計算並儲存本次對帳</button>
    <button type="button" data-export disabled>下載本次明細</button><div data-result></div>`;
  const el=k=>dlg.querySelector("[data-"+k+"]");
  el("plan").textContent=plan;
  const pages=[],urls=[], inputs=[el("purchase"),el("claim")];let busy=false,result=null;
  const say=s=>el("status").textContent=s;
  const pasted={purchase:[],claim:[]};
  for(const [k,kind] of [["paste-p","purchase"],["paste-c","claim"]]){
    const target=el(k), hint=()=>say("請按 Ctrl+V（Mac：⌘V）貼上"+kindName(kind)+"截圖。");
    target.onclick=hint;
    target.addEventListener("paste",e=>{
      const files=[...(e.clipboardData?.files||[])].filter(f=>/^image\/(png|jpeg|webp)$/.test(f.type));
      if(!files.length||busy)return;
      e.preventDefault();
      if(pasted.purchase.length+pasted.claim.length+pages.length+files.length>60)return say("最多可辨識 60 張。");
      pasted[kind].push(...files.map((f,i)=>new File([f],kindName(kind)+"截圖 "+(pasted[kind].length+i+1)+"."+f.type.split("/")[1],{type:f.type})));
      say("已待辨識：請購 "+pasted.purchase.length+" 張、核銷 "+pasted.claim.length+" 張（貼上）。可繼續貼或按辨識。");
    });
  }
  const invalidate=()=>{el("verified").checked=false;el("export").disabled=true;el("result").replaceChildren();result=null;};
  const lock=v=>{busy=v;dlg.querySelectorAll("input, button").forEach(e=>{if(!e.matches("[data-close]"))e.disabled=v;});el("export").disabled=v||!result;};
  function blank(page){return Object.fromEntries([["kind",page.kind],["page",page.label],...fields.map(([k])=>[k,""])]);}
  function renderPage(page){
    const pane=page.pane??node("details");
    pane.style.cssText="margin:8px 0;border:1px solid #ded6e9;border-radius:8px;padding:8px";
    if(!page.pane){el("pages").append(pane);page.pane=pane;}
    const title=node("summary",page.label+"｜"+(page.error?"未辨識，需檢查原圖":page.rows.length+" 列"));
    const imageLink=page.url?node("a","開啟原圖",{href:page.url,target:"_blank",rel:"noopener"}):node("small","來源：貼上的會統表格文字");
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
    pane.replaceChildren(title,imageLink,page.error?node("p",page.error):node("span"),wrap,add,removePage);
    if(page.error)pane.open=true;
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
        pages.push(page);renderPage(page);invalidate();el("copy").value="";
        say("已加入 "+rows.length+" 筆"+kindName(kind)+"資料。可以接著貼下一頁。");
      }catch(e){say(e.message);}
    };
  }
  const monitor=setInterval(()=>{if(!valid()&&dlg.open)dlg.close();},500);
  const active=()=>dlg.open&&valid();
  el("close").onclick=()=>dlg.close();
  dlg.addEventListener("close",()=>{clearInterval(monitor);urls.forEach(u=>URL.revokeObjectURL(u));dlg.remove();},{once:true});
  for(const k of ["count-p","count-c"])el(k).addEventListener("input",invalidate);
  el("scan").onclick=async()=>{
    if(busy||!active())return;
    const batch=inputs.flatMap((input,i)=>{const kind=i?"claim":"purchase";return [...input.files,...pasted[kind]].map(file=>({file,kind}));});
    if(!batch.length)return say("請先選擇截圖。");
    if(pages.length+batch.length>60||batch.some(x=>x.file.size>12*1024*1024||!/^image\/(png|jpeg|webp)$/.test(x.file.type)))return say("最多 60 張，每張最多 12 MB，請選 PNG、JPEG 或 WebP。");
    lock(true);invalidate();say("正在載入截圖辨識元件…");
    let w=null,initError="";
    try{
      if(!await authorized()||!active())return;
      try{w=await worker();}catch(e){initError=e.message||"辨識元件無法載入。";}
      for(const [i,{file,kind}] of batch.entries()){
        if(!active())return;
        const label=kindName(kind)+"｜"+file.name,url=URL.createObjectURL(file);urls.push(url);
        const page={kind,label,url,rows:[],error:initError};
        say("正在辨識 "+(i+1)+" / "+batch.length+" 張…");
        if(w)try{page.rows=await readPage(w,file,kind,label);}catch(e){page.error=e.message;}
        if(!active())return;
        if(!page.rows.length)page.rows.push(blank(page));
        pages.push(page);renderPage(page);lock(true);
      }
      inputs.forEach(i=>i.value="");pasted.purchase=[];pasted.claim=[];
      say("已加入 "+pages.length+" 張截圖，其中 "+pages.filter(p=>p.error).length+" 張未能辨識。請展開各頁核對。");
    }catch(e){say(e.message);}
    finally{try{await w?.terminate();}finally{lock(false);}}
  };
  el("calc").onclick=async()=>{
    if(busy||!active())return;
    invalidateResult();
    if(!pages.length)return say("請先加入會統表格或截圖。");
    if(!el("verified").checked)return say("請先核對匯入結果並勾選確認。");
    const counts=[el("count-p").value,el("count-c").value];
    if(counts.some(x=>!/^\d+$/.test(x)))return say("請填寫會統兩邊顯示的總筆數。");
    lock(true);say("正在讀取目前計畫並對帳…");
    try{
      if(!await authorized()||!active())return;
      const rows=pages.flatMap(p=>p.rows),records=await getRecords();
      if(!active())return;
      const calculated=calculateShots(rows,records);
      if(calculated.purchases!==Number(counts[0])||calculated.claims!==Number(counts[1]))throw Error("筆數不符：辨識到請購 "+calculated.purchases+" 筆、核銷 "+calculated.claims+" 筆（已排除重複資料列）。請檢查是否缺頁。");
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
