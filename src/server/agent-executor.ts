/**
 * agent-executor.ts — 服务端 Agent 执行器
 *
 * 在 Next.js Route Handler 中运行，封装 LLM 调用、JSON 解析、校验、存储。
 * 与 src/agent/agent-client.ts 互补：客户端处理 mock 模式，服务端处理真实 LLM 调用。
 */

import 'server-only'
import { buildSystemPrompt, buildFullPrompt } from '@/agent/prompt-builder'
import type { ReactionDef } from '@/types/a2ui-types'
import demoOutput from '@/demo.json'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface AgentConfig {
  provider: 'mock' | 'gemini' | 'deepseek' | 'claude' | 'openai'
  apiKey?: string
  model?: string
  baseUrl?: string
}

export interface AgentResult {
  a2ui: any[]
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
  const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY

  if (!apiKey) throw new Error('Missing GEMINI_API_KEY')

  const resp = await fetch(
    `${baseUrl}/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
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

// ===== DeepSeek API =====

async function callDeepSeek(
  systemPrompt: string,
  userMessage: string,
  config: AgentConfig,
): Promise<string> {
  const model = config.model ?? 'deepseek-chat'
  const baseUrl = config.baseUrl ?? 'https://api.deepseek.com'
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY

  if (!apiKey) throw new Error('Missing DEEPSEEK_API_KEY')

  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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

// ===== JSON 提取 =====

function extractJson(raw: string): unknown {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    text = text.slice(start, end + 1)
  }
  try { return JSON.parse(text) } catch {
    const repaired = repairJson(text)
    if (repaired) {
      try { return JSON.parse(repaired) } catch { /* fall through */ }
    }
    throw new Error(`Agent 返回了无效 JSON: ${raw.slice(0, 200)}`)
  }
}

function repairJson(text: string): string | null {
  let repaired = text
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,\s*([}\]])/g, '$1')
  repaired = repaired.replace(/'([^']*?)'(?=\s*:)/g, '"$1"')
  repaired = repaired.replace(/([\[{,:]\s*)'([^']*?)'/g, '$1"$2"')

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

// ===== 校验 =====

function validateOutput(data: Record<string, any>): AgentResult {
  if (!data || typeof data !== 'object') {
    throw new Error('Agent 输出不是有效的 JSON 对象')
  }

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
      firstPage.a2ui = [{ beginRendering: { surfaceId: 'main', catalogId: 'basic' } }, ...firstPage.a2ui]
    }
    if (data.shared?.dataModel) {
      for (const [key, value] of Object.entries(data.shared.dataModel)) {
        firstPage.a2ui.push({ updateDataModel: { surfaceId: 'main', path: `/${key}`, value } })
      }
    }
    return { a2ui: firstPage.a2ui, logic: firstPage.logic }
  }

  if (!Array.isArray(data.a2ui)) throw new Error('缺少 a2ui 数组')
  if (!data.logic || !Array.isArray(data.logic.reactions)) throw new Error('缺少 logic.reactions 数组')

  const firstMsg = data.a2ui[0]
  if (!firstMsg || !('beginRendering' in firstMsg)) {
    data.a2ui = [{ beginRendering: { surfaceId: 'main', catalogId: 'basic' } }, ...data.a2ui]
  }

  return { a2ui: data.a2ui, logic: data.logic }
}

// ===== 保存 test.json =====

async function saveToTestJson(data: unknown) {
  try {
    const filePath = path.join(process.cwd(), 'src/test.json')
    await fs.writeFile(filePath, JSON.stringify(data, null, 4), 'utf-8')
  } catch { /* 保存失败不影响主流程 */ }
}

// ===== 主入口 =====

export interface GenerateRequest {
  provider: 'gemini' | 'deepseek' | 'mock'
  requirement: string
  exampleType?: 'form' | 'dashboard'
  useFullPrompt?: boolean
}

export async function executeAgent(request: GenerateRequest): Promise<AgentResult> {
  const { provider, requirement, exampleType = 'dashboard', useFullPrompt = false } = request

  if (provider === 'mock') {
    await new Promise(r => setTimeout(r, 500))
    return { a2ui: demoOutput.a2ui, logic: demoOutput.logic as { reactions: ReactionDef[] } }
  }

  const config: AgentConfig = { provider, model: undefined, baseUrl: undefined }
  const systemPrompt = useFullPrompt
    ? buildFullPrompt(requirement, exampleType)
    : buildSystemPrompt(requirement, { exampleType })
  const userMessage = '请生成页面。只输出 JSON。'

  let raw: string
  switch (provider) {
    case 'gemini':
      raw = await callGemini(systemPrompt, userMessage, config)
      break
    case 'deepseek':
      raw = await callDeepSeek(systemPrompt, userMessage, config)
      break
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }

  const parsed = extractJson(raw)
  await saveToTestJson(parsed)
  return validateOutput(parsed as Record<string, any>)
}
