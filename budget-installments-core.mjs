export const isInstallment=r=>r?.installment?.enabled===true;
export const installmentRows=r=>Object.entries(r.installment?.entries||{}).map(([id,item])=>({id,...item}));
export function occupiedAmount(r){return isInstallment(r)?(r.installment.closed?r.installment.total:Number(r.amount||0)):Number(r.amount||0)+Number(r.advanceTopUpTotal||0);}
export const emptyInstallment=()=>({enabled:true,everUsed:false,closed:false,total:0,reviewedTotal:0,entries:{},mutationKey:''});
export function mutateInstallment(record,action,id,item,manager=false){
 if(!isInstallment(record)||record.deleted||record.locked||record.advanceAllocationId)throw Error('此筆不能操作分次核銷');
 const s=record.installment;if(s.closed)throw Error('已結案，不能再次異動或釋回');
 const next={...s,entries:{...s.entries},mutationKey:id||''};
 if(action==='close'){
  if(!manager)throw Error('只有經費管理員可以結案');
  if(s.reviewedTotal!==s.total)throw Error('請先核對完成所有明細');
  return {...next,closed:true};
 }
 if(action==='disable'){
  if(s.everUsed)throw Error('已有核銷歷程，不能取消分次核銷');
  return {...next,enabled:false};
 }
 const old=s.entries[id];
 if(action==='review'||action==='unlock'){
  if(!manager||!old)throw Error('只有經費管理員可以核對明細');
  if(action==='review'&&!old.voucher?.url)throw Error('請先補上單據再核對完成');
  next.entries[id]={...old,reviewed:action==='review'};
 }else if(action==='delete'){
  if(!old||old.reviewed)throw Error('已核對明細須由管理員先解鎖');
  delete next.entries[id];
 }else{
  if(old?.reviewed)throw Error('已核對明細須先解鎖');
  if(!Number.isSafeInteger(item.amount)||item.amount<=0||!item.purpose?.trim()||!/^\d{4}-\d{2}-\d{2}$/.test(item.date))throw Error('請填日期、用途與正整數金額');
  if(item.voucher && !item.voucher.url?.startsWith('https://'))throw Error('單據連結格式不正確');
  next.entries[id]={...item,reviewed:false};
 }
 const updated=next.entries[id];
 next.total=s.total-(old?.amount||0)+(updated?.amount||0);
 next.reviewedTotal=s.reviewedTotal-(old?.reviewed?old.amount:0)+(updated?.reviewed?updated.amount:0);
 next.everUsed=true;
 if(next.total>Number(record.amount))throw Error('累計核銷不可超過原申請總額');
 if(Object.keys(next.entries).length>150)throw Error('單筆最多 150 項，請另建主紀錄');
 return next;
}
export function reconciliationParts(r){
 if(!isInstallment(r))return [r];
 const items=installmentRows(r).map(e=>({...r,purpose:r.purpose+'｜'+e.purpose,amount:e.amount,estimated:!e.reviewed,estimateStage:e.reviewed?'':'reimbursing',reviewStatus:e.reviewed?'approved':'estimated',reviewed:e.reviewed,installment:undefined,accountingId:e.reimbursementNo||'',reimbursementNo:e.reimbursementNo||'',voucherUrl:e.voucher?.url||''}));
 const left=Number(r.amount)-r.installment.total;
 if(!r.installment.closed&&left>0)items.push({...r,purpose:r.purpose+'｜尚未核銷餘額',amount:left,estimated:true,estimateStage:'purchasing',installment:undefined,accountingId:r.purchaseOrderNo||''});
 return items;
}
export function installmentBuckets(r){
 const s=r.installment;
 return {approved:s.reviewedTotal,pending:s.total-s.reviewedTotal,reserved:s.closed?0:Number(r.amount)-s.total};
}
