// MUST Free Upload Service v0.6.3
// - Fixes CORS for GitHub Pages by normalizing ALLOWED_ORIGINS to URL.origin
// - Explicitly allows the MUST GitHub Pages origin used by the budget system
// - Keeps budget attachments private and authenticated
// - Moves /budget-access-sync before generic authorization; the endpoint still enforces Portal admin
// - Streams private budget downloads directly from GitHub raw media to avoid large-file base64 failures

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const BUDGET_ACCESS_PATH = "system-config/budget-access.json";
const BUDGET_ACCESS_CACHE_SECONDS = 300;
const MUST_GITHUB_PAGES_ORIGIN = "https://f00931must-hash.github.io";

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(req.url);
      if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
        return json({ ok: true, service: "MUST Free Upload Service", version: "0.6.3" }, 200, cors);
      }

      const id = await authenticate(req, env);

      // Dedicated Portal-admin endpoint. budgetAccessSync() performs its own admin authorization.
      if (url.pathname === "/budget-access-sync" && req.method === "POST") {
        return budgetAccessSync(req, id, env, cors);
      }

      await authorize(id, env);

      if (url.pathname === "/upload" && req.method === "POST") return upload(req, id, env, cors);
      if (url.pathname === "/download" && req.method === "GET") return downloadPrivate(url, id, env, cors);
      if (url.pathname === "/file-info" && req.method === "GET") return fileInfo(url, id, env, cors);
      if (url.pathname === "/delete" && req.method === "POST") return del(req, id, env, cors);
      if ((url.pathname === "/stats" || url.pathname === "/repo-stats") && req.method === "GET") return stats(url, id, env, cors);
      if (url.pathname === "/files" && req.method === "GET") return list(url, id, env, cors);

      return json({ ok: false, error: "找不到此 API。" }, 404, cors);
    } catch (e) {
      return json({ ok: false, error: e.message || "伺服器錯誤" }, Number(e.status || 500), cors);
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
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  if (!allowed.includes(MUST_GITHUB_PAGES_ORIGIN)) allowed.push(MUST_GITHUB_PAGES_ORIGIN);

  const requestOrigin = normalizeOrigin(origin);
  const selected = allowed.includes(requestOrigin) ? requestOrigin : (allowed[0] || "");

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeJwt(token) {
  try {
    return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return {};
  }
}

async function fetchWith429Retry(url, init, label) {
  const delays = [0, 350, 1000, 2200];
  let lastResponse = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await sleep(delays[i]);
    const r = await fetch(url, init);
    lastResponse = r;
    if (r.status !== 429) return r;
  }
  const text = await lastResponse.text().catch(() => "");
  let detail = "";
  try { detail = JSON.parse(text)?.error?.message || ""; } catch { detail = text.slice(0, 180); }
  fail(`${label}暫時忙碌（429${detail ? "：" + detail : ""}），請稍後再試。`, 429);
}

async function authenticate(req, env) {
  const h = req.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) fail("尚未登入或缺少登入憑證。", 401);

  const p = decodeJwt(token);
  const project = String(p.aud || "");
  let apiKey = "";
  if (project === env.ACTIVITY_FIREBASE_PROJECT_ID) apiKey = env.ACTIVITY_FIREBASE_API_KEY;
  else if (project === env.ANNOUNCEMENT_FIREBASE_PROJECT_ID) apiKey = env.ANNOUNCEMENT_FIREBASE_API_KEY;
  else if (project === env.PORTAL_FIREBASE_PROJECT_ID) apiKey = env.PORTAL_FIREBASE_API_KEY;
  else if (project === env.BUDGET_FIREBASE_PROJECT_ID) apiKey = env.BUDGET_FIREBASE_API_KEY;
  else fail("此 Firebase 專案尚未獲准使用上傳服務。", 403);

  const r = await fetchWith429Retry(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ idToken: token })
    },
    "Firebase 登入驗證"
  );
  if (!r.ok) fail("登入憑證已失效，請重新登入。", 401);

  const d = await r.json();
  const u = d.users?.[0];
  if (!u?.localId || !u?.email) fail("無法辨識登入者。", 401);

  return {
    token,
    uid: u.localId,
    email: String(u.email).toLowerCase(),
    displayName: u.displayName || u.email,
    project
  };
}

async function authorize(id, env) {
  const supers = String(env.SUPER_ADMIN_EMAILS || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
  if (supers.includes(id.email)) return;

  if (id.project === env.BUDGET_FIREBASE_PROJECT_ID) {
    const access = await loadBudgetAccessList(env);
    const u = access.users?.find(x => String(x.email || "").toLowerCase() === id.email);
    if (!u || u.enabled !== true) fail("此帳號目前沒有經費附件存取權限，請由 Portal 管理員重新同步經費權限。", 403);
    if (String(u.role || "user").toLowerCase() === "assistant") fail("小幫手不開放經費附件存取。", 403);
    return;
  }

  if (id.project === env.ACTIVITY_FIREBASE_PROJECT_ID) {
    const base = `https://firestore.googleapis.com/v1/projects/${env.ACTIVITY_FIREBASE_PROJECT_ID}/databases/(default)/documents/settings/admins`;
    const d = await fsGet(base, id.token);
    const emails = (d?.fields?.emails?.arrayValue?.values || []).map(v => String(v.stringValue || "").toLowerCase());
    if (!emails.includes(id.email)) fail("此帳號沒有活動系統上傳權限。", 403);
    return;
  }

  if (id.project === env.ANNOUNCEMENT_FIREBASE_PROJECT_ID) {
    const base = `https://firestore.googleapis.com/v1/projects/${env.ANNOUNCEMENT_FIREBASE_PROJECT_ID}/databases/(default)/documents/settings/admins`;
    const d = await fsGet(base, id.token);
    const users = (d?.fields?.users?.arrayValue?.values || []).map(v => v.mapValue?.fields || {});
    const ok = users.some(f => String(f.email?.stringValue || "").toLowerCase() === id.email && ["superAdmin", "teacher", "assistant"].includes(String(f.role?.stringValue || "")));
    if (!ok) fail("此帳號沒有公告圖片與附件上傳權限。", 403);
    return;
  }

  const base = `https://firestore.googleapis.com/v1/projects/${env.PORTAL_FIREBASE_PROJECT_ID}/databases/(default)/documents/portalUsers`;
  let d = await fsGet(`${base}/${encodeURIComponent(id.uid)}`, id.token);
  if (!d) d = await fsGet(`${base}/${encodeURIComponent(id.email)}`, id.token);
  if (!d) fail("此帳號尚未列入 Portal 授權名單。", 403);
  const role = String(d.fields?.role?.stringValue || "").toLowerCase();
  const enabled = d.fields?.enabled?.booleanValue;
  if (enabled === false || !["admin", "teacher", "assistant", "superadmin"].includes(role)) fail("此帳號沒有圖片與附件管理權限。", 403);
}

async function assertPortalAdmin(id, env) {
  if (id.project !== env.PORTAL_FIREBASE_PROJECT_ID) fail("經費附件授權名單只能由 Portal 管理員同步。", 403);
  const base = `https://firestore.googleapis.com/v1/projects/${env.PORTAL_FIREBASE_PROJECT_ID}/databases/(default)/documents/portalUsers`;
  let d = await fsGet(`${base}/${encodeURIComponent(id.uid)}`, id.token);
  if (!d) d = await fsGet(`${base}/${encodeURIComponent(id.email)}`, id.token);
  if (!d) fail("找不到 Portal 管理員資料。", 403);
  const enabled = d.fields?.enabled?.booleanValue;
  const role = String(d.fields?.role?.stringValue || "").toLowerCase();
  if (enabled === false || !["admin", "superadmin"].includes(role)) fail("只有 Portal 管理員可以同步經費附件授權名單。", 403);
}

function budgetAccessCacheRequest() {
  return new Request("https://budget-access-list.internal/current", { method: "GET" });
}

async function clearBudgetAccessCache() {
  try { await caches.default.delete(budgetAccessCacheRequest()); } catch {}
}

async function loadBudgetAccessList(env) {
  try {
    const hit = await caches.default.match(budgetAccessCacheRequest());
    if (hit) return await hit.json();
  } catch {}

  const cfg = budgetRepoConfig(env);
  const d = await ghOptional(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(BUDGET_ACCESS_PATH)}?ref=${encodeURIComponent(cfg.branch)}`);
  if (!d?.content) fail("尚未建立經費附件授權名單，請到 Portal 按一次「同步經費」。", 503);

  let access;
  try {
    const raw = new TextDecoder().decode(base64ToBytes(String(d.content).replace(/\s+/g, "")));
    access = JSON.parse(raw);
  } catch {
    fail("經費附件授權名單格式異常，請由 Portal 管理員重新同步。", 500);
  }

  if (!Array.isArray(access?.users)) fail("經費附件授權名單缺少 users 資料。", 500);
  try {
    const res = new Response(JSON.stringify(access), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${BUDGET_ACCESS_CACHE_SECONDS}`
      }
    });
    await caches.default.put(budgetAccessCacheRequest(), res);
  } catch {}
  return access;
}

async function budgetAccessSync(req, id, env, cors) {
  await assertPortalAdmin(id, env);
  const b = await req.json().catch(() => ({}));
  if (!Array.isArray(b.users)) fail("缺少經費授權使用者名單。");
  if (b.users.length > 500) fail("經費授權使用者數量異常。", 400);

  const seen = new Set();
  const users = [];
  for (const raw of b.users) {
    const email = String(raw?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    const role = String(raw?.role || "user").toLowerCase() === "manager" ? "manager" : "user";
    users.push({
      email,
      name: String(raw?.name || email).slice(0, 120),
      role,
      enabled: raw?.enabled !== false
    });
  }
  if (!users.length) fail("授權名單不可為空。", 400);

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: id.email,
    users
  };

  const cfg = budgetRepoConfig(env);
  const existing = await ghOptional(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(BUDGET_ACCESS_PATH)}?ref=${encodeURIComponent(cfg.branch)}`);
  const body = {
    message: `sync budget access: ${users.length} users`,
    branch: cfg.branch,
    content: bytesToBase64(new TextEncoder().encode(JSON.stringify(payload, null, 2))),
    committer: { name: id.displayName, email: id.email }
  };
  if (existing?.sha) body.sha = existing.sha;

  await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(BUDGET_ACCESS_PATH)}`, {
    method: "PUT",
    body: JSON.stringify(body)
  });
  await clearBudgetAccessCache();

  return json({
    ok: true,
    synced: users.length,
    managers: users.filter(x => x.role === "manager").length,
    updatedBy: id.email
  }, 200, cors);
}

async function fsGet(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) fail("無法確認使用者權限。", 403);
  return r.json();
}

function budgetRepoConfig(env) {
  if (!env.BUDGET_GITHUB_REPO) fail("尚未設定經費私密附件 Repository。", 500);
  return {
    owner: env.BUDGET_GITHUB_OWNER || env.GITHUB_OWNER,
    repo: env.BUDGET_GITHUB_REPO,
    branch: env.BUDGET_GITHUB_BRANCH || "main",
    token: env.BUDGET_GITHUB_TOKEN || env.GITHUB_TOKEN,
    isPrivate: true
  };
}

function repoConfig(system, id, env) {
  if (system === "budget") {
    if (id.project !== env.BUDGET_FIREBASE_PROJECT_ID) fail("經費附件只能由經費系統存取。", 403);
    return budgetRepoConfig(env);
  }
  return {
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    branch: env.GITHUB_BRANCH || "main",
    token: env.GITHUB_TOKEN,
    isPrivate: false
  };
}

async function upload(req, id, env, cors) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) fail("沒有收到檔案。");

  const system = safe(form.get("system") || "shared");
  const category = safe(form.get("category") || (file.type.startsWith("image/") ? "images" : "attachments"));
  const sub = safe(form.get("subfolder") || "");
  const cfg = repoConfig(system, id, env);

  const limit = system === "budget"
    ? 15
    : Number(file.type.startsWith("image/") ? env.MAX_IMAGE_MB : env.MAX_ATTACHMENT_MB) || 20;
  if (file.size > limit * 1024 * 1024) fail(`檔案超過上限 ${limit} MB。`);

  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const ext = extension(file.name, file.type);
  const rand = crypto.randomUUID().slice(0, 8);
  const middle = sub ? `${sub}/` : "";
  const path = `uploads/${system}/${category}/${middle}${yyyy}/${mm}/${stamp}_${rand}.${ext}`;
  const content = bytesToBase64(new Uint8Array(await file.arrayBuffer()));

  const commit = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `upload(${system}): ${file.name}`,
      branch: cfg.branch,
      content,
      committer: { name: id.displayName, email: id.email }
    })
  });

  const url = cfg.isPrivate
    ? `/download?system=budget&path=${encodeURIComponent(path)}`
    : `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/${path}`;

  return json({
    ok: true,
    file: {
      name: file.name,
      url,
      path,
      size: file.size,
      type: file.type || "",
      mimeType: file.type || "",
      sha: commit.content?.sha || "",
      uploadedBy: id.email,
      uploadedAt: now.toISOString(),
      private: cfg.isPrivate
    }
  }, 201, cors);
}

async function downloadPrivate(url, id, env, cors) {
  const system = safe(url.searchParams.get("system") || "");
  if (system !== "budget") fail("此下載端點僅供經費私密附件使用。", 403);
  const path = String(url.searchParams.get("path") || "").replace(/^\/+/, "");
  if (!path.startsWith("uploads/budget/")) fail("無效的經費附件路徑。", 403);

  const cfg = repoConfig("budget", id, env);
  if (!cfg.token) fail("伺服器尚未設定 GitHub Token。", 500);

  const apiUrl =
    `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}` +
    `/contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`;

  const r = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "MUST-Free-Upload-Service"
    },
    redirect: "follow"
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    let msg = "";
    try { msg = JSON.parse(detail)?.message || ""; } catch { msg = detail.slice(0, 180); }
    fail(msg || `附件讀取失敗（GitHub ${r.status}）`, r.status === 404 ? 404 : 502);
  }

  const name = path.split("/").pop() || "attachment";
  const type = r.headers.get("content-type") || mimeFromName(name);
  const headers = new Headers(cors);
  headers.set("content-type", type);
  headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set("cache-control", "private, no-store");
  const len = r.headers.get("content-length");
  if (len) headers.set("content-length", len);
  return new Response(r.body, { status: 200, headers });
}

async function fileInfo(url, id, env, cors) {
  const path = String(url.searchParams.get("path") || "").replace(/^\/+/, "");
  if (!path.startsWith("uploads/")) fail("只能讀取 uploads 目錄。", 403);
  const system = path.startsWith("uploads/budget/") ? "budget" : safe(url.searchParams.get("system") || "shared");
  const cfg = repoConfig(system, id, env);
  const d = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`);
  return json({ ok: true, file: { name: d.name, path: d.path, size: d.size || 0, sha: d.sha, url: cfg.isPrivate ? null : d.download_url || null, type: d.type, private: cfg.isPrivate } }, 200, cors);
}

async function del(req, id, env, cors) {
  const b = await req.json().catch(() => ({}));
  const path = String(b.path || "").replace(/^\/+/, "");
  if (!path.startsWith("uploads/")) fail("只能刪除 uploads 目錄內檔案。", 403);
  const system = path.startsWith("uploads/budget/") ? "budget" : safe(b.system || "shared");
  const cfg = repoConfig(system, id, env);
  const info = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`);
  await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(path)}`, {
    method: "DELETE",
    body: JSON.stringify({
      message: `delete: ${b.name || path}`,
      branch: cfg.branch,
      sha: info.sha,
      committer: { name: id.displayName, email: id.email }
    })
  });
  return json({ ok: true, deleted: { path, deletedBy: id.email } }, 200, cors);
}

async function stats(url, id, env, cors) {
  const system = safe(url.searchParams.get("system") || "shared");
  const cfg = repoConfig(system, id, env);
  const d = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}`);
  const used = Number(d.size || 0) * 1024;
  const limitMb = system === "budget" ? Number(env.BUDGET_REPO_LIMIT_MB || 1024) : 1024;
  const limit = limitMb * 1024 * 1024;
  return json({
    ok: true,
    system,
    usage: {
      usedBytes: used,
      limitBytes: limit,
      remainingBytes: Math.max(limit - used, 0),
      percent: limit > 0 ? Math.round(used / limit * 1000) / 10 : 0
    }
  }, 200, cors);
}

async function list(url, id, env, cors) {
  const path = String(url.searchParams.get("path") || "uploads").replace(/^\/+|\/+$/g, "");
  if (!path.startsWith("uploads")) fail("只能讀取 uploads 目錄。", 403);
  const system = path.startsWith("uploads/budget") ? "budget" : safe(url.searchParams.get("system") || "shared");
  const cfg = repoConfig(system, id, env);
  const recursive = url.searchParams.get("recursive") === "1" || url.searchParams.get("recursive") === "true";

  if (recursive) {
    const tree = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`);
    const prefix = path.replace(/\/+$/, "") + "/";
    const items = (tree.tree || [])
      .filter(x => x.type === "blob" && (x.path === path || x.path.startsWith(prefix)))
      .map(x => ({ name: x.path.split("/").pop(), path: x.path, type: "file", size: x.size || 0, sha: x.sha, url: cfg.isPrivate ? null : `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/${x.path}` }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return json({ ok: true, path, recursive: true, truncated: tree.truncated === true, items }, 200, cors);
  }

  const d = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`);
  const items = (Array.isArray(d) ? d : [d]).map(x => ({ name: x.name, path: x.path, type: x.type, size: x.size || 0, sha: x.sha, url: cfg.isPrivate ? null : x.download_url || null }));
  return json({ ok: true, path, recursive: false, items }, 200, cors);
}

async function gh(cfg, path, init = {}) {
  if (!cfg.token) fail("伺服器尚未設定 GitHub Token。", 500);
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "MUST-Free-Upload-Service",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {})
    }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) fail(d.message || `GitHub API 錯誤（${r.status}）`, r.status === 404 ? 404 : 502);
  return d;
}

async function ghOptional(cfg, path, init = {}) {
  if (!cfg.token) fail("伺服器尚未設定 GitHub Token。", 500);
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "MUST-Free-Upload-Service",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {})
    }
  });
  if (r.status === 404) return null;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) fail(d.message || `GitHub API 錯誤（${r.status}）`, 502);
  return d;
}

function safe(v) {
  return String(v || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function extension(name, mime) {
  const x = String(name).toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  if (x) return x[1];
  return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[mime] || "bin";
}

function mimeFromName(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  return { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext] || "application/octet-stream";
}

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

function enc(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}
