import { spawn } from 'child_process'
import path from 'path'

/**
 * 多 bot 同窗启动器：在同一个终端里同时运行 7 个 bot。
 * 每个 bot 以 MC_NO_TUI=1 启动（跳过全屏 UI），输出加 [Bot1]..[Bot7] 前缀合并显示。
 * 用法: npm run start:all   （或 start_all.bat）
 */

interface BotSpec {
  name: string
  envFile: string
}

const BOTS: BotSpec[] = [
  { name: 'Bot1', envFile: '.env.bot1' },
  { name: 'Bot2', envFile: '.env.bot2' },
  { name: 'Bot3', envFile: '.env.bot3' },
  { name: 'Bot4', envFile: '.env.bot4' },
  { name: 'Bot5', envFile: '.env.bot5' },
  { name: 'Bot6', envFile: '.env.bot6' },
  { name: 'Bot7', envFile: '.env.bot7' }
]

const DIM = '\x1b[2;37m'
const CYAN = '\x1b[1;36m'
const RST = '\x1b[0m'

// 每个子进程一行行转发，避免 chunk 切在行中间
// 注意：必须累积 Buffer 再按行解码，否则 emoji 等多字节字符被 chunk 边界切成 U+FFFD
class LineForwarder {
  private buf = Buffer.alloc(0)
  constructor (private name: string) {}

  push (chunk: Buffer | string): void {
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8')
    this.buf = Buffer.concat([this.buf, c])
    let nl: number
    while ((nl = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.subarray(0, nl)
      this.buf = this.buf.subarray(nl + 1)
      const text = line.toString('utf-8')
      if (text.trim()) this.emitLine(text)
    }
  }

  private emitLine (line: string): void {
    process.stdout.write(`${DIM}[${this.name}]${RST} ${line}\n`)
  }

  flush (): void {
    if (this.buf.length > 0) {
      const text = this.buf.toString('utf-8')
      if (text.trim()) this.emitLine(text)
    }
    this.buf = Buffer.alloc(0)
  }
}

function main (): void {
  // 同窗模式父进程也切到 UTF-8，保证子进程转发上来的 emoji/中文正常显示
  if (process.platform === 'win32') {
    try { spawn('cmd', ['/c', 'chcp 65001 > nul'], { stdio: 'ignore' }) } catch { /* */ }
  }

  console.log(`${CYAN}${'━'.repeat(40)}${RST}`)
  console.log(`${CYAN}  多 bot 同窗模式：Bot1 / Bot2 / Bot3 / Bot4 / Bot5 / Bot6 / Bot7${RST}`)
  console.log(`${CYAN}  Ctrl+C 退出全部${RST}`)
  console.log(`${CYAN}${'━'.repeat(40)}${RST}`)

  const children: Array<ReturnType<typeof spawn>> = []
  const forwarders = new Map<ReturnType<typeof spawn>, LineForwarder>()

  for (const bot of BOTS) {
    const child = spawn(process.execPath, [
      `--env-file=${path.join(process.cwd(), bot.envFile)}`,
      '--max-old-space-size=1536',
      '--expose-gc',
      '--import', 'tsx',
      'src/index.ts'
    ], {
      cwd: process.cwd(),
      env: { ...process.env, MC_NO_TUI: '1' },
      stdio: ['inherit', 'pipe', 'pipe']
    })

    children.push(child)
    const fw = new LineForwarder(bot.name)
    forwarders.set(child, fw)
    child.stdout.on('data', (c: Buffer) => fw.push(c))
    child.stderr.on('data', (c: Buffer) => fw.push(c))
    child.on('exit', (code) => {
      fw.flush()
      console.log(`${DIM}[${bot.name}] 进程退出 (code=${code})${RST}`)
    })
  }

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`${DIM}正在停止所有 bot...${RST}`)
    for (const c of children) { try { c.kill('SIGINT') } catch { /* */ } }
    setTimeout(() => process.exit(0), 1500)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // 子进程全部退出后，父进程也退出
  let alive = children.length
  for (const c of children) {
    c.on('exit', () => {
      alive--
      if (alive <= 0) { setTimeout(() => process.exit(0), 500) }
    })
  }
}

main()
