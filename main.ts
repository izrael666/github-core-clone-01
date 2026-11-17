// Forge entrypoint: the lifecycle this process follows beside the trial harness.
//
// The harness (the env) owns port 8080 and drives the suite. This process has five jobs:
//   1. read the env origin from MAKEFUN_ENV_URL (without it there is no trial to join),
//   2. start the forge on a kernel-chosen ephemeral port,
//   3. announce that port to the env with POST /register,
//   4. poll GET /done until the env says the trial is over,
//   5. shut the forge down and leave with code 0.
//
// The forge itself lives in app.ts. This file only runs the five jobs above, and it
// imports the forge and nothing else.

import { createApp } from "./app.ts";

/** The env origin, trailing slashes stripped; empty when MAKEFUN_ENV_URL is unset. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");

/** Longest a single register or done request may run before it is dropped and retried. */
const REQUEST_DEADLINE_MS = 30_000;
/** First pause between retries, and the longest pause. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;
/** Process exit codes: 0 when the trial finished, 1 when the run could not proceed. */
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
/** The HTTP verb the register announcement uses. */
const REGISTER_VERB = "POST";

/** Pause for `ms` milliseconds. */
const pause = (ms: number): Promise<void> =>
  new Promise((wake) => setTimeout(wake, ms));

/** Pause after the `n`th failed attempt: exponential from BACKOFF_FIRST_MS, capped. */
function backoffFor(n: number): number {
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_FIRST_MS * 2 ** Math.min(n, 8));
}

/** What one attempt at a step reports: finished, try again, or refused outright. */
type StepOutcome = "finished" | "again" | "refused";

/**
 * Run `step` until it reports finished or refused. A refusal ends the run at once;
 * anything else waits with a growing backoff and tries again, because the env may
 * still be starting and the suite must never be left waiting.
 */
async function retryUntil(step: () => Promise<StepOutcome>): Promise<StepOutcome> {
  for (let failures = 0; ; failures += 1) {
    const outcome = await step();
    if (outcome !== "again") return outcome;
    await pause(backoffFor(failures));
  }
}

/**
 * Announce the forge's port to the env. 200 accepts it; 409 means another entry
 * registered first, which this process accepts and waits like any other. 400/405 are
 * contract refusals and stop the run; a dropped request or any other answer retries.
 */
async function announce(port: number): Promise<StepOutcome> {
  const payload = JSON.stringify({ port });
  const res = await fetch(`${envOrigin}/register`, {
    method: REGISTER_VERB,
    headers: { "Content-Type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  }).catch(() => null);
  let announceVerdict: StepOutcome = "again";
  if (res !== null && (res.status === 200 || res.status === 409)) announceVerdict = "finished";
  if (res !== null && (res.status === 400 || res.status === 405)) announceVerdict = "refused";
  return announceVerdict;
}

/** Ask the env whether the trial is over; finished only when it answers {"done": true}. */
async function checkDone(): Promise<boolean> {
  const res = await fetch(`${envOrigin}/done`, {
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  }).catch(() => null);
  if (res === null || !res.ok) return false;
  const body = (await res.json().catch(() => null)) as { done?: unknown } | null;
  return body !== null && body.done === true;
}

/** Start the forge, announce it, and wait for the trial to finish. */
async function boot(): Promise<void> {
  if (envOrigin === "") {
    process.stderr.write("[forge] MAKEFUN_ENV_URL is missing, so there is no env to register with\n");
    process.exitCode = EXIT_FAILURE;
  }
  if (envOrigin !== "") {
    const forge = createApp();
    await new Promise<void>((ok, fail) => {
      forge.once("error", fail);
      forge.listen(0, () => ok());
    });
    const bound = forge.address();
    if (bound === null || typeof bound !== "object") {
      process.stderr.write("[forge] the forge did not bind an ephemeral TCP port\n");
      process.exitCode = EXIT_FAILURE;
      forge.close();
    }
    if (bound !== null && typeof bound === "object") {
      process.stdout.write(`[forge] listening on port ${bound.port}\n`);
      const announced = await retryUntil(() => announce(bound.port));
      if (announced === "refused") {
        process.stderr.write("[forge] the env refused the register, so the trial cannot start\n");
        process.exitCode = EXIT_FAILURE;
        forge.close();
      }
      if (announced !== "refused") {
        process.stdout.write("[forge] registered with the env; waiting for the trial to finish\n");
        await retryUntil(async () => ((await checkDone()) ? "finished" : "again"));
        forge.close();
        process.stdout.write("[forge] trial finished\n");
      }
    }
  }
}

boot().then(
  () => {
    if (process.exitCode === undefined) process.exitCode = EXIT_SUCCESS;
  },
  (err: unknown) => {
    process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = EXIT_FAILURE;
  },
);
