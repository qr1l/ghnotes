// Подпись версии сборки. Значения подставляются в vite.config.ts через define.

export const BUILD_COMMIT: string = __BUILD_COMMIT__
export const BUILD_DATE: string = __BUILD_DATE__

export function buildSignature(): string {
  return `сборка ${BUILD_COMMIT} · ${BUILD_DATE}`
}
