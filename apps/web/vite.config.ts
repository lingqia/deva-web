import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import pkg from './package.json'

// 浏览器前端构建:root 固定 src/renderer,产物输出到包目录 out/renderer。
// 服务端产物(out/server)由 scripts/build.mjs 的 esbuild 负责,两者互不清空对方目录。
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  define: {
    // 版本号唯一来源 = 本包 package.json(服务端启动快照同源读取)
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true
  },
  server: {
    // 固定绑定 IPv4 回环 + 定端口:开发 Origin 是固定值(DEVA_WEB_ORIGIN 默认 http://127.0.0.1:5173),
    // 服务端按精确 Origin 校验,端口漂移会导致 WS 握手被拒,故 strictPort。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7421' },
      '/ws': { target: 'ws://127.0.0.1:7421', ws: true }
    }
  }
})
