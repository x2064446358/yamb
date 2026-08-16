import { setTermOutput } from './logger'

let onSend: ((msg: string) => void) | null = null
let botName = ''
let started = false
let inputBuf = ''
let inputPos = 0 // cursor position within inputBuf
let msgLines: string[] = []
let scrollOff = 0 // scroll offset (0 = bottom, >0 = scrolled up)
const MAX_MSGS = 1000
let paused = false

// Live status — updated externally
export interface UiStatus {
  online: boolean
  ping: number
  uptime: string
  health: number | null
  food: number | null
  pos: { x: number; y: number; z: number } | null
  dimension: string | null
  viewDistance: number | null
  state: string | null
  queueSize: number | null
  heldItem: string | null
  entityCount: number | null
  dayTime: string | null
  heapUsed: number | null
  brewDetail: string | null
}

let ui: UiStatus = {
  online: false, ping: 0, uptime: '', health: null, food: null,
  pos: null, dimension: null, viewDistance: null, state: null, queueSize: null,
  heldItem: null, entityCount: null, dayTime: null, heapUsed: null, brewDetail: null
}

// TUI 输出拦截：把 console.log / 直接写 stdout/stderr 的杂散输出转成消息显示在消息区，
// 避免带换行的杂散输出污染画面（导致 UI 偏移一行 / 堆叠）。
let tuiWriting = false
const rawOutWrite = process.stdout.write.bind(process.stdout) as unknown as (chunk: unknown, ...args: unknown[]) => boolean

function tuiWrite (s: string): void {
  tuiWriting = true
  try { rawOutWrite(s) } finally { tuiWriting = false }
}

// 跨 write 缓冲：stdout 的多个 write 可能把 emoji 等多字节字符切到两次调用里，
// 直接各自 toString 会得到 U+FFFD。这里累积到行尾再按行解码。
let routeBuf = ''

function routeToUi (chunk: unknown, isErr: boolean): void {
  routeBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8')
  const parts = routeBuf.split('\n')
  routeBuf = parts.pop() ?? ''
  for (const line of parts) {
    const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    if (clean.trim()) addMsg(`${ts()}${isErr ? ' [ERROR]' : ''} ${clean}`)
  }
}

/** UI 启动后拦截杂散输出（console.log / 直接写 stdout/stderr），转成消息显示，避免污染画面 */
function installInterceptor (): void {
  const origOut = process.stdout.write.bind(process.stdout) as unknown as (...a: unknown[]) => boolean
  ;(process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = function (chunk: unknown, ...args: unknown[]): boolean {
    if (tuiWriting) return rawOutWrite(chunk as string, ...args)
    routeToUi(chunk, false)
    return true
  }
  const origErr = process.stderr.write.bind(process.stderr) as unknown as (...a: unknown[]) => boolean
  ;(process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = function (chunk: unknown): boolean {
    routeToUi(chunk, true)
    return true
  }
  ;(process.stdout as unknown as { __yambOrigWrite: (...a: unknown[]) => boolean }).__yambOrigWrite = origOut
  ;(process.stderr as unknown as { __yambOrigWrite: (...a: unknown[]) => boolean }).__yambOrigWrite = origErr
}

function uninstallInterceptor (): void {
  const o = (process.stdout as unknown as { __yambOrigWrite?: (...a: unknown[]) => boolean }).__yambOrigWrite
  const e = (process.stderr as unknown as { __yambOrigWrite?: (...a: unknown[]) => boolean }).__yambOrigWrite
  if (o) (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = o
  if (e) (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = e
}

const C  = '\x1b[1;36m'; const W  = '\x1b[1;37m'
const P  = '\x1b[1;35m'; const G  = '\x1b[1;32m'
const R  = '\x1b[1;31m'; const Y  = '\x1b[1;33m'
const D  = '\x1b[2;37m'; const RST = '\x1b[0m'
const S  = '\x1b[90m'   // dim gray
const B  = '\x1b[1;34m' // blue

function ww (): number {
  // 留 1 列余量：Windows Terminal 的 columns 有时比实际可视区多 1（滚动条），
  // 满宽写到最后一列会让边角 ┓/┛ 换行丢失
  return Math.max(20, (process.stdout.columns || 80) - 1)
}
function wh (): number { return process.stdout.rows || 24 }
function hL (n: number): string { return '━'.repeat(n) }
function pad2 (n: number): string { return n.toString().padStart(2, '0') }
function ts (): string {
  const d = new Date()
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
function stripA (s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, '') }

/** 字符是否为双格宽。只有"确定双格"的才按 2 格算：
 *  CJK/全角一定双格；代理对(emoji 等 >0xFFFF)在终端普遍双格。
 *  几何图形/杂项符号(♥●◈✦ 等)属"模糊宽度"，不同终端渲染不同，一律按单格算，避免顶栏右边界偏移。 */
function isWideChar (c: number): boolean {
  // CJK 及扩展
  if (c >= 0x1100 && c <= 0x115F) return true   // 谚文字母
  if (c >= 0x2E80 && c <= 0xA4CF) return true   // CJK 部首/汉字/扩展
  if (c >= 0xAC00 && c <= 0xD7A3) return true   // 谚文音节
  if (c >= 0xF900 && c <= 0xFAFF) return true   // CJK 兼容
  if (c >= 0xFE10 && c <= 0xFE6F) return true   // 竖排/兼容形式
  if (c >= 0xFF00 && c <= 0xFF60) return true   // 全角形式
  if (c >= 0xFFE0 && c <= 0xFFE6) return true   // 全角符号
  if (c > 0xFFFF) return true                   // 代理对（emoji 等）
  return false
}

/** Display width: CJK/emoji = 2, ASCII = 1. ANSI codes count as 0. */
function dw (s: string): number {
  let w = 0
  let inAnsi = false
  for (const ch of s) {
    if (inAnsi) { if (ch === 'm') inAnsi = false; continue }
    if (ch === '\x1b') { inAnsi = true; continue }
    w += isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1
  }
  return w
}

function fmtMsg (line: string): { icon: string; color: string; text: string } {
  const clean = stripA(line)
  const maxW = ww()
  // Detect type and replace text tag with icon + color
  if (clean.includes('[whisper]'))       return { icon: '◀', color: P,  text: clean.replace('[whisper]', '').trim() }
  if (clean.includes('[chat]'))          return { icon: '◉', color: W,  text: clean.replace('[chat]', '').trim() }
  if (clean.includes('[join]'))          return { icon: '✦', color: G,  text: clean.replace('[join]', '').trim() }
  if (clean.includes('[leave]'))         return { icon: '✖', color: R,  text: clean.replace('[leave]', '').trim() }
  if (clean.includes('[WARN]'))          return { icon: '▲', color: Y,  text: clean.replace('[WARN]', '').trim() }
  if (clean.includes('[ERROR]'))         return { icon: '●', color: R,  text: clean.replace('[ERROR]', '').trim() }
  if (clean.includes('[Reply]'))         return { icon: '✓', color: Y,  text: clean.replace('[Reply]', '').trim() }
  if (clean.includes('[Command'))        return { icon: '◆', color: C,  text: clean.replace('[Command]', '').trim() }
  if (clean.includes('[Riding]'))        return { icon: '⬆', color: G,  text: clean.replace('[Riding]', '').trim() }
  if (clean.includes('[Teleport]'))      return { icon: '◈', color: C,  text: clean.replace('[Teleport]', '').trim() }
  if (clean.includes('[death'))          return { icon: '☠', color: R,  text: clean }
  if (clean.includes('[respawn'))        return { icon: '↻', color: G,  text: clean }
  if (clean.includes('[MC:'))            return { icon: '○', color: D,  text: clean }
  return { icon: '·', color: D, text: clean }
}

let renderTimer: ReturnType<typeof setTimeout> | null = null
function schedule (): void {
  if (renderTimer) return
  renderTimer = setTimeout(() => { renderTimer = null; doRender() }, 16)
}

/** 原地覆写（不清屏）：滚动/刷新时顶栏与输入框固定不闪。
 *  \x1b[H 回到左上角逐行重写，\x1b[K 清每行旧内容，\x1b[J 清底部残留。 */
function writeScreen (out: string[]): void {
  // \x1b[H 回左上角 + \x1b[2J 强制清屏，保证每帧从干净状态重画，不残留旧帧导致堆叠
  tuiWrite('\x1b[H\x1b[2J' + out.map(l => l + '\x1b[K').join('\n') + '\x1b[J')
}

function doRender (): void {
  if (!started) return
  const w = ww(); const h = wh(); const out: string[] = []
  const inner = w - 2

  // ---- 顶栏：多行信息块 ----
  const dot = ui.online ? `${G}●${RST}` : `${D}○${RST}`
  const conn = ui.online ? `${G}在线${RST}` : `${D}断开${RST}`
  const upText = ui.uptime ? `${D}${ui.uptime}${RST}` : ''
  const pingText = ui.ping > 0 ? `${W}${ui.ping}ms${RST}` : ''
  const hp = ui.health != null ? `${R}♥${ui.health}${RST}` : ''
  const fp = ui.food != null ? `${Y}🍖${ui.food}${RST}` : ''
  const posText = ui.pos ? `${C}[${ui.pos.x},${ui.pos.y},${ui.pos.z}]${RST}` : ''
  const dimText = ui.dimension ? `${B}${ui.dimension}${RST}` : ''
  const vdText = ui.viewDistance != null ? `${P}视距${ui.viewDistance}${RST}` : ''
  const queueText = ui.queueSize != null && ui.queueSize > 0 ? `${S}队列${ui.queueSize}${RST}` : ''
  const dayText = ui.dayTime ? `${P}${ui.dayTime}${RST}` : ''
  const entityText = ui.entityCount != null ? `${S}实体${ui.entityCount}${RST}` : ''
  const heapText = ui.heapUsed != null ? `${S}内存${ui.heapUsed}MB${RST}` : ''
  const heldText = ui.heldItem ? `${W}手持:${ui.heldItem}${RST}` : ''
  const st = ui.state ? `${Y}${ui.state}${RST}` : ''

  const maxContent = Math.max(10, inner - 1)
  const pack = (parts: string[]): { text: string; w: number } => {
    let text = ''
    let cur = 0
    for (const part of parts) {
      if (!part) continue
      const pw = dw(stripA(part))
      if (cur + pw + (text ? 1 : 0) > maxContent) break
      if (text) { text += ' '; cur += 1 }
      text += part
      cur += pw
    }
    return { text, w: cur }
  }

  const headerRows: string[] = []
  const row1 = pack([
    `${B}◈${RST}${W}${botName}${RST}`,
    `${dot}${conn}`, pingText, upText
  ])
  headerRows.push(row1.text)

  const row2 = pack([hp, fp, posText, dimText, dayText, vdText])
  headerRows.push(row2.text)

  if (ui.brewDetail) {
    const row3 = pack([`${Y}酿酒${RST}`, `${C}${ui.brewDetail}${RST}`])
    headerRows.push(row3.text)
  } else {
    const row3 = pack([entityText, queueText, heapText, heldText, st])
    headerRows.push(row3.text)
  }

  const headerH = headerRows.length + 2
  out.push(`${C}┏${hL(inner)}┓${RST}`)
  for (const row of headerRows) {
    const rw = dw(stripA(row))
    out.push(`${C}┃${RST} ${row}${' '.repeat(Math.max(0, inner - 1 - rw))}${C}┃${RST}`)
  }
  out.push(`${C}┗${hL(inner)}┛${RST}`)

  // Messages
  const total = msgLines.length
  const msgH = Math.max(0, h - headerH - 1 - 3) // header + 滚动指示 + 输入框
  scrollOff = Math.max(0, Math.min(scrollOff, total - msgH))
  const end = total - scrollOff
  const start = Math.max(0, end - msgH)
  const vis = msgLines.slice(start, end)

  for (const line of vis) {
    const timeEnd = line.indexOf(' ')
    const timeStr = timeEnd > 0 ? line.slice(0, timeEnd) : ''
    const rest = timeEnd > 0 ? line.slice(timeEnd + 1) : line
    const f = fmtMsg(rest)
    const row = ` ${S}${timeStr}${RST} ${f.color}${f.icon}${RST} ${f.color}${f.text}${RST}`
    // 不补空格：\x1b[K 会清掉行尾旧内容；避免 vLn(JS长度) 对中文算窄导致换行挤乱布局
    out.push(row)
  }
  // 消息从顶部往下排，空白留在底部（像终端日志）；滚动到底时仍是最新在底
  for (let i = 0; i < msgH - vis.length; i++) out.push('')

  // Scroll indicator — only when scrolled up
  if (scrollOff > 0) {
    const pct = Math.round((scrollOff / Math.max(1, total - msgH)) * 100)
    const bar = `${S}─${RST} ${scrollOff}↑ ${pct}% ${S}${'─'.repeat(Math.max(0, w - 12 - String(scrollOff).length - String(pct).length))}${RST}`
    out.push(bar)
  } else {
    out.push('')
  }

  // Send box — always show, dimmed when paused
  const label = paused ? ' term ' : ' send '
  out.push(`${C}┏${label}${'━'.repeat(Math.max(0, w - 2 - label.length))}┓${RST}`)
  const inPrefix = paused ? `${C}┃${RST} ${Y}按 Enter 返回输入${RST} ${D}` : `${C}┃${RST} > ${W}`
  const inSuffix = `${RST}`
  const maxInW = Math.max(1, w - dw(stripA(inPrefix)) - 1)

  if (!paused) {
    let viewStart = 0
    let posW = 0
    for (let i = inputPos - 1; i >= 0; i--) {
      posW += dw(inputBuf[i])
      if (posW >= maxInW) { viewStart = i + 1; break }
    }
    let visInput = ''
    let visW = 0
    for (let i = viewStart; i < inputBuf.length; i++) {
      const cw = dw(inputBuf[i])
      if (visW + cw > maxInW) break
      visInput += inputBuf[i]
      visW += cw
    }
    const beforeCursor = inputBuf.slice(viewStart, inputPos)
    const cursorDW = dw(stripA(inPrefix)) + dw(beforeCursor)
    const inL = inPrefix + visInput + inSuffix
    out.push(inL + ' '.repeat(Math.max(0, w - dw(stripA(inL)))))
    out.push(`${C}┗${hL(inner)}┛${RST}`)
    writeScreen(out)
    tuiWrite(`\x1b[${h - 1};${cursorDW + 1}H`)
    return
  }

  // Paused: show dimmed input area
  const pauseL = inPrefix + inSuffix
  out.push(pauseL + ' '.repeat(Math.max(0, w - dw(stripA(pauseL)))))
  out.push(`${C}┗${hL(inner)}┛${RST}`)
  writeScreen(out)
}

function addMsg (text: string): void {
  const wasBottom = scrollOff === 0
  msgLines.push(text)
  if (msgLines.length > MAX_MSGS) msgLines = msgLines.slice(-MAX_MSGS)
  // Auto-scroll to bottom if already at bottom
  if (wasBottom) scrollOff = 0
  schedule()
}

let rawHandler: ((chunk: string) => void) | null = null

function togglePause (): void {
  paused = !paused
  if (paused) {
    // 退出 raw 输入模式，让终端能处理 F11 等快捷键；仍留在备用屏，界面继续刷新
    process.stdin.removeListener('data', rawHandler!)
    process.stdin.setRawMode(false)
    tuiWrite('\x1b[?1000l\x1b[?1006l')
    // In cooked mode, 'data' fires once per line on Enter
    process.stdin.once('data', () => { togglePause() })
  } else {
    // Resume raw mode for input capture
    process.stdin.setRawMode(true)
    process.stdin.setEncoding('utf-8')
    tuiWrite('\x1b[?1000h\x1b[?1006h')
    process.stdin.on('data', rawHandler!)
  }
  // Instant redraw for clean layout
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
  doRender()
}

export function startConsoleUI (name: string, send: (msg: string) => void): void {
  if (started) return
  if (process.env.MC_NO_TUI === '1' || !process.stdin.isTTY) return
  started = true; botName = name; onSend = send

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf-8')

  // 清主缓冲残留历史 → 进入备用屏 → 清备用屏并复位，保证 UI 从干净状态开始
  tuiWrite('\x1b[2J\x1b[3J\x1b[H\x1b[?1049h\x1b[2J\x1b[H')
  // Enable SGR mouse tracking for scroll wheel
  tuiWrite('\x1b[?1000h\x1b[?1006h')
  // 拦截杂散输出（console.log 等），避免污染画面
  installInterceptor()

  let escSeq = ''
  let escTimeout: ReturnType<typeof setTimeout> | null = null
  let mouseBytes = 0

  rawHandler = (chunk: string) => {
    // Paused: pass through to terminal. Esc or Enter resumes input.
    if (paused) {
      if (chunk === '\r' || chunk === '\n' || chunk === '\r\n' || chunk === '\x1b') { togglePause(); return }
      tuiWrite(chunk)
      return
    }
    for (const ch of chunk) {
      // Consume trailing bytes of \x1b[M mouse events
      if (mouseBytes > 0) { mouseBytes--; continue }
      if (escSeq) {
        // Reset timeout — more data arrived
        if (escTimeout) { clearTimeout(escTimeout); escTimeout = null }
        escSeq += ch
        // \x1b[M — legacy mouse event: 3 raw bytes follow, skip them
        if (escSeq === '\x1b[M') { mouseBytes = 3; escSeq = ''; schedule(); continue }
        // \x1bO — application mode prefix, wait for one more char
        if (escSeq === '\x1bO') continue
        // Sequence complete when last char is in @-~ range
        // BUT: \x1b[ is a CSI introducer, not complete — skip termination on bare '['
        if (escSeq !== '\x1b[' && ch >= '@' && ch <= '~') {
          const seq = escSeq; escSeq = ''
          // Mouse wheel (SGR format)
          const m = seq.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/)
          if (m) {
            const btn = parseInt(m[1], 10)
            const step = Math.max(1, Math.floor(wh() / 4))
            if (btn === 64) { scrollOff += step; schedule(); continue }
            if (btn === 65) { scrollOff = Math.max(0, scrollOff - step); schedule(); continue }
            continue
          }
          // Cursor keys (both ANSI \x1b[ and SS3 \x1bO)
          if (seq === '\x1b[D' || seq === '\x1bOD') { if (inputPos > 0) inputPos--; schedule(); continue }
          if (seq === '\x1b[C' || seq === '\x1bOC') { if (inputPos < inputBuf.length) inputPos++; schedule(); continue }
          if (seq === '\x1b[A' || seq === '\x1bOA') { schedule(); continue } // Up — ignore
          if (seq === '\x1b[B' || seq === '\x1bOB') { schedule(); continue } // Down — ignore
          // Home / End
          if (seq === '\x1b[H' || seq === '\x1bOH' || seq === '\x1b[1~') { inputPos = 0; schedule(); continue }
          if (seq === '\x1b[F' || seq === '\x1bOF' || seq === '\x1b[4~') { inputPos = inputBuf.length; schedule(); continue }
          // Delete
          if (seq === '\x1b[3~') { if (inputPos < inputBuf.length) { inputBuf = inputBuf.slice(0, inputPos) + inputBuf.slice(inputPos + 1); } schedule(); continue }
          // PgUp / PgDn
          if (seq === '\x1b[5~') { scrollOff += Math.max(1, Math.floor(wh() / 2)); schedule(); continue }
          if (seq === '\x1b[6~') { scrollOff = Math.max(0, scrollOff - Math.floor(wh() / 2)); schedule(); continue }
          // F1-F12 — pass through to terminal for fullscreen etc.
          if (/^\x1b\[(11|12|13|14|15|17|18|19|20|21|23|24)~$/.test(seq)) { tuiWrite(seq); schedule(); continue }
          if (/^\x1bO[PQRS]$/.test(seq)) { tuiWrite(seq); schedule(); continue }
          // All other escape sequences (mouse clicks, unknown keys) → consumed silently
          schedule()
        }
        continue
      }
      if (ch === '\x1b') {
        escSeq = ch
        if (escTimeout) clearTimeout(escTimeout)
        // 300ms timeout: lone Escape = toggle input/terminal mode
        escTimeout = setTimeout(() => {
          if (escSeq) { escSeq = ''; togglePause(); schedule() }
        }, 300)
        continue
      }
      // After lone Escape timeout, if next char is '[' or 'O', treat as start of late escape sequence
      if ((ch === '[' || ch === 'O') && !escSeq) {
        escSeq = '\x1b' + ch
        if (escTimeout) clearTimeout(escTimeout)
        continue
      }
      if (ch === '\x03') { process.stdin.setRawMode(false); tuiWrite('\x1b[?1000l\x1b[?1006l\x1b[?1049l'); process.exit(0) }
      if (ch === '\r' || ch === '\n') {
        const msg = inputBuf.trim()
        if (msg) { try { onSend?.(msg) } catch { /* */ }; inputBuf = ''; inputPos = 0; scrollOff = 0 }
        schedule(); continue
      }
      if (ch === '\x7f' || ch === '\b') {
        if (inputPos > 0) { inputBuf = inputBuf.slice(0, inputPos - 1) + inputBuf.slice(inputPos); inputPos-- }
        schedule(); continue
      }
      if (ch === '\t') { inputBuf = inputBuf.slice(0, inputPos) + '  ' + inputBuf.slice(inputPos); inputPos += 2; schedule(); continue }
      if (ch >= ' ') { inputBuf = inputBuf.slice(0, inputPos) + ch + inputBuf.slice(inputPos); inputPos++; schedule() }
    }
  }

  process.stdin.on('data', rawHandler)

  setTermOutput((text: string) => { addMsg(`${ts()} ${text}`) })
  doRender()
  process.stdout.on('resize', () => schedule())
}

export function setStatus (info: Partial<UiStatus>): void { ui = { ...ui, ...info }; schedule() }

/** 重载后更新终端输入的回调（onSend 是模块级变量，rawHandler 闭包引用它，改这里即可） */
export function setUiSend (send: (msg: string) => void): void {
  onSend = send
}
export function printLine (text: string): void { addMsg(`${ts()} ${text}`) }
export function stopConsoleUI (): void {
  setTermOutput(null)
  uninstallInterceptor()
  tuiWrite('\x1b[?1000l\x1b[?1006l\x1b[?1049l') // disable mouse tracking + 离开备用屏
  process.stdin.setRawMode(false)
  started = false
}
