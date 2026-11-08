import { defineConfig } from 'vitest/config'

// 单测配置(P5):与 vite.config.ts(root=src/renderer,服务前端构建/HMR)分离,
// 以包根扫描 src/web 客户端桥单测;不影响 Vite 构建 —— vite build 只读 vite.config.ts。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts']
  }
})
