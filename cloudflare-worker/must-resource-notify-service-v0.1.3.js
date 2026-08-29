// MUST Resource Room Notification Service v0.1.3 DIAGNOSTIC ONLY
// Purpose: isolate GitHub token access for LINE group linking.
// Logs status/message only; never logs token or LINE groupId.

const LINE_CONFIG_PATH = "system-config/line-notify.json";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
        return json({ ok: true, service: "MUST Resource Room Notification Service", version: "0.1.3-diagnostic" });
      }
      if (url.pathname === "/line/webhook" && req.method === "POST") {
        return lineWebhook(req, env, ctx);
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      console.error("notify-diagnostic-fatal", { message: String(e?.message || e).slice(0, 500) });
      return json({ ok: false, error: e?.message || "error" }, Number(e?.status || 500));
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cfg(env) {
  return {
    owner: String(env.BUDGET_GITHUB_OWNER || env.GITHUB_OWNER || ""),
    repo: String(env.BUDGET_GITHUB_REPO || ""),
    token: String(env.BUDGET_GITHUB_TOKEN || env.GITHUB_TOKEN || ""),
    branch: String(env.BUDGET_GITHUB_BRANCH || "main")
  };
}

async function lineWebhook(req, env, ctx) {
  if (!env.LINE_CHANNEL_SECRET) return json({ ok: false, error: "missing LINE_CHANNEL_SECRET" }, 500);
  const signature = req.headers.get("x-line-signature") || "";
  const raw = await req.text();
  if (!signature || !(await verifyLineSignature(raw, signature, env.LINE_CHANNEL_SECRET))) {
    return json({ ok: false, error: "invalid signature" }, 401);
  }

  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { return json({ ok: false, error: "bad json" }, 400); }
  const event = (Array.isArray(body.events) ? body.events : []).find(e => e?.source?.type === "group" && e?.source?.groupId);
  if (!event) return json({ ok: true, note: "no group event" });

  const job = diagnoseAndSave(event.source.groupId, event.type || "unknown", env)
    .catch(err => console.error("notify-diagnostic-failed", { message: String(err?.message || err).slice(0, 500) }));
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return json({ ok: true });
}

async function diagnoseAndSave(groupId, eventType, env) {
  const c = cfg(env);
  console.log("notify-diagnostic-env", {
    ownerConfigured: !!c.owner,
    repoConfigured: !!c.repo,
    tokenConfigured: !!c.token,
    branch: c.branch
  });
  if (!c.owner || !c.repo || !c.token) throw new Error("missing GitHub env");

  // 1) Can this token see the repository at all?
  const repoRes = await githubFetch(c, `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`);
  console.log("notify-repo-read", {
    repoReadStatus: repoRes.status,
    repoReadMessage: repoRes.message,
    repo: `${c.owner}/${c.repo}`
  });
  if (repoRes.status !== 200) throw new Error(`repo read failed: ${repoRes.status} ${repoRes.message}`);

  // 2) Can it read the existing system-config directory?
  const dirPath = "system-config";
  const dirRes = await githubFetch(c, `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${enc(dirPath)}?ref=${encodeURIComponent(c.branch)}`);
  console.log("notify-dir-read", {
    dirReadStatus: dirRes.status,
    dirReadMessage: dirRes.message,
    path: dirPath
  });
  if (dirRes.status !== 200) throw new Error(`dir read failed: ${dirRes.status} ${dirRes.message}`);

  // 3) Read target file if it already exists. 404 is expected for first link.
  const targetApi = `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${enc(LINE_CONFIG_PATH)}?ref=${encodeURIComponent(c.branch)}`;
  const targetRes = await githubFetch(c, targetApi);
  console.log("notify-target-read", {
    targetReadStatus: targetRes.status,
    targetReadMessage: targetRes.message,
    path: LINE_CONFIG_PATH
  });
  if (![200, 404].includes(targetRes.status)) throw new Error(`target read failed: ${targetRes.status} ${targetRes.message}`);

  // 4) Write/update target file. The groupId is written to private repo, never logged.
  const payload = {
    version: 1,
    groupId: String(groupId),
    linkedAt: new Date().toISOString(),
    lastEventType: String(eventType)
  };
  const putBody = {
    message: "link LINE notification group",
    branch: c.branch,
    content: bytesToBase64(new TextEncoder().encode(JSON.stringify(payload, null, 2)))
  };
  if (targetRes.status === 200 && targetRes.data?.sha) putBody.sha = targetRes.data.sha;

  const writeRes = await githubFetch(c, `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${enc(LINE_CONFIG_PATH)}`, {
    method: "PUT",
    body: JSON.stringify(putBody)
  });
  console.log("notify-file-write", {
    fileWriteStatus: writeRes.status,
    fileWriteMessage: writeRes.message,
    path: LINE_CONFIG_PATH
  });
  if (![200, 201].includes(writeRes.status)) throw new Error(`file write failed: ${writeRes.status} ${writeRes.message}`);

  console.log("notify-line-link-success", { repo: `${c.owner}/${c.repo}`, path: LINE_CONFIG_PATH });
}

async function githubFetch(c, path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${c.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "MUST-Resource-Notify-Service-Diagnostic",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {})
    }
  });
  const data = await r.json().catch(() => ({}));
  return {
    status: r.status,
    message: String(data?.message || (r.ok ? "OK" : "Unknown GitHub error")).slice(0, 300),
    data
  };
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
  return timingSafeEqual(bytesToBase64(new Uint8Array(mac)), String(signature));
}

function timingSafeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function enc(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
}
