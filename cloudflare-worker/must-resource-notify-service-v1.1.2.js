// MUST Resource Room Notification Service v1.1.2
// - LINE webhook + private group binding
// - Manager manual test/send APIs
// - Automatic reminders via Cloudflare Cron
// - Service Account supports one JSON secret first, old split secrets as fallback
// - /line/status does not execute automatic reminders or require manager lookup

const JSON_HEADERS={"content-type":"application/json; charset=utf-8"};
const ORIGIN="https://f00931must-hash.github.io";
const LINE_CONFIG_PATH="system-config/line-notify.json";
const DEFAULT_TIME="09:00";
const FOOTER="請記得務必將核銷單據掃描並上傳，並且確認金額是否輸入正確，謝謝。";

export default {
  async fetch(req,env,ctx){
    const cors=corsHeaders(req.headers.get("Origin")||"",env);
    if(req.method==="OPTIONS") return new Response(null,{status:204,headers:cors});
    try{
      const url=new URL(req.url);
      if((url.pathname==="/"||url.pathname==="/health")&&req.method==="GET"){
        return json({ok:true,service:"MUST Resource Room Notification Service",version:"1.1.2",scheduledReminder:true},200,cors);
      }
      if(url.pathname==="/line/webhook"&&req.method==="POST") return lineWebhook(req,env,ctx,cors);

      const identity=await authenticateBudget(req,env);

      // Status only exposes booleans and linked state. It never exposes secrets.
      if(url.pathname==="/line/status"&&req.method==="GET") return lineStatus(env,cors);

      await assertBudgetManager(identity,env);
      if(url.pathname==="/line/test"&&req.method==="POST") return lineTest(req,identity,env,cors);
      if(url.pathname==="/line/send"&&req.method==="POST") return lineSend(req,identity,env,cors);
      if(url.pathname==="/auto/run"&&req.method==="POST"){
        const result=await runAutomaticReminders(env,{source:"manager-test"});
        return json({ok:true,...result},200,cors);
      }
      return json({ok:false,error:"找不到此 API。"},404,cors);
    }catch(e){return json({ok:false,error:e?.message||"伺服器錯誤"},Number(e?.status||500),cors);}
  },
  async scheduled(event,env,ctx){
    ctx.waitUntil(runAutomaticReminders(env,{source:"cron",scheduledTime:event.scheduledTime}).catch(e=>console.error("automatic reminder failed",e?.message||e)));
  }
};

function json(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{...JSON_HEADERS,...headers}});}
function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
function normOrigin(v){try{return new URL(String(v||"").trim()).origin}catch{return String(v||"").trim().replace(/\/$/,"")}}
function corsHeaders(origin,env){const allowed=String(env.ALLOWED_ORIGINS||"").split(",").map(normOrigin).filter(Boolean);if(!allowed.includes(ORIGIN))allowed.push(ORIGIN);const o=normOrigin(origin);return{"access-control-allow-origin":allowed.includes(o)?o:(allowed[0]||ORIGIN),"access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"authorization,content-type","access-control-max-age":"86400",vary:"Origin"};}
function decodeJwt(token){try{return JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")))}catch{return{}}}

async function authenticateBudget(req,env){
  const h=req.headers.get("Authorization")||"";
  const token=h.startsWith("Bearer ")?h.slice(7).trim():"";
  if(!token) fail("尚未登入或缺少登入憑證。",401);
  const payload=decodeJwt(token);
  if(String(payload.aud||"")!==String(env.BUDGET_FIREBASE_PROJECT_ID||"")) fail("此通知服務僅供經費系統使用。",403);
  if(!env.BUDGET_FIREBASE_API_KEY) fail("尚未設定 Budget Firebase API Key。",500);
  const r=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.BUDGET_FIREBASE_API_KEY)}`,{method:"POST",headers:JSON_HEADERS,body:JSON.stringify({idToken:token})});
  if(!r.ok) fail("登入憑證已失效，請重新登入。",401);
  const d=await r.json(); const u=d.users?.[0];
  if(!u?.email) fail("無法辨識登入者。",401);
  return{token,email:String(u.email).toLowerCase(),uid:u.localId||""};
}

async function assertBudgetManager(identity,env){
  const projectId=projectIdForServer(env);
  const path=`users/${identity.email}`;

  // First: signed-in user's own token, same security model as the browser app.
  let r=await fetch(firestoreDocUrl(projectId,path),{headers:{Authorization:`Bearer ${identity.token}`}});
  if(r.ok){
    const u=firestoreDocumentToObject(await r.json());
    if(u.enabled===true&&String(u.role||"").toLowerCase()==="manager") return true;
  }

  // Fallback: server identity. This also covers REST/browser-token inconsistencies.
  const serverToken=await serviceAccountAccessToken(env);
  r=await fetch(firestoreDocUrl(projectId,path),{headers:{Authorization:`Bearer ${serverToken}`}});
  if(r.ok){
    const u=firestoreDocumentToObject(await r.json());
    if(u.enabled===true&&String(u.role||"").toLowerCase()==="manager") return true;
  }
  fail("找不到經費系統管理員資料。",403);
}

async function lineStatus(env,cors){
  const cfg=await loadLineConfig(env);
  const sa=safeServiceAccountStatus(env);
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
    automaticReminderConfigured:sa.email&&sa.privateKey&&sa.projectId
  },200,cors);
}

function safeServiceAccountStatus(env){
  let j=null;
  if(env.FIREBASE_SERVICE_ACCOUNT_JSON){try{j=JSON.parse(String(env.FIREBASE_SERVICE_ACCOUNT_JSON))}catch{}}
  return{
    email:!!(j?.client_email||env.FIREBASE_SERVICE_ACCOUNT_EMAIL),
    privateKey:!!(j?.private_key||env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY),
    projectId:!!(j?.project_id||env.BUDGET_FIREBASE_PROJECT_ID)
  };
}

function serviceAccountConfig(env){
  let j=null;
  if(env.FIREBASE_SERVICE_ACCOUNT_JSON){
    try{j=JSON.parse(String(env.FIREBASE_SERVICE_ACCOUNT_JSON));}
    catch{throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON 格式不是有效 JSON。");}
  }
  const email=String(j?.client_email||env.FIREBASE_SERVICE_ACCOUNT_EMAIL||"").trim();
  const privateKey=String(j?.private_key||env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY||"").trim().replace(/\\n/g,"\n");
  const projectId=String(j?.project_id||env.BUDGET_FIREBASE_PROJECT_ID||"").trim();
  if(!email) throw new Error("缺少 Firebase Service Account client_email。");
  if(!privateKey) throw new Error("缺少 Firebase Service Account private_key。");
  if(!projectId) throw new Error("缺少 Firebase project_id。");
  return{email,privateKey,projectId};
}
function projectIdForServer(env){
  if(env.BUDGET_FIREBASE_PROJECT_ID) return String(env.BUDGET_FIREBASE_PROJECT_ID);
  if(env.FIREBASE_SERVICE_ACCOUNT_JSON){try{return String(JSON.parse(String(env.FIREBASE_SERVICE_ACCOUNT_JSON)).project_id||"")}catch{}}
  fail("缺少 Firebase Project ID。",500);
}

async function serviceAccountAccessToken(env){
  const c=serviceAccountConfig(env); const now=Math.floor(Date.now()/1000);
  const unsigned=`${b64urlJson({alg:"RS256",typ:"JWT"})}.${b64urlJson({iss:c.email,scope:"https://www.googleapis.com/auth/datastore",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600})}`;
  const key=await importPrivateKey(c.privateKey);
  const sig=await crypto.subtle.sign({name:"RSASSA-PKCS1-v1_5"},key,new TextEncoder().encode(unsigned));
  const assertion=`${unsigned}.${b64urlBytes(new Uint8Array(sig))}`;
  const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.access_token) throw new Error(`Firebase Service Account 驗證失敗：${d.error_description||d.error||r.status}`);
  return d.access_token;
}
async function importPrivateKey(pem){const b64=pem.replace(/-----BEGIN PRIVATE KEY-----/g,"").replace(/-----END PRIVATE KEY-----/g,"").replace(/\s+/g,"");return crypto.subtle.importKey("pkcs8",base64ToBytes(b64),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);}
function b64urlJson(v){return b64urlBytes(new TextEncoder().encode(JSON.stringify(v)))}
function b64urlBytes(bytes){return bytesToBase64(bytes).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}

async function lineTest(req,identity,env,cors){return sendManagerLine(req,identity,env,cors,"【資源教室經費提醒－測試】\nLINE 提醒系統已成功連線。",false);}
async function lineSend(req,identity,env,cors){return sendManagerLine(req,identity,env,cors,"【資源教室經費提醒】\n目前有經費資料待處理，請進入經費系統確認。",true);}
async function sendManagerLine(req,identity,env,cors,fallback,appendFooter){const cfg=await loadLineConfig(env);if(!cfg?.groupId)fail("尚未綁定 LINE 群組。",409);const body=await req.json().catch(()=>({}));let text=String(body.text||fallback).trim();if(appendFooter&&!text.includes(FOOTER))text+=`\n\n${FOOTER}`;await pushLine(cfg.groupId,text.slice(0,4500),env);return json({ok:true,sent:true,sentBy:identity.email},200,cors);}
async function pushLine(to,text,env){if(!env.LINE_CHANNEL_ACCESS_TOKEN)fail("尚未設定 LINE_CHANNEL_ACCESS_TOKEN。",500);const r=await fetch("https://api.line.me/v2/bot/message/push",{method:"POST",headers:{Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({to,messages:[{type:"text",text}]})});if(!r.ok){const t=await r.text().catch(()=>"");fail(`LINE 發送失敗（${r.status}）${t?"："+t.slice(0,300):""}`,502);}}

async function lineWebhook(req,env,ctx,cors){
  if(!env.LINE_CHANNEL_SECRET)fail("尚未設定 LINE_CHANNEL_SECRET。",500);
  const signature=req.headers.get("x-line-signature")||""; const raw=await req.text();
  if(!signature||!(await verifyLineSignature(raw,signature,env.LINE_CHANNEL_SECRET))) return json({ok:false,error:"LINE webhook 簽章驗證失敗。"},401,cors);
  let body={};try{body=JSON.parse(raw||"{}")}catch{return json({ok:false,error:"Webhook JSON 格式錯誤。"},400,cors)}
  const groups=[];for(const e of Array.isArray(body.events)?body.events:[]){if(e?.source?.type==="group"&&e.source.groupId)groups.push({groupId:String(e.source.groupId),eventType:String(e.type||"unknown")});}
  if(groups.length){const job=saveLineGroup(groups[groups.length-1],env).catch(e=>console.error("saveLineGroup failed",e?.message||e));if(ctx?.waitUntil)ctx.waitUntil(job);else await job;}
  return json({ok:true},200,cors);
}
async function verifyLineSignature(body,signature,secret){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const mac=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body));return arrayBufferToBase64(mac)===String(signature||"");}

async function runAutomaticReminders(env,meta={}){
  const line=await loadLineConfig(env);if(!line?.groupId)throw new Error("尚未綁定 LINE 群組，跳過自動提醒。");
  const c=serviceAccountConfig(env);const token=await serviceAccountAccessToken(env);const now=new Date();
  const settingsDocs=await firestoreListCollection(c.projectId,token,"reminderSettings");let plansChecked=0,plansSent=0,remindersSent=0;
  for(const sd of settingsDocs){
    const planId=docIdFromName(sd.name),s=firestoreDocumentToObject(sd);if(!s.enabled||s.lineEnabled===false)continue;plansChecked++;
    const rows=await firestoreRunQuery(c.projectId,token,{from:[{collectionId:"expenseRecords"}],where:{fieldFilter:{field:{fieldPath:"planId"},op:"EQUAL",value:{stringValue:planId}}}});
    const records=rows.filter(x=>x.document).map(x=>({id:docIdFromName(x.document.name),...firestoreDocumentToObject(x.document)})).filter(r=>r.deleted!==true);
    const due=[];
    for(const r of records){for(const reason of classifyRecord(r,s,now)){const stateId=stateDocId(planId,r.id,reason.key);const state=await getReminderState(c.projectId,token,stateId);if(shouldSendAgain(state,s,now))due.push({record:r,reason,stateId});}}
    if(!due.length)continue;
    await pushLine(line.groupId,buildAutomaticMessage(s,due).slice(0,4500),env);
    const sentAt=now.toISOString();for(const x of due)await writeReminderState(c.projectId,token,x.stateId,{planId,recordId:x.record.id,reason:x.reason.key,reasonLabel:x.reason.label,lastSentAt:sentAt,lastEligibleAt:x.reason.eligibleAt.toISOString(),updatedAt:sentAt});
    plansSent++;remindersSent+=due.length;
  }
  return{source:meta.source||"unknown",plansChecked,plansSent,remindersSent,checkedAt:now.toISOString()};
}

function classifyRecord(r,s,now){if(approved(r))return[];const base=timestampDate(r.updatedAt||r.createdAt);if(!base)return[];const out=[];if(s.estimatedEnabled!==false&&r.estimated===true){const at=eligibilityDate(base,numberOr(s.estimatedAfterDays,14),validTime(s.estimatedTime)?s.estimatedTime:DEFAULT_TIME);if(now>=at)out.push({key:"estimated",label:"預估待追蹤",eligibleAt:at});}if(r.estimated!==true){if(s.missingVoucherEnabled!==false&&!hasVoucher(r)&&!managerWaived(r)){const at=eligibilityDate(base,numberOr(s.missingVoucherAfterDays,0),validTime(s.missingVoucherTime)?s.missingVoucherTime:DEFAULT_TIME);if(now>=at)out.push({key:"missingVoucher",label:"缺少核銷單據",eligibleAt:at});}if(s.unconfirmedEnabled!==false&&!confirmed(r)){const at=eligibilityDate(base,numberOr(s.unconfirmedAfterDays,1),validTime(s.unconfirmedTime)?s.unconfirmedTime:DEFAULT_TIME);if(now>=at)out.push({key:"unconfirmed",label:"未確認 Key 金額",eligibleAt:at});}}return out;}
function approved(r){return r?.reviewStatus==="approved"||r?.reviewed===true||r?.locked===true}function managerWaived(r){return r?.voucherWaiverManagerConfirmed===true||r?.amountConfirmedByManagerWaiver===true}function hasVoucher(r){return!!(r?.voucherUrl||r?.folderUrl)}function confirmed(r){return r?.amountConfirmed===true||r?.amountManuallyConfirmed===true||managerWaived(r)}
function buildAutomaticMessage(s,due){const map=new Map();for(const x of due){const key=x.record.ownerEmail||x.record.ownerName||"未填老師";const row=map.get(key)||{name:x.record.ownerName||x.record.ownerEmail||"未填老師",counts:{missingVoucher:0,unconfirmed:0,estimated:0}};row.counts[x.reason.key]++;map.set(key,row)}const lines=[String(s.messagePrefix||"【資源教室經費提醒】").trim(),"⚠️ 請以下老師協助確認經費資料"];for(const row of map.values()){const p=[];if(row.counts.missingVoucher)p.push(`缺少核銷單據 ${row.counts.missingVoucher} 筆`);if(row.counts.unconfirmed)p.push(`未確認 Key 金額 ${row.counts.unconfirmed} 筆`);if(row.counts.estimated)p.push(`預估待追蹤 ${row.counts.estimated} 筆`);lines.push(`${row.name}｜${p.join("、")}`)}lines.push("",FOOTER);return lines.join("\n")}
function shouldSendAgain(state,s,now){if(!state?.lastSentAt)return true;const last=timestampDate(state.lastSentAt);if(!last)return true;return now.getTime()>=last.getTime()+Math.max(1,numberOr(s.repeatEveryDays,1))*86400000}
function stateDocId(planId,recordId,reason){return`${planId}__${recordId}__${reason}`.replace(/[^A-Za-z0-9_-]/g,"_").slice(0,1400)}
function validTime(v){return/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v||""))}function numberOr(v,f){const n=Number(v);return Number.isFinite(n)?n:f}function timestampDate(v){if(!v)return null;const d=v instanceof Date?v:new Date(v);return Number.isNaN(d.getTime())?null:d}
function eligibilityDate(base,days,time){const p={};for(const x of new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(base))if(x.type!=="literal")p[x.type]=x.value;const [hh,mm]=(validTime(time)?time:DEFAULT_TIME).split(":").map(Number);return new Date(Date.UTC(+p.year,+p.month-1,+p.day+Number(days||0),hh-8,mm,0,0))}

function firestoreBase(projectId){return`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`}
function firestoreDocUrl(projectId,path){return`${firestoreBase(projectId)}/${path.split("/").map(encodeURIComponent).join("/")}`}
async function firestoreListCollection(projectId,token,id){let page="",docs=[];do{const u=new URL(`${firestoreBase(projectId)}/${encodeURIComponent(id)}`);u.searchParams.set("pageSize","300");if(page)u.searchParams.set("pageToken",page);const r=await fetch(u,{headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw new Error(`讀取 ${id} 失敗（${r.status}）`);const d=await r.json();docs.push(...(d.documents||[]));page=d.nextPageToken||""}while(page);return docs}
async function firestoreRunQuery(projectId,token,q){const r=await fetch(`${firestoreBase(projectId)}:runQuery`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({structuredQuery:q})});if(!r.ok)throw new Error(`Firestore 查詢失敗（${r.status}）`);return r.json()}
async function getReminderState(projectId,token,id){const r=await fetch(firestoreDocUrl(projectId,`reminderAutoState/${id}`),{headers:{Authorization:`Bearer ${token}`}});if(r.status===404)return null;if(!r.ok)throw new Error(`讀取提醒狀態失敗（${r.status}）`);return firestoreDocumentToObject(await r.json())}
async function writeReminderState(projectId,token,id,data){const r=await fetch(firestoreDocUrl(projectId,`reminderAutoState/${id}`),{method:"PATCH",headers:{Authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({fields:objectToFirestoreFields(data)})});if(!r.ok)throw new Error(`寫入提醒狀態失敗（${r.status}）`)}
function docIdFromName(n){return String(n||"").split("/").pop()||""}
function firestoreDocumentToObject(doc){const o={};for(const[k,v]of Object.entries(doc?.fields||{}))o[k]=firestoreValueToJs(v);return o}
function firestoreValueToJs(v){if(!v||typeof v!=="object")return null;if("stringValue"in v)return v.stringValue;if("integerValue"in v)return Number(v.integerValue);if("doubleValue"in v)return Number(v.doubleValue);if("booleanValue"in v)return v.booleanValue;if("timestampValue"in v)return v.timestampValue;if("nullValue"in v)return null;if("arrayValue"in v)return(v.arrayValue.values||[]).map(firestoreValueToJs);if("mapValue"in v){const o={};for(const[k,x]of Object.entries(v.mapValue.fields||{}))o[k]=firestoreValueToJs(x);return o}return null}
function objectToFirestoreFields(o){const out={};for(const[k,v]of Object.entries(o))out[k]=typeof v==="boolean"?{booleanValue:v}:typeof v==="number"?(Number.isInteger(v)?{integerValue:String(v)}:{doubleValue:v}):{stringValue:String(v)};return out}

function githubConfig(env){const owner=env.BUDGET_GITHUB_OWNER||env.GITHUB_OWNER,repo=env.BUDGET_GITHUB_REPO,token=env.BUDGET_GITHUB_TOKEN||env.GITHUB_TOKEN;if(!owner||!repo||!token)fail("通知服務尚未設定私密 GitHub Repository 權限。",500);return{owner,repo,token,branch:env.BUDGET_GITHUB_BRANCH||"main"}}
async function gh(cfg,path,init={}){const r=await fetch(`https://api.github.com${path}`,{...init,headers:{Accept:"application/vnd.github+json",Authorization:`Bearer ${cfg.token}`,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"MUST-Resource-Notify-Service",...(init.body?{"content-type":"application/json"}:{}),...(init.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)fail(d.message||`GitHub API 錯誤（${r.status}）`,502);return d}
async function ghOptional(cfg,path){const r=await fetch(`https://api.github.com${path}`,{headers:{Accept:"application/vnd.github+json",Authorization:`Bearer ${cfg.token}`,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"MUST-Resource-Notify-Service"}});if(r.status===404)return null;const d=await r.json().catch(()=>({}));if(!r.ok)fail(d.message||`GitHub API 錯誤（${r.status}）`,502);return d}
async function saveLineGroup(group,env){const cfg=githubConfig(env),existing=await ghOptional(cfg,`/repos/${cfg.owner}/${cfg.repo}/contents/${enc(LINE_CONFIG_PATH)}?ref=${encodeURIComponent(cfg.branch)}`);let previous={};if(existing?.content)try{previous=JSON.parse(new TextDecoder().decode(base64ToBytes(String(existing.content).replace(/\s+/g,""))))}catch{}if(String(previous.groupId||"")===group.groupId)return;const payload={version:1,groupId:group.groupId,linkedAt:new Date().toISOString(),lastEventType:group.eventType};const body={message:"link LINE notification group",branch:cfg.branch,content:bytesToBase64(new TextEncoder().encode(JSON.stringify(payload,null,2)))};if(existing?.sha)body.sha=existing.sha;await gh(cfg,`/repos/${cfg.owner}/${cfg.repo}/contents/${enc(LINE_CONFIG_PATH)}`,{method:"PUT",body:JSON.stringify(body)})}
async function loadLineConfig(env){const cfg=githubConfig(env),d=await ghOptional(cfg,`/repos/${cfg.owner}/${cfg.repo}/contents/${enc(LINE_CONFIG_PATH)}?ref=${encodeURIComponent(cfg.branch)}`);if(!d?.content)return null;return JSON.parse(new TextDecoder().decode(base64ToBytes(String(d.content).replace(/\s+/g,""))))}
function enc(p){return String(p).split("/").map(encodeURIComponent).join("/")}
function bytesToBase64(bytes){let s="";for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s)}
function base64ToBytes(b64){const raw=atob(b64),a=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)a[i]=raw.charCodeAt(i);return a}
function arrayBufferToBase64(buf){return bytesToBase64(new Uint8Array(buf))}
