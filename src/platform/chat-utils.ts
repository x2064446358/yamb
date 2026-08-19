interface TextField {
  value?: string
}

interface ChatComponentObject {
  text?: string | TextField
  translate?: string | TextField
  extra?: ChatComponent | ChatComponent[]
  with?: ChatComponent | ChatComponent[]
}

type ChatComponent = string | ChatComponent[] | ChatComponentObject

interface TextStyle {
  color?: string
  bold?: boolean
  italic?: boolean
  underlined?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
}

const ANSI_RESET = '\x1b[0m'
const MC_COLORS: Record<string, string> = {
  black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
  dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
  dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
  red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF'
}
const LEGACY_COLORS: Record<string, string> = {
  '0': 'black', '1': 'dark_blue', '2': 'dark_green', '3': 'dark_aqua', '4': 'dark_red',
  '5': 'dark_purple', '6': 'gold', '7': 'gray', '8': 'dark_gray', '9': 'blue',
  a: 'green', b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white'
}

function stripLegacyFormatting (value: string): string {
  return value.replace(/\u00a7[0-9A-FK-ORXa-fk-orx]/g, '')
}

function stylePrefix (style: TextStyle): string {
  const codes: string[] = []
  const color = style.color && (MC_COLORS[style.color] || style.color)
  if (color && /^#[0-9a-f]{6}$/i.test(color)) {
    const hex = color.slice(1)
    codes.push(`38;2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}`)
  }
  if (style.bold) codes.push('1')
  if (style.italic) codes.push('3')
  if (style.underlined) codes.push('4')
  if (style.strikethrough) codes.push('9')
  if (style.obfuscated) codes.push('8')
  return codes.length > 0 ? `\x1b[${codes.join(';')}m` : ''
}

function withStyle (text: string, style: TextStyle): string {
  if (!text) return ''
  const prefix = stylePrefix(style)
  return prefix ? `${prefix}${text}${ANSI_RESET}` : text
}

function legacyToAnsi (value: string, initial: TextStyle): string {
  let style = { ...initial }
  let output = ''
  let chunk = ''
  const flush = () => {
    output += withStyle(chunk, style)
    chunk = ''
  }

  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '\u00a7' || index + 1 >= value.length) {
      chunk += value[index]
      continue
    }
    flush()
    const code = value[++index].toLowerCase()
    if (LEGACY_COLORS[code]) {
      style = { color: LEGACY_COLORS[code] }
    } else if (code === 'l') style.bold = true
    else if (code === 'o') style.italic = true
    else if (code === 'n') style.underlined = true
    else if (code === 'm') style.strikethrough = true
    else if (code === 'k') style.obfuscated = true
    else if (code === 'r') style = {}
  }
  flush()
  return output
}

function nbtScalar (value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if ((record.type === 'string' || record.type === 'byte') && 'value' in record) return record.value
  return value
}

function componentToAnsiInner (component: unknown, inherited: TextStyle, seen: WeakSet<object>, depth = 0): string {
  if (depth > 40 || component == null) return ''
  if (typeof component === 'string') {
    try {
      return componentToAnsiInner(JSON.parse(component), inherited, seen, depth + 1)
    } catch {
      return legacyToAnsi(component, inherited)
    }
  }
  if (Array.isArray(component)) return component.map(part => componentToAnsiInner(part, inherited, seen, depth + 1)).join('')
  if (typeof component !== 'object') return withStyle(String(component), inherited)
  if (seen.has(component)) return ''
  seen.add(component)

  const value = component as Record<string, unknown>
  if ((value.type === 'compound' || value.type === 'list') && 'value' in value) {
    return componentToAnsiInner(value.value, inherited, seen, depth + 1)
  }
  if (value.type === 'string' && typeof value.value === 'string') return legacyToAnsi(value.value, inherited)

  const color = nbtScalar(value.color)
  const bold = nbtScalar(value.bold)
  const italic = nbtScalar(value.italic)
  const underlined = nbtScalar(value.underlined)
  const strikethrough = nbtScalar(value.strikethrough)
  const obfuscated = nbtScalar(value.obfuscated)
  const style: TextStyle = {
    ...inherited,
    ...(typeof color === 'string' ? { color } : {}),
    ...(typeof bold === 'boolean' ? { bold } : {}),
    ...(typeof italic === 'boolean' ? { italic } : {}),
    ...(typeof underlined === 'boolean' ? { underlined } : {}),
    ...(typeof strikethrough === 'boolean' ? { strikethrough } : {}),
    ...(typeof obfuscated === 'boolean' ? { obfuscated } : {})
  }

  let output = ''
  if (value.text != null) output += componentToAnsiInner(value.text, style, seen, depth + 1)
  else if (typeof value.translate === 'string') output += withStyle(value.translate, style)
  if (value.with) output += componentToAnsiInner(value.with, style, seen, depth + 1)
  if (value.extra) output += componentToAnsiInner(value.extra, style, seen, depth + 1)
  return output
}

/** Render a Minecraft JSON/NBT chat component with ANSI color/style codes. */
export function componentToAnsi (component: unknown): string {
  return componentToAnsiInner(component, {}, new WeakSet<object>())
}

function stripAnsiFormatting (value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '')
}

function componentToTextInner (component: unknown, seen: WeakSet<object>, depth = 0): string {
  if (depth > 40 || component == null) return ''
  if (typeof component === 'string') {
    try {
      return componentToTextInner(JSON.parse(component), seen, depth + 1)
    } catch {
      return stripLegacyFormatting(component)
    }
  }
  if (Array.isArray(component)) {
    if (seen.has(component)) return ''
    seen.add(component)
    return component.map(part => componentToTextInner(part, seen, depth + 1)).join('')
  }
  if (typeof component !== 'object') return String(component)
  if (seen.has(component)) return ''
  seen.add(component)

  const value = component as Record<string, unknown>
  if (value.type === 'compound' || value.type === 'list' || value.type === 'string') {
    return stripAnsiFormatting(componentToAnsi(component))
  }

  let text = ''
  if (value.text != null) text += componentToTextInner(value.text, seen, depth + 1)
  else if (value.translate != null) text += componentToTextInner(value.translate, seen, depth + 1)
  if (value.extra != null) text += componentToTextInner(value.extra, seen, depth + 1)
  if (value.with != null) text += componentToTextInner(value.with, seen, depth + 1)
  return text
}

export function componentToText (component: ChatComponent | null | undefined): string {
  if (!component) return ''
  return stripLegacyFormatting(componentToTextInner(component, new WeakSet<object>()))
}

export function usernameFromUuid (bot: { players?: Record<string, { uuid?: string }> }, uuid: string): string | null {
  if (!uuid || !bot) return null
  const normalized = String(uuid).toLowerCase()
  for (const [username, player] of Object.entries(bot.players || {})) {
    if (String(player.uuid || '').toLowerCase() === normalized) return username
  }
  return null
}
