<div align="center">

# 🔁 GlassLoop

### A closed agent loop you can *verify* — not just trust.

An AI agent that drafts, grades itself against a rubric, and revises — running inside an
**EigenCompute TEE** that cryptographically **signs every result**, so anyone can prove
what the loop actually did while no one was watching.

**[Live demo →](https://glassloop-chi.vercel.app)** ·
**[On-chain attestation →](https://verify-sepolia.eigencloud.xyz/app/0x93F0FF4EF5f52294f741fB4CB37D86928218cCb4)** ·
**[Docker image →](https://hub.docker.com/r/zeeshan8281/closed-loop-agent)**

</div>

---

## Why this exists

The agent-looping discourse ("stop prompting agents — design loops that prompt them")
all gets stuck on the same wall:

> *A loop running unattended is also a loop making mistakes unattended.
> "Done" is a claim, not a proof.*

Everyone answers with better evals. But an eval gate the operator can quietly edit is
still a promise. GlassLoop moves the gate into hardware:

1. **The whole loop runs inside a TEE** (EigenCompute / AMD SEV-SNP) — the cloud operator
   can't read its memory or alter a verdict mid-run.
2. **The image digest is registered on-chain** — you know exactly which code is running.
3. **Every result is Ed25519-signed inside the enclave**, with a key the KMS only releases
   to that attested image — and the web page **verifies the signature in your browser**.

The loop doesn't just say it passed its gate. It proves which code reached that conclusion.

## The three modes

Type any goal into the box on the site, pick a mode, press start. Nothing runs until you do.

| Mode | Shape | Who decides the steps |
|---|---|---|
| **Single loop** | draft → judge → critique feeds back → revise, until the gate clears | nobody — one fixed frame |
| **Fixed pipeline** | Outline → Draft → Polish; each stage is its own loop with its own gate | a human (`stages.json`) |
| **Agentic loop** | an orchestrator reads the goal + work so far, plans the next step *and how to grade it*, runs it, judges it, plans again | **the agent** — the plan emerges at runtime |

In every mode you watch it live: the worker's draft **streams token-by-token**, the judge's
score and critique land as they happen, and the diagram tracks which agent is thinking.

## The maker/checker split

```
              ┌──────────────────────── critique → revise ───────────────────────┐
              ▼                                                                   │
        ┌──────────┐         draft          ┌──────────────┐    fail (< 0.85)    │
        │  Worker  │ ─────────────────────▶ │    Judge     │ ────────────────────┘
        │ sonnet   │                        │  opus (eval  │
        └──────────┘                        │    gate)     │ ── pass ──▶ hands back ✓
                                            └──────────────┘
```

The judge is a deliberately **stronger model than the worker** (Opus judging Sonnet, via
OpenRouter). A loop that grades its own homework with the same model produces confident
slop — the gate is where taste lives, so the strong model is spent there. The verdict is a
**forced tool call** (`{score, passed, critique, suggestions}`), machine-checkable by
construction, and the critique becomes the next round's prompt. That feedback is what makes
it a loop rather than a retry.

## It provably halts

The production fear with unattended loops is the one that never stops. GlassLoop enforces
the three standard hard stops **inside the attested enclave**, so the halt conditions are
themselves part of the verified code:

| Stop | Default |
|---|---|
| Round / step cap | 6 rounds (single) · 4/stage (pipeline) · 10 steps (agentic) |
| No-progress detector | halt after 2 rounds without score improvement |
| Spend ceiling | $1.00–1.50 per run (real token counts, estimated prices) |

Every result records its `stop_reason`, per-round token usage, and cost — and the UI shows
a live budget meter while it runs.

## Architecture

```
  browser ──── glassloop-chi.vercel.app
                 │  static page + two tiny proxy functions (/api/loop, /api/progress)
                 │  server-side fetch → no mixed-content, IP never exposed to the page
                 ▼
  EigenCompute TEE  (app 0x93F0…cCb4 · server.ts, idle until POST /run)
                 │  loop.ts: single | stages | agentic
                 │  models via OpenRouter (worker claude-sonnet-4.6, judge claude-opus-4.8)
                 ▼
  result + Ed25519 signature over the exact JSON bytes
                 │  signing seed sealed by EigenCompute KMS — only the attested image gets it
                 ▼
  browser verifies signature against a pinned pubkey (Web Crypto) → ✓ / ✗ badge
```

## Run it locally

```bash
npm install
cp .env.example .env        # add your OPENROUTER_API_KEY
npm run serve               # http://localhost:8080 — idle until you start a run
```

```bash
# start a run (any mode, optional custom goal)
curl -X POST 'localhost:8080/run?mode=agentic' \
  -H 'content-type: application/json' \
  -d '{"goal":"Write a crisp explainer on why verifiable AI agents matter."}'

curl localhost:8080/progress   # live: phase, streaming draft, rounds, cost, signature when done
```

### API

| Endpoint | Does |
|---|---|
| `POST /run?mode=single\|stages\|agentic` | start a run; JSON body `{"goal": "..."}` optional |
| `GET /progress` | real-time state: current step/phase, streaming worker draft, scored rounds, live cost, `signed` + `signature` when done |
| `GET /result` | the final signed result |
| `GET /pubkey` | the enclave's Ed25519 verifying key |
| `GET /healthz` | liveness |

## Deploy your own

```bash
# 1. backend → EigenCompute (image must be linux/amd64 on a public registry)
docker build --platform linux/amd64 -t <you>/closed-loop-agent:v1 .
docker push <you>/closed-loop-agent:v1
ecloud compute app deploy --name glassloop --image-ref <you>/closed-loop-agent:v1 \
  --env-file deploy.env --instance-type g1-medium-1v --skip-profile --force
# deploy.env: OPENROUTER_API_KEY + SIGNING_SEED (+ overrides) — sealed by KMS,
# decryptable only inside the attested enclave, never baked into the image

# 2. frontend → Vercel (set TEE_BACKEND in glassloop/vercel.json to your enclave)
cd glassloop && vercel deploy --prod
# then pin your enclave's /pubkey value as PINNED_PUBKEY in index.html
```

## Honest limitations

This is a demo of the trust mechanism, not a production custody system:

- The enclave port is unauthenticated and single-tenant (one run at a time, anyone who
  finds it can start runs). A real deployment needs auth, rate limits, and a global spend cap.
- Costs are estimates (hardcoded per-token prices); token counts are exact.
- Signed results carry no nonce/timestamp yet, so a stale result replays as valid.
- The image is a dev build — runtime attestation is real; a reproducible source→image
  verifiable build is the next step.
- The live transcript is unverified while streaming; only the final result is signed.

## Config

Everything tunes via env (see `.env.example`): models (`WORKER_MODEL`, `JUDGE_MODEL`,
`ORCH_MODEL`), gate strictness (`PASS_THRESHOLD`), and all three hard stops
(`MAX_ROUNDS`, `STAGE_MAX_ROUNDS`, `AGENTIC_MAX_STEPS`, `NO_PROGRESS_PATIENCE`, `MAX_USD`).
Default goals live in `config.json` (single/agentic) and `stages.json` (pipeline) — point
them at anything.

---

<div align="center">

**The eval gate isn't a product gap. It's a trust gap. A TEE closes it.**

*built on [EigenCompute](https://docs.eigencloud.xyz/eigencompute/get-started/eigencompute-overview) · models via OpenRouter · frontend on Vercel*

</div>
