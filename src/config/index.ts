import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string(),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  TELEGRAM_API_ID: z.string().transform(Number),
  TELEGRAM_API_HASH: z.string(),

  TDLIB_SESSIONS_PATH: z.string().default('./tdlib_sessions'),
});

export type Env = z.infer<typeof envSchema>;

function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('[DEBUG] Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  // Debug log for config loading (hide sensitive values)
  console.log('[DEBUG] Config loaded successfully:', {
    NODE_ENV: result.data.NODE_ENV,
    PORT: result.data.PORT,
    HOST: result.data.HOST,
    DATABASE_URL: result.data.DATABASE_URL ? `${result.data.DATABASE_URL.slice(0, 20)}...` : 'NOT SET',
    JWT_SECRET: result.data.JWT_SECRET ? `[${result.data.JWT_SECRET.length} chars]` : 'NOT SET',
    TELEGRAM_API_ID: result.data.TELEGRAM_API_ID,
    TELEGRAM_API_HASH: result.data.TELEGRAM_API_HASH ? `[${result.data.TELEGRAM_API_HASH.length} chars]` : 'NOT SET',
    TDLIB_SESSIONS_PATH: result.data.TDLIB_SESSIONS_PATH,
  });

  return result.data;
}

export const config = loadConfig();
