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
  // ===== BI 看板 =====
  {
    url: '/api/dashboard/kpi',
    method: 'GET' as const,
    description: '获取看板 KPI 指标。totalSales/totalOrders 可被 WebSocket 实时推送覆盖，trend/spark 为历史数据不走推送',
    responseExample: {
      totalSales: 6580, salesTrend: 18.5, salesSpark: [420, 380, 510, 460, 590, 650],
      totalOrders: 2430, ordersTrend: 12.3, ordersSpark: [320, 280, 410, 390, 480, 550],
      avgPrice: 2.71, avgPriceTrend: -3.2, avgPriceSpark: [2.8, 2.5, 2.9, 3.1, 2.7, 2.71],
      profitRate: 22.8, profitRateTrend: 5.1, profitRateSpark: [18, 15, 22, 20, 25, 28],
    },
  },
  {
    url: '/api/dashboard/monthly-stats',
    method: 'GET' as const,
    description: '获取月度统计（销售额/营收/订单量/利润率，多图表共用）',
    responseExample: {
      list: [
        { month: '1月', sales: 420, revenue: 85, orders: 320, profitRate: 18 },
        { month: '2月', sales: 380, revenue: 72, orders: 280, profitRate: 15 },
        { month: '3月', sales: 510, revenue: 98, orders: 410, profitRate: 22 },
        { month: '4月', sales: 460, revenue: 110, orders: 390, profitRate: 20 },
        { month: '5月', sales: 590, revenue: 125, orders: 480, profitRate: 25 },
        { month: '6月', sales: 650, revenue: 148, orders: 550, profitRate: 28 },
      ],
    },
  },
  {
    url: '/api/dashboard/category-share',
    method: 'GET' as const,
    description: '获取各品类市场占比',
    responseExample: {
      list: [
        { name: '电子产品', value: 45 },
        { name: '家具家居', value: 25 },
        { name: '服装配饰', value: 15 },
        { name: '食品饮料', value: 10 },
        { name: '其他', value: 5 },
      ],
    },
  },
  {
    url: '/api/dashboard/ad-vs-sales',
    method: 'GET' as const,
    description: '获取广告投入 vs 销售额散点数据',
    responseExample: {
      list: [
        { ad: 5, sales: 320 }, { ad: 8, sales: 380 },
        { ad: 12, sales: 420 }, { ad: 15, sales: 480 },
        { ad: 18, sales: 510 }, { ad: 22, sales: 590 },
        { ad: 25, sales: 620 }, { ad: 30, sales: 650 },
        { ad: 10, sales: 350 }, { ad: 20, sales: 540 },
      ],
    },
  },
  {
    url: '/api/dashboard/product-scores',
    method: 'GET' as const,
    description: '获取产品综合评分（雷达图）',
    responseExample: {
      list: [
        { metric: '性能', score: 85 },
        { metric: '稳定性', score: 72 },
        { metric: '易用性', score: 90 },
        { metric: '安全性', score: 78 },
        { metric: '扩展性', score: 65 },
        { metric: '兼容性', score: 88 },
      ],
    },
  },
  {
    url: '/api/dashboard/quarterly-targets',
    method: 'GET' as const,
    description: '获取各季度目标完成率',
    responseExample: {
      list: [
        { quarter: 'Q1', rate: 82 },
        { quarter: 'Q2', rate: 95 },
        { quarter: 'Q3', rate: 70 },
        { quarter: 'Q4', rate: 88 },
      ],
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
