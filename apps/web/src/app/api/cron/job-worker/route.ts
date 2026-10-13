/**
 * `job-worker` cron (PLAN §14, every 2 minutes): runs queued jobs for about 240 s, then stops
 * claiming; a job that runs longer is resumed by a later invocation (`continueLater`, or lease
 * expiry). Failed jobs alert the platform admin and the tenant owner (T-043).
 *
 * Handlers: every `defineJob(...)` exported by `@cb/core` (feature tasks add theirs in their own
 * module; nothing to change here).
 */
import * as core from "@cb/core";
import {
  collectJobDefinitions,
  createJobFailureNotifier,
  createJobRegistry,
  createLogOnlyEmailTransport,
  createResendEmailTransport,
  DEFAULT_WORKER_BUDGET_MS,
  type EmailTransport,
  type Logger,
  runJobWorker,
} from "@cb/core";
import * as Sentry from "@sentry/nextjs";
import { serverEnv } from "@/env";
import { renderJobAlert } from "../_lib/alerts";
import { cronRoute } from "../_lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Seconds. The worker budget (240 s) leaves time to record outcomes; the lease (300 s) ≥ this. */
export const maxDuration = 300;

function emailTransport(log: Logger): EmailTransport {
  const { RESEND_API_KEY, EMAIL_FROM } = serverEnv;
  if (RESEND_API_KEY && EMAIL_FROM) {
    return createResendEmailTransport({ apiKey: RESEND_API_KEY, from: EMAIL_FROM });
  }
  return createLogOnlyEmailTransport(log);
}

export const GET = cronRoute("job_worker", async ({ db, log, requestId }) => {
  const registry = createJobRegistry(collectJobDefinitions(core));
  let captured = 0;
  const onFailure = createJobFailureNotifier({
    db: db(),
    transport: emailTransport(log),
    render: renderJobAlert,
    logger: log,
    capture: (event) => {
      captured += 1;
      Sentry.captureMessage(event.message, {
        level: "error",
        tags: event.tags,
        extra: event.extra,
      });
    },
  });
  const report = await runJobWorker({
    db: db(),
    registry,
    logger: log,
    requestId,
    budgetMs: DEFAULT_WORKER_BUDGET_MS,
    onFailure,
  });
  if (captured > 0) await Sentry.flush(2_000);
  return { ...report, types: registry.types() };
});
