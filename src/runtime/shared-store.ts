/**
 * shared-store.ts — 跨页面共享状态 (Zustand)
 *
 * 管理页面间导航参数、全局用户信息、token 等跨页持久化数据。
 * 使用 Zustand + persist 中间件，一行代码获得 localStorage 持久化。
 *
 * 未来扩展:
 * - 跨标签页同步: BroadcastChannel middleware
 * - DevTools: devtools middleware
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export interface SharedState {
  navParams: Record<string, any>
  userInfo: Record<string, any> | null
  token: string | null

  setNavParams: (p: Record<string, any>) => void
  clearNavParams: () => void
  setUserInfo: (info: Record<string, any> | null) => void
  setToken: (token: string | null) => void
  /** 批量更新（用于加载 JSON 的 shared.dataModel） */
  hydrate: (data: Record<string, any>) => void
}

export const useSharedStore = create<SharedState>()(
  persist(
    (set) => ({
      navParams: {},
      userInfo: null,
      token: null,

      setNavParams: (p) => set({ navParams: p }),
      clearNavParams: () => set({ navParams: {} }),
      setUserInfo: (info) => set({ userInfo: info }),
      setToken: (token) => set({ token }),
      hydrate: (data) => set((state) => ({ ...state, ...data })),
    }),
    {
      name: 'a2ui-shared',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        userInfo: state.userInfo,
        token: state.token,
      }),
    },
  ),
)
