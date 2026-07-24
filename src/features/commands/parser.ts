export function stripMcFormatting (text: string): string {
  return text.replace(/§./g, '').trim()
}

export function normalizeInput (text: string): string {
  return stripMcFormatting(text).replace(/^\/+/, '').trim()
}

export function matchesPrefix (text: string, prefix: string): boolean {
  const normalized = normalizeInput(text)
  if (!normalized.startsWith(prefix)) return false
  if (normalized === prefix) return true
  const after = normalized.slice(prefix.length)
  return after.startsWith(' ') || /^\d/.test(after)
}

export function parsePrefixedArgs (text: string, prefix: string): string[] {
  const normalized = normalizeInput(text)
  if (!matchesPrefix(normalized, prefix)) return []
  const rest = normalized.slice(prefix.length).trim()
  if (!rest) return []
  return rest.split(/\s+/)
}

export const KNOWN_COMMANDS = new Set([
  'phome', 'lock', 'unlock', 'add', 'remove', 'status', 'say', 'forward',
  'mount', '坐', 'unmount', '下车', '蹲下', 'cart', 'attack', 'container',
  'inv', 'store', 'take', 'drop',
  '挂机', '锁定', '解锁', '改锁定', '解锁all', '状态', '状态2', '状态3', '上车',
  '加白名单', '移除白名单', '白名单列表',
  '加管理员', '移除管理员', '管理员列表',
  '超管', '超管列表',
  '加phome白名单', '移除phome白名单', 'phome白名单列表',
  '加phome点', '移除phome点',
  '加黑', '黑名单',
  '丢弃', '丢弃全部', '手持',
  'use', 'place', 'look',
  '跳跃', '查', '指令', '指令循环',
  'dropall', 'hold', 'ride', 'xjump', 'xlook', 'xplace', 'xexec', 'xloop', 'xenchant',
  'xblacklist', 'xpwl', 'afk', 'afkhere',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '10', '11', '12', '13', '14', '15'
])

export function isKnownCommand (cmd: string): boolean {
  return KNOWN_COMMANDS.has(cmd.toLowerCase())
}

export function parseWhisperCommand (text: string): string[] | null {
  const normalized = normalizeInput(text)
  if (!normalized) return null
  const parts = normalized.split(/\s+/)
  const cmd = parts[0]?.toLowerCase()
  if (!cmd || !isKnownCommand(cmd)) return null
  return parts
}

export function parsePublicCommand (text: string, prefix: string): string[] | null {
  if (!matchesPrefix(text, prefix)) return null
  const args = parsePrefixedArgs(text, prefix)
  if (args.length === 0) return null
  return args
}

export type CommandSource = 'chat' | 'whisper'

export function parseCommandInput (
  text: string,
  prefix: string,
  source: CommandSource,
  allowPublicCommands: boolean
): string[] | null {
  if (source === 'whisper') {
    return parseWhisperCommand(text)
  }
  if (!allowPublicCommands) return null
  return parsePublicCommand(text, prefix)
}
