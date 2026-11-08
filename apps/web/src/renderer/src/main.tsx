/**
 * 应用入口(动态启动,web-migration-plan.md §8.1)。
 *
 * 本文件只做一件事:同步安装 window.deva 客户端桥,然后动态 import 引导模块。
 * 不能把业务/引导模块静态 import 进来 —— ESM 静态 import 先于本模块体求值,
 * installDevaBridge() 会晚于它们执行;业务模块(含 Provider 树、ChatFirstShell)必须只在
 * 认证成功后求值(见 boot.tsx 的 lazy 工厂与 AuthProvider 四态)。
 *
 * 启动时序:
 *   1. installDevaBridge():window.deva 挂载 + __DEVA_BOOTSTRAP__ = {config:{}}(登录前空配置兜底);
 *   2. import('./boot'):auth/me → 401 登录页 / 200 预取 config + 建 WS + 动态加载业务树 / 错误页。
 */
import { installDevaBridge } from '../../web/deva'

installDevaBridge()

void import('./boot')
