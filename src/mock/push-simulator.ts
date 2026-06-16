/**
 * push-simulator.ts — 本地模拟 WebSocket 数据推送
 *
 * 替代真实 WebSocket 进行本地开发调试。定时向 processor 注入 updateDataModel
 * 消息，模拟后端主动推送场景。接入真实 WebSocket 时替换此模块即可。
 */

import type { MessageProcessor } from '@a2ui/web_core/v0_9'
import type { ReactComponentImplementation } from '@a2ui/react/v0_9'
import { logger } from '@/lib/logger'

interface PushField {
  /** dataModel 路径 */
  path: string
  /** 基准值 */
  base: number
  /** 波动范围 ± */
  variation: number
}

interface MockPushConfig {
  /** 推送间隔 ms，默认 5000 */
  interval?: number
  /** 要推送的字段列表 */
  fields?: PushField[]
}

const DEFAULT_FIELDS: PushField[] = [
  { path: '/kpiSales', base: 6580, variation: 80 },
  { path: '/kpiOrders', base: 2430, variation: 15 },
  { path: '/kpiAvgPrice', base: 2.71, variation: 0.1 },
  { path: '/kpiProfitRate', base: 22.8, variation: 1.5 },
]

function round(v: number, decimals: number): number {
  const p = Math.pow(10, decimals)
  return Math.round(v * p) / p
}

export class MockPushSimulator {
  private timer: ReturnType<typeof setInterval> | null = null
  private surfaceId: string
  private config: Required<Omit<MockPushConfig, 'fields'>> & { fields: PushField[] }

  constructor(
    private processor: MessageProcessor<ReactComponentImplementation>,
    surfaceId: string = 'main',
    config: MockPushConfig = {},
  ) {
    this.surfaceId = surfaceId
    this.config = {
      interval: config.interval ?? 5000,
      fields: config.fields ?? DEFAULT_FIELDS,
    }
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      const messages = this.config.fields.map(f => ({
        version: 'v0.9' as const,
        updateDataModel: {
          surfaceId: this.surfaceId,
          path: f.path,
          value: round(f.base + (Math.random() - 0.5) * 2 * f.variation, f.path.includes('AvgPrice') ? 2 : 1),
        },
      }))
      try {
        this.processor.processMessages(messages as any)
      } catch (e: any) {
        logger.warn('[MockPush] processMessages 失败:', e?.message || e)
      }
    }, this.config.interval)
    logger.info(`[MockPush] 已启动，每 ${this.config.interval / 1000}s 推送 ${this.config.fields.length} 个 KPI 字段`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    logger.info('[MockPush] 已停止')
  }

  /** 手动推送一次（用于调试） */
  pushOnce() {
    const messages = this.config.fields.map(f => ({
      version: 'v0.9' as const,
      updateDataModel: {
        surfaceId: this.surfaceId,
        path: f.path,
        value: round(f.base + (Math.random() - 0.5) * 2 * f.variation, f.path.includes('AvgPrice') ? 2 : 1),
      },
    }))
    this.processor.processMessages(messages as any)
  }
}
