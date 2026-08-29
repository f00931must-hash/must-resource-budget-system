// MUST Resource Room Notification Service v1.0.2
// Production LINE notification worker.
//
// Features:
// - Verifies LINE webhook signatures.
// - Stores the linked LINE group ID in the private GitHub repository.
// - Exposes manager-only LINE status / test / send endpoints.
// - Formal reminders always append the voucher scan/upload + amount check notice.
// - Does not log secrets or LINE group IDs.

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

const MUST_GITHUB_PAGES_ORIGIN = "https://f00931must-hash.github.io";
const LINE_CONFIG_PATH = "system-config/line-notify.json";
const VOUCHER_FOOTER = "請記得務必將核銷單據掃描並上傳，並且確認金額是否輸入正確，謝謝。";

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    try {
      const url = new URL(req.url);

      if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
        return json({
          ok: true,
          service: "MUST Resource Room Notification Service",
          version: "1.0.2"
        }, 200, cors);
      }

      // LINE webhook is authenticated using X-Line-Signature.
      if (url.pathname === "/line/webhook" && req.method === "POST") {
        return lineWebhook(req, env, ctx, cors);
      }

      // Management APIs require Budget Firebase login + manager role.
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

      return json({
        ok: false,
        error: "找不到此 API。"
      }, 404, cors);

    } catch (e) {
      return json({
        ok: false,
        error: e?.message || "伺服器錯誤"
      }, Number(e?.status || 500), cors);
    }
  }
};

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/$/, "");
  }
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
    headers: {
      ...JSON_HEADERS,
      ...headers
    }
  });
}

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

function decodeJwt(token) {
  try {
    return JSON.parse(
      atob(
        token
          .split(".")[1]
          .replace(/-/g, "+")
          .replace(/_/g, "/")
      )
    );
  } catch {
    return {};
  }
}

async function authenticateBudget(req, env) {
  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!token) {
    fail("尚未登入或缺少登入憑證。", 401);
  }

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
      body: JSON.stringify({
        idToken: token
      })
    }
  );

  if (!response.ok) {
    fail("登入憑證已失效，請重新登入。", 401);
  }

  const data = await response.json();
  const user = data.users?.[0];

  if (!user?.localId || !user?.email) {
    fail("無法辨識登入者。", 401);
  }

  return {
    token,
    uid: user.localId,
    email: String(user.email).toLowerCase(),
    displayName: user.displayName || user.email
  };
}

async function assertBudgetManager(identity, env) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.BUDGET_FIREBASE_PROJECT_ID)}` +
    `/databases/(default)/documents/users/${encodeURIComponent(identity.email)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${identity.token}`
    }
  });

  if (!response.ok) {
    fail("找不到經費系統管理員資料。", 403);
  }

  const data = await response.json();
  const fields = data?.fields || {};
  const enabled = fields.enabled?.booleanValue === true;
  const role = String(fields.role?.stringValue || "").toLowerCase();

  if (!enabled || role !== "manager") {
    fail("此功能僅限經費管理員使用。", 403);
  }
}

async function lineWebhook(req, env, ctx, cors) {
  if (!env.LINE_CHANNEL_SECRET) {
    fail("尚未設定 LINE_CHANNEL_SECRET。", 500);
  }

  const signature = req.headers.get("x-line-signature") || "";
  const raw = await req.text();

  const valid = signature && await verifyLineSignature(
    raw,
    signature,
    env.LINE_CHANNEL_SECRET
  );

  if (!valid) {
    return json({
      ok: false,
      error: "LINE webhook 簽章驗證失敗。"
    }, 401, cors);
  }

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json({
      ok: false,
      error: "Webhook JSON 格式錯誤。"
    }, 400, cors);
  }

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
    const job = saveLineGroup(latest, env).catch(err => {
      console.error("saveLineGroup failed", err?.message || err);
    });

    if (ctx?.waitUntil) {
      ctx.waitUntil(job);
    } else {
      await job;
    }
  }

  // Do not reply to normal LINE chat messages here.
  return json({
    ok: true
  }, 200, cors);
}

async function verifyLineSignature(body, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );

  return timingSafeEqual(
    arrayBufferToBase64(mac),
    String(signature || "")
  );
}

function timingSafeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));

  if (aa.length !== bb.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < aa.length; i++) {
    diff |= aa[i] ^ bb[i];
  }

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
        new TextDecoder().decode(
          base64ToBytes(
            String(existing.content).replace(/\s+/g, "")
          )
        )
      );
    } catch {
      previous = {};
    }
  }

  // Avoid a new GitHub commit for every ordinary message from the same group.
  if (String(previous.groupId || "") === group.groupId) {
    return;
  }

  const payload = {
    version: 1,
    groupId: group.groupId,
    linkedAt: new Date().toISOString(),
    lastEventType: group.eventType
  };

  const body = {
    message: "link LINE notification group",
    branch: cfg.branch,
    content: bytesToBase64(
      new TextEncoder().encode(
        JSON.stringify(payload, null, 2)
      )
    )
  };

  if (existing?.sha) {
    body.sha = existing.sha;
  }

  await gh(
    cfg,
    `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(LINE_CONFIG_PATH)}`,
    {
      method: "PUT",
      body: JSON.stringify(body)
    }
  );
}

async function loadLineConfig(env) {
  const cfg = githubConfig(env);

  const data = await ghOptional(
    cfg,
    `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(LINE_CONFIG_PATH)}?ref=${encodeURIComponent(cfg.branch)}`
  );

  if (!data?.content) {
    return null;
  }

  try {
    return JSON.parse(
      new TextDecoder().decode(
        base64ToBytes(
          String(data.content).replace(/\s+/g, "")
        )
      )
    );
  } catch {
    fail("LINE 群組設定檔格式異常。", 500);
  }
}

async function lineStatus(env, cors) {
  const cfg = await loadLineConfig(env);

  return json({
    ok: true,
    lineConfigured: !!(
      env.LINE_CHANNEL_SECRET &&
      env.LINE_CHANNEL_ACCESS_TOKEN
    ),
    groupLinked: !!cfg?.groupId,
    linkedAt: cfg?.linkedAt || null
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

async function sendManagerLine(
  req,
  identity,
  env,
  cors,
  fallbackText,
  appendVoucherFooter
) {
  const cfg = await loadLineConfig(env);

  if (!cfg?.groupId) {
    fail("尚未綁定 LINE 群組。", 409);
  }

  const body = await req.json().catch(() => ({}));
  let text = String(body.text || fallbackText).trim();

  if (!text) {
    fail("提醒內容不可空白。", 400);
  }

  if (
    appendVoucherFooter &&
    !text.includes(VOUCHER_FOOTER)
  ) {
    text = `${text}\n\n${VOUCHER_FOOTER}`;
  }

  text = text.slice(0, 4500);

  await pushLineMessage(
    cfg.groupId,
    text,
    env
  );

  return json({
    ok: true,
    sent: true,
    sentBy: identity.email
  }, 200, cors);
}

async function pushLineMessage(to, text, env) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    fail("尚未設定 LINE_CHANNEL_ACCESS_TOKEN。", 500);
  }

  const response = await fetch(
    "https://api.line.me/v2/bot/message/push",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        to,
        messages: [
          {
            type: "text",
            text
          }
        ]
      })
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    fail(
      `LINE 發送失敗（${response.status}）${detail ? "：" + detail.slice(0, 300) : ""}`,
      502
    );
  }
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
  const response = await fetch(
    `https://api.github.com${path}`,
    {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${cfg.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MUST-Resource-Notify-Service",
        ...(init.body
          ? { "content-type": "application/json" }
          : {}),
        ...(init.headers || {})
      }
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    fail(
      data.message || `GitHub API 錯誤（${response.status}）`,
      response.status === 404 ? 404 : 502
    );
  }

  return data;
}

async function ghOptional(cfg, path, init = {}) {
  const response = await fetch(
    `https://api.github.com${path}`,
    {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${cfg.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MUST-Resource-Notify-Service",
        ...(init.body
          ? { "content-type": "application/json" }
          : {}),
        ...(init.headers || {})
      }
    }
  );

  if (response.status === 404) {
    return null;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    fail(
      data.message || `GitHub API 錯誤（${response.status}）`,
      502
    );
  }

  return data;
}

function enc(path) {
  return String(path)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

function bytesToBase64(bytes) {
  let result = "";

  for (let i = 0; i < bytes.length; i += 32768) {
    result += String.fromCharCode(
      ...bytes.subarray(i, i + 32768)
    );
  }

  return btoa(result);
}

function base64ToBytes(base64) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);

  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }

  return bytes;
}

function arrayBufferToBase64(buffer) {
  return bytesToBase64(
    new Uint8Array(buffer)
  );
}
