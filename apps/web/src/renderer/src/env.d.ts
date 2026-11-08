/**
 * 渲染层全局类型声明(保持全局脚本形态:无顶层 import/export,否则 declare 全部模块化)。
 * 原 electron-vite / preload/index.d.ts 的全局声明已随 preload 目录删除:
 * window.deva 的类型来自 @shared/api 的显式契约(WindowDevaApi),实现于 src/web 客户端桥(P5)。
 */

/** 构建时由 scripts/build.mjs 注入(esbuild define,服务端与前端同源取值),值取自 apps/web/package.json。 */
declare const __APP_VERSION__: string

/** 静态资源（vite 构建为带哈希的 URL）。 */
declare module '*.svg' {
  const src: string
  export default src
}

interface Window {
  /** 客户端桥:白名单 API 契约(通道清单与去向见 docs/web-api-inventory.md)。 */
  deva: import('@shared/api').WindowDevaApi
  /**
   * 登录后预取的启动快照(承接已删除的 config:get-sync 通道):首帧主题/语言/布局从这里读,避免闪烁;
   * config:set 成功后由客户端同步更新。未登录 / 尚未预取时为 undefined,调用点须兜底 ?? {}。
   */
  __DEVA_BOOTSTRAP__?: import('@shared/api').DevaBootstrap
}
