# HANDOFF — GlassLoop (closed-loop agent on EigenCompute)

> Read this first, then `loop.ts`, `server.ts`, `glassloop/index.html`, and
> `README.md`. Everything here is true as of 2026-06-09.

## What this is

**GlassLoop** — a verifiable closed agent loop, live end-to-end:

- **Frontend:** https://glassloop-chi.vercel.app (Vercel project `glassloop`,
  team `team_d2iNytjMuKmgbHLvTAewMSR4`, EigenCloud-branded, ABC Repro + Geist)
- **Backend:** EigenCompute TEE app `0x93F0FF4EF5f52294f741fB4CB37D86928218cCb4`,
  IP `34.70.216.22:8080` (plain HTTP, serves the EXPOSE'd port directly),
  image `docker.io/zeeshan8281/closed-loop-agent:v16-layered`
- **Attestation:** https://verify-sepolia.eigencloud.xyz/app/0x93F0FF4EF5f52294f741fB4CB37D86928218cCb4

## Architecture

```
browser ── glassloop-chi.vercel.app (static + /api/loop, /api/progress proxies)
                │ server-side fetch (solves mixed-content; browser never sees the IP)
                ▼
        enclave 34.70.216.22:8080  (server.ts — idle until POST /run)
                │ runs loop.ts: single | stages | agentic
                ▼ models via OpenRouter (worker sonnet-4.6, judge/orch opus-4.8)
        result signed (Ed25519, seed sealed by KMS) → browser verifies vs pinned pubkey
```

Three modes (tabs): **single** (one loop), **stages** (human-defined
Outline→Draft→Polish pipeline), **agentic** (orchestrator plans its own steps —
the only mode where the agent decides the plan). A "your goal" box feeds any
mode a custom goal (`POST /run` body `{"goal": "..."}`); blank = default
`config.json` / `stages.json`.

## Key design decisions (don't undo without reason)

- **Judge ≠ worker; judge is the stronger model.** The gate is the moat.
- **Three hard stops, enforced in-enclave:** round/step caps, no-progress
  detector (2 stale rounds), `MAX_USD` ceiling ($1.50). Currently
  `AGENTIC_MAX_STEPS=10`.
- **Sign the exact shipped JSON bytes** (`signed` field) — do NOT re-serialize
  on either side; a canonicalization mismatch broke verification once already.
- **Agentic steps are attempts, not gates** — keep/build on the best-scoring
  draft (`best_step` in result); never gate the artifact on PASS_THRESHOLD or
  you ship an empty result.
- **Judge prompt fences the artifact** (`===ARTIFACT START/END===`) — without
  it the judge hallucinated its own trailing instruction as a flaw in every draft.
- **`chatTool` retries malformed tool-call JSON** (3x) — models occasionally
  emit broken JSON; without retry the whole run dies.

## Secrets & deploys

- `deploy.env` (gitignored) holds `OPENROUTER_API_KEY`, `SIGNING_SEED`,
  `ANTHROPIC_API_KEY` (legacy/unused), `WORKER_MODEL`, `JUDGE_MODEL`,
  `AGENTIC_MAX_STEPS`, `MAX_USD` — sealed by EigenCompute KMS at deploy.
- **Backend deploy:** build/push `--platform linux/amd64` to Docker Hub
  (public — ecloud's layering can't read the macOS keychain, so private GHCR
  fails), then `ecloud compute app upgrade ... --image-ref ... --env-file
  deploy.env --force`. Keep `Dockerfile` mv'd to `Dockerfile.keep` during
  deploy or the CLI prompts. Changing only env? Re-upgrade same image.
- **Frontend deploy:** `bash glassloop/apideploy.sh` — uses Vercel REST API
  pinned to `216.198.79.131` because the CLI's default-resolved IPs are blocked
  in the Claude Code sandbox (deploys silently hang otherwise). From a normal
  shell, plain `vercel deploy --prod` works too.
- **If the signing seed ever changes, update `PINNED_PUBKEY` in
  `glassloop/index.html`** (fetch the new one from `/pubkey`).

## State / gotchas

- Anthropic key is funded again but **the enclave runs on OpenRouter**; switch
  back by flipping the client in `loop.ts` if ever desired.
- Single global run state — one run at a time (409 otherwise); no multi-tenancy,
  no auth on the enclave port. Fine for a demo, a known gap beyond it.
- $ costs are **estimates** (hardcoded per-token prices in `loop.ts`).
- Enclave build is a **dev image, not a verifiable build** — runtime
  attestation is real, source↔image proof is not (repo is private).
