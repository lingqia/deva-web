import { ChatFirstShell } from './redesign/ChatFirstShell'
import { WebFolderPickerHost } from './components/WebFolderPicker'

/**
 * 应用根组件：渲染「对话优先」外壳。
 *
 * 旧的 IDE 式外壳（AppShell + 活动栏/侧边面板/底部终端/状态栏等）已整体下线删除，
 * 只保留对话优先形态；相关 store（ui/git）与演示数据一并移除。
 * WebFolderPickerHost 常驻：任一调用点（工作区挂载/打开、mount 请求卡）经
 * pickServerFolder() 唤起「选择服务器目录」对话框（P6，plan §8.2）。
 */
export function App(): React.JSX.Element {
  return (
    <>
      <WebFolderPickerHost />
      <ChatFirstShell />
    </>
  )
}
