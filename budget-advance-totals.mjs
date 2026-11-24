// Cash allocated to a teacher: additional payments consume the batch balance;
// only refunds already confirmed against the linked expense release it.
export function grossAdvance(allocation){
  return Number(allocation.estimatedAmount||0)+Number(allocation.advanceTopUpTotal||0);
}
export function netAdvance(allocation,confirmedRefundAmount=0){
  return grossAdvance(allocation)-Number(confirmedRefundAmount||0);
}
