export function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T;
