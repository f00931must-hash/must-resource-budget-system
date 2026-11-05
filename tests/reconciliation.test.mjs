import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../budget-reconciliation-shots.js',import.meta.url),'utf8');
const { calculateShots, readCopiedTable }=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const claim=(id,name,amount,more={})=>({kind:'claim',id,name,amount,related:'',status:'已完成',applicant:'林測試',...more});
const local=(name,amount,more={})=>({name,amount,stage:'已核銷',applicant:'測試',...more});
const exceptions=r=>r.details.filter(d=>d.type!=='相符');

test('核銷整頁文字：關聯欄換行，傳票不是請購單號',()=>{
  const table=[
    ['維護','現況','年度','本核銷單號▼','相關編號','案名','金額','單位','申請人','選'].join('\t'),
    ['查詢紀錄列表','已完成','116','G20270101001','申請單號：120270101001'].join('\t'),
    ['測試案名','12,475','資教','林測試',''].join('\t'),
    ['查詢紀錄列表','已完成','116','G20270101002','傳票編號：1160916D076','另一個測試案','200','資教','林測試',''].join('\t')
  ].join('\n');
  const rows=readCopiedTable(table,'claim','測試頁');
  assert.deepEqual(rows.map(r=>[r.id,r.related,r.amount]),[['G20270101001','120270101001','12,475'],['G20270101002','','200']]);
});
test('跨年度共用規則：全名與簡稱、案名簡寫及異體字',()=>{
  const rows=[claim('G20270101001','核銷合理調整推廣文宣品（濕紙巾）',18000)];
  const r=calculateShots(rows,[local('合理調整溼紙巾',18000)]);
  assert.equal(r.details[0].type,'相符');
  assert.deepEqual(exceptions(r),[]);
});
test('確定是同一案，金額不同時只列一筆有方向的差額',()=>{
  const rows=[claim('G20270101001','擬核銷「糕點×海洋律動」戶外體驗活動',39247)];
  const r=calculateShots(rows,[local('「糕點X海洋律動」戶外暨體驗活動',39245,{applicant:'另一位老師'})]);
  assert.deepEqual(exceptions(r).map(d=>[d.type,d.difference]),[['金額不同',-2]]);
});
test('同預支的分批核銷逐筆比對，金額與總額都不重算請購',()=>{
  const id='120270101001';
  const a=claim('G20270101001','核銷資源教室雜支：充電線及小信封等',9057,{related:id});
  const b=claim('G20270101002','核銷資源教室雜支：鍵盤及滑鼠等',9573,{related:id});
  const p={kind:'purchase',id,name:'資源教室雜支',amount:30000,status:'已完成',applicant:'林測試',code:'006',related:a.id+'、'+b.id};
  const ar=local('資源教室雜支：充電線及小信封等',9057,{accountingId:id});
  const br=local('資源教室雜支：鍵盤及滑鼠等',9573);
  const r=calculateShots([p,a,b,a],[ar,br]);
  assert.equal(r.accounting,18630);assert.equal(r.pendingAmount,0);
  assert.deepEqual(exceptions(r),[]);
  assert.deepEqual(exceptions(calculateShots([p,a,b],[ar])).map(d=>[d.amount,d.group.map(row=>row.id)]),[[9573,[id,b.id]]]);
  assert.deepEqual(calculateShots([p,a],[ar]).missing,[b.id]);
  assert.equal(exceptions(calculateShots([p,a,b],[local('資源教室雜支',30000,{accountingId:id})])).filter(d=>d.r&&d.group.length).length,0);
});
test('同金額、學期衝突或候選有歧義，不自動合併',()=>{
  const a=claim('G20270101001','116-1學生期初會議',11830);
  for(const rs of [[local('116-2學生期初會議',11830)],[local('設備採購測試',11830)],[local('116-1學生期初會議',11830),local('116-1學生期初會議',11830)]]){
    assert(!calculateShots([a],rs).details.some(d=>d.type==='相符'));
  }
});

test('作廢及排除類別不計入，會議和差旅不因申請人員身分被排除',()=>{
  const r=calculateShots([
    claim('G20270101001','助理人員服務費',1000),
    claim('G20270101002','助理人員期末工作會議',200),
    claim('G20270101003','輔導人員差旅費',300),
    claim('G20270101004','作廢的測試費用',400,{status:'已作廢'}),
    claim('G20270101005','課業輔導鐘點費',500)
  ],[local('輔導人員費',600,{category:'輔導人員費'}),local('助理人員期末工作會議',200)]);
  assert.equal(r.accounting,500);
  assert.equal(r.budget,200);
});

test('案名簡寫：系所名稱、桌遊短名及職涯活動別名',()=>{
  const accounting=[
    claim('G20270101001','核銷個別化支持計畫(ISP)會議—資工系、半材系、時尚系',5088),
    claim('G20270101002','擬辦理玩出職業想像-橫桿人生桌遊工作坊',10634),
    claim('G20270101003','擬辦資源教室「職涯不迷航職涯諮詢與評估」...',35203),
    claim('G20270101004','擬辦「職人工事參訪體驗活動」',42373)
  ];
  const records=[
    local('個別化支持計畫(ISP)會議(資工、半材、時尚系)',5006),
    local('橫槓人生桌遊',10422),
    local('人生導航職涯諮詢與評估',35203),
    local('橋接未來畢業生轉銜輔導座談會',8698)
  ];
  const r=calculateShots(accounting,records);
  assert.deepEqual(r.details.filter(d=>d.r&&d.group.length).map(d=>[d.type,d.difference]),[['金額不同',-82],['金額不同',-212],['相符',0]]);
  assert(exceptions(r).some(d=>d.group.some(s=>s.id==='G20270101004')&&!d.r));
  assert(!calculateShots(accounting.slice(2,3),[local(records[2].name,35100)]).details.some(d=>d.r&&d.group.length));
  assert(!calculateShots(accounting.slice(0,1),[local('個別化支持計畫(ISP)會議(資工、半材、機械系)',5006)]).details.some(d=>d.r&&d.group.length));
});
