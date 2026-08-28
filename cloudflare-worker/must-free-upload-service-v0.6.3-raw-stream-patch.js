// v0.6.3 replacement for downloadPrivate() in must-free-upload-service v0.6.1+
// Fix: stream private GitHub file bytes directly instead of Contents/Git Blob JSON+base64.
// Security is unchanged: Firebase authentication + budget allowlist authorization happen before this function.

async function downloadPrivate(url, id, env, cors) {
  const system = safe(url.searchParams.get("system") || "");
  if (system !== "budget") fail("此下載端點僅供經費私密附件使用。", 403);

  const path = String(url.searchParams.get("path") || "").replace(/^\/+/, "");
  if (!path.startsWith("uploads/budget/")) fail("無效的經費附件路徑。", 403);

  const cfg = repoConfig("budget", id, env);
  if (!cfg.token) fail("伺服器尚未設定 GitHub Token。", 500);

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`;

  // GitHub raw media type returns the actual file body and avoids loading a large base64 JSON payload into Worker memory.
  const upstream = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "MUST-Free-Upload-Service"
    },
    redirect: "follow"
  });

  if (!upstream.ok) {
    let detail = "";
    try {
      const text = await upstream.text();
      try { detail = JSON.parse(text)?.message || text.slice(0, 160); }
      catch { detail = text.slice(0, 160); }
    } catch {}
    if (upstream.status === 404) fail("找不到附件內容。", 404);
    fail(`附件讀取失敗（GitHub ${upstream.status}${detail ? "：" + detail : ""}）`, 502);
  }

  const name = path.split("/").pop() || "attachment";
  const headers = new Headers(cors);
  headers.set("content-type", upstream.headers.get("content-type") || mimeFromName(name));
  headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set("cache-control", "private, no-store");

  const len = upstream.headers.get("content-length");
  if (len) headers.set("content-length", len);
  const etag = upstream.headers.get("etag");
  if (etag) headers.set("etag", etag);

  return new Response(upstream.body, {
    status: 200,
    headers
  });
}
