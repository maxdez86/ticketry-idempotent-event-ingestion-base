import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "./migrate.js";
import { createPool } from "./pool.js";

const SEED_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../seeds/dev-seed.sql");

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. It must point at the owner connection of the target database.");
    process.exit(2);
  }
  return url;
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  const pool = createPool({ connectionString: requireDatabaseUrl(), max: 2, applicationName: "ticketry-cli" });
  try {
    switch (command) {
      case "migrate": {
        const result = await migrate(pool, { log: (message) => console.log(`[migrate] ${message}`) });
        console.log(
          `[migrate] applied ${result.applied.length} migration(s), ${result.alreadyApplied} already applied`
        );
        break;
      }
      case "seed": {
        const sql = await readFile(SEED_FILE, "utf8");
        await pool.query(sql);
        console.log(`[seed] loaded ${path.basename(SEED_FILE)}`);
        break;
      }
      default:
        console.error("usage: tsx src/cli.ts <migrate|seed>");
        process.exit(2);
    }
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
