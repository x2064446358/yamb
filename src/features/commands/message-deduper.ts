export default class MessageDeduper {
  private recent = new Map<string, number>()
  private readonly ttlMs: number

  constructor (ttlMs = 1500) {
    this.ttlMs = ttlMs
  }

  shouldSkip (username: string, message: string): boolean {
    const text = message.trim()
    if (!text || !username) return true
    // Some chat plugins emit the same line twice: once as plain text and
    // once with their decorative trailing "喵~" suffix. Treat that suffix
    // as presentation-only for the short duplicate window.
    return this.isSeen(`msg:${username}:${dedupeText(text)}`)
  }

  shouldSkipSystem (text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed) return true
    return this.isSeen(`sys:${trimmed}`)
  }

  shouldSkipEvent (eventKey: string): boolean {
    if (!eventKey) return true
    return this.isSeen(`evt:${eventKey}`)
  }

  private isSeen (key: string): boolean {
    const now = Date.now()

    for (const [k, time] of this.recent) {
      if (now - time > this.ttlMs) this.recent.delete(k)
    }

    const last = this.recent.get(key)
    if (last !== undefined && now - last < this.ttlMs) {
      return true
    }

    this.recent.set(key, now)
    return false
  }
}

function dedupeText (text: string): string {
  const normalized = text.trim().replace(/\s*喵(?:~|～)\s*$/u, '')
  return normalized || text.trim()
}
