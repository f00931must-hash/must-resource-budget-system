// MUST Resource Room Notification Service v0.1.1
// LINE Messaging API webhook + manager-only test notification endpoint.
// Safe diagnostics: logs only whether required GitHub variables exist; never logs secret values.

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MUST_GITHUB_PAGES_ORIGIN = "https://f00931must-hash.github.io";
const LINE_CONFIG_PATH = "system-config/line-notify.json";

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(req.url);

      if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
        return json({ ok: true, service: "MUST Resource Room Notification Service", version: "0.1.1" }, 200, cors);
      }

      if (url.pathname === "/line/webhook" && req.method === "POST") {
        return lineWebhook(req, env, ctx, cors);
      }

      const id = await authenticateBudget(req, env);
      await assertBudgetManager(id, env);

      if (url.pathname === "/line/status" && req.method === "GET") return lineStatus(env, cors);
      if (url.pathname === "/line/test" && req.method === "POST") return lineTest(req, id, env, cors);

      return json({ ok: false, error: "找不到此 API。" }, 404, cors);
    } catch (e) {
      return json({ ok: false, error: e?.message || "伺服器錯誤" }, Number(e?.status || 500), cors);
    }
  }
};

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try { return new URL(raw).origin; }
  catch { return raw.replace(/\/$/, ""); }
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(normalizeOrigin).filter(Boolean);
  if (!allowed.includes(MUST_GITHUB_PAGES_ORIGIN)) allowed.push(MUST_GITHUB_PAGES_ORIGIN);
  const requestOrigin = normalizeOrigin(origin);
  const selected = allowed.includes(requestOrigin) ? requestOrigin : (allowed[0] || MUST_GITHUB_PAGES_ORIGIN);
  return {
    "access-control-allow-origin": selected,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

function decodeJwt(token) {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); }
  catch { return {}; }
}

async function authenticateBudget(req, env) {
  const h = req.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) fail("尚未登入或缺少登入憑證。", 401);

  const p = decodeJwt(token);
  if (String(p.aud || "") !== String(env.BUDGET_FIREBASE_PROJECT_ID || "")) fail("此通知服務僅供經費系統使用。", 403);
  if (!env.BUDGET_FIREBASE_API_KEY) fail("尚未設定 Budget Firebase API Key。", 500);

  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.BUDGET_FIREBASE_API_KEY)}`, {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ idToken: token })
  });
  if (!r.ok) fail("登入憑證已失效，請重新登入。", 401);
  const d = await r.json();
  const u = d.users?.[0];
  if (!u?.localId || !u?.email) fail("無法辨識登入者。", 401);
  return { token, uid: u.localId, email: String(u.email).toLowerCase(), displayName: u.displayName || u.email };
}

async function assertBudgetManager(id, env) {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.BUDGET_FIREBASE_PROJECT_ID)}/databases/(default)/documents/users/${encodeURIComponent(id.email)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${id.token}` } });
  if (!r.ok) fail("找不到經費系統管理員資料。", 403);
  const d = await r.json();
  const f = d?.fields || {};
  const enabled = f.enabled?.booleanValue === true;
  const role = String(f.role?.stringValue || "").toLowerCase();
  if (!enabled || role !== "manager") fail("此功能僅限經費管理員使用。", 403);
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
      groups.push({ groupId: String(source.groupId), eventType: String(event.type || "unknown"), seenAt: new Date().toISOString() });
    }
  }

  if (groups.length) {
    const latest = groups[groups.length - 1];
    const job = saveLineGroup(latest, env).catch(err => console.error("saveLineGroup failed", err));
    if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  }

  return json({ ok: true }, 200, cors);
}

async function verifyLineSignature(body, signature, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
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
  const existing = await ghOptional(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(LINE_CONFIG_PATH)}?ref=${encodeURIComponent(cfg.branch)}`);

  let previous = {};
  if (existing?.content) {
    try { previous = JSON.parse(new TextDecoder().decode(base64ToBytes(String(existing.content).replace(/\s+/g, "")))); }
    catch {}
  }
  if (String(previous.groupId || "") === group.groupId) return;

  const payload = { version: 1, groupId: group.groupId, linkedAt: new Date().toISOString(), lastEventType: group.eventType };
  const body = {
    message: "link LINE notification group",
    branch: cfg.branch,
    content: bytesToBase64(new TextEncoder().encode(JSON.stringify(payload, null, 2)))
  };
  if (existing?.sha) body.sha = existing.sha;
  await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(LINE_CONFIG_PATH)}`, { method: "PUT", body: JSON.stringify(body) });
}

async function loadLineConfig(env) {
  const cfg = githubConfig(env);
  const d = await ghOptional(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(LINE_CONFIG_PATH)}?ref=${encodeURIComponent(cfg.branch)}`);
  if (!d?.content) return null;
  try { return JSON.parse(new TextDecoder().decode(base64ToBytes(String(d.content).replace(/\s+/g, "")))); }
  catch { fail("LINE 群組設定檔格式異常。", 500); }
}

async function lineStatus(env, cors) {
  const cfg = await loadLineConfig(env);
  return json({ ok: true, lineConfigured: !!(env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN), groupLinked: !!cfg?.groupId, linkedAt: cfg?.linkedAt || null }, 200, cors);
}

async function lineTest(req, id, env, cors) {
  const cfg = await loadLineConfig(env);
  if (!cfg?.groupId) fail("尚未綁定 LINE 群組。請先把 Bot 加入資教群組，並在群組內傳一則訊息。", 409);
  const body = await req.json().catch(() => ({}));
  const text = String(body.text || "【資源教室經費提醒－測試】\nLINE 提醒系統已成功連線。").slice(0, 4500);
  await pushLineMessage(cfg.groupId, text, env);
  return json({ ok: true, sent: true, sentBy: id.email }, 200, cors);
}

async function pushLineMessage(to, text, env) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) fail("尚未設定 LINE_CHANNEL_ACCESS_TOKEN。", 500);
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] })
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    fail(`LINE 發送失敗（${r.status}）${detail ? "：" + detail.slice(0, 300) : ""}`, 502);
  }
}

function githubConfig(env) {
  const owner = env.BUDGET_GITHUB_OWNER || env.GITHUB_OWNER;
  const repo = env.BUDGET_GITHUB_REPO;
  const token = env.BUDGET_GITHUB_TOKEN || env.GITHUB_TOKEN;

  // SAFE diagnostics: boolean only. Never print actual values or secrets.
  console.log("notify-github-env", {
    githubOwnerConfigured: !!owner,
    githubRepoConfigured: !!repo,
    githubTokenConfigured: !!token,
    githubBranchConfigured: !!env.BUDGET_GITHUB_BRANCH
  });

  if (!owner || !repo || !token) {
    const missing = [
      !owner ? "BUDGET_GITHUB_OWNER" : "",
      !repo ? "BUDGET_GITHUB_REPO" : "",
      !token ? "BUDGET_GITHUB_TOKEN" : ""
    ].filter(Boolean);
    fail(`通知服務缺少 GitHub 設定：${missing.join(", ")}`, 500);
  }
  return { owner, repo, token, branch: env.BUDGET_GITHUB_BRANCH || "main" };
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

function enc(path) { return String(path).split("/").map(encodeURIComponent).join("/"); }

function bytesToBase64(bytes) {
  let b = "";
  for (let i = 0; i < bytes.length; i += 32768) b += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(b);
}

function base64ToBytes(base64) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function arrayBufferToBase64(buffer) { return bytesToBase64(new Uint8Array(buffer)); }
