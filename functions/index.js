const {initializeApp}=require("firebase-admin/app");
const {getAuth}=require("firebase-admin/auth");
const {getFirestore,Timestamp}=require("firebase-admin/firestore");
const {onDocumentWrittenWithAuthContext}=require("firebase-functions/v2/firestore");
const {labels,makeEntry,eventKey,days30}=require("./operation.js");
initializeApp();
const db=getFirestore();
async function actorEmail(type,id){
  if(!id||type==="system"||type==="service_account"||type==="api_key"||type==="unauthenticated")return "";
  if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id))return id.toLowerCase();
  try{return (await getAuth().getUser(id)).email?.toLowerCase()||"";}
  catch(err){if(["auth/user-not-found","auth/invalid-uid"].includes(err.code))return "";throw err;}
}
for(const collection of Object.keys(labels)){
  exports["log_"+collection]=onDocumentWrittenWithAuthContext({document:collection+"/{recordId}",retry:true},async event=>{
    if(!event.data)return;
    const before=event.data.before.exists?event.data.before.data():null;
    const after=event.data.after.exists?event.data.after.data():null;
    if(!before&&!after)return;
    const entry=makeEntry(collection,before,after);
    if(!entry)return;
    const occurred=after&&event.data.after.updateTime?event.data.after.updateTime.toMillis():Date.parse(event.time);
    if(!Number.isFinite(occurred)||occurred+days30<=Date.now())return;
    const actorId=event.authId||"";
    const email=await actorEmail(event.authType,actorId);
    try{
      await db.collection("budgetOperationLogs").doc(eventKey(event.id)).create({...entry,
        recordId:event.params.recordId,collection,actorId,actorEmail:email,authType:event.authType||"unknown",
        occurredAt:Timestamp.fromMillis(occurred),expiresAt:Timestamp.fromMillis(occurred+days30)
      });
    }catch(err){if(err.code!==6&&err.code!=="ALREADY_EXISTS")throw err;}
  });
}
