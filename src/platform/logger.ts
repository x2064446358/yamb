import fs from 'fs'
import path from 'path'

const MAX_LOG_SIZE = 5 * 1024 * 1024 // 5MB

function pad2 (n: number): string { return n.toString().padStart(2, '0') }
function ts (): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

let logPath = ''
let logStream: fs.WriteStream | null = null

function rotateLog (): void {
  if (!logPath) return
  try {
    const stats = fs.statSync(logPath)
    if (stats.size < MAX_LOG_SIZE) return
  } catch { return }
  // Rotate: rename current → .1, create new
  const bak = logPath + '.1'
  try { fs.unlinkSync(bak) } catch { /* */ }
  try { fs.renameSync(logPath, bak) } catch { /* */ }
  logStream?.close()
  logStream = fs.createWriteStream(logPath, { flags: 'a' })
}

function writeLog (line: string): void {
  if (logStream) {
    rotateLog()
    logStream.write(`[${ts()}] ${line}\n`)
  }
}

export function initLogger (p: string): void {
  logPath = p
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  logStream = fs.createWriteStream(logPath, { flags: 'a' })
}

function toMsg (...args: unknown[]): string {
  return args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
}

let _termOut: ((msg: string) => void) | null = null

/** Called by console-ui to intercept all terminal output */
export function setTermOutput (fn: ((msg: string) => void) | null): void {
  _termOut = fn
}

function termWrite (msg: string): void {
  if (_termOut) { _termOut(msg); return }
  process.stdout.write(msg + '\n')
}

/** 聊天消息：仅终端 */
export function chat (msg: string): void {
  termWrite(`\x1b[2;37m${ts()}\x1b[0m \x1b[36m${msg}\x1b[0m`)
}

/** 重要事件：终端 + 文件 */
export function info (...args: unknown[]): void {
  const msg = toMsg(...args)
  termWrite(`\x1b[2;37m${ts()}\x1b[0m ${msg}`)
  writeLog(msg)
}

/** 警告：终端 + 文件 */
export function warn (...args: unknown[]): void {
  const msg = toMsg(...args)
  termWrite(`\x1b[2;37m${ts()}\x1b[0m \x1b[33m[WARN]\x1b[0m ${msg}`)
  writeLog(`[WARN] ${msg}`)
}

/** 错误：终端 + 文件 */
export function error (...args: unknown[]): void {
  const msg = toMsg(...args)
  termWrite(`\x1b[2;37m${ts()}\x1b[0m \x1b[31m[ERROR]\x1b[0m ${msg}`)
  writeLog(`[ERROR] ${msg}`)
}

/** 调试：仅文件 */
export function debug (...args: unknown[]): void {
  const msg = toMsg(...args)
  writeLog(`[DEBUG] ${msg}`)
}

export function closeLogger (): void {
  logStream?.close()
  logStream = null
}
