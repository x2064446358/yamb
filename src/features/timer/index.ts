export interface TimerInfo {
  username: string
  label: string
  finishAt: number
  display: string
}

export type TimerStartResult =
  | { status: 'started'; replaced: boolean; display: string }
  | { status: 'invalid'; input: string }
  | { status: 'too_long' }

interface TimerEntry extends TimerInfo {
  handle: ReturnType<typeof setTimeout>
}

/** In-memory player reminders. They intentionally do not survive a reload. */
export default class TimerModule {
  private readonly entries = new Map<string, TimerEntry>()
  private onDone: ((timer: TimerInfo) => void) | null = null

  setOnDone (fn: (timer: TimerInfo) => void): void {
    this.onDone = fn
  }

  start (username: string, label: string, rawDuration: string): TimerStartResult {
    const seconds = this.parseDuration(rawDuration)
    if (seconds == null || seconds <= 0) return { status: 'invalid', input: rawDuration }
    if (seconds > 200 * 1200) return { status: 'too_long' }

    const key = this.key(username, label)
    const existing = this.entries.get(key)
    if (existing) clearTimeout(existing.handle)

    const display = rawDuration.trim().toLowerCase().replace(/\s+/g, '')
    const finishAt = Date.now() + seconds * 1000
    const handle = setTimeout(() => {
      const entry = this.entries.get(key)
      if (!entry || entry.handle !== handle) return
      this.entries.delete(key)
      try {
        this.onDone?.({ username: entry.username, label: entry.label, finishAt: entry.finishAt, display: entry.display })
      } catch { /* Reminder delivery is best effort. */ }
    }, seconds * 1000)

    this.entries.set(key, { username, label, finishAt, display, handle })
    return { status: 'started', replaced: existing !== undefined, display }
  }

  cancel (username: string, label: string): boolean {
    const key = this.key(username, label)
    const entry = this.entries.get(key)
    if (!entry) return false
    clearTimeout(entry.handle)
    this.entries.delete(key)
    return true
  }

  list (username: string): TimerInfo[] {
    return [...this.entries.values()]
      .filter(entry => entry.username.toLowerCase() === username.toLowerCase())
      .sort((a, b) => a.finishAt - b.finishAt)
      .map(({ username: owner, label, finishAt, display }) => ({ username: owner, label, finishAt, display }))
  }

  dispose (): void {
    for (const entry of this.entries.values()) clearTimeout(entry.handle)
    this.entries.clear()
  }

  private key (username: string, label: string): string {
    return `${username.toLowerCase()}::${label.toLowerCase()}`
  }

  private parseDuration (raw: string): number | null {
    const value = raw.trim().toLowerCase().replace(/\s+/g, '')
    if (!value) return null

    const units: Record<string, number> = {
      '\u79d2': 1, s: 1,
      '\u5206': 60, '\u5206\u949f': 60, m: 60,
      '\u5c0f\u65f6': 3600, h: 3600,
      '\u6e38\u620f\u65e5': 1200
    }
    const pattern = /(\d+(?:\.\d+)?)([a-z\u4e00-\u9fa5]+)/g
    let total = 0
    let cursor = 0
    let matched = false
    let match: RegExpExecArray | null
    while ((match = pattern.exec(value)) !== null) {
      if (match.index !== cursor) return null
      const multiplier = units[match[2]]
      if (multiplier === undefined) return null
      total += Number(match[1]) * multiplier
      cursor = pattern.lastIndex
      matched = true
    }
    return matched && cursor === value.length ? total : null
  }
}
