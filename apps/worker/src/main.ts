import { createPool } from "@ticketry/db";
import type { Pool } from "@ticketry/db";

import { runDigest } from "./jobs/digest.js";
import { runExports } from "./jobs/exports.js";
import { runSlaSweep } from "./jobs/sla-sweep.js";
import { runLifecycleIngestion } from "./jobs/lifecycle-ingestion.js";

const JOBS = {
  "sla-sweep": async (pool: Pool) => runSlaSweep(pool),
  digest: async (pool: Pool) => runDigest(pool),
  exports: async (pool: Pool) => runExports(pool),
  "lifecycle-ingestion": async (pool: Pool) => runLifecycleIngestion(pool, [])
} as const;

type JobName = keyof typeof JOBS;

function parseArgs(argv: string[]): { once: boolean; jobs: JobName[] } {
  const once = argv.includes("--once");
  const named = argv.filter((arg) => !arg.startsWith("--"));
  const jobs = (named.length > 0 ? named : Object.keys(JOBS)) as JobName[];
  for (const job of jobs) {
    if (!(job in JOBS)) {
      throw new Error(`unknown job "${job}"; expected one of ${Object.keys(JOBS).join(", ")}`);
    }
  }
  return { once, jobs };
}

async function runAll(pool: Pool, jobs: JobName[]): Promise<void> {
  for (const job of jobs) {
    const started = Date.now();
    try {
      const result = await JOBS[job](pool);
      console.log(`[worker] ${job} ok in ${Date.now() - started}ms`, JSON.stringify(summarize(result)));
    } catch (error) {
      console.error(`[worker] ${job} failed:`, error instanceof Error ? error.message : error);
    }
  }
}

function summarize(result: unknown): unknown {
  if (result && typeof result === "object" && "processed" in result) {
    const processed = (result as { processed: unknown[] }).processed;
    return { processed: processed.length };
  }
  return result;
}

async function main(): Promise<void> {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error("APP_DATABASE_URL is required (the ticketry_app connection string)");
  }
  const { once, jobs } = parseArgs(process.argv.slice(2));
  const pool = createPool({ connectionString: url, max: 4, applicationName: "ticketry-worker" });
  const interval = Number(process.env.WORKER_INTERVAL_MS ?? 60_000);

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    do {
      await runAll(pool, jobs);
      if (once) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    } while (!stopping);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
