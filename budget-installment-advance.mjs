export function installmentAdvanceCandidates(records){
 return records.flatMap(parent=>{
  if(!parent.installment?.enabled)return [parent];
  if(parent.deleted||parent.installment.closed)return [];
  return Object.entries(parent.installment.entries||{}).filter(([,e])=>!e.advanceAllocationId).map(([key,e])=>({...parent,id:parent.id+'::'+key,purpose:parent.purpose+'｜'+e.purpose,amount:e.amount,estimated:true,reviewed:false,locked:false,reviewStatus:'estimated',_installmentParentId:parent.id,_installmentEntryId:key}));
 });
}
export function installmentAllocationRecord(a,records){
 const parent=records.find(r=>r.id===a.expenseRecordId);
 if(a.recordOrigin!=='installment-item')return parent||null;
 const entry=parent?.installment?.entries?.[a.installmentEntryId];
 if(!entry)return null;
 return {...parent,amount:entry.amount,advanceTopUpTotal:0,estimated:false,reviewed:entry.reviewed===true,locked:entry.reviewed===true,reviewStatus:entry.reviewed?'approved':'pending',purpose:entry.purpose};
}
export function linkInstallmentAllocation(parent,key,batch,allocationId,email,stamp,note=''){
 const s=parent.installment,e=s?.entries?.[key];
 if(!s?.enabled||s.closed||parent.deleted||!e||e.advanceAllocationId||!Number.isSafeInteger(e.amount)||e.amount<=0)throw Error('細項已分配、結案或變更，請重新選取');
 const categories=batch.categoryIds?.length?batch.categoryIds:[batch.categoryId];
 if(batch.deleted||batch.planId!==parent.planId||batch.semester!==parent.semester||!categories.includes(parent.categoryId))throw Error('細項與預支批次的計畫、學期或經費項目不符');
 return {
  installment:{...s,entries:{...s.entries,[key]:{...e,advanceAllocationId:allocationId}},mutationKey:key},
  allocation:{planId:parent.planId,batchId:batch.id,expenseRecordId:parent.id,installmentEntryId:key,categoryId:parent.categoryId,categoryName:parent.categoryName||'',ownerEmail:parent.ownerEmail,ownerName:parent.ownerName||parent.ownerEmail,purpose:parent.purpose+'｜'+e.purpose,estimatedAmount:e.amount,note,recordOrigin:'installment-item',payoutSplit:true,splitAssigned:0,splitUnreceived:0,splitRefundTotal:0,splitRecipients:{},deleted:false,createdBy:email,createdAt:stamp,updatedBy:email,updatedAt:stamp}
 };
}
export function unlinkInstallmentAllocation(parent,a){
 const s=parent.installment,e=s?.entries?.[a.installmentEntryId];
 if(a.deleted||a.recordOrigin!=='installment-item'||!e||e.advanceAllocationId!==a.id||Number(a.splitAssigned||0)!==0||s.closed)throw Error('請先刪除尚未領取的分筆款項；已有領款或已結案不能解除');
 return {...s,entries:{...s.entries,[a.installmentEntryId]:{...e,advanceAllocationId:''}},mutationKey:a.installmentEntryId};
}
