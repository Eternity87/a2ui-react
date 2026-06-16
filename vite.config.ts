import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

function saveTestJsonPlugin(): Plugin {
  return {
    name: 'save-test-json',
    configureServer(server) {
      server.middlewares.use('/api/save-test-json', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
          try {
            const filePath = path.resolve(__dirname, 'src/test.json')
            // 格式化后再写入，便于阅读
            const parsed = JSON.parse(body)
            fs.writeFileSync(filePath, JSON.stringify(parsed, null, 4), 'utf-8')
            res.statusCode = 200
            res.end(JSON.stringify({ ok: true }))
          } catch (err: any) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: err?.message || 'Unknown error' }))
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
