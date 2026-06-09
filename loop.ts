#!/usr/bin/env node
/**
 * Closed-loop agent.
 *
 * A human defines the *frame* (goal, rubric, max rounds). The agent then runs
 * itself in a loop: draft -> evaluate against the rubric -> if it fails the gate,
 * feed the critique back and revise -> repeat, until the eval gate passes or the
 * round budget is spent.
 *
 * This is the "closed loop" from the agent-looping playbook:
 *   > clear goal
 *   > defined steps
 *   > an eval at each step
 *   > a point where it stops or hands back (and feeds back performance data)
 *
 * Why run it in a TEE (EigenCompute)?
 *   An unattended loop's weak spot is trust: "how do I know it didn't quietly
 *   produce garbage, or tamper with its own eval?" Running the whole loop inside
 *   an Intel TDX enclave makes the exact image attestable and the run an
 *   immutable audit trail. The loop doesn't just claim it passed its gate — it
 *   can prove which code reached that conclusion.
 *
 * The worker model drafts. A *separate, stronger* model is the judge, because the
 * eval gate is the moat — that is where taste lives, so we spend the strong model
 * there, not on the drafting.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";

const WORKER_MODEL = process.env.WORKER_MODEL ?? "anthropic/claude-sonnet-4.6";
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "anthropic/claude-opus-4.8";
const MAX_ROUNDS = parseInt(process.env.MAX_ROUNDS ?? "6", 10);
const STAGE_MAX_ROUNDS = parseInt(process.env.STAGE_MAX_ROUNDS ?? "4", 10);
const PASS_THRESHOLD = parseFloat(process.env.PASS_THRESHOLD ?? "0.85");

// Hard stops — the three every production loop write-up converges on. A max
// round count alone isn't enough: a loop also has to stop when it stops
// improving, and when it would blow a spend ceiling. Enforced inside the
// enclave, so the halt conditions are themselves attestable.
const NO_PROGRESS_PATIENCE = parseInt(process.env.NO_PROGRESS_PATIENCE ?? "2", 10); // give up after K non-improving rounds
const SCORE_EPSILON = parseFloat(process.env.SCORE_EPSILON ?? "0.01"); // what counts as "improvement"
const MAX_USD = parseFloat(process.env.MAX_USD ?? "1.00"); // per-run spend ceiling (estimate)

// Estimated $ per 1M tokens, per model (override via env). Used only to enforce
// and report the budget ceiling — it's an estimate, labelled as such.
const PRICE = {
  worker: { in: parseFloat(process.env.WORKER_PRICE_IN ?? "3"), out: parseFloat(process.env.WORKER_PRICE_OUT ?? "15") },
  judge: { in: parseFloat(process.env.JUDGE_PRICE_IN ?? "15"), out: parseFloat(process.env.JUDGE_PRICE_OUT ?? "75") },
};

export const LIMITS = {
  maxRounds: MAX_ROUNDS,
  stageMaxRounds: STAGE_MAX_ROUNDS,
  passThreshold: PASS_THRESHOLD,
  noProgressPatience: NO_PROGRESS_PATIENCE,
  maxUsd: MAX_USD,
};

// Routed through OpenRouter (OpenAI-compatible). Override base URL / key / models via env.
const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
  defaultHeaders: { "HTTP-Referer": "https://glassloop-chi.vercel.app", "X-Title": "GlassLoop" },
});

interface Usage { input: number; output: number; }

interface ToolDef { name: string; description: string; input_schema: Record<string, unknown>; }

// Streaming chat → returns the full text and token usage. onToken sees the text
// as it streams (the worker's visible "thought process").
async function chat(
  model: string, system: string, user: string, maxTokens: number,
  onToken?: (full: string) => void,
): Promise<{ text: string; usage: Usage }> {
  const stream = await client.chat.completions.create({
    model, max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    stream: true, stream_options: { include_usage: true },
  });
  let text = "";
  let usage: Usage = { input: 0, output: 0 };
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta?.content;
    if (d) { text += d; onToken?.(text); }
    if (chunk.usage) usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
  }
  return { text: text.trim(), usage };
}

// Forced single-tool call → returns the parsed arguments and usage. This is how
// the judge and the orchestrator emit machine-checkable structured output.
async function chatTool<T>(
  model: string, system: string, user: string, tool: ToolDef, maxTokens: number,
): Promise<{ args: T; usage: Usage }> {
  let lastErr: unknown;
  // Models occasionally emit malformed JSON in a tool call (e.g. an unescaped
  // quote in a free-text field). Retry a few times rather than crash the run.
  for (let attempt = 0; attempt < 3; attempt++) {
    const msg = await client.chat.completions.create({
      model, max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }],
      tool_choice: { type: "function", function: { name: tool.name } },
    });
    const call = msg.choices?.[0]?.message?.tool_calls?.[0];
    const usage: Usage = { input: msg.usage?.prompt_tokens ?? 0, output: msg.usage?.completion_tokens ?? 0 };
    if (call && call.type === "function") {
      try { return { args: JSON.parse(call.function.arguments || "{}") as T, usage }; }
      catch (e) { lastErr = e; } // malformed JSON — retry
    } else {
      lastErr = new Error("model did not return a tool call");
    }
  }
  throw lastErr ?? new Error("tool call failed after retries");
}
const costOf = (p: { in: number; out: number }, u: Usage): number =>
  (u.input / 1e6) * p.in + (u.output / 1e6) * p.out;

export type StopReason =
  | "gate_cleared"     // judge passed it
  | "max_rounds"       // ran out of round budget
  | "no_progress"      // score stopped improving
  | "budget_exceeded"  // hit the $ ceiling
  | "agent_done"       // orchestrator declared the goal met (agentic mode)
  | "max_steps";       // orchestrator hit its step budget (agentic mode)

const ORCH_MODEL = process.env.ORCH_MODEL ?? JUDGE_MODEL;
const AGENTIC_MAX_STEPS = parseInt(process.env.AGENTIC_MAX_STEPS ?? "4", 10);
// Demo-tunable floor: the orchestrator may not declare done before this many
// steps — it must keep finding genuine improvements (review, verify, tighten…).
const AGENTIC_MIN_STEPS = parseInt(process.env.AGENTIC_MIN_STEPS ?? "3", 10);

export interface Frame {
  goal: string;
  rubric: string;
}

export interface Round {
  n: number;
  draft: string;
  score: number;
  passed: boolean;
  critique: string;
  suggestions: string[];
  tokens: Usage;     // worker + judge tokens for this round
  cost_usd: number;  // estimated $ for this round
}

export interface Result {
  goal: string;
  cleared_gate: boolean;
  stop_reason: StopReason;
  rounds_run: number;
  best_score: number;
  best_round: number;
  final_artifact: string;
  tokens: Usage;
  cost_usd: number;
  trail: Round[];
}

// --- the frame: a human defines this, the agent loops inside it ---------------

export function loadFrame(path = "config.json"): Frame {
  const frame = JSON.parse(readFileSync(path, "utf-8"));
  for (const key of ["goal", "rubric"] as const) {
    if (!(key in frame)) {
      console.error(`config.json missing required field: ${key}`);
      process.exit(1);
    }
  }
  return frame;
}

// --- worker: drafts, then revises against critique ----------------------------

// In a multi-stage loop, each stage's worker is handed the previous stage's
// (already gate-cleared) output to build on.
interface StageContext {
  priorName: string;
  priorOutput: string;
}

async function draft(
  frame: Frame,
  prior: Round | null,
  stage?: StageContext,
  onToken?: (full: string) => void,
): Promise<{ text: string; usage: Usage }> {
  const system =
    "You are the worker in a closed-loop agent. Produce the best " +
    "possible artifact for the goal. You will be judged against an " +
    "explicit rubric and may be asked to revise. Output only the " +
    "artifact itself — no preamble, no commentary.";

  const stageBlock = stage
    ? `INPUT FROM THE PREVIOUS STAGE (${stage.priorName}) — already cleared its own gate, build directly on it:\n${stage.priorOutput}\n\n`
    : "";

  let user: string;
  if (prior === null) {
    user = `GOAL:\n${frame.goal}\n\nRUBRIC:\n${frame.rubric}\n\n${stageBlock}Produce the first draft.`;
  } else {
    const sug = prior.suggestions.map((s) => `- ${s}`).join("\n") || "(none)";
    user =
      `GOAL:\n${frame.goal}\n\nRUBRIC:\n${frame.rubric}\n\n${stageBlock}` +
      `Your previous draft scored ${prior.score.toFixed(2)} and did not clear ` +
      `the gate.\n\nJUDGE CRITIQUE:\n${prior.critique}\n\n` +
      `CONCRETE FIXES TO MAKE:\n${sug}\n\n` +
      `PREVIOUS DRAFT:\n${prior.draft}\n\n` +
      `Revise. Fix every issue above; keep what already worked.`;
  }

  // Stream the worker so the host can surface the draft as it's written.
  return chat(WORKER_MODEL, system, user, 4096, onToken);
}

// --- judge: the eval gate. structured verdict via a forced tool call ----------

const EVAL_TOOL: ToolDef = {
  name: "submit_evaluation",
  description:
    "Score the artifact against the rubric and decide if it clears the gate.",
  input_schema: {
    type: "object",
    properties: {
      score: {
        type: "number",
        description: "0.0–1.0, how well the artifact meets the rubric.",
      },
      passed: {
        type: "boolean",
        description:
          "True only if the artifact genuinely satisfies the goal and rubric.",
      },
      critique: {
        type: "string",
        description: "Concise, specific assessment of what is weak or missing.",
      },
      suggestions: {
        type: "array",
        items: { type: "string" },
        description: "Concrete, actionable fixes for the next revision.",
      },
    },
    required: ["score", "passed", "critique", "suggestions"],
  },
};

interface Verdict {
  score: number;
  passed: boolean;
  critique: string;
  suggestions: string[];
}

async function judge(
  frame: Frame,
  artifact: string,
): Promise<Verdict & { usage: Usage }> {
  const system =
    "You are the eval gate of a closed-loop agent — the moat. Judge " +
    "strictly and honestly against the rubric. Do not pass slop. A " +
    "draft only passes if it would satisfy a discerning human who " +
    "set this goal. Reward substance, not length.";
  // Fence the artifact so the judge can't mistake these surrounding instructions
  // for part of the text it's grading (that bug made it ding a phantom line).
  const user =
    `GOAL:\n${frame.goal}\n\nRUBRIC:\n${frame.rubric}\n\n` +
    `Score ONLY the text between the markers below — nothing outside them is part of the artifact:\n` +
    `===ARTIFACT START===\n${artifact}\n===ARTIFACT END===`;

  const { args, usage } = await chatTool<Verdict>(JUDGE_MODEL, system, user, EVAL_TOOL, 1024);
  return {
    score: Number(args.score),
    passed: Boolean(args.passed), // raw judge boolean; threshold applied in the loop
    critique: args.critique,
    suggestions: args.suggestions ?? [],
    usage,
  };
}

// --- the loop -----------------------------------------------------------------

// Live hooks so a host (e.g. the HTTP server) can stream the loop in real time:
// onPhase fires when a round enters drafting/judging; onRound fires once a round
// is scored. The verdicts emitted are the same ones written to the audit trail.
export interface RunHooks {
  onPhase?: (n: number, phase: "drafting" | "judging", maxRounds: number) => void;
  onRound?: (r: Round) => void;
  onPartial?: (n: number, text: string) => void; // worker draft so far, live
}

// Accumulator threaded through a loop (and across stages) to enforce the
// shared spend ceiling and report total tokens/cost.
interface Acc { input: number; output: number; cost: number; }

interface LoopCallbacks {
  onPhase?: (n: number, phase: "drafting" | "judging") => void;
  onPartial?: (n: number, text: string) => void;
  onRound?: (r: Round) => void;
}

// The atomic closed loop: draft → judge → revise, until one of the three hard
// stops fires (gate cleared / no progress / budget) or the round budget runs out.
async function loopToGate(
  frame: Frame,
  maxRounds: number,
  ctx: StageContext | undefined,
  acc: Acc,
  cb: LoopCallbacks,
): Promise<{ rounds: Round[]; stop: StopReason }> {
  const history: Round[] = [];
  let prior: Round | null = null;
  let bestScore = -1;
  let stale = 0;
  let stop: StopReason = "max_rounds";

  for (let n = 1; n <= maxRounds; n++) {
    if (acc.cost >= MAX_USD) { stop = "budget_exceeded"; break; } // don't start a round we can't afford

    cb.onPhase?.(n, "drafting");
    const d = await draft(frame, prior, ctx, (t) => cb.onPartial?.(n, t));
    cb.onPhase?.(n, "judging");
    const v = await judge(frame, d.text);

    const tokens: Usage = { input: d.usage.input + v.usage.input, output: d.usage.output + v.usage.output };
    const cost = costOf(PRICE.worker, d.usage) + costOf(PRICE.judge, v.usage);
    acc.input += tokens.input; acc.output += tokens.output; acc.cost += cost;

    const passed = v.passed && v.score >= PASS_THRESHOLD;
    const r: Round = { n, draft: d.text, score: v.score, passed, critique: v.critique, suggestions: v.suggestions, tokens, cost_usd: cost };
    history.push(r);
    cb.onRound?.(r);
    log(`  round ${n}: score=${v.score.toFixed(2)} passed=${passed} cost=$${cost.toFixed(4)} (run total $${acc.cost.toFixed(4)})`);

    if (passed) { stop = "gate_cleared"; break; }

    // no-progress: stop if the score hasn't meaningfully improved for K rounds
    if (v.score > bestScore + SCORE_EPSILON) { bestScore = v.score; stale = 0; }
    else if (++stale >= NO_PROGRESS_PATIENCE) { stop = "no_progress"; break; }

    prior = r;
  }
  return { rounds: history, stop };
}

export async function run(frame: Frame, hooks: RunHooks = {}): Promise<Result> {
  log("=".repeat(64));
  log(`GOAL: ${frame.goal}`);
  log(`gate: pass AND score>=${PASS_THRESHOLD} | stops: ${MAX_ROUNDS} rounds · ${NO_PROGRESS_PATIENCE} stale · $${MAX_USD}`);
  log("=".repeat(64));

  const acc: Acc = { input: 0, output: 0, cost: 0 };
  const { rounds, stop } = await loopToGate(frame, MAX_ROUNDS, undefined, acc, {
    onPhase: (n, phase) => hooks.onPhase?.(n, phase, MAX_ROUNDS),
    onPartial: (n, t) => hooks.onPartial?.(n, t),
    onRound: (r) => hooks.onRound?.(r),
  });

  const best = rounds.reduce((a, b) => (b.score > a.score ? b : a));
  const result: Result = {
    goal: frame.goal,
    cleared_gate: stop === "gate_cleared",
    stop_reason: stop,
    rounds_run: rounds.length,
    best_score: best.score,
    best_round: best.n,
    final_artifact: best.draft,
    tokens: { input: acc.input, output: acc.output },
    cost_usd: acc.cost,
    trail: rounds,
  };
  writeFileSync("result.json", JSON.stringify(result, null, 2));
  log(`\n⏹  stopped: ${stop} · ${rounds.length} round(s) · $${acc.cost.toFixed(4)}`);
  log("FINAL ARTIFACT:\n");
  console.log(best.draft);
  return result;
}

// --- multi-stage loop: a pipeline of closed loops, each with its own gate ------

export interface StageFrame {
  name: string;
  goal: string;
  rubric: string;
}

export interface StageResult {
  name: string;
  goal: string;
  cleared: boolean;
  stop_reason: StopReason;
  best_score: number;
  best_round: number;
  rounds: Round[];
  final: string;
  tokens: Usage;
  cost_usd: number;
}

export interface StagesResult {
  mode: "stages";
  stages: StageResult[];
  final_artifact: string;
  cleared_gate: boolean;
  stop_reason: "completed" | "budget_exceeded";
  total_rounds: number;
  tokens: Usage;
  cost_usd: number;
}

export interface StageHooks {
  onStageStart?: (i: number, name: string, total: number) => void;
  onPhase?: (i: number, n: number, phase: "drafting" | "judging", maxRounds: number) => void;
  onRound?: (i: number, r: Round) => void;
  onStageDone?: (i: number, summary: StageResult) => void;
  onPartial?: (i: number, n: number, text: string) => void; // worker draft so far, live
}

export function loadStages(path = "stages.json"): StageFrame[] {
  const data = JSON.parse(readFileSync(path, "utf-8"));
  const stages = data.stages;
  if (!Array.isArray(stages) || stages.length === 0) {
    console.error("stages.json must contain a non-empty 'stages' array");
    process.exit(1);
  }
  for (const s of stages) {
    if (!s.name || !s.goal || !s.rubric) {
      console.error("each stage needs name, goal and rubric");
      process.exit(1);
    }
  }
  return stages;
}

// Each stage runs its own draft→judge→revise loop until its gate passes (or the
// stage budget is spent), then hands its winning output to the next stage.
export async function runStages(
  stages: StageFrame[],
  hooks: StageHooks = {},
): Promise<StagesResult> {
  log("=".repeat(64));
  log(`MULTI-STAGE LOOP · ${stages.length} stages · ${STAGE_MAX_ROUNDS} rounds/stage`);
  log("=".repeat(64));

  const results: StageResult[] = [];
  const acc: Acc = { input: 0, output: 0, cost: 0 }; // budget is shared across the whole pipeline
  let priorOutput: string | null = null;
  let priorName: string | null = null;
  let totalRounds = 0;
  let pipelineStop: "completed" | "budget_exceeded" = "completed";

  for (let i = 0; i < stages.length; i++) {
    if (acc.cost >= MAX_USD) {
      pipelineStop = "budget_exceeded";
      log(`\n⏹  budget $${MAX_USD} reached before stage ${i + 1}; stopping pipeline.`);
      break;
    }
    const s = stages[i];
    const frame: Frame = { goal: s.goal, rubric: s.rubric };
    log(`\n=== stage ${i + 1}/${stages.length}: ${s.name} ===`);
    hooks.onStageStart?.(i, s.name, stages.length);

    const ctx =
      priorOutput !== null ? { priorName: priorName!, priorOutput } : undefined;

    const { rounds, stop } = await loopToGate(frame, STAGE_MAX_ROUNDS, ctx, acc, {
      onPhase: (n, phase) => hooks.onPhase?.(i, n, phase, STAGE_MAX_ROUNDS),
      onPartial: (n, t) => hooks.onPartial?.(i, n, t),
      onRound: (r) => hooks.onRound?.(i, r),
    });
    totalRounds += rounds.length;

    const best = rounds.reduce((a, b) => (b.score > a.score ? b : a));
    const sTokens: Usage = rounds.reduce(
      (u, r) => ({ input: u.input + r.tokens.input, output: u.output + r.tokens.output }),
      { input: 0, output: 0 },
    );
    const summary: StageResult = {
      name: s.name,
      goal: s.goal,
      cleared: stop === "gate_cleared",
      stop_reason: stop,
      best_score: best.score,
      best_round: best.n,
      rounds,
      final: best.draft,
      tokens: sTokens,
      cost_usd: rounds.reduce((c, r) => c + r.cost_usd, 0),
    };
    results.push(summary);
    hooks.onStageDone?.(i, summary);
    priorOutput = best.draft;
    priorName = s.name;

    if (stop === "budget_exceeded") { pipelineStop = "budget_exceeded"; break; }
  }

  const ranAll = results.length === stages.length;
  const result: StagesResult = {
    mode: "stages",
    stages: results,
    final_artifact: results.length ? results[results.length - 1].final : "",
    cleared_gate: ranAll && results.every((r) => r.cleared),
    stop_reason: pipelineStop,
    total_rounds: totalRounds,
    tokens: { input: acc.input, output: acc.output },
    cost_usd: acc.cost,
  };
  writeFileSync("result.json", JSON.stringify(result, null, 2));
  log(`\n⏹  pipeline ${pipelineStop} · ${totalRounds} rounds · $${acc.cost.toFixed(4)}`);
  return result;
}

// --- agentic loop: the AGENT plans its own steps (a real higher-order loop) ----
// Unlike the multi-stage pipeline (where a human pre-defines the stages), here an
// orchestrator model decides the next step at runtime: it looks at the goal and
// the work so far, picks the next action (with its own success test), runs it,
// then decides again — until it judges the goal met, or hits a hard stop. The
// plan is not predefined; it emerges. The maker/checker split still holds: a
// separate judge scores each step, and the orchestrator (not the worker) decides.

export interface AgenticStep {
  name: string;
  instruction: string;       // what the orchestrator told the worker to do
  success_criteria: string;  // how the orchestrator said to check it
  thought: string;           // the orchestrator's reasoning for this step
  cleared: boolean;
  best_score: number;
  best_round: number;
  rounds: Round[];
  final: string;
  tokens: Usage;
  cost_usd: number;
}

export interface AgenticResult {
  mode: "agentic";
  goal: string;
  steps: AgenticStep[];
  final_artifact: string;
  best_step: number; // index of the step whose draft became the final artifact
  cleared_gate: boolean;
  stop_reason: StopReason;
  total_rounds: number;
  tokens: Usage;
  cost_usd: number;
}

interface Plan {
  thought: string;
  done: boolean;
  step_name: string;
  instruction: string;
  success_criteria: string;
}

export interface AgenticHooks {
  onPlan?: (i: number, plan: Plan) => void;
  onPhase?: (i: number, phase: "planning" | "executing" | "judging") => void;
  onPartial?: (i: number, text: string) => void;
  onStepDone?: (i: number, step: AgenticStep) => void;
}

const PLAN_TOOL: ToolDef = {
  name: "plan_next_step",
  description: "Decide the single next step that best advances the goal, or declare the goal complete.",
  input_schema: {
    type: "object",
    properties: {
      thought: { type: "string", description: "Assess the current artifact against the goal: what's missing or weak." },
      done: { type: "boolean", description: "True only if the goal is genuinely, fully met by the current artifact." },
      step_name: { type: "string", description: "A short label for the next step (e.g. 'Outline', 'Draft', 'Tighten', 'Fact-check')." },
      instruction: { type: "string", description: "Precise instruction for the worker to carry out this step." },
      success_criteria: { type: "string", description: "How to judge whether this step succeeded — a crisp rubric." },
    },
    required: ["thought", "done", "step_name", "instruction", "success_criteria"],
  },
};

// the orchestrator: picks the next step (or stops). This is the decision-maker
// in the body of the loop — the thing that makes it agentic, not a fixed pipeline.
async function orchestrate(goal: string, artifact: string, history: AgenticStep[], mustContinue = false): Promise<Plan & { usage: Usage }> {
  const system =
    "You are the orchestrator of an autonomous closed-loop agent. YOU decide the plan — " +
    "the steps are not predefined. Work like a careful expert who does NOT ship the first draft. " +
    "Sequence it: (1) produce a first draft, then (2) CRITICALLY REVIEW it and improve a real weakness " +
    "(accuracy, structure, clarity, completeness, or tone), then (3) a final tightening/verification pass. " +
    "Aim for roughly 3 purposeful steps — each must genuinely improve the work, not pad. Do NOT one-shot it: " +
    "never set done=true on the very first draft unless it is already flawless. Only declare done once a " +
    "refined version genuinely nails the goal. Don't loop forever either — stop once it's truly excellent " +
    "(usually after a draft and a couple of improvement passes). Build on what exists; don't chase trivial " +
    "perfection like an exact word count.";
  const hist = history.length
    ? history.map((h, i) => `Step ${i + 1} (${h.name}): ${h.cleared ? "PASSED" : "FAILED"} @ ${h.best_score.toFixed(2)} — ${h.rounds[0]?.critique ?? ""}`).join("\n")
    : "(no steps yet)";
  const cont = mustContinue
    ? "\n\nIMPORTANT: the minimum step count has NOT been reached — you may NOT set done=true. Choose the single most valuable next improvement step (critical review, fact-check, strengthen a weak section, restructure, tighten, final verification)."
    : "";
  const user = `GOAL:\n${goal}\n\nCURRENT ARTIFACT:\n${artifact || "(nothing produced yet)"}\n\nSTEPS SO FAR:\n${hist}${cont}\n\nDecide the next step, or declare done.`;
  const { args, usage } = await chatTool<Plan>(ORCH_MODEL, system, user, PLAN_TOOL, 1500);
  return { ...args, usage };
}

// the worker carries out one orchestrator-chosen step against the running artifact
async function execute(goal: string, instruction: string, current: string, onToken?: (t: string) => void): Promise<{ text: string; usage: Usage }> {
  const system = "You are the worker in an autonomous agent loop. Carry out the instruction precisely to advance the goal. Output only the resulting artifact — no preamble, no commentary.";
  const user = `GOAL:\n${goal}\n\nCURRENT ARTIFACT:\n${current || "(nothing yet — start it)"}\n\nINSTRUCTION FOR THIS STEP:\n${instruction}\n\nProduce the updated artifact.`;
  return chat(WORKER_MODEL, system, user, 4096, onToken);
}

export async function runAgentic(goal: string, hooks: AgenticHooks = {}): Promise<AgenticResult> {
  log("=".repeat(64));
  log(`AGENTIC LOOP · the orchestrator plans its own steps · up to ${AGENTIC_MAX_STEPS}`);
  log("=".repeat(64));

  const steps: AgenticStep[] = [];
  const acc: Acc = { input: 0, output: 0, cost: 0 };
  // Each step is an attempt; we keep the BEST one produced and build on it. The
  // judge score is feedback for the orchestrator, not a hard accept/reject gate
  // (that gate belongs to the single loop). The orchestrator decides when done.
  let bestText = "";
  let bestScore = -1;
  let bestIndex = -1;
  let stop: StopReason = "max_steps";
  let total = 0;

  for (let i = 0; i < AGENTIC_MAX_STEPS; i++) {
    if (acc.cost >= MAX_USD) { stop = "budget_exceeded"; break; }

    hooks.onPhase?.(i, "planning");
    const mustContinue = steps.length < AGENTIC_MIN_STEPS && i < AGENTIC_MAX_STEPS - 1;
    let plan = await orchestrate(goal, bestText, steps, mustContinue); // orchestrator judges the best draft so far
    acc.input += plan.usage.input; acc.output += plan.usage.output;
    acc.cost += costOf(PRICE.judge, plan.usage); // orchestrator runs the strong model
    if (plan.done && mustContinue) {
      // backstop: the floor says keep going — convert the early "done" into a real improvement pass
      plan = {
        ...plan, done: false, step_name: "Critical review & improve",
        instruction: "Critically review the current artifact against the goal. Identify its single weakest aspect (accuracy, completeness, structure, clarity, or punch) and produce an improved version that fixes it. Keep everything that already works.",
        success_criteria: "PASS if the revision genuinely improves the weakest aspect while preserving prior strengths. FAIL if it regressed or changed nothing meaningful.",
      };
    }
    hooks.onPlan?.(i, plan);
    log(`\n=== step ${i + 1}: ${plan.step_name} ${plan.done ? "(DONE)" : ""} ===\n  ${plan.thought}`);
    if (plan.done) { stop = "agent_done"; break; }

    hooks.onPhase?.(i, "executing");
    const ex = await execute(goal, plan.instruction, bestText, (t) => hooks.onPartial?.(i, t)); // build on the best
    hooks.onPhase?.(i, "judging");
    const v = await judge({ goal: plan.instruction, rubric: plan.success_criteria }, ex.text);

    const tokens: Usage = { input: ex.usage.input + v.usage.input, output: ex.usage.output + v.usage.output };
    const cost = costOf(PRICE.worker, ex.usage) + costOf(PRICE.judge, v.usage);
    acc.input += tokens.input; acc.output += tokens.output; acc.cost += cost;

    const passed = v.passed && v.score >= PASS_THRESHOLD;
    const r: Round = { n: 1, draft: ex.text, score: v.score, passed, critique: v.critique, suggestions: v.suggestions, tokens, cost_usd: cost };
    total++;
    const isBest = v.score > bestScore;
    if (isBest) { bestScore = v.score; bestText = ex.text; bestIndex = steps.length; } // keep the best draft

    const step: AgenticStep = {
      name: plan.step_name, instruction: plan.instruction, success_criteria: plan.success_criteria, thought: plan.thought,
      cleared: passed, best_score: v.score, best_round: 1, rounds: [r], final: ex.text,
      tokens, cost_usd: cost,
    };
    steps.push(step);
    hooks.onStepDone?.(i, step);
    log(`  step ${i + 1} scored ${v.score.toFixed(2)}${isBest ? " (new best)" : ""} · $${cost.toFixed(4)}`);
  }

  const result: AgenticResult = {
    mode: "agentic", goal, steps, final_artifact: bestText, best_step: bestIndex,
    cleared_gate: stop === "agent_done", stop_reason: stop, total_rounds: total,
    tokens: { input: acc.input, output: acc.output }, cost_usd: acc.cost,
  };
  writeFileSync("result.json", JSON.stringify(result, null, 2));
  log(`\n⏹  agentic ${stop} · ${steps.length} steps · $${acc.cost.toFixed(4)}`);
  return result;
}

function log(msg: string): void {
  console.error(msg);
}

// --- CLI entry: only when run directly, not when imported by the server -------

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const cfg = process.argv[2] ?? "config.json";
  const t0 = Date.now();
  run(loadFrame(cfg))
    .then(() => log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`))
    .catch((err) => {
      log(`\n✗ ${err?.message ?? err}`);
      process.exit(1);
    });
}
