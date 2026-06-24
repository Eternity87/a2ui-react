import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

/** 仅在 dev server 生效：Agent 生成结果自动落盘到 src/test.json */
function saveTestJsonPlugin(): Plugin {
  const MAX_BODY_SIZE = 100_000 // 100KB
  const ADMIN_TOKEN = process.env.VITE_ADMIN_TOKEN

  return {
    name: 'save-test-json',
    apply: 'serve', // 仅 dev server，不影响 production build
    configureServer(server) {
      server.middlewares.use('/api/save-test-json', (req, res) => {
        // 1. 方法校验
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method Not Allowed' }))
          return
        }

        // 2. Content-Type 校验
        const ct = req.headers['content-type'] ?? ''
        if (!ct.includes('application/json')) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'Content-Type must be application/json' }))
          return
        }

        // 3. Token 认证（配置了 VITE_ADMIN_TOKEN 才生效）
        if (ADMIN_TOKEN) {
          const token = req.headers['x-admin-token']
          if (token !== ADMIN_TOKEN) {
            res.statusCode = 403
            res.end(JSON.stringify({ error: 'Forbidden' }))
            return
          }
        }

        // 4. 读取请求体（带大小限制）
        let body = ''
        let size = 0
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_SIZE) {
            res.statusCode = 413
            res.end(JSON.stringify({ error: 'Payload too large' }))
            req.destroy()
            return
          }
          body += chunk.toString()
        })

        req.on('error', () => {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'Request error' }))
        })

        req.on('end', () => {
          try {
            const filePath = path.resolve(__dirname, 'src/test.json')
            const parsed = JSON.parse(body)
            fs.writeFileSync(filePath, JSON.stringify(parsed, null, 4), 'utf-8')
            res.statusCode = 200
            res.end(JSON.stringify({ ok: true }))
          } catch (err: unknown) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid JSON' }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), saveTestJsonPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
