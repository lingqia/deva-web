import { getConfig, setConfig } from './config'

/**
 * 扩展（技能 / MCP 服务）的可用角色：让某个技能或 MCP 只给指定的几个角色用，形成角色的专属能力。
 *
 * - 存 `config.json` 的 `skills.roles[id]` / `mcp.roles[id]`（与各自的 `enabled` 映射并列），值为角色 id 数组。
 *   **映射里没有 = 全部角色可用**：新装的技能 / 新接的 MCP 默认人人可用，行为与没有这项设置时一致。
 * - 指定的角色后来都删了：该项改回全部角色并停用（见 pruneRoles；不会停在「没有角色能用」）。
 * - 只管「这个角色的对话里看不看得到」：启用开关仍是总闸，MCP 的连接也与角色无关（启用即连接）。
 *   运行期由 chat.ts 按本对话绑定的角色过滤技能清单、skill 工具、`/技能名` 与 MCP 工具表。
 */

export type ExtSection = 'skills' | 'mcp'

function section(name: ExtSection): Record<string, unknown> {
  const s = getConfig()[name]
  return s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
}

function rolesMap(name: ExtSection): Record<string, string[]> {
  const roles = section(name).roles
  if (!roles || typeof roles !== 'object') return {}
  const out: Record<string, string[]> = {}
  for (const [id, v] of Object.entries(roles as Record<string, unknown>)) {
    if (Array.isArray(v)) out[id] = v.filter((x): x is string => typeof x === 'string')
  }
  return out
}

function writeRolesMap(name: ExtSection, map: Record<string, string[]>): void {
  setConfig({ [name]: { ...section(name), roles: map } })
}

/** 某项的可用角色；null = 全部角色。 */
export function getRoles(name: ExtSection, id: string): string[] | null {
  return rolesMap(name)[id] ?? null
}

/** 设置某项的可用角色；null = 全部角色（删掉该键）。 */
export function setRoles(name: ExtSection, id: string, roles: string[] | null): void {
  const map = rolesMap(name)
  if (roles === null) {
    if (!(id in map)) return
    delete map[id]
  } else {
    map[id] = [...new Set(roles.filter((r) => typeof r === 'string' && r))]
  }
  writeRolesMap(name, map)
}

/** 该项是否对这个角色可用（不看启用态）。 */
export function allowsPersona(name: ExtSection, id: string, personaId: string): boolean {
  const roles = getRoles(name, id)
  return roles === null || roles.includes(personaId)
}

/** 指定的角色都没了的项（已改回全部角色，待调用方停用）。 */
export interface OrphanedExts {
  skills: string[]
  mcp: string[]
}

/**
 * 从各项的可用角色里剔除 keep 不认的角色（删除角色时、启动时清理已不存在的角色）。剔除后一个不剩的项
 * 改回全部角色（删掉该键），并列在返回值里——调用方负责把它们停用：指定给的角色都没了，不该悄悄变成人人可用。
 */
export function pruneRoles(keep: (personaId: string) => boolean): OrphanedExts {
  const orphaned: OrphanedExts = { skills: [], mcp: [] }
  for (const name of ['skills', 'mcp'] as const) {
    const map = rolesMap(name)
    let changed = false
    for (const [id, roles] of Object.entries(map)) {
      const left = roles.filter(keep)
      if (left.length && left.length === roles.length) continue
      changed = true
      if (left.length) map[id] = left
      else {
        delete map[id]
        orphaned[name].push(id)
      }
    }
    if (changed) writeRolesMap(name, map)
  }
  return orphaned
}
