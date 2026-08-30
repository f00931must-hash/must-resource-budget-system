// Budget reminder purchasing-rule adapter v1.6.6
// Reuses the existing second reminder card but maps it to the new purchasing-only auto rule.
// Keeps legacy unconfirmed* fields untouched for backward compatibility.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
const $=id=>document.getElementById(id);
let app=null,auth=null,db=null,installed=false;

function currentPlanId(){return $("planSelect")?.value||"";}
function validTime(v){return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v||""));}

function renameRule(){
  const card=$("ruleUnconfirmed")?.closest(".reminder-rule-card");
  const strong=card?.querySelector(".check-row strong");
  if(strong) strong.textContent="請購中";
}

async function loadPurchasingSettings(){
  const planId=currentPlanId();
  if(!planId||!db)return;
  try{
    const snap=await getDoc(doc(db,"reminderSettings",planId));
    if(!snap.exists())return;
    const s=snap.data();
    if(typeof s.purchasingEnabled==="boolean"&&$("ruleUnconfirmed")) $("ruleUnconfirmed").checked=s.purchasingEnabled;
    if(Number.isFinite(Number(s.purchasingAfterDays))&&$("ruleUnconfirmedDays")) $("ruleUnconfirmedDays").value=Number(s.purchasingAfterDays);
    if(validTime(s.purchasingTime)&&$("ruleUnconfirmedTime")) $("ruleUnconfirmedTime").value=s.purchasingTime;
  }catch(e){console.warn("load purchasing reminder settings failed",e);}
}

async function savePurchasingSettings(){
  const planId=currentPlanId();
  const user=auth?.currentUser;
  if(!planId||!user||!db)return;
  const time=$("ruleUnconfirmedTime")?.value||"09:00";
  try{
    await setDoc(doc(db,"reminderSettings",planId),{
      purchasingEnabled:$("ruleUnconfirmed")?.checked!==false,
      purchasingAfterDays:Number($("ruleUnconfirmedDays")?.value||0),
      purchasingTime:validTime(time)?time:"09:00",
      updatedAt:serverTimestamp(),
      updatedBy:String(user.email||"").toLowerCase()
    },{merge:true});
  }catch(e){console.warn("save purchasing reminder settings failed",e);}
}

function patchVisibleLabels(){
  renameRule();
  const summary=$("reminderPreviewSummary");
  if(summary){
    [...summary.querySelectorAll(".summary-card span")].forEach(el=>{
      if(el.textContent.trim()==="未確認 Key 金額") el.textContent="請購中";
    });
  }
}

function install(){
  if(installed)return true;
  const rule=$("ruleUnconfirmed");
  const save=$("saveReminderSettingsBtn");
  if(!rule||!save)return false;
  installed=true;
  renameRule();
  save.addEventListener("click",()=>setTimeout(savePurchasingSettings,0));
  $("reminderTab")?.addEventListener("click",()=>setTimeout(()=>{renameRule();loadPurchasingSettings();patchVisibleLabels();},120));
  $("refreshReminderPreviewBtn")?.addEventListener("click",()=>setTimeout(patchVisibleLabels,180));
  $("planSelect")?.addEventListener("change",()=>setTimeout(loadPurchasingSettings,120));
  loadPurchasingSettings();
  setTimeout(patchVisibleLabels,100);
  return true;
}

for(let i=0;i<80&&!install();i++) await new Promise(r=>setTimeout(r,50));

app=getApps().find(a=>a.options?.projectId===PROJECT_ID)||null;
if(app){auth=getAuth(app);db=getFirestore(app);setTimeout(loadPurchasingSettings,0);}
