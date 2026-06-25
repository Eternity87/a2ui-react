import { NextRequest, NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_BODY_SIZE = 100_000

export async function POST(req: NextRequest) {
  const adminToken = process.env.ADMIN_TOKEN

  if (adminToken && req.headers.get('x-admin-token') !== adminToken) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const text = await req.text()

  if (text.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  try {
    const parsed = JSON.parse(text)
    const filePath = path.join(process.cwd(), 'src/test.json')
    await fs.writeFile(filePath, JSON.stringify(parsed, null, 4), 'utf-8')
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid JSON' },
      { status: 400 },
    )
  }
}
