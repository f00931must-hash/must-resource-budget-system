// Plan restore companion for recycle bin v1.2.8.
// Restoring a deleted plan also restores categories soft-deleted with that plan.
import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, updateDoc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID="must-resource-budget-system";
let busy=false;

document.addEventListener("click",async e=>{
  const btn=e.target.closest?.('[data-trash-restore^="plan:"]');
  if(!btn||busy)return;
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  const id=String(btn.dataset.trashRestore||"").split(":")[1]; if(!id)return;
  const app=getApps().find(a=>a.options?.projectId===PROJECT_ID); if(!app)return;
  const auth=getAuth(app), user=auth.currentUser; if(!user?.email)return;
  const db=getFirestore(app), email=String(user.email).toLowerCase();
  try{
    busy=true;
    const userSnap=await getDoc(doc(db,"users",email));
    if(!userSnap.exists()||userSnap.data().enabled!==true||userSnap.data().role!=="manager")throw new Error("只有經費管理員可以還原計畫。");
    const planRef=doc(db,"budgetPlans",id),planSnap=await getDoc(planRef);
    if(!planSnap.exists()||planSnap.data().deleted!==true)throw new Error("此計畫已不存在或已還原。");
    const plan=planSnap.data();
    if(!confirm(`確定還原「${plan.name||"此計畫"}」嗎？\n\n當時一起移入回收桶的經費項目也會一併還原。`))return;
    await updateDoc(planRef,{deleted:false,deletedAt:null,deletedBy:null,restoredAt:serverTimestamp(),restoredBy:email,updatedAt:serverTimestamp(),updatedBy:email});
    const cats=await getDocs(collection(db,"budgetCategories"));
    let restoredCategories=0;
    for(const c of cats.docs){
      const data=c.data();
      if(data.planId!==id||data.deleted!==true)continue;
      await updateDoc(c.ref,{deleted:false,deletedAt:null,deletedBy:null,restoredAt:serverTimestamp(),restoredBy:email,updatedAt:serverTimestamp(),updatedBy:email});
      restoredCategories++;
    }
    await addDoc(collection(db,"auditLogs"),{type:"recycle-bin",targetId:id,action:"restore-plan-with-categories",restoredCategories,actorEmail:email,createdAt:serverTimestamp()});
    alert(`計畫已還原${restoredCategories?`，並一併還原 ${restoredCategories} 個經費項目`:""}。`);
    location.reload();
  }catch(err){alert("還原失敗："+(err?.message||err));}
  finally{busy=false;}
},true);
