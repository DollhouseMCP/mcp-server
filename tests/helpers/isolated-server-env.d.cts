export function isolatedServerEnv(directory: string, environment?: NodeJS.ProcessEnv): Record<string, string>;
export function isolateNativeHome(directory: string): () => void;
