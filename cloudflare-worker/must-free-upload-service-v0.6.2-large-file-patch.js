// v0.6.2 replacement for downloadPrivate() in must-free-upload-service v0.6.1
// Fix: GitHub Contents API may omit `content` for larger files. Fallback to Git Blob API.
// Security is unchanged: caller has already passed Firebase authentication + budget allowlist authorization.

async function downloadPrivate(url, id, env, cors) {
  const system = safe(url.searchParams.get("system") || "");
  if (system !== "budget") fail("此下載端點僅供經費私密附件使用。", 403);
  const path = String(url.searchParams.get("path") || "").replace(/^\/+/, "");
  if (!path.startsWith("uploads/budget/")) fail("無效的經費附件路徑。", 403);

  const cfg = repoConfig("budget", id, env);
  const d = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`);

  let encoded = String(d?.content || "").replace(/\s+/g, "");
  let size = Number(d?.size || 0);

  // GitHub Contents API does not include inline base64 content for some larger files.
  // In that case, fetch the same object through the Git Blob API using its SHA.
  if (!encoded && d?.sha) {
    const blob = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/blobs/${encodeURIComponent(d.sha)}`);
    encoded = String(blob?.content || "").replace(/\s+/g, "");
    size = Number(blob?.size || size || 0);
  }

  if (!encoded) fail("找不到附件內容或附件過大無法讀取。", 404);

  const bytes = base64ToBytes(encoded);
  const name = d?.name || path.split("/").pop() || "attachment";
  const type = mimeFromName(name);
  const headers = new Headers(cors);
  headers.set("content-type", type);
  headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set("cache-control", "private, no-store");
  if (size > 0) headers.set("content-length", String(size));
  return new Response(bytes, { status: 200, headers });
}
