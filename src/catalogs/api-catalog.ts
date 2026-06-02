export const apiCatalog = [
  {
    url: '/api/products',
    method: 'GET' as const,
    description: '按产品大类查询产品列表',
    params: {
      category: { type: 'string', required: true, description: '产品大类编码' },
    },
    responseExample: {
      list: [
        { id: 'P001', name: '笔记本电脑', price: 5999, unit: '台' },
        { id: 'P002', name: '机械键盘', price: 899, unit: '个' },
        { id: 'P003', name: '显示器 27寸', price: 2499, unit: '台' },
      ],
    },
  },
  {
    url: '/api/product-detail',
    method: 'GET' as const,
    description: '根据产品ID查询详情',
    params: {
      id: { type: 'string', required: true, description: '产品ID' },
    },
    responseExample: {
      id: 'P001',
      name: '笔记本电脑',
      price: 5999,
      unit: '台',
      stock: 50,
      status: 'active',
    },
  },
  {
    url: '/api/orders',
    method: 'GET' as const,
    description: '查询订单列表（支持关键词搜索订单号/产品名）',
    params: {
      keyword: { type: 'string', description: '搜索关键词（匹配订单号或产品名）' },
    },
    responseExample: {
      list: [
        { orderId: 'ORD001', productId: 'P001', productName: '笔记本电脑', quantity: 2, unitPrice: 5999, totalPrice: 11998, status: 'created', createdAt: '2026-05-10 10:30:00' },
      ],
    },
  },
  {
    url: '/api/orders',
    method: 'POST' as const,
    description: '创建订单',
    body: {
      productId: { type: 'string', required: true },
      quantity: { type: 'number', required: true },
      unitPrice: { type: 'number', required: true },
    },
    responseExample: {
      orderId: 'ORD001',
      status: 'created',
      message: '订单创建成功',
    },
  },

  // ===== 店铺相关 =====
  {
    url: '/api/shops',
    method: 'GET' as const,
    description: '查询店铺列表（支持按名称/城市搜索）',
    params: {
      keyword: { type: 'string', description: '搜索关键词（匹配店铺名或城市）' },
    },
    responseExample: {
      list: [
        { id: 'S001', name: '朝阳旗舰店', city: '北京', manager: '张三', phone: '13800001111', status: 'active' },
      ],
    },
  },
  {
    url: '/api/shop-detail',
    method: 'GET' as const,
    description: '根据店铺ID查询详情',
    params: {
      id: { type: 'string', required: true, description: '店铺ID' },
    },
    responseExample: {
      id: 'S001',
      name: '朝阳旗舰店',
      city: '北京',
      address: '朝阳区建国路88号',
      manager: '张三',
      phone: '13800001111',
      status: 'active',
      openDate: '2025-01-15',
    },
  },

  // ===== 用户相关 =====
  {
    url: '/api/users',
    method: 'GET' as const,
    description: '查询用户列表（支持按姓名/角色搜索）',
    params: {
      keyword: { type: 'string', description: '搜索关键词（匹配姓名或角色）' },
    },
    responseExample: {
      list: [
        { id: 'U001', name: '李四', role: '店长', shopName: '朝阳旗舰店', phone: '13900002222', status: 'active' },
      ],
    },
  },
  {
    url: '/api/user-detail',
    method: 'GET' as const,
    description: '根据用户ID查询详情',
    params: {
      id: { type: 'string', required: true, description: '用户ID' },
    },
    responseExample: {
      id: 'U001',
      name: '李四',
      role: '店长',
      shopName: '朝阳旗舰店',
      phone: '13900002222',
      email: 'lisi@example.com',
      status: 'active',
      createdAt: '2024-06-01',
    },
  },
  {
    url: '/api/login',
    method: 'POST' as const,
    description: '用户登录',
    body: {
      username: { type: 'string', required: true },
      password: { type: 'string', required: true },
    },
    responseExample: {
      token: 'mock-jwt-token',
      user: { id: 'U001', name: '李四', role: '店长' },
      message: '登录成功',
    },
  },
] as const
