/**
 * Agent API 客户端
 *
 * 浏览器端薄层：mock 模式本地返回 demo 数据；非 mock 调用服务端 /api/generate。
 * 真实 LLM 调用和 JSON 处理逻辑在 src/server/agent-executor.ts 中。
 */

import type { ReactionDef } from '@/types/a2ui-types'
import demoOutput from '../demo.json'

export interface AgentConfig {
  provider: 'mock' | 'gemini' | 'deepseek' | 'claude' | 'openai'
}

export interface AgentResult {
  a2ui: any[]
  logic: { reactions: ReactionDef[] }
}

async function callGenerateApi(body: {
  provider: string
  requirement: string
  exampleType: 'form' | 'dashboard'
  useFullPrompt: boolean
}): Promise<AgentResult> {
  const resp = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const data = await resp.json()
  if (!resp.ok) {
    throw new Error(data.error ?? `API error ${resp.status}`)
  }
  return data as AgentResult
}

export async function generatePage(
  userRequirement: string,
  config: AgentConfig,
  exampleType: 'form' | 'dashboard' = 'dashboard',
): Promise<AgentResult> {
  if (config.provider === 'mock') {
    await new Promise(r => setTimeout(r, 500))
    return { a2ui: demoOutput.a2ui, logic: demoOutput.logic as { reactions: ReactionDef[] } }
  }

  return callGenerateApi({
    provider: config.provider,
    requirement: userRequirement,
    exampleType,
    useFullPrompt: false,
  })
}

export async function generatePageWithExample(
  userRequirement: string,
  config: AgentConfig,
  exampleType: 'form' | 'dashboard' = 'dashboard',
): Promise<AgentResult> {
  if (config.provider === 'mock') {
    return generatePage(userRequirement, config)
  }

  return callGenerateApi({
    provider: config.provider,
    requirement: userRequirement,
    exampleType,
    useFullPrompt: true,
  })
}
