import { NextRequest, NextResponse } from 'next/server'
import { executeAgent, type GenerateRequest } from '@/server/agent-executor'

const MAX_BODY_SIZE = 100_000

export async function POST(req: NextRequest) {
  const text = await req.text()

  if (text.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  let body: GenerateRequest
  try {
    body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.provider || !body.requirement?.trim()) {
    return NextResponse.json(
      { error: 'provider and requirement are required' },
      { status: 400 },
    )
  }

  try {
    const result = await executeAgent(body)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const status = message.includes('Missing') ? 500
      : message.includes('API error') ? 502
      : message.includes('无效 JSON') ? 422
      : 500
    return NextResponse.json({ error: message }, { status })
  }
}
