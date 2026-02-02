import { z } from 'zod';
declare const envSchema: z.ZodObject<{
    NODE_ENV: z.ZodDefault<z.ZodEnum<{
        production: "production";
        development: "development";
        test: "test";
    }>>;
    PORT: z.ZodPipe<z.ZodDefault<z.ZodString>, z.ZodTransform<number, string>>;
    HOST: z.ZodDefault<z.ZodString>;
    DATABASE_URL: z.ZodString;
    REDIS_URL: z.ZodDefault<z.ZodString>;
    JWT_SECRET: z.ZodString;
    JWT_EXPIRES_IN: z.ZodDefault<z.ZodString>;
    JWT_REFRESH_EXPIRES_IN: z.ZodDefault<z.ZodString>;
    TELEGRAM_API_ID: z.ZodPipe<z.ZodString, z.ZodTransform<number, string>>;
    TELEGRAM_API_HASH: z.ZodString;
    TDLIB_SESSIONS_PATH: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type Env = z.infer<typeof envSchema>;
export declare const config: {
    NODE_ENV: "production" | "development" | "test";
    PORT: number;
    HOST: string;
    DATABASE_URL: string;
    REDIS_URL: string;
    JWT_SECRET: string;
    JWT_EXPIRES_IN: string;
    JWT_REFRESH_EXPIRES_IN: string;
    TELEGRAM_API_ID: number;
    TELEGRAM_API_HASH: string;
    TDLIB_SESSIONS_PATH: string;
};
export {};
//# sourceMappingURL=index.d.ts.map