/** Типы для `transformersEnv.mjs` (TASK-147.2). */
export interface TransformersEnvLike {
  cacheDir?: string | null;
  allowLocalModels?: boolean;
  allowRemoteModels?: boolean;
  localModelPath?: string;
}

export function configureTransformersEnv(env: TransformersEnvLike | undefined | null, options: { cacheDir: string; offline?: boolean }): void;
