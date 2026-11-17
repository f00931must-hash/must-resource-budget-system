const {createHash}=require("node:crypto");
const {isDeepStrictEqual}=require("node:util");
const days30=30*86400000;
const labels={
  expenseRecords:"使用紀錄",advanceBatches:"預支批次",advanceAllocations:"預支分配",
  advancePayouts:"分筆領款",budgetPlans:"計畫",budgetCategories:"經費科目",
  users:"使用者權限",reminderSettings:"提醒設定"
};
const ignored=new Set(["updatedBy","updatedAt"]);
function makeEntry(collection,before,after){
  const old=before||{}, data=after||before||{};
  const changes=Object.keys({...old,...(after||{})}).filter(k=>!ignored.has(k)&&!isDeepStrictEqual(old[k],(after||{})[k]));
  if(before&&after&&!changes.length)return null;
  const ordered=[
    [old.deleted!==true&&data.deleted===true,"移到回收桶"],
    [old.deleted===true&&data.deleted===false,"還原"],
    [old.reviewStatus!=="approved"&&data.reviewStatus==="approved","核對完成"],
    [old.locked===true&&data.locked===false,"解鎖"],
    [old.allocationReceivedConfirmed!==true&&data.allocationReceivedConfirmed===true||old.receivedConfirmed!==true&&data.receivedConfirmed===true,"確認領款"],
    [Number(data.refundConfirmedTotal||0)>Number(old.refundConfirmedTotal||0)||Number(data.refundTotal||0)>Number(old.refundTotal||0),"確認退款"],
    [data.refundReportedAt&&changes.includes("refundReportedAt"),"申請退款"],
    [Number(data.advanceTopUpTotal||0)>Number(old.advanceTopUpTotal||0),"追加預支"],
    [changes.includes("ownerEmail")||changes.includes("accountingOwnerEmail"),"變更負責老師"],
    [changes.includes("voucherUrl")&&!!data.voucherUrl,"上傳／更換附件"],
    [changes.includes("voucherUrl")&&!data.voucherUrl&&!!old.voucherUrl,"移除附件"]
  ];
  const action=!before?"建立":!after?"刪除":ordered.find(([yes])=>yes)?.[1]||"編輯";
  return {action:labels[collection]+"："+action,label:String(data.purpose||data.name||"").slice(0,200),planId:String(data.planId||"")};
}
const eventKey=id=>createHash("sha256").update(id).digest("hex");
module.exports={labels,makeEntry,eventKey,days30};
