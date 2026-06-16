import { logger } from '@/lib/logger'

// 模拟产品数据
const products = [
  { id: 'P001', name: '笔记本电脑', price: 5999, unit: '台', stock: 50, status: 'active', category: 'ELECTRONICS' },
  { id: 'P002', name: '机械键盘', price: 899, unit: '个', stock: 200, status: 'active', category: 'ELECTRONICS' },
  { id: 'P003', name: '显示器 27寸', price: 2499, unit: '台', stock: 30, status: 'active', category: 'ELECTRONICS' },
  { id: 'P004', name: '办公椅', price: 1599, unit: '把', stock: 10, status: 'discontinued', category: 'FURNITURE' },
  { id: 'P005', name: '站立式办公桌', price: 3999, unit: '张', stock: 15, status: 'active', category: 'FURNITURE' },
]

// 模拟订单数据
const orders = [
  { orderId: 'ORD001', productId: 'P001', productName: '笔记本电脑', quantity: 2, unitPrice: 5999, totalPrice: 11998, status: 'created',   createdAt: '2026-05-10 10:30:00' },
  { orderId: 'ORD002', productId: 'P003', productName: '显示器 27寸', quantity: 1, unitPrice: 2499, totalPrice: 2499,  status: 'paid',      createdAt: '2026-05-11 14:20:00' },
  { orderId: 'ORD003', productId: 'P002', productName: '机械键盘',   quantity: 3, unitPrice: 899,  totalPrice: 2697,  status: 'shipped',   createdAt: '2026-05-12 09:15:00' },
  { orderId: 'ORD004', productId: 'P005', productName: '站立式办公桌', quantity: 1, unitPrice: 3999, totalPrice: 3999,  status: 'completed', createdAt: '2026-05-13 16:45:00' },
  { orderId: 'ORD005', productId: 'P001', productName: '笔记本电脑', quantity: 1, unitPrice: 5999, totalPrice: 5999,  status: 'paid',      createdAt: '2026-05-14 11:00:00' },
  { orderId: 'ORD006', productId: 'P004', productName: '办公椅',     quantity: 2, unitPrice: 1599, totalPrice: 3198,  status: 'cancelled', createdAt: '2026-05-15 08:20:00' },
]

// 模拟店铺数据
const shops = [
  { id: 'S001', name: '朝阳旗舰店', city: '北京', address: '朝阳区建国路88号', manager: '张三', phone: '13800001111', status: 'active', openDate: '2025-01-15' },
  { id: 'S002', name: '浦东体验店', city: '上海', address: '浦东新区陆家嘴100号', manager: '王五', phone: '13800002222', status: 'active', openDate: '2025-03-20' },
  { id: 'S003', name: '天河分店',   city: '广州', address: '天河区体育西路50号',   manager: '赵六', phone: '13800003333', status: 'active', openDate: '2025-06-10' },
  { id: 'S004', name: '南山社区店', city: '深圳', address: '南山区科技园路20号',   manager: '孙七', phone: '13800004444', status: 'closed', openDate: '2024-11-01' },
]

// 模拟用户数据
const users = [
  { id: 'U001', name: '李四', role: '店长',   shopId: 'S001', shopName: '朝阳旗舰店', phone: '13900002222', email: 'lisi@example.com',   status: 'active', createdAt: '2024-06-01' },
  { id: 'U002', name: '王五', role: '店长',   shopId: 'S002', shopName: '浦东体验店', phone: '13900003333', email: 'wangwu@example.com', status: 'active', createdAt: '2024-06-15' },
  { id: 'U003', name: '小明', role: '店员',   shopId: 'S001', shopName: '朝阳旗舰店', phone: '13900004444', email: 'xiaoming@example.com', status: 'active', createdAt: '2025-01-10' },
  { id: 'U004', name: '小红', role: '店员',   shopId: 'S003', shopName: '天河分店',   phone: '13900005555', email: 'xiaohong@example.com', status: 'active', createdAt: '2025-02-20' },
  { id: 'U005', name: '赵六', role: '店长',   shopId: 'S003', shopName: '天河分店',   phone: '13900006666', email: 'zhaoliu@example.com', status: 'active', createdAt: '2024-09-01' },
  { id: 'U006', name: '孙七', role: '区经',   shopId: null,   shopName: null,          phone: '13900007777', email: 'sunqi@example.com',   status: 'active', createdAt: '2023-12-01' },
]

export function createMockApiExecutor() {
  return async (req: { url: string; method: string; params?: any; body?: any }) => {
    // 模拟 300ms 网络延迟
    await new Promise(r => setTimeout(r, 300))

    switch (req.url) {
      case '/api/products': {
        const filtered = products.filter(p => p.category === req.params?.category)
        return { data: { list: filtered } }
      }
      case '/api/product-detail': {
        const product = products.find(p => p.id === req.params?.id)
        if (!product) throw new Error('产品不存在')
        return { data: product }
      }
      case '/api/orders': {
        if (req.method === 'GET') {
          let result = [...orders]
          if (req.params?.keyword) {
            const kw = String(req.params.keyword).toLowerCase()
            result = result.filter(o =>
              o.orderId.toLowerCase().includes(kw) ||
              o.productName.toLowerCase().includes(kw)
            )
          }
          return { data: { list: result } }
        }
        // POST — 创建订单
        return {
          data: {
            orderId: 'ORD' + Date.now(),
            status: 'created',
            message: '订单创建成功',
          },
        }
      }
      // ===== 店铺 =====
      case '/api/shops': {
        let result = [...shops]
        if (req.params?.keyword) {
          const kw = String(req.params.keyword).toLowerCase()
          result = result.filter(s =>
            s.name.toLowerCase().includes(kw) ||
            s.city.toLowerCase().includes(kw)
          )
        }
        return { data: { list: result } }
      }
      case '/api/shop-detail': {
        const shop = shops.find(s => s.id === req.params?.id)
        if (!shop) throw new Error('店铺不存在')
        return { data: shop }
      }

      // ===== 用户 =====
      case '/api/users': {
        let result = [...users]
        if (req.params?.keyword) {
          const kw = String(req.params.keyword).toLowerCase()
          result = result.filter(u =>
            u.name.toLowerCase().includes(kw) ||
            u.role.toLowerCase().includes(kw)
          )
        }
        return { data: { list: result } }
      }
      case '/api/user-detail': {
        const user = users.find(u => u.id === req.params?.id)
        if (!user) throw new Error('用户不存在')
        return { data: user }
      }
      case '/api/login': {
        const { username, password } = req.body ?? {}
        if (!username || !password) throw new Error('用户名和密码不能为空')
        // 模拟验证：任意非空用户名+密码即可登录
        const user = users.find(u => u.name === username) ?? users[0]
        return {
          data: {
            token: 'mock-jwt-' + Date.now(),
            user: { id: user.id, name: user.name, role: user.role },
            message: '登录成功',
          },
        }
      }

      // ===== BI 看板 =====
      case '/api/dashboard/kpi':
        return { data: {
          totalSales: 6580, salesTrend: 18.5, salesSpark: [420, 380, 510, 460, 590, 650],
          totalOrders: 2430, ordersTrend: 12.3, ordersSpark: [320, 280, 410, 390, 480, 550],
          avgPrice: 2.71, avgPriceTrend: -3.2, avgPriceSpark: [2.8, 2.5, 2.9, 3.1, 2.7, 2.71],
          profitRate: 22.8, profitRateTrend: 5.1, profitRateSpark: [18, 15, 22, 20, 25, 28],
        }}
      case '/api/dashboard/monthly-stats':
        return { data: { list: [
          { month: '1月', sales: 420, revenue: 85, orders: 320, profitRate: 18 },
          { month: '2月', sales: 380, revenue: 72, orders: 280, profitRate: 15 },
          { month: '3月', sales: 510, revenue: 98, orders: 410, profitRate: 22 },
          { month: '4月', sales: 460, revenue: 110, orders: 390, profitRate: 20 },
          { month: '5月', sales: 590, revenue: 125, orders: 480, profitRate: 25 },
          { month: '6月', sales: 650, revenue: 148, orders: 550, profitRate: 28 },
        ]}}
      case '/api/dashboard/category-share':
        return { data: { list: [
          { name: '电子产品', value: 45 },
          { name: '家具家居', value: 25 },
          { name: '服装配饰', value: 15 },
          { name: '食品饮料', value: 10 },
          { name: '其他', value: 5 },
        ]}}
      case '/api/dashboard/ad-vs-sales':
        return { data: { list: [
          { ad: 5,  sales: 320 }, { ad: 8,  sales: 380 },
          { ad: 12, sales: 420 }, { ad: 15, sales: 480 },
          { ad: 18, sales: 510 }, { ad: 22, sales: 590 },
          { ad: 25, sales: 620 }, { ad: 30, sales: 650 },
          { ad: 10, sales: 350 }, { ad: 20, sales: 540 },
        ]}}
      case '/api/dashboard/product-scores':
        return { data: { list: [
          { metric: '性能', score: 85 },
          { metric: '稳定性', score: 72 },
          { metric: '易用性', score: 90 },
          { metric: '安全性', score: 78 },
          { metric: '扩展性', score: 65 },
          { metric: '兼容性', score: 88 },
        ]}}
      case '/api/dashboard/quarterly-targets':
        return { data: { list: [
          { quarter: 'Q1', rate: 82 },
          { quarter: 'Q2', rate: 95 },
          { quarter: 'Q3', rate: 70 },
          { quarter: 'Q4', rate: 88 },
        ]}}

      // ===== 页面 JSON（供 Dialog 远程加载） =====
      case '/api/pages/productPicker': {
        return { data: {
          a2ui: [
            { beginRendering: { surfaceId: 'main', catalogId: 'basic' } },
            { surfaceUpdate: { surfaceId: 'main', components: [
              { id: 'root', component: 'Row', props: { children: ['pickerTitle', 'pickerInput', 'pickerTable', 'pickerActions'], gap: 12 } },
              { id: 'pickerTitle', component: 'Text', props: { text: '输入产品 ID 后点击"选择"，或从下方表格查看可用产品' } },
              { id: 'pickerInput', component: 'TextField', props: { label: '产品 ID', value: { path: '/selectedId' }, placeholder: '如 P001' } },
              { id: 'pickerTable', component: 'DataTable', props: {
                columns: [
                  { key: 'id', label: 'ID' },
                  { key: 'name', label: '产品名' },
                  { key: 'price', label: '单价' },
                  { key: 'unit', label: '单位' },
                  { key: 'status', label: '状态' },
                ],
                value: { path: '/products' },
                emptyText: '暂无产品',
              } },
              { id: 'pickerActions', component: 'Row', props: { children: ['selectBtn', 'closePickerBtn'], gap: 8 } },
              { id: 'selectBtn', component: 'Button', props: { label: '选择', variant: 'primary', reactionId: 'selectProduct' } },
              { id: 'closePickerBtn', component: 'Button', props: { label: '取消', variant: 'secondary', reactionId: 'closePicker' } },
            ] } },
            { updateDataModel: { surfaceId: 'main', path: '/products', value: products.map(p => ({
              id: p.id, name: p.name, price: p.price, unit: p.unit, status: p.status,
            })) } },
            { updateDataModel: { surfaceId: 'main', path: '/selectedId', value: '' } },
          ],
          logic: { reactions: [
            {
              id: 'selectProduct',
              when: { field: 'selectBtn', event: 'click' },
              then: [
                { type: 'setValues', map: { '/parent/productId': '/selectedId' } },
                { type: 'setValues', map: { '/parent/pickerOpen': false } },
              ],
            },
            {
              id: 'closePicker',
              when: { field: 'closePickerBtn', event: 'click' },
              then: [
                { type: 'setValues', map: { '/parent/pickerOpen': false } },
              ],
            },
          ] },
        } }
      }

      default:
        throw new Error(`Unknown API: ${req.url}`)
    }
  }
}

/**
 * 获取页面 JSON（供 Dialog 组件远程加载子页面）
 * /api/ 路径走 mock executor，https:// 及 localhost 走真实 fetch
 */
export async function fetchPageSource(source: string): Promise<{
  a2ui: any[]
  logic: { reactions: any[] }
} | null> {
  if (source.startsWith('/api/')) {
    const executor = createMockApiExecutor()
    try {
      const result = await executor({ url: source, method: 'GET' })
      return result.data as { a2ui: any[]; logic: { reactions: any[] } }
    } catch {
      return null
    }
  }
  const isSecureRemote = source.startsWith('https://')
  const isLocalDev = source.startsWith('http://localhost') || source.startsWith('http://127.0.0.1')
  if (!isSecureRemote && !isLocalDev) {
    logger.error(`[fetchPageSource] Only https:// and localhost URLs are allowed, got: ${source}`)
    return null
  }
  try {
    const resp = await fetch(source)
    if (!resp.ok) {
      logger.error(`[fetchPageSource] HTTP ${resp.status}: ${resp.statusText}`)
      return null
    }
    return await resp.json()
  } catch (err: any) {
    logger.error(`[fetchPageSource] Failed: ${err?.message || err}`)
    return null
  }
}
