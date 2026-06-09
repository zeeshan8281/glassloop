// Server-side proxy to the closed-loop agent in the EigenCompute TEE.
// GET  → /result (final);  POST → /run?mode=single|stages|agentic (start a run).
// The fetch runs server-side so the browser never touches the raw http:// IP.

const BACKEND = process.env.TEE_BACKEND || "http://34.70.216.22:8080";
const MODES = ["single", "stages", "agentic"];

export default async function handler(req, res) {
  const isPost = req.method === "POST";
  const q = req.query && req.query.mode;
  const mode = MODES.includes(q) ? q : "single";
  const path = isPost ? `/run?mode=${mode}` : "/result";
  const init = { method: isPost ? "POST" : "GET", signal: AbortSignal.timeout(25000) };
  if (isPost && req.body) {
    // forward the typed goal (Vercel parses JSON bodies into req.body)
    init.headers = { "content-type": "application/json" };
    init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  try {
    const r = await fetch(`${BACKEND}${path}`, init);
    const text = await r.text();
    res.setHeader("cache-control", "no-store");
    res.status(r.status);
    res.setHeader("content-type", "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: `enclave unreachable: ${e?.message ?? e}` });
  }
}
