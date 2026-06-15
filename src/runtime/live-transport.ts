/**
 * live-transport.ts — 实时数据推送传输层
 *
 * 支持 WebSocket 连接，接收后端推送的 A2UI 消息并 feed 给 MessageProcessor。
 * 后端推送的消息格式与前端 processMessages 输入一致。
 *
 * 用法示例:
 *   const transport = new LiveTransport('ws://localhost:8080/ws', processor, {
 *     onOpen: () => console.log('已连接'),
 *     onError: (e) => console.error('连接错误', e),
 *     reconnect: true,
 *   })
 *   transport.connect()
 *   // 页面关闭时
 *   transport.disconnect()
 */

import type { MessageProcessor } from '@a2ui/web_core/v0_9'
import type { ReactComponentImplementation } from '@a2ui/react/v0_9'

interface LiveTransportOptions {
  /** 连接成功回调 */
  onOpen?: () => void
  /** 连接错误回调 */
  onError?: (err: Event) => void
  /** 连接关闭回调 */
  onClose?: (code: number, reason: string) => void
  /** 收到消息回调（在 processMessages 之前） */
  onMessage?: (data: any) => void
  /** 是否自动重连，默认 true */
  reconnect?: boolean
  /** 重连间隔 ms，默认 3000 */
  reconnectInterval?: number
  /** 最大重连次数，默认 Infinity */
  maxReconnects?: number
  /** 心跳间隔 ms，默认 30000 */
  heartbeat?: number
}

export class LiveTransport {
  private ws: WebSocket | null = null
  private reconnectCount = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private destroyed = false
  private opts: Required<LiveTransportOptions>

  constructor(
    private url: string,
    private processor: MessageProcessor<ReactComponentImplementation>,
    opts: LiveTransportOptions = {},
  ) {
    this.opts = {
      onOpen: opts.onOpen ?? (() => {}),
      onError: opts.onError ?? (() => {}),
      onClose: opts.onClose ?? (() => {}),
      onMessage: opts.onMessage ?? (() => {}),
      reconnect: opts.reconnect ?? true,
      reconnectInterval: opts.reconnectInterval ?? 3000,
      maxReconnects: opts.maxReconnects ?? Infinity,
      heartbeat: opts.heartbeat ?? 30000,
    }
  }

  connect() {
    if (this.destroyed) return
    try {
      this.ws = new WebSocket(this.url)
    } catch (e) {
      console.error('[LiveTransport] WebSocket 创建失败:', e)
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.reconnectCount = 0
      this.opts.onOpen()
      this.startHeartbeat()
    }

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string)
        this.opts.onMessage(data)
        // 消息可能是单个消息或消息数组（A2UI v0.9 格式）
        const messages = Array.isArray(data) ? data : [data]
        this.processor.processMessages(messages as any)
      } catch (err: any) {
        console.error('[LiveTransport] 消息处理失败:', err?.message || err)
      }
    }

    this.ws.onerror = (err: Event) => {
      this.opts.onError(err)
    }

    this.ws.onclose = (event: CloseEvent) => {
      this.stopHeartbeat()
      this.opts.onClose(event.code, event.reason)
      if (!this.destroyed) {
        this.scheduleReconnect()
      }
    }
  }

  disconnect() {
    this.destroyed = true
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onclose = null // 阻止触发自动重连
      this.ws.close()
      this.ws = null
    }
  }

  /** 发送消息到服务端 */
  send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data))
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private scheduleReconnect() {
    if (!this.opts.reconnect || this.reconnectCount >= this.opts.maxReconnects) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectCount++
      console.log(`[LiveTransport] 重连 (${this.reconnectCount})...`)
      this.connect()
    }, this.opts.reconnectInterval)
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('ping')
      }
    }, this.opts.heartbeat)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
