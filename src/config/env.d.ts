interface EnvConfig {
    supabase: {
        url: string;
        serviceRoleKey: string;
    };
    worker: {
        scanIntervalMs: number;
        batchBlockSize: number;
    };
    nodeEnv: string;
    logLevel: string;
}
export declare const env: EnvConfig;
export {};
//# sourceMappingURL=env.d.ts.map