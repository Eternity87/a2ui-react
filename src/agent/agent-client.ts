/**
 * Agent API 客户端
 *
 * 调用 LLM (Gemini / DeepSeek) 生成 A2UI + Logic JSON。
 * 支持 mock 模式（无需 API Key），直接返回 demo 数据。
 */

import { buildSystemPrompt, buildFullPrompt } from './prompt-builder'
import { logger } from '@/lib/logger'
import type { A2UIMessage, ReactionDef } from '@/types/a2ui-types'
import demoOutput from '../demo.json'

export interface AgentConfig {
  provider: 'mock' | 'gemini' | 'deepseek' | 'claude' | 'openai'
  apiKey?: string
  model?: string
  baseUrl?: string
}

export interface AgentResult {
  a2ui: A2UIMessage[]
  logic: { reactions: ReactionDef[] }
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
    `${baseUrl}/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.apiKey ?? '',
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 8192,
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
      max_tokens: 8192,
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

function extractJson(raw: string): unknown {
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

  try {
    return JSON.parse(text)
  } catch {
    // JSON 解析失败，尝试修复常见 LLM 输出问题
    const repaired = repairJson(text)
    if (repaired) {
      try { return JSON.parse(repaired) } catch { /* fall through */ }
    }
    throw new Error(`Agent 返回了无效 JSON: ${raw.slice(0, 200)}`)
  }
}

/** 修复常见 LLM JSON 输出问题：尾部逗号、单引号、注释、截断括号 */
function repairJson(text: string): string | null {
  let repaired = text
    .replace(/\/\/.*$/gm, '')        // 单行注释
    .replace(/\/\*[\s\S]*?\*\//g, '') // 多行注释
    .replace(/,\s*([}\]])/g, '$1')    // 尾部逗号
  // 单引号 → 双引号（仅替换 JSON 结构位置的引号，不触碰字符串内容中的引号）
  // Pass 1: 单引号 key → 双引号（关闭引号后紧跟 :）
  repaired = repaired.replace(/'([^']*?)'(?=\s*:)/g, '"$1"')
  // Pass 2: 单引号 value → 双引号（开启引号前有 { [ , : 等结构字符）
  repaired = repaired.replace(/([\[{,:]\s*)'([^']*?)'/g, '$1"$2"')

  // 补齐截断的括号
  let openBraces = 0, openBrackets = 0
  let inString = false, skipNext = false
  for (const ch of repaired) {
    if (skipNext) { skipNext = false; continue }
    if (ch === '\\') { skipNext = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') openBraces++
    if (ch === '}') openBraces--
    if (ch === '[') openBrackets++
    if (ch === ']') openBrackets--
  }
  if (openBraces > 0) repaired += '}'.repeat(openBraces)
  if (openBrackets > 0) repaired += ']'.repeat(openBrackets)

  return repaired !== text ? repaired : null
}

// ===== 校验输出 =====

/** JSON 解析后的原始对象（宽松类型，仅在边界使用） */
type JsonData = Record<string, any>

function validateOutput(data: JsonData): AgentResult {
  if (!data || typeof data !== 'object') {
    throw new Error('Agent 输出不是有效的 JSON 对象')
  }

  // 多页面格式 → 提取第一页
  if (data.pages && typeof data.pages === 'object') {
    const pageIds = Object.keys(data.pages)
    if (pageIds.length === 0) throw new Error('pages 对象为空')
    const firstPage = data.pages[pageIds[0]]
    if (!firstPage || !Array.isArray(firstPage.a2ui)) {
      throw new Error(`页面 "${pageIds[0]}" 缺少 a2ui 数组`)
    }
    if (!firstPage.logic || !Array.isArray(firstPage.logic.reactions)) {
      throw new Error(`页面 "${pageIds[0]}" 缺少 logic.reactions 数组`)
    }
    const firstMsg = firstPage.a2ui[0]
    if (!firstMsg || !('beginRendering' in firstMsg)) {
      logger.warn('[AgentClient] 第一条消息不是 beginRendering，已自动修正')
      firstPage.a2ui = [{ beginRendering: { surfaceId: 'main', catalogId: 'basic' } }, ...firstPage.a2ui]
    }
    // 合并 shared.dataModel 到第一页的 updateDataModel 消息末尾
    if (data.shared?.dataModel) {
      for (const [key, value] of Object.entries(data.shared.dataModel)) {
        firstPage.a2ui.push({ updateDataModel: { surfaceId: 'main', path: `/${key}`, value } })
      }
    }
    return { a2ui: firstPage.a2ui as A2UIMessage[], logic: firstPage.logic as { reactions: ReactionDef[] } }
  }

  // 单页面格式
  if (!Array.isArray(data.a2ui)) {
    throw new Error('缺少 a2ui 数组（Agent 可能输出了非 JSON 内容）')
  }
  if (!data.logic || !Array.isArray(data.logic.reactions)) {
    throw new Error('缺少 logic.reactions 数组')
  }

  const firstMsg = data.a2ui[0]
  if (!firstMsg || !('beginRendering' in firstMsg)) {
    logger.warn('[AgentClient] 第一条消息不是 beginRendering，已自动修正')
    data.a2ui = [{ beginRendering: { surfaceId: 'main', catalogId: 'basic' } }, ...data.a2ui]
  }

  return { a2ui: data.a2ui as A2UIMessage[], logic: data.logic as { reactions: ReactionDef[] } }
}

// ===== 保存到 test.json（非 mock 模式） =====

async function saveToTestJson(data: unknown) {
  try {
    await fetch('/api/save-test-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  } catch { /* 保存失败不影响主流程 */ }
}

// ===== 主入口 =====

export async function generatePage(
  userRequirement: string,
  config: AgentConfig,
  exampleType: 'form' | 'dashboard' = 'dashboard',
): Promise<AgentResult> {
  // Mock 模式：直接返回 demo 数据
  if (config.provider === 'mock') {
    await new Promise(r => setTimeout(r, 500)) // 模拟延迟
    return { a2ui: demoOutput.a2ui as A2UIMessage[], logic: demoOutput.logic as { reactions: ReactionDef[] } }
  }

  const systemPrompt = buildSystemPrompt(userRequirement, { exampleType })
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
  saveToTestJson(parsed)
  return validateOutput(parsed as JsonData)
}

/**
 * 使用完整示例 Prompt 生成（附带格式参考示例，适合首次使用或复杂需求）
 */
export async function generatePageWithExample(
  userRequirement: string,
  config: AgentConfig,
  exampleType: 'form' | 'dashboard' = 'dashboard',
): Promise<AgentResult> {
  if (config.provider === 'mock') {
    return generatePage(userRequirement, config)
  }

  const systemPrompt = buildFullPrompt(userRequirement, exampleType)
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
  saveToTestJson(parsed)
  return validateOutput(parsed as JsonData)
}
