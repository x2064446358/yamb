import { spawn } from 'child_process'
import type { CommandSource } from '../commands/parser'

type Reply = (username: string, message: string, source: CommandSource) => Promise<void>

/** Application-provided in-process reload action. */
let reloadHook: (() => void) | null = null

export function setReloadHook (fn: () => void): void {
  reloadHook = fn
}

/** Handles terminal-only reload, with a child-process fallback for standalone use. */
export async function reloadBot (source: CommandSource, reply: Reply): Promise<void> {
  if (source !== 'console') {
    await reply('console-admin', '重载 仅限终端使用', source)
    return
  }

  if (reloadHook) {
    await reply('console-admin', '正在重载 bot 脚本（进程内软重启，保持窗口）...', 'console')
    setTimeout(() => { reloadHook?.() }, 300)
    return
  }

  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, YAMB_RELOAD: '1' },
      stdio: 'inherit'
    })
    child.unref()
    await reply('console-admin', '正在重载 bot 脚本，新进程将自动接管...', 'console')
    setTimeout(() => process.exit(0), 1000)
  } catch (err) {
    await reply('console-admin', `重载失败: ${(err as Error).message}`, 'console')
  }
}
