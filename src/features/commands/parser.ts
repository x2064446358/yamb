export function stripMcFormatting (text: string): string {
  return text.replace(/§./g, '').trim()
}

export function normalizeInput (text: string): string {
  return stripMcFormatting(text).replace(/^\/+/, '').replace(/\s*喵~$/g, '').trim()
}

export function matchesPrefix (text: string, prefix: string): boolean {
  const normalized = normalizeInput(text)
  return normalized.startsWith(prefix)
}

export function parsePrefixedArgs (text: string, prefix: string): string[] {
  const normalized = normalizeInput(text)
  if (!matchesPrefix(normalized, prefix)) return []
  const rest = normalized.slice(prefix.length).trim()
  if (!rest) return []
  return rest.split(/\s+/)
}

export const KNOWN_COMMANDS = new Set([
  'lock', 'unlock', 'add', 'remove', 'status', 'say', 'forward',
  'mount', '坐', 'unmount', '下车', '蹲下', 'cart', 'attack', 'container',
  'inv', 'store', 'take', 'drop',
  '挂机', '锁定', '解锁', '改锁定', '解锁all', '状态', '状态2', '状态3', '上车',
  '加白名单', '移除白名单', '白名单列表',
  '加phome白名单', '移除phome白名单', 'phome白名单列表',
  '加phome超管', '移除phome超管', 'phome超管列表',
  '加phome点', '移除phome点',
  '加黑',
  '丢弃', '丢弃全部', '手持',
  '使用', 'place', '放置', 'look', '看向', '装水', 'fillwater',
  '跳跃', '查', '指令', '指令循环',
  'help', '帮助',
  'brew', '酿酒', 'node', '定时',
  '加酿酒白名单', '移除酿酒白名单', '酿酒白名单列表',
  'dropall', 'hold', 'ride', 'xjump', 'xlook', 'xplace', 'xexec', 'xloop', 'xenchant',
  'xblacklist', 'xpwl', 'afk', 'afkhere',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '10', '11', '12', '13', '14', '15'
])

export function isKnownCommand (cmd: string): boolean {
  if (/^\d+$/.test(cmd)) return true // 数字命令（phome 编号快捷，私聊 1-n 直传）
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

export type CommandSource = 'chat' | 'whisper' | 'console'

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
