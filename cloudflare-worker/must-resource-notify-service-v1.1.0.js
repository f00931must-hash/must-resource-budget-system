// MUST Resource Room Notification Service v1.1.0
// Production LINE notification worker with automatic scheduled reminders.
//
// Features:
// - Verifies LINE webhook signatures.
// - Stores the linked LINE group ID in the private GitHub repository.
// - Exposes manager-only LINE status / test / manual send endpoints.
// - Uses a Firebase service account for scheduled Firestore access.
// - Cloudflare Cron can run every minute; each reminder rule decides the real send time.
// - Prevents duplicate spam by storing per-record/per-reason lastSentAt state.
// - Formal reminders append the voucher scan/upload + amount check notice.
// - Does not log secrets or LINE group IDs.

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MUST_GITHUB_PAGES_ORIGIN = "https://f00931must-hash.github.io";
const LINE_CONFIG_PATH = "system-config/line-notify.json";
const DEFAULT_TIME = "09:00";
const VOUCHER_FOOTER = "請記得務必將核銷單據掃描並上傳，並且確認金額是否輸入正確，謝謝。";
const REASONS = {
  missingVoucher: "缺少核銷單據",
  unconfirmed: "未確認 Key 金額",
  estimated: "預估待追蹤"
};

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(req.url);

      if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
        return json({
          ok: true,
          service: "MUST Resource Room Notification Service",
          version: "1.1.0",
          scheduledReminder: true
        }, 200, cors);
      }

      if (url.pathname === "/line/webhook" && req.method === "POST") {
        return lineWebhook(req, env, ctx, cors);
      }

      const identity = await authenticateBudget(req, env);
      await assertBudgetManager(identity, env);

      if (url.pathname === "/line/status" && req.method === "GET") {
        return lineStatus(env, cors);
      }

      if (url.pathname === "/line/test" && req.method === "POST") {
        return lineTest(req, identity, env, cors);
      }

      if (url.pathname === "/line/send" && req.method === "POST") {
        return lineSend(req, identity, env, cors);
      }

      if (url.pathname === "/auto/run" && req.method === "POST") {
        const result = await runAutomaticReminders(env, { source: "manager-test" });
        return json({ ok: true, ...result }, 200, cors);
      }

      return json({ ok: false, error: "找不到此 API。" }, 404, cors);
    } catch (e) {
      return json({
        ok: false,
        error: e?.message || "伺服器錯誤"
      }, Number(e?.status || 500), cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runAutomaticReminders(env, { source: "cron", scheduledTime: event.scheduledTime })
        .catch(err => console.error("automatic reminder failed", err?.message || err))
    );
  }
};

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try { return new URL(raw).origin; }
  catch { return raw.replace(/\/$/, ""); }
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  if (!allowed.includes(MUST_GITHUB_PAGES_ORIGIN)) {
    allowed.push(MUST_GITHUB_PAGES_ORIGIN);
  }

  const requestOrigin = normalizeOrigin(origin);
  const selected = allowed.includes(requestOrigin)
    ? requestOrigin
    : (allowed[0] || MUST_GITHUB_PAGES_ORIGIN);

  return {
    "access-control-allow-origin": selected,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

function decodeJwt(token) {
  try {
    return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return {};
  }
}

async function authenticateBudget(req, env) {
  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!token) fail("尚未登入或缺少登入憑證。", 401);

  const payload = decodeJwt(token);
  if (String(payload.aud || "") !== String(env.BUDGET_FIREBASE_PROJECT_ID || "")) {
    fail("此通知服務僅供經費系統使用。", 403);
  }

  if (!env.BUDGET_FIREBASE_API_KEY) {
    fail("尚未設定 Budget Firebase API Key。", 500);
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.BUDGET_FIREBASE_API_KEY)}`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ idToken: token })
    }
  );

  if (!response.ok) fail("登入憑證已失效，請重新登入。", 401);

  const data = await response.json();
  const user = data.users?.[0];
  if (!user?.email) fail("無法辨識登入者。", 401);

  return {
    token,
    uid: user.localId || "",
    email: String(user.email).toLowerCase(),
    displayName: user.displayName || user.email
  };
}

async function assertBudgetManager(identity, env) {
  const accessToken = await serviceAccountAccessToken(env);
  const projectId = requiredEnv(env, "BUDGET_FIREBASE_PROJECT_ID");
  const email = identity.email.toLowerCase();

  // First try the current project convention: users/{lowercase email}.
  const directUrl = firestoreDocUrl(projectId, `users/${email}`);
  const direct = await fetch(directUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (direct.ok) {
    const user = firestoreDocumentToObject(await direct.json());
    if (user.enabled === true && String(user.role || "").toLowerCase() === "manager") return;
  }

  // Fallback for older user documents that were not keyed by email.
  const matches = await firestoreRunQuery(projectId, accessToken, {
    from: [{ collectionId: "users" }],
    where: {
      fieldFilter: {
        field: { fieldPath: "email" },
        op: "EQUAL",
        value: { stringValue: email }
      }
    },
    limit: 5
  });

  const found = matches
    .map(x => x.document ? firestoreDocumentToObject(x.document) : null)
    .find(x => x && x.enabled === true && String(x.role || "").toLowerCase() === "manager");

  if (!found) fail("找不到經費系統管理員資料。", 403);
}

async function lineWebhook(req, env, ctx, cors) {
  if (!env.LINE_CHANNEL_SECRET) fail("尚未設定 LINE_CHANNEL_SECRET。", 500);

  const signature = req.headers.get("x-line-signature") || "";
  const raw = await req.text();

  if (!signature || !(await verifyLineSignature(raw, signature, env.LINE_CHANNEL_SECRET))) {
    return json({ ok: false, error: "LINE webhook 簽章驗證失敗。" }, 401, cors);
  }

  let body;
  try { body = JSON.parse(raw || "{}"); }
  catch { return json({ ok: false, error: "Webhook JSON 格式錯誤。" }, 400, cors); }

  const groups = [];
  for (const event of Array.isArray(body.events) ? body.events : []) {
    const source = event?.source;
    if (source?.type === "group" && source.groupId) {
      groups.push({
        groupId: String(source.groupId),
        eventType: String(event.type || "unknown")
      });
    }
  }

  if (groups.length) {
    const latest = groups[groups.length - 1];
    const job = saveLineGroup(latest, env)
      .catch(err => console.error("saveLineGroup failed", err?.message || err));
    if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  }

  return json({ ok: true }, 200, cors);
}

async function verifyLineSignature(body, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return timingSafeEqual(arrayBufferToBase64(mac), String(signature || ""));
}

function timingSafeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

async function saveLineGroup(group, env) {
  const cfg = githubConfig(env);
  const existing = await ghOptional(
    cfg,
    `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(LINE_CONFIG_PATH)}?ref=${encodeURIComponent(cfg.branch)}`
  );

  let previous = {};
  if (existing?.content) {
    try {
      previous = JSON.parse(
        new TextDecoder().decode(base64ToBytes(String(existing.content).replace(/\s+/g, "")))
      );
    } catch {}
  }

  if (String(previous.groupId || "") === group.groupId) return;

  const payload = {
    version: 1,
    groupId: group.groupId,
    linkedAt: new Date().toISOString(),
    lastEventType: group.eventType
  };

  const body = {
    message: "link LINE notification group",
    branch: cfg.branch,
    content: bytesToBase64(new TextEncoder().encode(JSON.stringify(payload, null, 2)))
  };
  if (existing?.sha) body.sha = existing.sha;

  await gh(
    cfg,
    `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(LINE_CONFIG_PATH)}`,
    { method: "PUT", body: JSON.stringify(body) }
  );
}

async function loadLineConfig(env) {
  const cfg = githubConfig(env);
  const d = await ghOptional(
    cfg,
    `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(LINE_CONFIG_PATH)}?ref=${encodeURIComponent(cfg.branch)}`
  );
  if (!d?.content) return null;

  try {
    return JSON.parse(
      new TextDecoder().decode(base64ToBytes(String(d.content).replace(/\s+/g, "")))
    );
  } catch {
    fail("LINE 群組設定檔格式異常。", 500);
  }
}

async function lineStatus(env, cors) {
  const cfg = await loadLineConfig(env);
  return json({
    ok: true,
    lineConfigured: !!(env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN),
    channelSecretConfigured: !!env.LINE_CHANNEL_SECRET,
    accessTokenConfigured: !!env.LINE_CHANNEL_ACCESS_TOKEN,
    groupLinked: !!cfg?.groupId,
    linkedAt: cfg?.linkedAt || null,
    automaticReminderConfigured: !!(
      env.FIREBASE_SERVICE_ACCOUNT_EMAIL &&
      env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY &&
      env.BUDGET_FIREBASE_PROJECT_ID
    )
  }, 200, cors);
}

async function lineTest(req, identity, env, cors) {
  return sendManagerLine(
    req,
    identity,
    env,
    cors,
    "【資源教室經費提醒－測試】\nLINE 提醒系統已成功連線。",
    false
  );
}

async function lineSend(req, identity, env, cors) {
  return sendManagerLine(
    req,
    identity,
    env,
    cors,
    "【資源教室經費提醒】\n目前有經費資料待處理，請進入經費系統確認。",
    true
  );
}

async function sendManagerLine(req, identity, env, cors, fallbackText, appendFooter) {
  const cfg = await loadLineConfig(env);
  if (!cfg?.groupId) fail("尚未綁定 LINE 群組。", 409);

  const body = await req.json().catch(() => ({}));
  let text = String(body.text || fallbackText).trim();
  if (!text) fail("提醒內容不可空白。", 400);
  if (appendFooter && !text.includes(VOUCHER_FOOTER)) {
    text = `${text}\n\n${VOUCHER_FOOTER}`;
  }
  text = text.slice(0, 4500);

  await pushLineMessage(cfg.groupId, text, env);
  return json({ ok: true, sent: true, sentBy: identity.email }, 200, cors);
}

async function pushLineMessage(to, text, env) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    fail("尚未設定 LINE_CHANNEL_ACCESS_TOKEN。", 500);
  }

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }]
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    fail(
      `LINE 發送失敗（${response.status}）${detail ? "：" + detail.slice(0, 300) : ""}`,
      502
    );
  }
}

async function runAutomaticReminders(env, meta = {}) {
  const line = await loadLineConfig(env);
  if (!line?.groupId) throw new Error("尚未綁定 LINE 群組，跳過自動提醒。" );
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("尚未設定 LINE_CHANNEL_ACCESS_TOKEN。" );

  const projectId = requiredEnv(env, "BUDGET_FIREBASE_PROJECT_ID");
  const accessToken = await serviceAccountAccessToken(env);
  const now = new Date();

  const settingsDocs = await firestoreListCollection(projectId, accessToken, "reminderSettings");
  let plansChecked = 0;
  let plansSent = 0;
  let remindersSent = 0;

  for (const settingsDoc of settingsDocs) {
    const planId = docIdFromName(settingsDoc.name);
    const settings = firestoreDocumentToObject(settingsDoc);
    if (!settings.enabled || settings.lineEnabled === false) continue;

    plansChecked++;
    const recordRows = await firestoreRunQuery(projectId, accessToken, {
      from: [{ collectionId: "expenseRecords" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "planId" },
          op: "EQUAL",
          value: { stringValue: planId }
        }
      }
    });

    const records = recordRows
      .filter(x => x.document)
      .map(x => ({
        id: docIdFromName(x.document.name),
        ...firestoreDocumentToObject(x.document)
      }))
      .filter(r => r.deleted !== true);

    const due = [];

    for (const record of records) {
      const reasons = classifyRecord(record, settings, now);
      for (const reason of reasons) {
        const stateId = stateDocId(planId, record.id, reason.key);
        const state = await getReminderState(projectId, accessToken, stateId);
        if (!shouldSendAgain(state, settings, now)) continue;
        due.push({ record, reason, stateId });
      }
    }

    if (!due.length) continue;

    const text = buildAutomaticMessage(settings, due);
    await pushLineMessage(line.groupId, text.slice(0, 4500), env);

    const sentAt = now.toISOString();
    for (const item of due) {
      await writeReminderState(projectId, accessToken, item.stateId, {
        planId,
        recordId: item.record.id,
        reason: item.reason.key,
        reasonLabel: item.reason.label,
        lastSentAt: sentAt,
        lastEligibleAt: item.reason.eligibleAt.toISOString(),
        updatedAt: sentAt
      });
    }

    plansSent++;
    remindersSent += due.length;
  }

  return {
    source: meta.source || "unknown",
    plansChecked,
    plansSent,
    remindersSent,
    checkedAt: now.toISOString()
  };
}

function classifyRecord(record, settings, now) {
  if (approved(record)) return [];

  const reasons = [];
  const base = timestampDate(record.updatedAt || record.createdAt);
  if (!base) return reasons;

  if (
    settings.estimatedEnabled !== false &&
    record.estimated === true
  ) {
    const eligibleAt = eligibilityDate(
      base,
      numberOr(settings.estimatedAfterDays, 14),
      validTime(settings.estimatedTime) ? settings.estimatedTime : DEFAULT_TIME
    );
    if (now >= eligibleAt) {
      reasons.push({ key: "estimated", label: REASONS.estimated, eligibleAt });
    }
  }

  if (record.estimated !== true) {
    if (
      settings.missingVoucherEnabled !== false &&
      !hasVoucher(record) &&
      !managerWaived(record)
    ) {
      const eligibleAt = eligibilityDate(
        base,
        numberOr(settings.missingVoucherAfterDays, 0),
        validTime(settings.missingVoucherTime) ? settings.missingVoucherTime : DEFAULT_TIME
      );
      if (now >= eligibleAt) {
        reasons.push({ key: "missingVoucher", label: REASONS.missingVoucher, eligibleAt });
      }
    }

    if (
      settings.unconfirmedEnabled !== false &&
      !confirmed(record)
    ) {
      const eligibleAt = eligibilityDate(
        base,
        numberOr(settings.unconfirmedAfterDays, 1),
        validTime(settings.unconfirmedTime) ? settings.unconfirmedTime : DEFAULT_TIME
      );
      if (now >= eligibleAt) {
        reasons.push({ key: "unconfirmed", label: REASONS.unconfirmed, eligibleAt });
      }
    }
  }

  return reasons;
}

function approved(r) {
  return r?.reviewStatus === "approved" || r?.reviewed === true || r?.locked === true;
}

function managerWaived(r) {
  return r?.voucherWaiverManagerConfirmed === true || r?.amountConfirmedByManagerWaiver === true;
}

function hasVoucher(r) {
  return !!(r?.voucherUrl || r?.folderUrl);
}

function confirmed(r) {
  return r?.amountConfirmed === true || r?.amountManuallyConfirmed === true || managerWaived(r);
}

function buildAutomaticMessage(settings, due) {
  const prefix = String(settings.messagePrefix || "【資源教室經費提醒】").trim();
  const byTeacher = new Map();

  for (const item of due) {
    const name = item.record.ownerName || item.record.ownerEmail || "未填老師";
    const key = item.record.ownerEmail || name;
    const row = byTeacher.get(key) || {
      name,
      counts: { missingVoucher: 0, unconfirmed: 0, estimated: 0 }
    };
    row.counts[item.reason.key]++;
    byTeacher.set(key, row);
  }

  const lines = [
    prefix,
    "⚠️ 請以下老師協助確認經費資料"
  ];

  for (const row of byTeacher.values()) {
    const parts = [];
    if (row.counts.missingVoucher) parts.push(`缺少核銷單據 ${row.counts.missingVoucher} 筆`);
    if (row.counts.unconfirmed) parts.push(`未確認 Key 金額 ${row.counts.unconfirmed} 筆`);
    if (row.counts.estimated) parts.push(`預估待追蹤 ${row.counts.estimated} 筆`);
    lines.push(`${row.name}｜${parts.join("、")}`);
  }

  lines.push("", VOUCHER_FOOTER);
  return lines.join("\n");
}

function shouldSendAgain(state, settings, now) {
  if (!state?.lastSentAt) return true;
  const last = timestampDate(state.lastSentAt);
  if (!last) return true;
  const repeatDays = Math.max(1, numberOr(settings.repeatEveryDays, 1));
  return now.getTime() >= last.getTime() + repeatDays * 86400000;
}

function stateDocId(planId, recordId, reasonKey) {
  return `${planId}__${recordId}__${reasonKey}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 1400);
}

async function getReminderState(projectId, accessToken, stateId) {
  const r = await fetch(firestoreDocUrl(projectId, `reminderAutoState/${stateId}`), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`讀取提醒狀態失敗（${r.status}）`);
  return firestoreDocumentToObject(await r.json());
}

async function writeReminderState(projectId, accessToken, stateId, data) {
  const fields = objectToFirestoreFields(data);
  const r = await fetch(firestoreDocUrl(projectId, `reminderAutoState/${stateId}`), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`寫入提醒狀態失敗（${r.status}）${t ? "：" + t.slice(0, 200) : ""}`);
  }
}

function validTime(v) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));
}

function numberOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function timestampDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function taipeiParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const out = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = p.value;
  return out;
}

function eligibilityDate(base, days, time) {
  const p = taipeiParts(base);
  const [hh, mm] = (validTime(time) ? time : DEFAULT_TIME).split(":").map(Number);
  return new Date(Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day) + Number(days || 0),
    hh - 8,
    mm,
    0,
    0
  ));
}

function requiredEnv(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`缺少環境變數：${name}`);
  return value;
}

async function serviceAccountAccessToken(env) {
  const email = requiredEnv(env, "FIREBASE_SERVICE_ACCOUNT_EMAIL");
  const privateKeyPem = requiredEnv(env, "FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };

  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claim)}`;
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned)
  );
  const assertion = `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    throw new Error(`Firebase Service Account 驗證失敗：${d.error_description || d.error || r.status}`);
  }
  return d.access_token;
}

async function importPrivateKey(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bytes = base64ToBytes(base64);
  return crypto.subtle.importKey(
    "pkcs8",
    bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function base64UrlJson(value) {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function firestoreBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

function firestoreDocUrl(projectId, path) {
  return `${firestoreBase(projectId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function firestoreListCollection(projectId, accessToken, collectionId) {
  let pageToken = "";
  const docs = [];
  do {
    const url = new URL(`${firestoreBase(projectId)}/${encodeURIComponent(collectionId)}`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) throw new Error(`讀取 ${collectionId} 失敗（${r.status}）`);
    const d = await r.json();
    docs.push(...(d.documents || []));
    pageToken = d.nextPageToken || "";
  } while (pageToken);
  return docs;
}

async function firestoreRunQuery(projectId, accessToken, structuredQuery) {
  const r = await fetch(`${firestoreBase(projectId)}:runQuery`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ structuredQuery })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Firestore 查詢失敗（${r.status}）${t ? "：" + t.slice(0, 200) : ""}`);
  }
  return r.json();
}

function docIdFromName(name) {
  return String(name || "").split("/").pop() || "";
}

function firestoreDocumentToObject(doc) {
  const out = {};
  for (const [key, value] of Object.entries(doc?.fields || {})) {
    out[key] = firestoreValueToJs(value);
  }
  return out;
}

function firestoreValueToJs(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(firestoreValueToJs);
  if ("mapValue" in v) {
    const o = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = firestoreValueToJs(val);
    return o;
  }
  return null;
}

function objectToFirestoreFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = jsToFirestoreValue(v);
  return out;
}

function jsToFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: String(v) };
}

function githubConfig(env) {
  const owner = env.BUDGET_GITHUB_OWNER || env.GITHUB_OWNER;
  const repo = env.BUDGET_GITHUB_REPO;
  const token = env.BUDGET_GITHUB_TOKEN || env.GITHUB_TOKEN;
  if (!owner || !repo || !token) {
    fail("通知服務尚未設定私密 GitHub Repository 權限。", 500);
  }
  return {
    owner,
    repo,
    token,
    branch: env.BUDGET_GITHUB_BRANCH || "main"
  };
}

async function gh(cfg, path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "MUST-Resource-Notify-Service",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {})
    }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) fail(d.message || `GitHub API 錯誤（${r.status}）`, r.status === 404 ? 404 : 502);
  return d;
}

async function ghOptional(cfg, path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "MUST-Resource-Notify-Service",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {})
    }
  });
  if (r.status === 404) return null;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) fail(d.message || `GitHub API 錯誤（${r.status}）`, 502);
  return d;
}

function enc(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function bytesToBase64(bytes) {
  let b = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    b += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(b);
}

function base64ToBytes(base64) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function arrayBufferToBase64(buffer) {
  return bytesToBase64(new Uint8Array(buffer));
}
