/**
 * logger.ts — 统一日志封装
 *
 * 开发环境输出到 console，生产环境仅 error 级别输出。
 * warn/info/debug 在生产构建中不输出，减少噪音。
 */

const isDev = import.meta.env.DEV

export const logger = {
  warn: (...args: any[]) => { if (isDev) console.warn(...args) },
  error: (...args: any[]) => console.error(...args),
  info: (...args: any[]) => { if (isDev) console.info(...args) },
  debug: (...args: any[]) => { if (isDev) console.debug(...args) },
}
