import {getApps} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {getAuth} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {getFirestore,doc,getDoc,runTransaction,serverTimestamp} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
const money=new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0});
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
export function refundDue(a,r){return a.refundReported===true?Number(a.refundAmount||0):0;}
export function confirmedRefund(a,r){return a.refundReceivedConfirmed===true&&r&&Number(r.amount)===Number(a.estimatedAmount)-Number(a.refundAmount)&&Number(a.refundAmount)>0?Number(a.refundAmount):0;}
export function settlementMarkup(a,r,manager=false){
 if(!r||a.allocationReceivedConfirmed!==true)return "";
 if(a.refundReceivedConfirmed===true)return '<small style="display:block">✓ 已收到退款 '+money.format(a.refundAmount)+'</small>';
 if(a.refundReported===true)return '<div style="margin-top:8px"><strong>申報退款 '+money.format(a.refundAmount)+'</strong><small style="display:block">待管理員確認收到</small>'+(manager?'<button class="primary-btn" data-settlement-action="receive" data-allocation="'+esc(a.id)+'">確認收到退款</button>':'')+'</div>';
 if(manager)return "";
 return '<div style="margin-top:8px"><input type="number" min="1" max="'+Number(a.estimatedAmount||0)+'" step="1" data-refund-amount="'+esc(a.id)+'" aria-label="退款金額" placeholder="輸入退款金額" style="max-width:150px"><button class="primary-btn" data-settlement-action="report" data-allocation="'+esc(a.id)+'">申報退款</button></div>';
}
let busy=false;
export async function settlementAction(button){
 if(busy)return;
 const app=getApps().find(a=>a.options?.projectId==="must-resource-budget-system"),auth=getAuth(app),db=getFirestore(app),user=auth.currentUser,email=user?.email?.toLowerCase();
 if(!email)return;
 const action=button.dataset.settlementAction,id=button.dataset.allocation;
 const me=await getDoc(doc(db,"users",email));if(!me.exists()||me.data().enabled!==true)throw Error("帳號未啟用");
 const manager=me.data().role==="manager";
 if(action==="receive"&&!manager)throw Error("僅管理員可以確認");
 if(!["report","receive"].includes(action))throw Error("請重新整理使用新版退款流程");
 const input=button.parentElement?.querySelector("[data-refund-amount]");
 const amount=Number(input?.value);
 if(action==="report"&&(!Number.isInteger(amount)||amount<=0))throw Error("請輸入大於 0 的退款金額");
 if(!confirm(action==="receive"?"確認你已實際收到這筆退款？確認後才更正使用紀錄金額並釋回可用額度。":"申報退款 "+money.format(amount)+" 給管理員確認？"))return;
 busy=true;button.disabled=true;
 try{
 const ar=doc(db,"advanceAllocations",id);
 await runTransaction(db,async tx=>{
 const as=await tx.get(ar);if(!as.exists())throw Error("找不到分配紀錄");
 const a=as.data();if(a.deleted===true||a.allocationReceivedConfirmed!==true)throw Error("分配已移除或尚未確認領款");
 const rr=doc(db,"expenseRecords",a.expenseRecordId),rs=await tx.get(rr);if(!rs.exists())throw Error("找不到使用紀錄");
 const r=rs.data();if(r.deleted===true||r.advanceAllocationId!==id)throw Error("連結已變更，請重新整理");
 const now=serverTimestamp(),stamp={updatedAt:now,updatedBy:email};
 if(action==="report"){
 if(String(a.ownerEmail||"").toLowerCase()!==email||a.refundReported===true||a.refundReceivedConfirmed===true)throw Error("不能重複申報此筆退款");
 if(amount>Number(a.estimatedAmount))throw Error("退款不可超過原分配金額");
 tx.update(ar,{refundReported:true,refundAmount:amount,refundReportedBy:email,refundReportedAt:now,...stamp});
 }else{
 const refund=Number(a.refundAmount),remaining=Number(a.estimatedAmount)-refund;
 if(a.refundReported!==true||a.refundReceivedConfirmed===true||!Number.isInteger(refund)||refund<=0||remaining<0)throw Error("退款已處理或金額不正確");
 tx.update(rr,{amount:remaining,refundAdjustment:{allocationId:id,originalAmount:Number(a.estimatedAmount),refundAmount:refund,remainingAmount:remaining,confirmedBy:email,confirmedAt:now},...(r.actualAdjustment?.status==="pending"?{actualAdjustment:{...r.actualAdjustment,status:"cancelled",reviewedBy:email,reviewedAt:now}}:{}),...stamp});
 tx.update(ar,{refundReceivedConfirmed:true,refundReceivedBy:email,refundReceivedAt:now,settlementAmount:remaining,...stamp});
 }
 });
 window.dispatchEvent(new Event("budget-advance-refresh"));
 window.dispatchEvent(new Event("budget-settlement-refresh"));
 alert(action==="report"?"已送出退款金額，待管理員確認。":"已確認收到退款，使用紀錄金額已同步更正。請重新整理使用紀錄查看。");
 }finally{busy=false;button.disabled=false;}
}
