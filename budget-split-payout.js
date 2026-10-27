import {getApps} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js';
import {getAuth} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import {getFirestore,collection,doc,getDoc,getDocs,query,where,runTransaction,serverTimestamp} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
const money=new Intl.NumberFormat('zh-TW',{style:'currency',currency:'TWD',maximumFractionDigits:0});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=v=>Number(v||0);
function context(){const app=getApps().find(a=>a.options.projectId==='must-resource-budget-system');return {db:getFirestore(app),user:getAuth(app).currentUser};}
async function actor(){const {db,user}=context(),email=user?.email?.toLowerCase();if(!email)throw Error('請先登入');const s=await getDoc(doc(db,'users',email));if(!s.exists()||s.data().enabled!==true)throw Error('帳號未啟用');return {db,email,role:s.data().role};}
function refresh(){window.dispatchEvent(new Event('budget-advance-refresh'));window.dispatchEvent(new Event('budget-settlement-refresh'));}
export async function loadSplitPayouts(db,planId,email,ownOnly){
 try{const q=query(collection(db,'advancePayouts'),where(ownOnly?'handlerEmail':'planId','==',ownOnly?email:planId));const s=await getDocs(q);return s.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.planId===planId&&x.deleted!==true);}
 catch(e){if(e.code==='permission-denied')return [];throw e;}
}
export function splitPending(a,payouts,teacher='*'){
 if(!a.payoutSplit)return a.allocationReceivedConfirmed!==true&&(teacher==='*'||a.ownerEmail===teacher)?amount(a.estimatedAmount):0;
 if(teacher==='*')return Math.max(0,amount(a.estimatedAmount)-amount(a.splitAssigned)+amount(a.splitUnreceived));
 return payouts.filter(p=>p.allocationId===a.id&&p.ownerEmail===teacher&&!p.receivedConfirmed&&!p.deleted).reduce((s,p)=>s+amount(p.amount),0);
}
function refundMarkup(p,reviewer=false){
 const total=amount(p.refundTotal),pending=amount(p.refundPending),left=amount(p.amount)-total;
 const history=Object.values(p.refundHistory||{}).map(h=>`<small style="display:block">${esc(h.at?.toDate?.()?.toLocaleString('zh-TW')||'')}　退款 ${money.format(h.amount)}</small>`).join('');
 let html=total?`<small style="display:block">累積退款 ${money.format(total)}</small>${history?`<details><summary>退款紀錄</summary>${history}</details>`:''}`:'';
 if(pending)return html+`<small style="display:block">本次退款 ${money.format(pending)}，待確認</small>${reviewer?`<button class="ghost-btn" data-split-action="refund-receive" data-payout="${esc(p.id)}">確認收到退款</button>`:''}`;
 if(!reviewer&&p.receivedConfirmed&&left>0)html+=`<div><input type="number" min="1" max="${left}" step="1" placeholder="本次退款金額" aria-label="本次退款金額" style="max-width:140px" data-split-refund><button class="ghost-btn" data-split-action="refund-report" data-payout="${esc(p.id)}">申報退款</button></div>`;
 return html;
}
export function splitMarkup(a,payouts){
 if(!a.payoutSplit&&!/雜支|耗材/.test(String(a.categoryName||a.purpose||"")))return "";
 const rows=payouts.filter(p=>p.allocationId===a.id&&!p.deleted);
 const detail=rows.map(p=>`<div style="padding:8px 0;border-top:1px solid #ddd"><strong>${esc(p.ownerName||p.ownerEmail)}</strong> ${money.format(p.amount)}　${p.receivedConfirmed?'✓ 已確認領款':'尚未確認領款'}${!p.receivedConfirmed?` <button class="link-btn danger" data-split-action="remove" data-payout="${esc(p.id)}">刪除</button>`:''}${refundMarkup(p,true)}</div>`).join('');
 return `<div style="grid-column:1/-1;padding-top:8px">${a.payoutSplit?`<strong>分筆付款｜尚未分配 ${money.format(amount(a.estimatedAmount)-amount(a.splitAssigned))}</strong>${detail}`:''}${!a.allocationReceivedConfirmed&&!a.refundReported&&amount(a.estimatedAmount)>amount(a.splitAssigned)?`<button class="ghost-btn" data-split-action="add" data-allocation="${esc(a.id)}">分配款項給老師</button>`:''}</div>`;
}
async function addDialog(id){
 const {db,email,role}=await actor();if(!['manager','advance'].includes(role))throw Error('僅管理員或預支承辦人可分配');
 const s=await getDoc(doc(db,'advanceAllocations',id));if(!s.exists())throw Error('找不到分配');const a=s.data();
 const b=await getDoc(doc(db,'advanceBatches',a.batchId));if(role!=='manager'&&(!b.exists()||b.data().handlerEmail!==email||a.ownerEmail!==email))throw Error('只能處理自己的批次及活動');
 const users=await getDocs(collection(db,'users'));const choices=users.docs.map(d=>({email:d.id,...d.data()})).filter(u=>u.enabled&&u.role!=='assistant');
 document.getElementById('splitPayoutDialog')?.remove();const dlg=document.createElement('dialog');dlg.id='splitPayoutDialog';
 dlg.innerHTML=`<form class="dialog-form"><div class="dialog-head"><h3>分配款項</h3><button type="button" class="icon-btn" data-split-close>×</button></div><p>${esc(a.purpose)}｜原金額 ${money.format(a.estimatedAmount)}｜尚未分配 ${money.format(amount(a.estimatedAmount)-amount(a.splitAssigned))}</p><label>領款老師<select name="owner" required><option value="">請選擇</option>${choices.map(u=>`<option value="${esc(u.email)}">${esc(u.name||u.displayName||u.email)}</option>`).join('')}</select></label><label>這位老師的金額<input name="amount" type="number" min="1" max="${amount(a.estimatedAmount)-amount(a.splitAssigned)}" step="1" required></label><p class="hint">不會新增使用紀錄。分筆後，各位老師只確認自己的金額。</p><button class="primary-btn">儲存分配</button></form>`;
 document.body.append(dlg);dlg.querySelector('[data-split-close]').onclick=()=>dlg.close();
 dlg.querySelector('form').onsubmit=async e=>{e.preventDefault();const submit=e.target.querySelector('button.primary-btn');submit.disabled=true;try{
  const f=new FormData(e.target),recipient=choices.find(u=>u.email===f.get('owner')),value=Number(f.get('amount'));if(!recipient||!Number.isSafeInteger(value)||value<=0)throw Error('請選老師並輸入正整數');
  const child=doc(collection(db,'advancePayouts'));
  await runTransaction(db,async tx=>{
   const ar=doc(db,'advanceAllocations',id),as=await tx.get(ar);if(!as.exists())throw Error('分配已移除');const p=as.data();
   const bs=await tx.get(doc(db,'advanceBatches',p.batchId)),rs=await tx.get(doc(db,'expenseRecords',p.expenseRecordId));
   if(p.deleted||p.allocationReceivedConfirmed||p.refundReported||!bs.exists()||bs.data().deleted||!rs.exists()||rs.data().deleted||rs.data().advanceAllocationId!==id)throw Error('此筆已領款、已退款或連結已變更，不能拆分');
   if(role!=='manager'&&(bs.data().handlerEmail!==email||p.ownerEmail!==email))throw Error('沒有分配權限');
   const assigned=amount(p.splitAssigned)+value;if(assigned>amount(p.estimatedAmount))throw Error('合計不可超過原分配金額');
   const stamp={updatedAt:serverTimestamp(),updatedBy:email};
   tx.set(child,{allocationId:id,expenseRecordId:p.expenseRecordId,batchId:p.batchId,planId:p.planId,handlerEmail:bs.data().handlerEmail||p.ownerEmail,ownerEmail:recipient.email,ownerName:recipient.name||recipient.displayName||recipient.email,purpose:p.purpose||'',categoryName:p.categoryName||'',amount:value,receivedConfirmed:false,refundTotal:0,refundPending:0,deleted:false,createdBy:email,createdAt:serverTimestamp(),...stamp});
   tx.update(ar,{payoutSplit:true,splitRecipients:{...(p.splitRecipients||{}),[recipient.email]:true},splitAssigned:assigned,splitUnreceived:amount(p.splitUnreceived)+value,splitRefundTotal:amount(p.splitRefundTotal),splitMutationId:child.id,...stamp});
  });dlg.close();refresh();
 }catch(e){alert(e.message);}finally{submit.disabled=false;}};dlg.showModal();
}
export async function splitAction(button){
 if(button.disabled)return;const action=button.dataset.splitAction;if(action==='add')return addDialog(button.dataset.allocation);
 const {db,email,role}=await actor(),id=button.dataset.payout,value=Number(button.parentElement.querySelector('[data-split-refund]')?.value);
 if(action==='refund-report'&&(!Number.isSafeInteger(value)||value<=0))throw Error('請輸入本次退款金額');
 if(!confirm(({receive:'確認已收到這筆分配金額？',remove:'刪除這筆尚未領取的分配？','refund-report':`申報退款 ${money.format(value)}？`,'refund-receive':'確認已實際收到這次退款？'})[action]))return;
 button.disabled=true;try{await runTransaction(db,async tx=>{
  const pr=doc(db,'advancePayouts',id),ps=await tx.get(pr);if(!ps.exists()||ps.data().deleted)throw Error('分配已移除');const p=ps.data(),ar=doc(db,'advanceAllocations',p.allocationId),as=await tx.get(ar);
  if(!as.exists()||as.data().deleted||!as.data().payoutSplit)throw Error('原活動分配已移除');const a=as.data(),br=await tx.get(doc(db,'advanceBatches',p.batchId));
  if(!br.exists()||br.data().deleted)throw Error('批次已移除');const reviewer=role==='manager'||role==='advance'&&br.data().handlerEmail===email;
  const stamp={updatedAt:serverTimestamp(),updatedBy:email},parentStamp={...stamp,splitMutationId:id};
  if(action==='receive'){
   if(p.ownerEmail!==email||p.receivedConfirmed)throw Error('只能確認自己的未領款項');
   tx.update(pr,{receivedConfirmed:true,receivedBy:email,receivedAt:serverTimestamp(),...stamp});tx.update(ar,{splitUnreceived:amount(a.splitUnreceived)-amount(p.amount),...parentStamp});
  }else if(action==='remove'){
   if(!reviewer||p.receivedConfirmed)throw Error('只能刪除尚未領取的款項');
   tx.update(pr,{deleted:true,...stamp});tx.update(ar,{splitAssigned:amount(a.splitAssigned)-amount(p.amount),splitUnreceived:amount(a.splitUnreceived)-amount(p.amount),...parentStamp});
  }else if(action==='refund-report'){
   if(p.ownerEmail!==email||!p.receivedConfirmed||amount(p.refundPending)>0||value>amount(p.amount)-amount(p.refundTotal))throw Error('退款已申報或超過可退金額');
   tx.update(pr,{refundPending:value,refundReportedBy:email,refundReportedAt:serverTimestamp(),...stamp});
  }else if(action==='refund-receive'){
   const delta=amount(p.refundPending);if(!reviewer||delta<=0)throw Error('沒有待確認退款或無權限');
   const rr=doc(db,'expenseRecords',p.expenseRecordId),rs=await tx.get(rr),next=amount(a.splitRefundTotal)+delta;
   if(!rs.exists()||rs.data().deleted||rs.data().advanceAllocationId!==p.allocationId||amount(rs.data().amount)!==amount(a.estimatedAmount)-amount(a.splitRefundTotal))throw Error('使用紀錄金額已變更，請重新確認');
   const history={...(p.refundHistory||{})};history['r'+(Object.keys(history).length+1)]={amount:delta,at:serverTimestamp(),by:email};
   tx.update(pr,{refundTotal:amount(p.refundTotal)+delta,refundPending:0,refundHistory:history,refundReceivedBy:email,refundReceivedAt:serverTimestamp(),...stamp});
   tx.update(ar,{splitRefundTotal:next,...parentStamp});tx.update(rr,{amount:amount(a.estimatedAmount)-next,...stamp});
  }else throw Error('未知操作');
 });refresh();}finally{button.disabled=false;}
}
let ownLoading=false;
export async function renderOwnSplitPayouts(){
 if(ownLoading)return;const list=document.getElementById('myAdvanceList');if(!list)return;ownLoading=true;
 try{const {db,email}=await actor(),plan=document.getElementById('planSelect')?.value;let box=document.getElementById('mySplitPayouts');if(!box){box=document.createElement('div');box.id='mySplitPayouts';box.className='panel';list.after(box);}if(!plan){box.innerHTML='';return;}
  const snap=await getDocs(query(collection(db,'advancePayouts'),where('ownerEmail','==',email)));const all=snap.docs.map(d=>({id:d.id,...d.data()})).filter(p=>p.planId===plan&&!p.deleted);
  const ids=[...new Set(all.map(p=>p.allocationId))],parents=new Map(await Promise.all(ids.map(async id=>{const s=await getDoc(doc(db,'advanceAllocations',id));return [id,s.exists()?s.data():null];})));
  if(document.getElementById('planSelect')?.value!==plan)return;
  const rows=all.filter(p=>parents.get(p.allocationId)&&!parents.get(p.allocationId).deleted);
  box.innerHTML=rows.length?'<h3>分筆領款</h3>'+rows.map(p=>`<div style="padding:14px 0;border-bottom:1px solid #ddd"><strong>${esc(p.purpose)}</strong>｜${esc(p.categoryName)}<p>我的分配金額：<strong>${money.format(p.amount)}</strong>　${p.receivedConfirmed?'✓ 已確認收到':`<button class="primary-btn" data-split-action="receive" data-payout="${esc(p.id)}">確認收到分配金額</button>`}</p>${refundMarkup(p)}</div>`).join(''):'';
  box.querySelectorAll('[data-split-action]').forEach(b=>b.onclick=()=>splitAction(b).catch(e=>alert(e.message)));
 }catch(e){if(e.code!=='permission-denied')console.warn('分筆領款讀取失敗',e);}finally{ownLoading=false;}
}
