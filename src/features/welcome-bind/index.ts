import type MinecraftBot from '../../platform/minecraft-bot'
import { debug } from '../../platform/logger'

// The collector normally sends UUIDs, but some messages use an 11-character
// final group. Accept both collector formats while keeping the ID shape strict.
const COLLECTOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{11,12}$/i
const DEDUPE_MS = 30_000

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unwrapNbt (value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(unwrapNbt)

  const record = value as Record<string, unknown>
  if ((record.type === 'compound' || record.type === 'list') && 'value' in record) {
    return unwrapNbt(record.value)
  }
  if (record.type === 'string' && typeof record.value === 'string') return record.value
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, unwrapNbt(item)]))
}

function collectClickCommands (value: unknown, commands: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectClickCommands(item, commands)
    return
  }
  if (!isRecord(value)) return

  const click = value.clickEvent ?? value.click_event
  if (isRecord(click) && click.action === 'run_command' && typeof click.value === 'string') {
    commands.add(click.value)
  }
  for (const item of Object.values(value)) collectClickCommands(item, commands)
}

function parseEmbeddedJson (text: string): unknown | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  try { return JSON.parse(text.slice(start)) } catch { return null }
}

/**
 * Executes only the signed-format welcome binding command published by the
 * UuidCollector service. It never executes arbitrary click events.
 */
export default class WelcomeBindModule {
  private readonly recent = new Map<string, number>()

  constructor (private readonly mcBot: MinecraftBot) {}

  handle (component: unknown, plainText: string): void {
    let serialized = ''
    try { serialized = JSON.stringify(component) } catch { /* ignore malformed component */ }
    const source = `${plainText}\n${serialized}`
    if (!source.includes('UuidCollectorBot') || !source.includes('UuidCollector JSON')) return

    const commands = new Set<string>()
    collectClickCommands(unwrapNbt(component), commands)

    // MCC can forward the component as a JSON string inside a text message.
    const embedded = parseEmbeddedJson(plainText)
    if (embedded) collectClickCommands(unwrapNbt(embedded), commands)

    for (const candidate of commands) this.executeIfWelcomeBind(candidate)
  }

  private executeIfWelcomeBind (candidate: string): void {
    const parts = candidate.trim().split(/[ \t]+/)
    if (parts.length !== 4 || parts[0] !== '/tsl' || parts[1] !== 'bindwelcome') return
    if (!COLLECTOR_ID.test(parts[2]) || !COLLECTOR_ID.test(parts[3])) return

    const command = `/tsl bindwelcome ${parts[2]} ${parts[3]}`
    const now = Date.now()
    for (const [key, time] of this.recent) {
      if (now - time > DEDUPE_MS) this.recent.delete(key)
    }
    if (this.recent.has(command)) return

    if (this.mcBot.chat(command)) {
      this.recent.set(command, now)
      debug('[WelcomeBind] Sent bindwelcome command')
    }
  }
}
