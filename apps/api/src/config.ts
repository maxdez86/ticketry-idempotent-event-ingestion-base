export interface ApiConfig {
  appDatabaseUrl: string;
  port: number;
  host: string;
  logLevel: string;
  poolMax: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const appDatabaseUrl = env.APP_DATABASE_URL;
  if (!appDatabaseUrl) {
    throw new Error("APP_DATABASE_URL is required (the ticketry_app connection string)");
  }
  return {
    appDatabaseUrl,
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? "info",
    poolMax: Number(env.DB_POOL_MAX ?? 10)
  };
}
