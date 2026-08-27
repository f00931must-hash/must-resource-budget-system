// MUST Free Upload Service v0.5.5
// - Keeps existing activity / announcement / portal uploads unchanged
// - Adds private budget attachment storage + authenticated download
// - Budget attachment max size: 15 MB
// - Budget authorization follows the budget app: enabled users may use attachments; assistants are blocked
// - Keeps legacy /repo-stats compatibility
// - Budget permission check: Cloudflare Cache API + automatic retry on Firebase / Firestore 429

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const BUDGET_AUTH_SOFT_TTL_MS = 2 * 60 * 1000;
const BUDGET_AUTH_STALE_TTL_MS = 10 * 60 * 1000;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(req.url);
      if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
        return json({ ok: true, service: "MUST Free Upload Service", version: "0.5.5" }, 200, cors);
      }

      const id = await authenticate(req, env);
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

function corsHeaders(origin, env) {
  const a = String(env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
  const selected = a.some(x => origin === x || origin.startsWith(x + "/")) ? origin : a[0] || "";
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

function budgetCacheRequest(project, email) {
  return new Request(`https://budget-auth-cache.internal/${encodeURIComponent(project)}/${encodeURIComponent(email)}`, { method: "GET" });
}

async function readBudgetAuthCache(project, email) {
  try {
    const cache = caches.default;
    const hit = await cache.match(budgetCacheRequest(project, email));
    if (!hit) return null;
    return await hit.json();
  } catch {
    return null;
  }
}

async function writeBudgetAuthCache(project, email, data) {
  try {
    const cache = caches.default;
    const payload = { ...data, validatedAt: Date.now() };
    const res = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=600"
      }
    });
    await cache.put(budgetCacheRequest(project, email), res);
  } catch {
    // Cache failure must not block attachment access.
  }
}

function assertBudgetCachedPermission(cached) {
  if (!cached) return;
  if (cached.enabled !== true) fail("此帳號目前未啟用經費附件權限。", 403);
  if (cached.role === "assistant") fail("小幫手不開放經費附件存取。", 403);
}

async function authorize(id, env) {
  const supers = String(env.SUPER_ADMIN_EMAILS || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
  if (supers.includes(id.email)) return;

  if (id.project === env.BUDGET_FIREBASE_PROJECT_ID) {
    const now = Date.now();
    const cached = await readBudgetAuthCache(id.project, id.email);
    const age = cached?.validatedAt ? now - Number(cached.validatedAt) : Infinity;

    if (cached && age <= BUDGET_AUTH_SOFT_TTL_MS) {
      assertBudgetCachedPermission(cached);
      return;
    }

    const base = `https://firestore.googleapis.com/v1/projects/${env.BUDGET_FIREBASE_PROJECT_ID}/databases/(default)/documents/users`;
    try {
      const d = await fsGetWithRetry(`${base}/${encodeURIComponent(id.email)}`, id.token);
      if (!d) fail("此帳號尚未列入經費系統授權名單。", 403);

      const enabled = d.fields?.enabled?.booleanValue;
      const role = String(d.fields?.role?.stringValue || "user").toLowerCase();
      const fresh = { enabled, role };
      await writeBudgetAuthCache(id.project, id.email, fresh);
      assertBudgetCachedPermission(fresh);
      return;
    } catch (e) {
      if (Number(e.status) === 429 && cached && age <= BUDGET_AUTH_STALE_TTL_MS) {
        assertBudgetCachedPermission(cached);
        return;
      }
      throw e;
    }
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

async function fsGetWithRetry(url, token) {
  const delays = [0, 350, 1000, 2200];
  let lastStatus = 0;
  let lastDetail = "";

  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await sleep(delays[i]);

    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404 || r.status === 403) return null;
    if (r.ok) return r.json();

    lastStatus = r.status;
    const text = await r.text().catch(() => "");
    try {
      const data = JSON.parse(text);
      lastDetail = data?.error?.message || "";
    } catch {
      lastDetail = text.slice(0, 180);
    }

    if (r.status !== 429) break;
  }

  fail(
    `無法確認使用者權限（Firestore ${lastStatus || "錯誤"}${lastDetail ? "：" + lastDetail : ""}）`,
    lastStatus === 429 ? 429 : 403
  );
}

async function fsGet(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) fail("無法確認使用者權限。", 403);
  return r.json();
}

function repoConfig(system, id, env) {
  if (system === "budget") {
    if (id.project !== env.BUDGET_FIREBASE_PROJECT_ID) fail("經費附件只能由經費系統存取。", 403);
    if (!env.BUDGET_GITHUB_REPO) fail("尚未設定經費私密附件 Repository。", 500);
    return {
      owner: env.BUDGET_GITHUB_OWNER || env.GITHUB_OWNER,
      repo: env.BUDGET_GITHUB_REPO,
      branch: env.BUDGET_GITHUB_BRANCH || "main",
      token: env.BUDGET_GITHUB_TOKEN || env.GITHUB_TOKEN,
      isPrivate: true
    };
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
  const d = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`);
  if (!d?.content) fail("找不到附件內容。", 404);

  const bytes = base64ToBytes(String(d.content).replace(/\s+/g, ""));
  const name = d.name || "attachment";
  const type = mimeFromName(name);
  const headers = new Headers(cors);
  headers.set("content-type", type);
  headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set("cache-control", "private, no-store");
  return new Response(bytes, { status: 200, headers });
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
