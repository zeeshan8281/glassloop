#!/usr/bin/env node
/**
 * HTTP wrapper around the closed-loop agent, for running inside an
 * EigenCompute TEE.
 *
 * EigenCompute expects a long-lived process bound to 0.0.0.0:<PORT>. This
 * server holds the loop and runs it ON DEMAND (it does NOT auto-run on boot):
 * a client POSTs /run?mode=single|stages to start it, then polls /progress to
 * watch the real run unfold. The verdict + per-round trail it serves are
 * attestable to the exact image that ran inside the enclave.
 *
 * Two modes:
 *   single  one closed loop: draft → judge → revise, until the gate passes.
 *   stages  a pipeline of closed loops (Angle → Draft → Polish), each with its
 *           own gate; every stage loops internally before handing off.
 *
 * Endpoints:
 *   GET  /healthz   liveness ({ ok: true })
 *   GET  /progress  real-time state: mode, current stage/round/phase, the
 *                   per-stage rounds scored so far, and the result when done
 *   POST /run?mode= start a run (409 if one is already in progress)
 *   GET  /result    the final result.json, or 202 while running / 409 if idle
 *   GET  /          short human-readable status
 */

import { createServer } from "node:http";
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import {
  loadFrame,
  loadStages,
  run,
  runStages,
  runAgentic,
  LIMITS,
  type Round,
  type StageResult,
} from "./loop.ts";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const CONFIG = process.env.CONFIG ?? "config.json";
const STAGES = process.env.STAGES ?? "stages.json";

// When the user types their own goal, we judge against this generic rubric
// (single/agentic) or build a generic Outline→Draft→Polish pipeline (stages).
const GENERIC_RUBRIC =
  "PASS if the artifact fully and correctly satisfies the goal, is clear and well-crafted, " +
  "has a strong opening and a clean ending, and contains no obvious errors, padding, or filler. " +
  "Judge on substance and craft. FAIL only if it misses the goal, is vague, bloated, or sloppy.";
function genericStages(goal: string) {
  return [
    { name: "Outline", goal: `Produce a tight outline / plan for this task — not the full answer yet:\n\n${goal}`, rubric: "PASS if the outline is lean, covers what the task needs, and is a plan rather than a finished answer. FAIL if vague or already a full draft." },
    { name: "Draft", goal: `Write the full piece from the outline, fully addressing this task:\n\n${goal}`, rubric: GENERIC_RUBRIC },
    { name: "Polish", goal: `Tighten and sharpen the draft — fix weak spots and cut filler without losing substance — for this task:\n\n${goal}`, rubric: GENERIC_RUBRIC },
  ];
}

// --- result signing -----------------------------------------------------------
// The signing key is derived from SIGNING_SEED, a secret EigenCompute's KMS only
// releases to the attested image. So a valid signature over a result proves it
// came from the verified code in the enclave — not from a proxy or a swapped
// server. The public key is pinned in the frontend, which verifies every result.
const SEED_SRC = process.env.SIGNING_SEED || process.env.ANTHROPIC_API_KEY || "glassloop-dev-seed";
const SEED = createHash("sha256").update("glassloop-sign-v1:" + SEED_SRC).digest();
const SIGN_PRIV = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), SEED]),
  format: "der", type: "pkcs8",
});
const PUBKEY_B64 = createPublicKey(SIGN_PRIV).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

// Sign the EXACT JSON bytes we will ship, and ship that same string. No
// re-serialization on either side → no canonicalization drift (e.g. dropped
// undefined props or number-format edge cases breaking verification).
function signResult(result: unknown): { payload: string; signature: string } {
  const payload = JSON.stringify(result);
  return { payload, signature: edSign(null, Buffer.from(payload, "utf8"), SIGN_PRIV).toString("base64") };
}

type Phase = "idle" | "planning" | "drafting" | "judging";

// One stage's live view. Single mode is modelled as a pipeline of exactly one
// stage, so the frontend can render both modes with the same shape.
interface StageView {
  name: string;
  goal: string;
  rounds: Round[];
  done: boolean;
  cleared: boolean;
  best_score: number | null;
  thought?: string;          // agentic mode: the orchestrator's reasoning for this step
  success_criteria?: string; // agentic mode: how this step is judged
}

// The worker's draft as it streams, for the in-flight round — this is what lets
// the UI show each agent's live "thought process", not just a status label.
interface Partial { stageIndex: number; round: number; text: string; }

interface Live {
  mode: "single" | "stages" | "agentic" | null;
  status: "idle" | "running" | "done" | "error";
  startedAt: number | null;
  phase: Phase;
  stageIndex: number;
  round: number;
  maxRounds: number;
  stages: StageView[];
  partial: Partial | null;
  result: unknown | null;
  signature: string | null; // Ed25519 signature over the result, set when done
  signedPayload: string | null; // the exact signed JSON bytes (verified as-is by the browser)
  error: string | null;
}

let live: Live = {
  mode: null, status: "idle", startedAt: null, phase: "idle",
  stageIndex: 0, round: 0, maxRounds: 0, stages: [], partial: null, result: null, signature: null, signedPayload: null, error: null,
};

function startSingle(customGoal?: string | null): void {
  const frame = customGoal ? { goal: customGoal, rubric: GENERIC_RUBRIC } : loadFrame(CONFIG);
  live = {
    mode: "single", status: "running", startedAt: Date.now(), phase: "drafting",
    stageIndex: 0, round: 0, maxRounds: 0,
    stages: [{ name: "Closed loop", goal: frame.goal, rounds: [], done: false, cleared: false, best_score: null }],
    partial: null, result: null, signature: null, signedPayload: null, error: null,
  };
  run(frame, {
    onPhase: (n, phase, maxRounds) => { live.round = n; live.phase = phase; live.maxRounds = maxRounds; },
    onRound: (r) => { live.stages[0].rounds = [...live.stages[0].rounds, r]; live.partial = null; },
    onPartial: (n, text) => { live.partial = { stageIndex: 0, round: n, text }; },
  })
    .then((res) => {
      live.phase = "idle"; live.status = "done"; live.result = res; { const _s = signResult(res); live.signature = _s.signature; live.signedPayload = _s.payload; }
      live.stages[0].done = true; live.stages[0].cleared = res.cleared_gate; live.stages[0].best_score = res.best_score;
    })
    .catch((err: unknown) => fail(err));
}

function startStages(customGoal?: string | null): void {
  const frames = customGoal ? genericStages(customGoal) : loadStages(STAGES);
  live = {
    mode: "stages", status: "running", startedAt: Date.now(), phase: "drafting",
    stageIndex: 0, round: 0, maxRounds: 0,
    stages: frames.map((s) => ({ name: s.name, goal: s.goal, rounds: [], done: false, cleared: false, best_score: null })),
    partial: null, result: null, signature: null, signedPayload: null, error: null,
  };
  runStages(frames, {
    onStageStart: (i) => { live.stageIndex = i; live.round = 0; live.partial = null; },
    onPhase: (i, n, phase, maxRounds) => { live.stageIndex = i; live.round = n; live.phase = phase; live.maxRounds = maxRounds; },
    onRound: (i, r) => { live.stages[i].rounds = [...live.stages[i].rounds, r]; live.partial = null; },
    onStageDone: (i, sum: StageResult) => { live.stages[i].done = true; live.stages[i].cleared = sum.cleared; live.stages[i].best_score = sum.best_score; },
    onPartial: (i, n, text) => { live.partial = { stageIndex: i, round: n, text }; },
  })
    .then((res) => { live.phase = "idle"; live.status = "done"; live.result = res; { const _s = signResult(res); live.signature = _s.signature; live.signedPayload = _s.payload; } })
    .catch((err: unknown) => fail(err));
}

// Agentic mode: the orchestrator plans its own steps, so the stage list grows at
// runtime as each step is decided — nothing is pre-seeded.
function startAgentic(customGoal?: string | null): void {
  const goal = customGoal || loadFrame(CONFIG).goal;
  live = {
    mode: "agentic", status: "running", startedAt: Date.now(), phase: "drafting",
    stageIndex: 0, round: 1, maxRounds: 0, stages: [], partial: null, result: null, signature: null, signedPayload: null, error: null,
  };
  runAgentic(goal, {
    onPlan: (i, plan) => {
      live.stageIndex = i; live.partial = null;
      if (!plan.done) live.stages = [...live.stages, {
        name: plan.step_name, goal: plan.instruction,
        success_criteria: plan.success_criteria, thought: plan.thought,
        rounds: [], done: false, cleared: false, best_score: null,
      }];
    },
    onPhase: (i, phase) => { live.stageIndex = i; live.phase = phase === "judging" ? "judging" : phase === "planning" ? "planning" : "drafting"; },
    onPartial: (i, text) => { live.partial = { stageIndex: i, round: 1, text }; },
    onStepDone: (i, step) => {
      if (live.stages[i]) { live.stages[i].rounds = step.rounds; live.stages[i].done = true; live.stages[i].cleared = step.cleared; live.stages[i].best_score = step.best_score; }
      live.partial = null;
    },
  })
    .then((res) => { live.phase = "idle"; live.status = "done"; live.result = res; { const _s = signResult(res); live.signature = _s.signature; live.signedPayload = _s.payload; } })
    .catch((err: unknown) => fail(err));
}

function fail(err: unknown): void {
  const error = err instanceof Error ? err.message : String(err);
  console.error(`✗ loop failed: ${error}`);
  live.phase = "idle"; live.status = "error"; live.error = error;
}

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

const server = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  const path = u.pathname;

  if (path === "/healthz") { json(res, 200, { ok: true }); return; }

  if (path === "/progress") {
    // running token/cost totals, summed from the rounds scored so far
    let inTok = 0, outTok = 0, cost = 0;
    for (const s of live.stages) for (const r of s.rounds) {
      inTok += r.tokens.input; outTok += r.tokens.output; cost += r.cost_usd;
    }
    json(res, 200, {
      mode: live.mode, status: live.status, startedAt: live.startedAt,
      phase: live.phase, stageIndex: live.stageIndex, round: live.round, maxRounds: live.maxRounds,
      stages: live.stages, partial: live.partial, result: live.result, error: live.error,
      signature: live.signature, signed: live.signedPayload, pubkey: PUBKEY_B64,
      tokens: { input: inTok, output: outTok }, cost_usd: cost,
      limits: { maxUsd: LIMITS.maxUsd, maxRounds: LIMITS.maxRounds, stageMaxRounds: LIMITS.stageMaxRounds, noProgressPatience: LIMITS.noProgressPatience },
    });
    return;
  }

  if (path === "/pubkey") { json(res, 200, { pubkey: PUBKEY_B64, alg: "Ed25519" }); return; }

  if (path === "/run" && req.method === "POST") {
    if (live.status === "running") { json(res, 409, { error: "a run is already in progress" }); return; }
    const q = u.searchParams.get("mode");
    const mode = q === "stages" ? "stages" : q === "agentic" ? "agentic" : "single";
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 8000) req.destroy(); }); // cap a typed goal at ~8KB
    req.on("end", () => {
      let goal: string | null = null;
      try { const g = JSON.parse(body || "{}").goal; if (typeof g === "string" && g.trim()) goal = g.trim(); } catch { /* no/invalid body → default goal */ }
      try {
        if (mode === "agentic") startAgentic(goal);
        else if (mode === "stages") startStages(goal);
        else startSingle(goal);
      } catch (err) { fail(err); json(res, 500, { error: live.error }); return; }
      json(res, 202, { status: "started", mode, custom: !!goal });
    });
    return;
  }

  if (path === "/result") {
    if (live.status === "done") json(res, 200, live.result);
    else if (live.status === "error") json(res, 500, { error: live.error });
    else if (live.status === "running") json(res, 202, { status: "running" });
    else json(res, 409, { status: "idle", hint: "POST /run?mode=single|stages to start" });
    return;
  }

  if (path === "/") {
    json(res, 200, { service: "closed-loop-agent", mode: live.mode, status: live.status });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`closed-loop-agent listening on 0.0.0.0:${PORT} — idle, POST /run to start`);
});
