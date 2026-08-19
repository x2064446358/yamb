import { startApp, stopApp } from './app'
import { debug, warn, error } from './platform/logger'
import { stopConsoleUI } from './platform/console-ui'

// 进程信号与全局异常处理只注册一次（index.ts 作为入口不会被重载）
let shuttingDown = false
async function shutdown (exitCode = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  debug('[Main] Shutting down...')
  stopConsoleUI()
  try {
    await stopApp()
  } finally {
    process.exit(exitCode)
  }
}

process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })

process.on('uncaughtException', (err) => {
  error('[Main] Uncaught exception:', err)
  void shutdown(1)
})

process.on('unhandledRejection', (reason, promise) => {
  const msg = String(reason)
  if (msg.includes('blockUpdate') || msg.includes('did not fire within timeout')) {
    warn('[Main] Place block timeout (ignored)')
    return
  }
  error('[Main] Unhandled rejection at:', promise, 'reason:', reason)
})

startApp().catch(err => {
  console.error('[Main] Fatal error:', err)
  void shutdown(1)
})
