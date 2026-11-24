// The existing rules allow unused mode cancellation, then ordinary recycling.
// Both steps retain the original amount; used/closed ledgers are never converted.
export async function prepareInstallmentRecycle({db,ref,runTransaction,serverTimestamp,email,manager}){
 return runTransaction(db,async tx=>{
  const snap=await tx.get(ref),r=snap.exists()?snap.data():null;
  if(!r||r.deleted)throw Error('紀錄已移除，請重新整理');
  if(!manager&&r.ownerEmail!==email)throw Error('只能刪除自己的紀錄');
  const s=r.installment;
  if(!s?.enabled)return false;
  if(s.everUsed||s.closed||s.total!==0||s.reviewedTotal!==0||Object.keys(s.entries||{}).length||r.locked||r.reviewed||r.advanceAllocationId)throw Error('已有核銷歷程或已鎖定，請使用結案保留明細');
  tx.update(ref,{installment:{...s,enabled:false},updatedBy:email,updatedAt:serverTimestamp()});
  return true;
 });
}
