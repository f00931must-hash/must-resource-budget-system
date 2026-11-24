import {isInstallment,installmentRows,emptyInstallment,mutateInstallment} from './budget-installments-core.mjs?v=20261124-1';
export function installInstallments(c){
 const {$,state,db,doc,collection,addDoc,runTransaction,serverTimestamp,isManager,toast,refreshOneExpense,uploadVoucherFile,selectedRecordOwner,esc,escAttr,money}=c;
 const form=$('recordForm'),wrap=document.createElement('label');wrap.className='check-row';
 wrap.innerHTML='<input type="checkbox" id="recordInstallment"><span><strong>啟用分次核銷</strong><small>一次申請、多筆核銷。新增第一筆明細後即不能取消；主紀錄金額只占用一次。</small></span>';
 form.querySelector('.voucher-upload').before(wrap);
 function sync(record){
  const box=$('recordInstallment');box.checked=isInstallment(record);box.disabled=record?.installment?.everUsed===true||!!record&&!isInstallment(record);
  box.dataset.recordId=record?.id||'';
  toggle();
 }
 function toggle(){
  const active=$('recordInstallment').checked;
  form.querySelector('.voucher-upload').hidden=active;form.querySelector('.voucher-upload').classList.toggle('hidden',active);
  if($('recordNoVoucherRequestWrap'))$('recordNoVoucherRequestWrap').hidden=active;
  if(active&&$('recordNoVoucherRequest'))$('recordNoVoucherRequest').checked=false;
 }
 $('recordInstallment').onchange=toggle;
 async function save(existing){
  if(!$('recordInstallment').checked&&!isInstallment(existing))return false;
  const btn=$('recordSaveBtn');if(btn.disabled)return true;btn.disabled=true;
  const planId=state.activePlanId,email=state.user.email.toLowerCase();
  try{
   const categoryId=$('recordCategory').value,semester=$('recordSemester').value.trim(),amount=Number($('recordAmount').value),purpose=$('recordPurpose').value.trim();
   if(!existing&&state.plans.find(p=>p.id===planId)?.active===false)throw Error('此計畫已停用');
   if(!purpose||!categoryId||!/^\d{3}-[12]$/.test(semester)||!Number.isSafeInteger(amount)||amount<=0)throw Error('請填用途、科目、學期與正整數總額');
   if(existing&&amount!==Number(existing.amount))throw Error('分次核銷主紀錄總額固定；尚無明細時可取消模式後修改');
   let id=existing?.id;
   const stamp={updatedBy:email,updatedAt:serverTimestamp()};
   if(existing){
    await runTransaction(db,async tx=>{
     const ref=doc(db,'expenseRecords',id),r=(await tx.get(ref)).data();
     if(!r||r.deleted||r.installment?.closed||(!isManager()&&r.ownerEmail!==email))throw Error('紀錄已變更或沒有權限');
     if(r.categoryId!==categoryId||r.semester!==semester)throw Error('分次核銷主紀錄科目與學期固定');
     const s=$('recordInstallment').checked?r.installment:mutateInstallment(r,'disable','',null,isManager());
     tx.update(ref,{installment:s,purpose,note:$('recordNote').value.trim(),purchaseOrderNo:$('recordPurchaseOrderNo')?.value.trim()||'',...stamp});
    });
   }else{
    const owner=selectedRecordOwner(null);
    id=(await addDoc(collection(db,'expenseRecords'),{planId,categoryId,semester,purpose,amount,note:$('recordNote').value.trim(),purchaseOrderNo:$('recordPurchaseOrderNo')?.value.trim()||'',ownerEmail:owner.email,ownerName:owner.name,estimated:true,estimateStage:'purchasing',reviewStatus:'estimated',reviewed:false,locked:false,archived:false,amountConfirmed:false,createdBy:email,createdAt:serverTimestamp(),...stamp,installment:emptyInstallment()})).id;
   }
   $('recordDialog').close();await refreshOneExpense(id,planId);toast('分次核銷主紀錄已儲存');
  }catch(e){toast('分次核銷儲存失敗：'+e.message,8000);}
  finally{btn.disabled=false;}return true;
 }
 const dialog=document.createElement('dialog');dialog.id='installmentDialog';dialog.style.cssText='width:min(960px,95vw);max-height:90vh;overflow:auto;border:0;border-radius:16px;padding:24px';document.body.append(dialog);
 let currentId='',editId='',busy=false;
 const getCurrent=()=>state.records.find(r=>r.id===currentId);
 function render(){
  const r=getCurrent();if(!r)return;const s=r.installment,can=isManager()||r.ownerEmail===state.user.email.toLowerCase(),editable=can&&!s.closed;
  dialog.innerHTML=`<h2>${esc(r.purpose)}｜分次核銷</h2><p>原申請 ${money.format(r.amount)}｜已登記 ${money.format(s.total)}｜已核對 ${money.format(s.reviewedTotal)}｜${s.closed?'結案釋回':'尚未核銷'} ${money.format(r.amount-s.total)}</p><p>${s.closed?'已結案；占用金額為已核銷合計。':'明細不重複扣計畫經費；請逐筆附單據、交管理員核對。'}</p><div style="overflow:auto"><table style="width:100%"><thead><tr><th>日期</th><th>項目</th><th>金額</th><th>核銷單號</th><th>單據</th><th>狀態／操作</th></tr></thead><tbody>${installmentRows(r).map(e=>`<tr><td>${esc(e.date)}</td><td>${esc(e.purpose)}</td><td>${money.format(e.amount)}</td><td>${esc(e.reimbursementNo)}</td><td><a target="_blank" rel="noopener" href="${escAttr(e.voucher.url)}">${esc(e.voucher.name)}</a></td><td>${e.reviewed?'已核對':'待核對'} ${editable?`${!e.reviewed?`<button type="button" data-edit="${e.id}">編輯</button><button type="button" data-action="delete" data-id="${e.id}">刪除</button>`:''}${isManager()?`<button type="button" data-action="${e.reviewed?'unlock':'review'}" data-id="${e.id}">${e.reviewed?'解鎖':'核對完成'}</button>`:''}`:''}</td></tr>`).join('')}</tbody></table></div>${editable?`<form id="installmentEntryForm"><h3>新增／編輯核銷項目</h3><label>日期<input id="instDate" type="date" required></label><label>用途<input id="instPurpose" required maxlength="300"></label><label>金額<input id="instAmount" type="number" min="1" step="1" required></label><label>核銷單號（選填）<input id="instNumber" maxlength="100"></label><label>核銷單據（每筆一份；修改時可保留原單據）<input id="instFile" type="file"></label><label><input id="instConfirmed" type="checkbox" required>確認單據金額與本筆相同</label><button class="primary-btn" type="submit">儲存明細</button><button type="button" id="instCancelEdit">取消編輯</button></form>${isManager()?'<button type="button" id="instCloseCase" class="primary-btn">結案並釋回餘額</button>':''}`:''}<p>結案釋回計畫額度不代表已收到現金退款；實際領款案件仍須另辦退款確認。</p><button type="button" id="instDismiss">關閉</button>`;
  editId='';dialog.querySelector('#instDismiss').onclick=()=>dialog.close();
  if(!editable)return;
  $('instDate').value=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Taipei'});
  $('instCancelEdit').onclick=()=>render();
  dialog.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{editId=b.dataset.edit;const e=s.entries[editId];$('instDate').value=e.date;$('instPurpose').value=e.purpose;$('instAmount').value=e.amount;$('instNumber').value=e.reimbursementNo;$('instConfirmed').checked=e.confirmed;});
  dialog.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>act(b.dataset.action,b.dataset.id));
  $('instCloseCase')?.addEventListener('click',()=>act('close',''));
  $('installmentEntryForm').onsubmit=async e=>{
   e.preventDefault();if(busy)return;
   const file=$('instFile').files[0],old=s.entries[editId];
   if(!file&&!old?.voucher)return toast('請附本筆核銷單據');
   if(file&&file.size>20*1024*1024)return toast('單據不可超過 20MB');
   const item={date:$('instDate').value,purpose:$('instPurpose').value.trim(),amount:Number($('instAmount').value),reimbursementNo:$('instNumber').value.trim(),confirmed:$('instConfirmed').checked,voucher:old?.voucher};
   await act('save',editId||crypto.randomUUID(),item,file);
  };
 }
 async function act(action,id,item,file){
  if(busy)return;
  const r=getCurrent();if(!r)return;
  if(['close','delete'].includes(action)&&!confirm(action==='close'?`結案後不可再新增或修改，將釋回 ${money.format(r.amount-r.installment.total)}。確認？`:'刪除此核銷項目？原申請總額不變。'))return;
  busy=true;dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
  const planId=state.activePlanId,email=state.user.email.toLowerCase();
  try{
   if(action==='save')mutateInstallment(r,action,id,{...item,voucher:file?{url:'https://pending-upload.invalid'}:item.voucher},isManager());
   if(file){const saved=$('recordId').value;$('recordId').value=r.id;try{const u=await uploadVoucherFile(file);item.voucher={url:u.url,name:u.name,path:u.path||'',type:u.type||'',size:u.size||0};}finally{$('recordId').value=saved;}}
   await runTransaction(db,async tx=>{
    const ref=doc(db,'expenseRecords',r.id),fresh=(await tx.get(ref)).data();
    if(!fresh||fresh.deleted||fresh.planId!==planId||(!isManager()&&fresh.ownerEmail!==email))throw Error('紀錄或權限已變更');
    const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
    if(canonical(fresh.installment)!==canonical(r.installment))throw Error('其他人已修改，請關閉後重新開啟');
    const next=mutateInstallment(fresh,action,id,item,isManager());
    tx.update(ref,{installment:next,updatedAt:serverTimestamp(),updatedBy:email});
   });
   await refreshOneExpense(r.id,planId);render();toast('已儲存');
  }catch(e){toast('分次核銷失敗：'+e.message,8000);}
  finally{busy=false;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
 }
 function markup(r){const s=r.installment;return `<div style="grid-column:1/-1"><strong>${s.closed?'分次核銷・已結案':'分次核銷中'}</strong>｜已登記 ${money.format(s.total)}｜尚未核銷 ${money.format(r.amount-s.total)} <button type="button" class="link-btn" data-installment="${r.id}">查看／登記明細</button></div>`;}
 document.addEventListener('click',async e=>{const b=e.target.closest('[data-installment]');if(!b)return;currentId=b.dataset.installment;try{await refreshOneExpense(currentId,state.activePlanId);render();dialog.showModal();}catch(err){toast('讀取明細失敗：'+err.message);}});
 return {sync,save,markup};
}
