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

      default:
        throw new Error(`Unknown API: ${req.url}`)
    }
  }
}
