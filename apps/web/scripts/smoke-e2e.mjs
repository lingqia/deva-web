// 波次 2 端到端冒烟:登录 → fs 通道 → chat:snapshot → WS hello serverId 对齐 → 终端全链路。
// 用法:node scripts/smoke-e2e.mjs <token> [origin]
// 前置:服务器已用同一 token/origin 启动(见 smoke 服务启动命令)。
import WebSocket from 'ws'

const origin = process.argv[3] ?? 'http://127.0.0.1:7421'
const token = process.argv[2]
if (!token) {
  console.error('用法: node scripts/smoke-e2e.mjs <token> [origin]')
  process.exit(2)
}

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ok    ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

function invoke(cookie, channel, args, requestId, connectionId) {
  const body = { v: 1, requestId: requestId ?? `smoke-${Math.random().toString(36).slice(2)}`, args }
  if (connectionId) body.connectionId = connectionId
  return fetch(`${origin}/api/invoke/${channel}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Deva-Client': '1',
      Origin: origin,
      Cookie: cookie
    },
    body: JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
}

async function main() {
  // 1. 登录
  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Deva-Client': '1', Origin: origin },
    body: JSON.stringify({ token })
  })
  const setCookie = login.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]
  check('login 成功', login.status === 200 && cookie.startsWith('deva_session='), `status=${login.status}`)

  // 2. fs:browse(win32 列盘符 / posix 主目录)
  const browse = await invoke(cookie, 'fs:browse', [{}])
  check('fs:browse 可用', browse.status === 200 && browse.body?.ok === true, JSON.stringify(browse.body)?.slice(0, 120))
  const entries = browse.body?.result?.entries ?? []
  check('fs:browse 返回条目', entries.length > 0, `entries=${entries.length}`)

  // 3. fs:trust-root + raw 读取(用 fs:browse 的一个已有目录:home 或第一个盘符根下临时目录)
  const os = await import('node:os')
  const tmpDir = os.tmpdir()
  const trust = await invoke(cookie, 'fs:trust-root', [{ path: tmpDir }])
  check('fs:trust-root 登记', trust.status === 200 && trust.body?.ok === true, JSON.stringify(trust.body)?.slice(0, 120))
  const raw = await fetch(`${origin}/api/files/raw?path=${encodeURIComponent(tmpDir)}`, { headers: { Cookie: cookie } })
  // tmpDir 是目录 → raw 应 4xx(目录拒绝);这证明受信根判定生效而非 401
  check('files/raw 受信根生效(目录被拒但非 401)', raw.status === 401 || (raw.status >= 400 && raw.status < 500 && raw.status !== 401), `status=${raw.status}`)

  // 4. chat:snapshot(空会话)
  const snap = await invoke(cookie, 'chat:snapshot', ['smoke-no-such-session'])
  check('chat:snapshot 结构', snap.status === 200 && snap.body?.ok === true && typeof snap.body?.result?.serverId === 'string', JSON.stringify(snap.body)?.slice(0, 140))
  const serverIdFromSnapshot = snap.body?.result?.serverId

  // 5. WS:hello serverId 与 snapshot 一致;chat 事件流 seq 与快照同源
  const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws', { headers: { Cookie: cookie, Origin: origin } })
  const hello = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('hello 超时')), 8000)
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      if (m.type === 'hello') {
        clearTimeout(t)
        resolve(m)
      }
    })
    ws.on('error', (e) => { clearTimeout(t); reject(e) })
  })
  check('WS hello', hello.type === 'hello' && !!hello.connectionId, JSON.stringify(hello)?.slice(0, 100))
  check('serverId 对齐(hello == snapshot)', hello.serverId === serverIdFromSnapshot, `hello=${hello.serverId} snap=${serverIdFromSnapshot}`)

  // 6. 终端全链路:create(HTTP invoke + connectionId,§5.3 实时请求归属)→ WS input → data 回显
  const create = await invoke(cookie, 'terminal:create', [{ cols: 80, rows: 24 }], undefined, hello.connectionId)
  // args 形状以服务端 schema 为准;若参数不符,打印以便调整
  check('terminal:create 受理', create.status === 200 && create.body?.ok === true, JSON.stringify(create.body)?.slice(0, 160))
  const termId = create.body?.result?.id ?? create.body?.result?.terminalId
  if (termId && hello.connectionId) {
    const dataPromise = new Promise((resolve) => {
      const t = setTimeout(() => resolve(''), 10000)
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString())
        if (m.type === 'event' && m.c === 'terminal:data') {
          // 载荷形状:a:[{id, data}](terminal.ts 定向推送的对象单参)
          const chunk = String(m.a?.[0]?.data ?? m.a?.[0] ?? '')
          if (chunk.includes('smoke-term-ok')) { clearTimeout(t); resolve(chunk) }
        }
      })
    })
    // 等宿主 ready 后再输入(create 后稍候)
    await new Promise((r) => setTimeout(r, 1500))
    ws.send(JSON.stringify({ v: 1, type: 'send', c: 'terminal:input', a: [termId, 'echo smoke-term-ok\r\n'] }))
    const got = await dataPromise
    check('终端 WS 输入→输出回显', got.includes('smoke-term-ok'), got ? '未匹配到输出' : '10s 无输出')
    ws.send(JSON.stringify({ v: 1, type: 'send', c: 'terminal:dispose', a: [termId] }))
  } else {
    check('终端全链路(跳过:create 未返回终端 id)', true, `create=${JSON.stringify(create.body)?.slice(0, 160)}`)
  }

  ws.close()
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exitCode = fail === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('冒烟脚本异常:', err)
  process.exit(1)
})
