/**
 * Agent API 客户端
 *
 * 调用 LLM (Gemini / DeepSeek) 生成 A2UI + Logic JSON。
 * 支持 mock 模式（无需 API Key），直接返回 demo 数据。
 */

import { buildSystemPrompt, buildFullPrompt } from './prompt-builder'
import demoOutput from '../demo.json'

export interface AgentConfig {
  provider: 'mock' | 'gemini' | 'deepseek' | 'claude' | 'openai'
  apiKey?: string
  model?: string
  baseUrl?: string
}

export interface AgentResult {
  a2ui: any[]
  logic: { reactions: any[] }
}

// ===== Gemini API =====

async function callGemini(
  systemPrompt: string,
  userMessage: string,
  config: AgentConfig,
): Promise<string> {
  const model = config.model ?? 'gemini-2.5-flash'
  const baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com'

  const resp = await fetch(
    `${baseUrl}/v1beta/models/${model}:generateContent?key=${config.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 4096,
        },
      }),
    },
  )

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Gemini API error ${resp.status}: ${err}`)
  }

  const data = await resp.json()
  return data.candidates[0].content.parts[0].text
}

// ===== DeepSeek API (OpenAI 兼容) =====

async function callDeepSeek(
  systemPrompt: string,
  userMessage: string,
  config: AgentConfig,
): Promise<string> {
  const model = config.model ?? 'deepseek-chat'
  const baseUrl = config.baseUrl ?? 'https://api.deepseek.com'

  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4096,
    }),
  })

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`DeepSeek API error ${resp.status}: ${err}`)
  }

  const data = await resp.json()
  return data.choices[0].message.content
}

// ===== 提取 JSON =====

function extractJson(raw: string): any {
  let text = raw.trim()
  // 去掉 markdown 代码块包裹
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }
  // LLM 可能在 JSON 前后附加文字，截取第一个 { 到最后一个 } 之间的内容
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    text = text.slice(start, end + 1)
  }
  return JSON.parse(text)
}

// ===== 校验输出 =====

function validateOutput(data: any): AgentResult {
  if (!data || typeof data !== 'object') {
    throw new Error('Agent 输出不是有效的 JSON 对象')
  }
  if (!Array.isArray(data.a2ui)) {
    throw new Error('缺少 a2ui 数组')
  }
  if (!data.logic || !Array.isArray(data.logic.reactions)) {
    throw new Error('缺少 logic.reactions 数组')
  }

  // 校验消息顺序
  const firstMsg = data.a2ui[0]
  if (!firstMsg || !('beginRendering' in firstMsg)) {
    console.warn('[AgentClient] 第一条消息不是 beginRendering，已自动修正')
    data.a2ui = [{ beginRendering: { surfaceId: 'main', catalogId: 'basic' } }, ...data.a2ui]
  }

  return { a2ui: data.a2ui, logic: data.logic }
}

// ===== 主入口 =====

export async function generatePage(
  userRequirement: string,
  config: AgentConfig,
): Promise<AgentResult> {
  // Mock 模式：直接返回 demo 数据
  if (config.provider === 'mock') {
    await new Promise(r => setTimeout(r, 500)) // 模拟延迟
    return { a2ui: demoOutput.a2ui, logic: demoOutput.logic }
  }

  const systemPrompt = buildSystemPrompt(userRequirement)
  const userMessage = '请生成页面。只输出 JSON。'

  let raw: string
  switch (config.provider) {
    case 'gemini':
      raw = await callGemini(systemPrompt, userMessage, config)
      break
    case 'deepseek':
      raw = await callDeepSeek(systemPrompt, userMessage, config)
      break
    default:
      throw new Error(`Unknown provider: ${config.provider}`)
  }

  const parsed = extractJson(raw)
  return validateOutput(parsed)
}

/**
 * 使用完整示例 Prompt 生成（附带格式参考示例，适合首次使用或复杂需求）
 */
export async function generatePageWithExample(
  userRequirement: string,
  config: AgentConfig,
): Promise<AgentResult> {
  if (config.provider === 'mock') {
    return generatePage(userRequirement, config)
  }

  const systemPrompt = buildFullPrompt(userRequirement)
  const userMessage = '请根据需求生成页面，参考示例的格式。只输出 JSON。'

  let raw: string
  switch (config.provider) {
    case 'gemini':
      raw = await callGemini(systemPrompt, userMessage, config)
      break
    case 'deepseek':
      raw = await callDeepSeek(systemPrompt, userMessage, config)
      break
    default:
      throw new Error(`Unknown provider: ${config.provider}`)
  }

  const parsed = extractJson(raw)
  return validateOutput(parsed)
}
