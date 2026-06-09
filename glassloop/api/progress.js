// Server-side proxy to the enclave's real-time progress endpoint.
// Relays the live loop state (current round, drafting/judging phase, and every
// round scored so far) so the frontend animation tracks the actual TEE run.

const BACKEND = process.env.TEE_BACKEND || "http://34.70.216.22:8080";

export default async function handler(req, res) {
  try {
    const r = await fetch(`${BACKEND}/progress`, { signal: AbortSignal.timeout(25000) });
    const text = await r.text();
    res.setHeader("cache-control", "no-store");
    res.status(r.status);
    res.setHeader("content-type", "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: `enclave unreachable: ${e?.message ?? e}` });
  }
}
