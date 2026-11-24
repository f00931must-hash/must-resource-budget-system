import {isBudgetManager,normalizeEmail} from './budget-permissions.mjs';
export const DIAGNOSTICS_VERSION='20261124-3';
export const EXPECTED_RELEASE={app:'installments-20261124',upload:'0.7.0',notify:'1.2.0'};
export function classifyFailure(input,stage='') {
  const text=String(input?.code||'')+' '+String(input?.message||input||'');
  let kind='unknown',code='unknown';
  if(/permission-denied|insufficient permissions|沒有.*權限|無.*權限|未獲授權/i.test(text)){kind='permission';code='permission-denied';}
  else if(/quota|resource-exhausted/i.test(text)){kind='quota';code='resource-exhausted';}
  else if(/unauthenticated|token-expired|憑證.*失效|尚未登入/i.test(text)){kind='session';code='unauthenticated';}
  else if(/已鎖定|已核銷並鎖定|已連結預支|已領款|合計不可超過/i.test(text)){kind='workflow';code='workflow-restriction';}
  else if(!/失敗|錯誤|error|failed/i.test(text))return null;
  const phases=['同步寫入分配與使用紀錄','寫入分配操作紀錄','讀取預估使用紀錄','讀取預支分配','讀取預支批次','儲存免附單據申請','新增免附單據申請','附件上傳','紀錄寫入','畫面更新','退款','分筆','核對','儲存'];
  const phase=phases.find(p=>text.includes(p)||String(stage).includes(p))||'未提供階段';
  // Only fixed labels are retained. No message, names, amounts, paths, IDs, or tokens.
  return {kind,code,phase,saved:/已儲存|已分配成功/.test(text)?'yes':'unknown'};
}
export function recordDiagnosis(r,email) {
  if(!r)return {kind:'missing',message:'找不到紀錄。請確認選取的紀錄仍存在。'};
  if(r.deleted===true)return {kind:'deleted',message:'紀錄在回收桶。請由管理員從回收桶還原。'};
  if(r.installment?.enabled){
    const s=r.installment;
    if(s.closed)return {kind:'installment-closed',message:'分次核銷已結案，不能刪除、重開或再次釋回餘額。'};
    if(s.everUsed||Object.keys(s.entries||{}).length)return {kind:'installment-used',message:'分次核銷已有歷程，不能取消模式或刪除主紀錄。請到「查看／登記明細」核對並結案；刪光明細也不解除模式鎖定。'};
    return {kind:'installment-empty',message:'這是尚無核銷明細的分次主紀錄，可以刪除。新版刪除會先取消空白模式，再移到回收桶。舊版可自行：編輯 → 取消勾選分次核銷 → 儲存 → 刪除。若仍被拒絕，請下載摘要；改帳號角色不會修復程式或規則缺漏。'};
  }
  if(r.reviewStatus==='approved'||r.reviewed===true||r.locked===true)return {kind:'locked',message:'紀錄已核對鎖定。請回使用紀錄按「解鎖」後再編輯。'};
  if(r.advanceAllocationId)return {kind:'linked',message:'已連結預支。金額請走追加或退款；解除分配請到預支／動支。本頁不更改紀錄。'};
  if(normalizeEmail(r.ownerEmail)!==normalizeEmail(email))return {kind:'other',message:'這筆不是目前帳號負責的紀錄；經費管理員仍可編輯，老師須用負責帳號操作。'};
  return {kind:'editable',message:'紀錄未鎖定。這只能確認狀態，不能證明所有寫入規則會通過。'};
}
export function healthDiagnosis(actual,expected){
  if(!actual?.ok||typeof actual.version!=='string')return {kind:'unknown',text:'無法確認部署版本，請查看服務後台。'};
  return actual.version===expected?{kind:'ok',text:`版本 ${actual.version}，符合目前版次。`}:{kind:'different',text:`目前 ${actual.version}；本版預期 ${expected}。版次不同，請確認是否已部署。`};
}
export function diagnosticReport({checks=[],events=[]}={}) {
  return {schema:1,version:DIAGNOSTICS_VERSION,generatedAt:new Date().toISOString(),rulesVersion:'unverified',checks:checks.map(c=>({service:['app','upload','notify','account'].includes(c.service)?c.service:'unknown',status:['ok','different','unknown','active','inactive'].includes(c.status)?c.status:'unknown',version:(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9]{1,8})?$/.test(c.version||'')||/^permissions-[0-9]{8}$/.test(c.version||''))?c.version:undefined})),events:events.slice(-20).map(e=>({at:Number.isFinite(e.at)?e.at:0,kind:['permission','quota','session','workflow','unknown'].includes(e.kind)?e.kind:'unknown',code:['permission-denied','resource-exhausted','unauthenticated','workflow-restriction'].includes(e.code)?e.code:'unknown',phase:['同步寫入分配與使用紀錄','寫入分配操作紀錄','讀取預估使用紀錄','讀取預支分配','讀取預支批次','儲存免附單據申請','新增免附單據申請','附件上傳','紀錄寫入','畫面更新','退款','分筆','核對','儲存'].includes(e.phase)?e.phase:'未提供階段',saved:e.saved==='yes'?'yes':'unknown'})),notice:'此摘要不含帳號、經費內容、金額、附件或登入憑證。讀取檢查不等於寫入測試。'};
}
export function createAccountService({auth,db,doc,getDocFromServer,runTransaction,serverTimestamp}) {
  const current=()=>normalizeEmail(auth.currentUser?.email);
  async function requireManager(){
    const email=current();if(!email)throw Error('尚未登入');
    const snap=await getDocFromServer(doc(db,'users',email));
    if(current()!==email||!snap.exists()||!isBudgetManager(snap.data(),email))throw Error('此功能僅限目前啟用中的經費管理員');
    return email;
  }
  return {
    async inspect(email){await requireManager();const key=normalizeEmail(email);if(!/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(key))throw Error('請輸入完整電子郵件');const snap=await getDocFromServer(doc(db,'users',key));return snap.exists()?{email:key,profile:snap.data()}:null;},
    async inspectRecord(id){const email=await requireManager();if(!/^[\w-]{1,128}$/.test(id))throw Error('紀錄編號格式不正確');const s=await getDocFromServer(doc(db,'expenseRecords',id));return recordDiagnosis(s.exists()?s.data():null,email);},
    async save(email,{role,enabled,expected}){
      const actor=await requireManager(),key=normalizeEmail(email);
      if(!/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(key)||!['user','teacher','advance','manager'].includes(role)||typeof enabled!=='boolean')throw Error('帳號或角色設定不正確');
      if(key===actor&&(!enabled||role!=='manager'))throw Error('不能在此停用或降級自己的管理員資格。請使用另一位管理員處理。');
      return runTransaction(db,async tx=>{
        const me=await tx.get(doc(db,'users',actor)),target=await tx.get(doc(db,'users',key));
        if(current()!==actor||!me.exists()||!isBudgetManager(me.data(),actor))throw Error('管理員資格已變更，請重新登入');
        if(!target.exists())throw Error('帳號不存在，請先從入口管理介面建立經費授權');
        const before=target.data();
        if(!expected||before.role!==expected.role||before.enabled!==expected.enabled)throw Error('帳號設定已被其他人變更，請重新檢查');
        if(before.role===role&&before.enabled===enabled)return {changed:false};
        tx.update(doc(db,'users',key),{role,enabled,updatedAt:serverTimestamp(),updatedBy:actor});
        return {changed:true};
      });
    }
  };
}
