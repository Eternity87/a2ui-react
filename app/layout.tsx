import './globals.css'

export const metadata = {
  title: 'A2UI React',
  description: 'A2UI debugger and preview runtime',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
