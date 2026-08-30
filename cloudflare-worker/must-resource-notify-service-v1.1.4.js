// MUST Resource Room Notification Service v1.1.4
// LINE + Email notification worker.
// Email recipient addresses are stored in the private GitHub repository, not Firestore.
// Automatic reminders only track records marked estimated=true + estimateStage="purchasing".

const JSON_HEADERS={"content-type":"application/json; charset=utf-8"};
const ORIGIN="https://f00931must-hash.github.io";
const LINE_CONFIG_PATH="system-config/line-notify.json";
const EMAIL_CONFIG_PATH="system-config/email-recipients.json";
const DEFAULT_TIME="09:00";
const REMINDER_FOOTER="請確認目前請購進度；如已取得核銷單據，請記得完成核銷登記並確認 Key 金額，謝謝。";

export default {
  async fetch(req,env,ctx){
    const cors=corsHeaders(req.headers.get("Origin")||"",env);
    if(req.method==="OPTIONS") return new Response(null,{status:204,headers:cors});
    try{
      const url=new URL(req.url);
      if((url.pathname==="/"||url.pathname==="/health")&&req.method==="GET"){
        return json({ok:true,service:"MUST Resource Room Notification Service",version:"1.1.4",scheduledReminder:true,automaticRule:"purchasing-only",emailRecipients:"private-github"},200,cors);
      }
      if(url.pathname==="/line/webhook"&&req.method==="POST") return lineWebhook(req,env,ctx,cors);

      const identity=await authenticateBudget(req,env);
      if(url.pathname==="/line/status"&&req.method==="GET") return lineStatus(env,cors);

      await assertBudgetManager(identity,env);
      if(url.pathname==="/line/test"&&req.method==="POST") return lineTest(identity,env,cors);
      if(url.pathname==="/line/send"&&req.method==="POST") return lineSend(req,identity,env,cors);
      if(url.pathname==="/auto/test"&&req.method==="POST") return automaticTest(identity,env,cors);
      if(url.pathname==="/email/config"&&req.method==="GET") return emailConfigGet(env,cors);
      if(url.pathname==="/email/config"&&req.method==="POST") return emailConfigSave(req,identity,env,cors);
      if(url.pathname==="/email/test"&&req.method==="POST") return emailTest(req,identity,env,cors);
      if(url.pathname==="/auto/run"&&req.method==="POST"){
        const result=await runAutomaticReminders(env,{source:"manager-run"});
        return json({ok:true,...result},200,cors);
      }
      return json({ok:false,error:"找不到此 API。"},404,cors);
    }catch(e){
      return json({ok:false,error:e?.message||"伺服器錯誤"},Number(e?.status||500),cors);
    }
  },

  async scheduled(event,env,ctx){
    ctx.waitUntil(runAutomaticReminders(env,{source:"cron",scheduledTime:event.scheduledTime}).catch(e=>console.error("automatic reminder failed",e?.message||e)));
  }
};

function json(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{...JSON_HEADERS,...headers}});}
function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
function normOrigin(v){try{return new URL(String(v||"").trim()).origin}catch{return String(v||"").trim().replace(/\/$/,"")}}
function corsHeaders(origin,env){
  const allowed=String(env.ALLOWED_ORIGINS||"").split(",").map(normOrigin).filter(Boolean);
  if(!allowed.includes(ORIGIN))allowed.push(ORIGIN);
  const o=normOrigin(origin);
  return {
    "access-control-allow-origin":allowed.includes(o)?o:(allowed[0]||ORIGIN),
    "access-control-allow-methods":"GET,POST,OPTIONS",
    "access-control-allow-headers":"authorization,content-type",
    "access-control-max-age":"86400",vary:"Origin"
  };
}
function decodeJwt(token){try{return JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")))}catch{return{}}}

async function authenticateBudget(req,env){
  const h=req.headers.get("Authorization")||"";
  const token=h.startsWith("Bearer ")?h.slice(7).trim():"";
  if(!token)fail("尚未登入或缺少登入憑證。",401);
  const payload=decodeJwt(token);
  if(String(payload.aud||"")!==String(env.BUDGET_FIREBASE_PROJECT_ID||""))fail("此通知服務僅供經費系統使用。",403);
  if(!env.BUDGET_FIREBASE_API_KEY)fail("尚未設定 Budget Firebase API Key。",500);
  const r=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.BUDGET_FIREBASE_API_KEY)}`,{method:"POST",headers:JSON_HEADERS,body:JSON.stringify({idToken:token})});
  if(!r.ok)fail("登入憑證已失效，請重新登入。",401);
  const d=await r.json();const u=d.users?.[0];
  if(!u?.email)fail("無法辨識登入者。",401);
  return{token,email:String(u.email).toLowerCase(),uid:u.localId||""};
}

async function assertBudgetManager(identity,env){
  const projectId=projectIdForServer(env),path=`users/${identity.email}`;
  let r=await fetch(firestoreDocUrl(projectId,path),{headers:{Authorization:`Bearer ${identity.token}`}});
  if(r.ok){const u=firestoreDocumentToObject(await r.json());if(u.enabled===true&&String(u.role||"").toLowerCase()==="manager")return true;}
  const serverToken=await serviceAccountAccessToken(env);
  r=await fetch(firestoreDocUrl(projectId,path),{headers:{Authorization:`Bearer ${serverToken}`}});
  if(r.ok){const u=firestoreDocumentToObject(await r.json());if(u.enabled===true&&String(u.role||"").toLowerCase()==="manager")return true;}
  fail("找不到經費系統管理員資料。",403);
}

async function lineStatus(env,cors){
  const cfg=await loadJsonConfig(LINE_CONFIG_PATH,env),sa=safeServiceAccountStatus(env);
  return json({
    ok:true,
    lineConfigured:!!(env.LINE_CHANNEL_SECRET&&env.LINE_CHANNEL_ACCESS_TOKEN),
    channelSecretConfigured:!!env.LINE_CHANNEL_SECRET,
    accessTokenConfigured:!!env.LINE_CHANNEL_ACCESS_TOKEN,
    groupLinked:!!cfg?.groupId,
    linkedAt:cfg?.linkedAt||null,
    serviceAccountJsonConfigured:!!env.FIREBASE_SERVICE_ACCOUNT_JSON,
    serviceAccountEmailConfigured:sa.email,
    serviceAccountPrivateKeyConfigured:sa.privateKey,
    projectIdConfigured:sa.projectId,
    automaticReminderConfigured:sa.email&&sa.privateKey&&sa.projectId,
    automaticRule:"purchasing-only",
    emailProviderConfigured:!!(env.RESEND_API_KEY&&env.EMAIL_FROM),
    emailFromConfigured:!!env.EMAIL_FROM
  },200,cors);
}

function safeServiceAccountStatus(env){
  let j=null;if(env.FIREBASE_SERVICE_ACCOUNT_JSON){try{j=JSON.parse(String(env.FIREBASE_SERVICE_ACCOUNT_JSON))}catch{}}
  return{email:!!(j?.client_email||env.FIREBASE_SERVICE_ACCOUNT_EMAIL),privateKey:!!(j?.private_key||env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY),projectId:!!(j?.project_id||env.BUDGET_FIREBASE_PROJECT_ID)};
}
function serviceAccountConfig(env){
  let j=null;
  if(env.FIREBASE_SERVICE_ACCOUNT_JSON){try{j=JSON.parse(String(env.FIREBASE_SERVICE_ACCOUNT_JSON));}catch{throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON 格式不是有效 JSON。");}}
  const email=String(j?.client_email||env.FIREBASE_SERVICE_ACCOUNT_EMAIL||"").trim();
  const privateKey=String(j?.private_key||env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY||"").trim().replace(/\\n/g,"\n");
  const projectId=String(j?.project_id||env.BUDGET_FIREBASE_PROJECT_ID||"").trim();
  if(!email)throw new Error("缺少 Firebase Service Account client_email。");
  if(!privateKey)throw new Error("缺少 Firebase Service Account private_key。");
  if(!projectId)throw new Error("缺少 Firebase project_id。");
  return{email,privateKey,projectId};
}
function projectIdForServer(env){
  if(env.BUDGET_FIREBASE_PROJECT_ID)return String(env.BUDGET_FIREBASE_PROJECT_ID);
  if(env.FIREBASE_SERVICE_ACCOUNT_JSON){try{return String(JSON.parse(String(env.FIREBASE_SERVICE_ACCOUNT_JSON)).project_id||"")}catch{}}
  fail("缺少 Firebase Project ID。",500);
}
async function serviceAccountAccessToken(env){
  const c=serviceAccountConfig(env),now=Math.floor(Date.now()/1000);
  const unsigned=`${b64urlJson({alg:"RS256",typ:"JWT"})}.${b64urlJson({iss:c.email,scope:"https://www.googleapis.com/auth/datastore",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600})}`;
  const key=await importPrivateKey(c.privateKey);
  const sig=await crypto.subtle.sign({name:"RSASSA-PKCS1-v1_5"},key,new TextEncoder().encode(unsigned));
  const assertion=`${unsigned}.${b64urlBytes(new Uint8Array(sig))}`;
  const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.access_token)throw new Error(`Firebase Service Account 驗證失敗：${d.error_description||d.error||r.status}`);
  return d.access_token;
}
async function importPrivateKey(pem){const b64=pem.replace(/-----BEGIN PRIVATE KEY-----/g,"").replace(/-----END PRIVATE KEY-----/g,"").replace(/\s+/g,"");return crypto.subtle.importKey("pkcs8",base64ToBytes(b64),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);}
function b64urlJson(v){return b64urlBytes(new TextEncoder().encode(JSON.stringify(v)))}
function b64urlBytes(bytes){return bytesToBase64(bytes).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}

async function lineTest(identity,env,cors){
  const cfg=await loadJsonConfig(LINE_CONFIG_PATH,env);if(!cfg?.groupId)fail("尚未綁定 LINE 群組。",409);
  await pushLine(cfg.groupId,"【資源教室經費提醒－測試】\nLINE 提醒系統已成功連線。",env);
  return json({ok:true,sent:true,sentBy:identity.email},200,cors);
}
async function lineSend(req,identity,env,cors){
  const cfg=await loadJsonConfig(LINE_CONFIG_PATH,env);if(!cfg?.groupId)fail("尚未綁定 LINE 群組。",409);
  const body=await req.json().catch(()=>({}));
  const text=String(body.text||"【資源教室經費提醒】\n目前有經費資料待處理，請進入經費系統確認。").trim();
  await pushLine(cfg.groupId,text.slice(0,4500),env);
  return json({ok:true,sent:true,sentBy:identity.email},200,cors);
}
async function automaticTest(identity,env,cors){
  const line=await loadJsonConfig(LINE_CONFIG_PATH,env);if(!line?.groupId)fail("尚未綁定 LINE 群組。",409);
  const c=serviceAccountConfig(env),token=await serviceAccountAccessToken(env);
  const settingsDocs=await firestoreListCollection(c.projectId,token,"reminderSettings");
  const enabledPlans=settingsDocs.filter(d=>{const s=firestoreDocumentToObject(d);return s.enabled===true&&s.lineEnabled!==false;}).length;
  const now=new Date();
  const text=["【資源教室經費自動提醒－測試成功】","✅ LINE 群組：正常","✅ Firebase Service Account：正常","✅ Firestore 讀取：正常",`✅ 已啟用提醒的計畫：${enabledPlans} 個`,"","正式自動提醒目前只追蹤「請購中」紀錄；單純預估不會通知。",`測試時間：${formatTaipei(now)}`].join("\n");
  await pushLine(line.groupId,text,env);
  return json({ok:true,sent:true,enabledPlans,checkedAt:now.toISOString(),sentBy:identity.email},200,cors);
}
async function pushLine(to,text,env){
  if(!env.LINE_CHANNEL_ACCESS_TOKEN)fail("尚未設定 LINE_CHANNEL_ACCESS_TOKEN。",500);
  const r=await fetch("https://api.line.me/v2/bot/message/push",{method:"POST",headers:{Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({to,messages:[{type:"text",text}]})});
  if(!r.ok){const t=await r.text().catch(()=>"");fail(`LINE 發送失敗（${r.status}）${t?"："+t.slice(0,300):""}`,502);}
}

async function emailConfigGet(env,cors){
  const cfg=await loadJsonConfig(EMAIL_CONFIG_PATH,env);
  return json({ok:true,recipients:cfg?.recipients||{},updatedAt:cfg?.updatedAt||null,emailProviderConfigured:!!(env.RESEND_API_KEY&&env.EMAIL_FROM)},200,cors);
}
async function emailConfigSave(req,identity,env,cors){
  const body=await req.json().catch(()=>({}));
  const incoming=body?.recipients&&typeof body.recipients==="object"?body.recipients:{};
  const recipients={};
  for(const [loginEmail,row] of Object.entries(incoming)){
    const key=String(loginEmail||"").trim().toLowerCase();
    if(!key)continue;
    const schoolEmail=String(row?.schoolEmail||"").trim();
    if(schoolEmail&&!isEmail(schoolEmail))fail(`學校信箱格式錯誤：${schoolEmail}`,400);
    recipients[key]={name:String(row?.name||"").trim(),schoolEmail};
  }
  const payload={version:1,recipients,updatedAt:new Date().toISOString(),updatedBy:identity.email};
  await saveJsonConfig(EMAIL_CONFIG_PATH,payload,"update budget email recipients",env);
  return json({ok:true,count:Object.values(recipients).filter(x=>x.schoolEmail).length},200,cors);
}
async function emailTest(req,identity,env,cors){
  const body=await req.json().catch(()=>({}));
  const to=String(body.to||"").trim();
  if(!isEmail(to))fail("請先輸入有效的學校信箱。",400);
  await sendEmail(to,"資源教室經費提醒－測試信","您好：\n\n這是一封資源教室經費系統的 Email 測試信。\n若您收到此信，代表 Email 通知寄送設定正常。\n\n明新科技大學資源教室",env);
  return json({ok:true,sent:true,to,sentBy:identity.email},200,cors);
}
async function sendEmail(to,subject,text,env){
  if(!env.RESEND_API_KEY||!env.EMAIL_FROM)fail("Email 寄件服務尚未設定。請先設定 RESEND_API_KEY 與 EMAIL_FROM。",500);
  const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,"content-type":"application/json"},body:JSON.stringify({from:String(env.EMAIL_FROM),to:[to],subject,text})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)fail(`Email 發送失敗（${r.status}）${d?.message?"："+d.message:""}`,502);
  return d;
}
function isEmail(v){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||""));}

async function lineWebhook(req,env,ctx,cors){
  if(!env.LINE_CHANNEL_SECRET)fail("尚未設定 LINE_CHANNEL_SECRET。",500);
  const signature=req.headers.get("x-line-signature")||"",raw=await req.text();
  if(!signature||!(await verifyLineSignature(raw,signature,env.LINE_CHANNEL_SECRET)))return json({ok:false,error:"LINE webhook 簽章驗證失敗。"},401,cors);
  let body={};try{body=JSON.parse(raw||"{}")}catch{return json({ok:false,error:"Webhook JSON 格式錯誤。"},400,cors)}
  const groups=[];for(const e of Array.isArray(body.events)?body.events:[]){if(e?.source?.type==="group"&&e.source.groupId)groups.push({groupId:String(e.source.groupId),eventType:String(e.type||"unknown")});}
  if(groups.length){const job=saveLineGroup(groups[groups.length-1],env).catch(e=>console.error("saveLineGroup failed",e?.message||e));if(ctx?.waitUntil)ctx.waitUntil(job);else await job;}
  return json({ok:true},200,cors);
}
async function verifyLineSignature(body,signature,secret){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const mac=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body));return arrayBufferToBase64(mac)===String(signature||"");}

async function runAutomaticReminders(env,meta={}){
  const line=await loadJsonConfig(LINE_CONFIG_PATH,env);
  const emailCfg=await loadJsonConfig(EMAIL_CONFIG_PATH,env);
  const recipients=emailCfg?.recipients||{};
  const c=serviceAccountConfig(env),token=await serviceAccountAccessToken(env),now=new Date();
  const settingsDocs=await firestoreListCollection(c.projectId,token,"reminderSettings");
  let plansChecked=0,linePlansSent=0,lineRemindersSent=0,emailSent=0;

  for(const sd of settingsDocs){
    const planId=docIdFromName(sd.name),s=firestoreDocumentToObject(sd);
    if(!s.enabled)continue;
    plansChecked++;
    const rows=await firestoreRunQuery(c.projectId,token,{from:[{collectionId:"expenseRecords"}],where:{fieldFilter:{field:{fieldPath:"planId"},op:"EQUAL",value:{stringValue:planId}}}});
    const records=rows.filter(x=>x.document).map(x=>({id:docIdFromName(x.document.name),...firestoreDocumentToObject(x.document)})).filter(r=>r.deleted!==true);
    const eligible=[];
    for(const r of records){const reason=classifyPurchasingRecord(r,s,now);if(reason)eligible.push({record:r,reason});}
    if(!eligible.length)continue;

    if(s.lineEnabled!==false&&line?.groupId){
      const due=[];
      for(const x of eligible){const stateId=stateDocId(planId,x.record.id,"purchasing-line");const state=await getReminderState(c.projectId,token,stateId);if(shouldSendAgain(state,s,now))due.push({...x,stateId});}
      if(due.length){
        await pushLine(line.groupId,buildLineAutomaticMessage(s,due).slice(0,4500),env);
        const sentAt=now.toISOString();
        for(const x of due)await writeReminderState(c.projectId,token,x.stateId,{planId,recordId:x.record.id,reason:"purchasing-line",reasonLabel:"請購中待核銷 LINE",lastSentAt:sentAt,lastEligibleAt:x.reason.eligibleAt.toISOString(),updatedAt:sentAt});
        linePlansSent++;lineRemindersSent+=due.length;
      }
    }

    if(s.emailEnabled===true&&env.RESEND_API_KEY&&env.EMAIL_FROM){
      const byTeacher=new Map();
      for(const x of eligible){
        const loginEmail=String(x.record.ownerEmail||"").toLowerCase();
        const schoolEmail=String(recipients?.[loginEmail]?.schoolEmail||"").trim();
        if(!schoolEmail)continue;
        const stateId=stateDocId(planId,x.record.id,"purchasing-email");
        const state=await getReminderState(c.projectId,token,stateId);
        if(!shouldSendAgain(state,s,now))continue;
        const row=byTeacher.get(loginEmail)||{loginEmail,schoolEmail,name:recipients?.[loginEmail]?.name||x.record.ownerName||loginEmail,items:[]};
        row.items.push({...x,stateId});byTeacher.set(loginEmail,row);
      }
      for(const row of byTeacher.values()){
        const body=buildEmailAutomaticMessage(row.name,row.items);
        await sendEmail(row.schoolEmail,"資源教室經費提醒｜請購中待核銷",body,env);
        const sentAt=now.toISOString();
        for(const x of row.items)await writeReminderState(c.projectId,token,x.stateId,{planId,recordId:x.record.id,reason:"purchasing-email",reasonLabel:"請購中待核銷 Email",lastSentAt:sentAt,lastEligibleAt:x.reason.eligibleAt.toISOString(),updatedAt:sentAt});
        emailSent++;
      }
    }
  }
  return{source:meta.source||"unknown",plansChecked,linePlansSent,lineRemindersSent,emailSent,checkedAt:now.toISOString()};
}

function classifyPurchasingRecord(r,s,now){
  if(r?.deleted===true||r?.estimated!==true||String(r?.estimateStage||"")!=="purchasing")return null;
  const base=timestampDate(r.updatedAt||r.createdAt);if(!base)return null;
  const enabled=s.purchasingEnabled!==undefined?s.purchasingEnabled:s.unconfirmedEnabled;
  if(enabled===false)return null;
  const afterDays=numberOr(s.purchasingAfterDays,s.unconfirmedAfterDays??30);
  const time=validTime(s.purchasingTime)?s.purchasingTime:(validTime(s.unconfirmedTime)?s.unconfirmedTime:DEFAULT_TIME);
  const eligibleAt=eligibilityDate(base,afterDays,time);
  return now>=eligibleAt?{eligibleAt}:null;
}
function buildLineAutomaticMessage(s,due){
  const map=new Map();
  for(const x of due){const key=x.record.ownerEmail||x.record.ownerName||"未填老師";const row=map.get(key)||{name:x.record.ownerName||x.record.ownerEmail||"未填老師",count:0};row.count++;map.set(key,row);}
  const lines=[String(s.messagePrefix||"【資源教室經費提醒】").trim(),"⚠️ 以下老師仍有「請購中」資料尚未進入核銷"];
  for(const row of map.values())lines.push(`${row.name}｜請購中 ${row.count} 筆`);
  lines.push("",REMINDER_FOOTER);return lines.join("\n");
}
function buildEmailAutomaticMessage(name,items){
  const lines=[`${name}老師您好：`,``,`您目前仍有 ${items.length} 筆「請購中」經費紀錄尚未進入核銷：`,``,...items.map(x=>`・${x.record.purpose||"未填用途"}${x.record.semester?`（${x.record.semester}）`:""}`),``,REMINDER_FOOTER,``,`明新科技大學資源教室`];
  return lines.join("\n");
}
function shouldSendAgain(state,s,now){if(!state?.lastSentAt)return true;const last=timestampDate(state.lastSentAt);if(!last)return true;return now.getTime()>=last.getTime()+Math.max(1,numberOr(s.repeatEveryDays,30))*86400000;}
function stateDocId(planId,recordId,reason){return `${planId}__${recordId}__${reason}`.replace(/[^A-Za-z0-9_-]/g,"_").slice(0,1400)}
function validTime(v){return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v||""))}
function numberOr(v,f){const n=Number(v);return Number.isFinite(n)?n:f}
function timestampDate(v){if(!v)return null;const d=v instanceof Date?v:new Date(v);return Number.isNaN(d.getTime())?null:d}
function eligibilityDate(base,days,time){const p={};for(const x of new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(base))if(x.type!=="literal")p[x.type]=x.value;const[hh,mm]=(validTime(time)?time:DEFAULT_TIME).split(":").map(Number);return new Date(Date.UTC(+p.year,+p.month-1,+p.day+Number(days||0),hh-8,mm,0,0));}
function formatTaipei(d){return new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(d)}

function firestoreBase(projectId){return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`}
function firestoreDocUrl(projectId,path){return `${firestoreBase(projectId)}/${path.split("/").map(encodeURIComponent).join("/")}`}
async function firestoreListCollection(projectId,token,id){let page="",docs=[];do{const u=new URL(`${firestoreBase(projectId)}/${encodeURIComponent(id)}`);u.searchParams.set("pageSize","300");if(page)u.searchParams.set("pageToken",page);const r=await fetch(u,{headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw new Error(`讀取 ${id} 失敗（${r.status}）`);const d=await r.json();docs.push(...(d.documents||[]));page=d.nextPageToken||"";}while(page);return docs;}
async function firestoreRunQuery(projectId,token,q){const r=await fetch(`${firestoreBase(projectId)}:runQuery`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({structuredQuery:q})});if(!r.ok)throw new Error(`Firestore 查詢失敗（${r.status}）`);return r.json();}
async function getReminderState(projectId,token,id){const r=await fetch(firestoreDocUrl(projectId,`reminderAutoState/${id}`),{headers:{Authorization:`Bearer ${token}`}});if(r.status===404)return null;if(!r.ok)throw new Error(`讀取提醒狀態失敗（${r.status}）`);return firestoreDocumentToObject(await r.json());}
async function writeReminderState(projectId,token,id,data){const r=await fetch(firestoreDocUrl(projectId,`reminderAutoState/${id}`),{method:"PATCH",headers:{Authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({fields:objectToFirestoreFields(data)})});if(!r.ok)throw new Error(`寫入提醒狀態失敗（${r.status}）`);}
function docIdFromName(n){return String(n||"").split("/").pop()||""}
function firestoreDocumentToObject(doc){const o={};for(const[k,v]of Object.entries(doc?.fields||{}))o[k]=firestoreValueToJs(v);return o;}
function firestoreValueToJs(v){if(!v||typeof v!=="object")return null;if("stringValue"in v)return v.stringValue;if("integerValue"in v)return Number(v.integerValue);if("doubleValue"in v)return Number(v.doubleValue);if("booleanValue"in v)return v.booleanValue;if("timestampValue"in v)return v.timestampValue;if("nullValue"in v)return null;if("arrayValue"in v)return(v.arrayValue.values||[]).map(firestoreValueToJs);if("mapValue"in v){const o={};for(const[k,x]of Object.entries(v.mapValue.fields||{}))o[k]=firestoreValueToJs(x);return o;}return null;}
function objectToFirestoreFields(o){const out={};for(const[k,v]of Object.entries(o))out[k]=typeof v==="boolean"?{booleanValue:v}:typeof v==="number"?(Number.isInteger(v)?{integerValue:String(v)}:{doubleValue:v}):{stringValue:String(v)};return out;}

function githubConfig(env){const owner=env.BUDGET_GITHUB_OWNER||env.GITHUB_OWNER,repo=env.BUDGET_GITHUB_REPO,token=env.BUDGET_GITHUB_TOKEN||env.GITHUB_TOKEN;if(!owner||!repo||!token)fail("通知服務尚未設定私密 GitHub Repository 權限。",500);return{owner,repo,token,branch:env.BUDGET_GITHUB_BRANCH||"main"};}
async function gh(cfg,path,init={}){const r=await fetch(`https://api.github.com${path}`,{...init,headers:{Accept:"application/vnd.github+json",Authorization:`Bearer ${cfg.token}`,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"MUST-Resource-Notify-Service",...(init.body?{"content-type":"application/json"}:{}),...(init.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)fail(d.message||`GitHub API 錯誤（${r.status}）`,502);return d;}
async function ghOptional(cfg,path){const r=await fetch(`https://api.github.com${path}`,{headers:{Accept:"application/vnd.github+json",Authorization:`Bearer ${cfg.token}`,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"MUST-Resource-Notify-Service"}});if(r.status===404)return null;const d=await r.json().catch(()=>({}));if(!r.ok)fail(d.message||`GitHub API 錯誤（${r.status}）`,502);return d;}
async function loadJsonConfig(path,env){const cfg=githubConfig(env),d=await ghOptional(cfg,`/repos/${cfg.owner}/${cfg.repo}/contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`);if(!d?.content)return null;try{return JSON.parse(new TextDecoder().decode(base64ToBytes(String(d.content).replace(/\s+/g,""))))}catch{fail(`${path} 格式異常。`,500);}}
async function saveJsonConfig(path,payload,message,env){const cfg=githubConfig(env),existing=await ghOptional(cfg,`/repos/${cfg.owner}/${cfg.repo}/contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`);const body={message,branch:cfg.branch,content:bytesToBase64(new TextEncoder().encode(JSON.stringify(payload,null,2)))};if(existing?.sha)body.sha=existing.sha;await gh(cfg,`/repos/${cfg.owner}/${cfg.repo}/contents/${enc(path)}`,{method:"PUT",body:JSON.stringify(body)});}
async function saveLineGroup(group,env){const previous=await loadJsonConfig(LINE_CONFIG_PATH,env)||{};if(String(previous.groupId||"")===group.groupId)return;await saveJsonConfig(LINE_CONFIG_PATH,{version:1,groupId:group.groupId,linkedAt:new Date().toISOString(),lastEventType:group.eventType},"link LINE notification group",env);}
function enc(p){return String(p).split("/").map(encodeURIComponent).join("/")}
function bytesToBase64(bytes){let s="";for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s)}
function base64ToBytes(b64){const raw=atob(b64),a=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)a[i]=raw.charCodeAt(i);return a}
function arrayBufferToBase64(buf){return bytesToBase64(new Uint8Array(buf))}
