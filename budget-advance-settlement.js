import {getApps} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {getAuth} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {getFirestore,doc,getDoc,runTransaction,serverTimestamp} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
const money=new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0});
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
export function refundDue(a,r){return r&&r.estimated!==true?Math.max(0,Number(a.estimatedAmount||0)-Number(r.amount||0)):0;}
export function confirmedRefund(a,r){return a.refundReceivedConfirmed===true&&Number(a.refundAmount)===refundDue(a,r)?Number(a.refundAmount):0;}
export function settlementMarkup(a,r,manager=false){
 if(!r)return "";
 const request=r.actualAdjustment,due=refundDue(a,r);
 let html="";
 if(request?.status==="pending"){
 html+='<div style="margin-top:8px"><strong>待確認實際金額：'+money.format(request.amount)+'</strong><small style="display:block">'+esc(request.reason)+'</small>';
 if(manager)html+='<button class="link-btn" data-settlement-action="approve" data-allocation="'+esc(a.id)+'">確認實際金額</button><button class="link-btn" data-settlement-action="reject" data-allocation="'+esc(a.id)+'">退回修改</button>';
 html+='</div>';
 }else if(request?.status==="rejected")html+='<small style="display:block;color:#b42318">調整已退回：'+esc(request.reviewReason||"請修正後重新送出")+'</small>';
 if(due>0){
 html+='<div style="margin-top:8px"><strong>應退 '+money.format(due)+'</strong><small style="display:block">'+(confirmedRefund(a,r)>0?'✓ 管理員已收到退款':a.refundReported===true?'已申報退款・待管理員確認':'尚未申報退款')+'</small>';
 if(a.allocationReceivedConfirmed===true&&!confirmedRefund(a,r)){
 if(!manager&&a.refundReported!==true)html+='<button class="primary-btn" data-settlement-action="report" data-allocation="'+esc(a.id)+'">申報退款</button>';
 if(manager&&a.refundReported===true)html+='<button class="primary-btn" data-settlement-action="receive" data-allocation="'+esc(a.id)+'">確認收到退款</button>';
 }
 html+='</div>';
 }
 if(r.estimated===true&&request?.status!=="pending"&&!manager)html+='<small style="display:block">請到使用紀錄填寫「實際金額申請」並附單據。</small>';
 return html;
}
let busy=false;
export async function settlementAction(button){
 if(busy)return;
 const app=getApps().find(a=>a.options?.projectId==="must-resource-budget-system"),auth=getAuth(app),db=getFirestore(app),user=auth.currentUser,email=user?.email?.toLowerCase();
 if(!email)return;
 const action=button.dataset.settlementAction,id=button.dataset.allocation;
 const me=await getDoc(doc(db,"users",email));if(!me.exists()||me.data().enabled!==true)throw Error("帳號未啟用");
 const manager=me.data().role==="manager";
 if(["approve","reject","receive"].includes(action)&&!manager)throw Error("僅管理員可以確認");
 let reason="";
 if(action==="reject"){reason=prompt("請填退回原因：")?.trim()||"";if(!reason)return;}
 if(!confirm(action==="receive"?"確認你已實際收到這筆退款？確認後才計入可用金額。":action==="report"?"確認你已將應退款項交回管理員？":action==="approve"?"確認已核對單據與實際金額？使用紀錄將由系統更正。":"確認退回讓老師修改？"))return;
 busy=true;button.disabled=true;
 try{
 const ar=doc(db,"advanceAllocations",id);
 await runTransaction(db,async tx=>{
 const as=await tx.get(ar);if(!as.exists())throw Error("找不到分配紀錄");
 const a=as.data();if(a.deleted===true)throw Error("分配已移除");
 const rr=doc(db,"expenseRecords",a.expenseRecordId),rs=await tx.get(rr);if(!rs.exists())throw Error("找不到使用紀錄");
 const r=rs.data();if(r.deleted===true||r.advanceAllocationId!==id)throw Error("連結已變更，請重新整理");
 const now=serverTimestamp(),stamp={updatedAt:now,updatedBy:email},req=r.actualAdjustment;
 if(action==="approve"||action==="reject"){
 if(req?.status!=="pending")throw Error("此申請已處理");
 if(action==="reject"){tx.update(rr,{actualAdjustment:{...req,status:"rejected",reviewReason:reason,reviewedBy:email,reviewedAt:now},actualAdjustmentHistory:[...(r.actualAdjustmentHistory||[]),{...req,status:"rejected",reviewReason:reason,reviewedBy:email,reviewedAt:new Date()}],...stamp});return;}
 const actual=Number(req.amount),allocated=Number(a.estimatedAmount||0);
 if(!Number.isFinite(actual)||actual<0||actual>allocated)throw Error("實際金額須介於 0 與原分配金額；超支請先另辦追加");
 if(!(r.voucherUrl||r.folderUrl)||r.amountConfirmed!==true)throw Error("請先附上單據並確認實際金額");
 if(a.refundReported===true||a.refundReceivedConfirmed===true)throw Error("已進入退款流程，不能再次調整");
 tx.update(rr,{amount:actual,estimated:false,estimateStage:"",reviewStatus:"pending",reviewed:false,locked:false,archived:true,amountConfirmed:true,amountManuallyConfirmed:true,actualAdjustment:{...req,status:"approved",reviewedBy:email,reviewedAt:now},actualAdjustmentHistory:[...(r.actualAdjustmentHistory||[]),{...req,status:"approved",previousAmount:r.amount,reviewedBy:email,reviewedAt:new Date()}],...stamp});
 tx.update(ar,{settlementAmount:actual,refundDueAmount:allocated-actual,settlementConfirmedBy:email,settlementConfirmedAt:now,...stamp});
 }else{
 const due=refundDue(a,r);if(due<=0||a.allocationReceivedConfirmed!==true)throw Error("尚無可辦理的退款");
 if(action==="report"){
 if(String(a.ownerEmail||"").toLowerCase()!==email||a.refundReported===true||a.refundReceivedConfirmed===true)throw Error("不能申報此筆退款");
 tx.update(ar,{refundReported:true,refundAmount:due,refundReportedBy:email,refundReportedAt:now,...stamp});
 }else if(action==="receive"){
 if(a.refundReported!==true||a.refundReceivedConfirmed===true||Number(a.refundAmount)!==due)throw Error("退款狀態或金額已變更，請重新整理");
 tx.update(ar,{refundReceivedConfirmed:true,refundReceivedBy:email,refundReceivedAt:now,...stamp});
 }
 }
 });
 window.dispatchEvent(new Event("budget-advance-refresh"));
 window.dispatchEvent(new Event("budget-settlement-refresh"));
 alert("已儲存。使用紀錄請重新整理查看最新金額。");
 }finally{busy=false;button.disabled=false;}
}
