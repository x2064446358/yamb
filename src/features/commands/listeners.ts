import { componentToText, usernameFromUuid } from '../../platform/chat-utils'
import { getBotClient } from '../../platform/bot-client'
import { parseWhisperMessage, shouldIgnoreSystemMessage } from './whisper-parser'
import MessageDeduper from './message-deduper'
import type { CommandSource } from './parser'
import type MinecraftBot from '../../platform/minecraft-bot'
import type CommandHandler from './handler'
import type TeleportIncomingHandler from '../teleport/incoming-handler'
import type SystemMessageBuffer from './system-buffer'

const ANSI_MAP: Record<string, string> = {
  '0': '\x1b[0m',     // reset
  '1': '\x1b[0;34m',  // dark blue
  '2': '\x1b[0;32m',  // dark green
  '3': '\x1b[0;36m',  // dark aqua
  '4': '\x1b[0;31m',  // dark red
  '5': '\x1b[0;35m',  // dark purple
  '6': '\x1b[0;33m',  // gold
  '7': '\x1b[0;37m',  // gray
  '8': '\x1b[0;90m',  // dark gray
  '9': '\x1b[0;94m',  // blue
  'a': '\x1b[0;92m',  // green
  'b': '\x1b[0;96m',  // aqua
  'c': '\x1b[0;91m',  // red
  'd': '\x1b[0;95m',  // light purple
  'e': '\x1b[0;93m',  // yellow
  'f': '\x1b[0;97m',  // white
  'k': '\x1b[5m',     // obfuscated
  'l': '\x1b[1m',     // bold
  'm': '\x1b[9m',     // strikethrough
  'n': '\x1b[4m',     // underline
  'o': '\x1b[3m',     // italic
  'r': '\x1b[0m'      // reset
}

function mcToAnsi(text: string): string {
  return text.replace(/§([0-9a-fk-or])/gi, (_, code: string) => {
    return ANSI_MAP[code.toLowerCase()] || ''
  }) + '\x1b[0m'
}

type BotWithFlag = NonNullable<MinecraftBot['bot']> & { _mchatbotListenersRegistered?: boolean }

export function registerChatListeners (
  mcBot: MinecraftBot,
  commandHandler?: CommandHandler,
  teleportHandler?: TeleportIncomingHandler,
  systemBuffer?: SystemMessageBuffer
): void {
  const bot = mcBot.bot as BotWithFlag | null
  if (!bot) return
  if (bot._mchatbotListenersRegistered) return
  bot._mchatbotListenersRegistered = true

  const deduper = new MessageDeduper()

  function dispatch (username: string, message: string, source: CommandSource): void {
    const text = message.trim()
    if (!text || !username || deduper.shouldSkip(username, text)) return

    const colored = mcToAnsi(`${username}: ${text}`)
    console.log(`[MC:${source}] ${colored}`)
    teleportHandler?.handle(text)
    if (commandHandler) {
      void commandHandler.handle(username, text, source)
    }
  }

  function handleSystemText (text: string): void {
    const trimmed = text.trim()
    if (!trimmed || deduper.shouldSkipSystem(trimmed)) return

    if (shouldIgnoreSystemMessage(trimmed)) return

    console.log(`[MC:system] ${mcToAnsi(trimmed)}`)
    systemBuffer?.push(trimmed)
    teleportHandler?.handle(trimmed)

    // Phome accept: "玩家 X 已传送到你的位置"
    const phomeOk = trimmed.match(/玩家 (.+) 已传送到你的位置/)
    if (phomeOk && commandHandler) {
      const player = phomeOk[1]
      commandHandler.handlePhomeResult(true, player)
      return
    }

    // Phome reject / TPA reject
    const phomeRej = trimmed.match(/玩家 (.+) 拒绝了你的传送请求/)
    if (phomeRej && commandHandler) {
      const player = phomeRej[1]
      commandHandler.handlePhomeResult(false, player)
      return
    }

    // TPA success: "[TSL] 已传送到 X 的位置"
    const tpaOk = trimmed.match(/已传送到 (.+) 的位置/)
    if (tpaOk && commandHandler) {
      const player = tpaOk[1]
      commandHandler.handleTpaSuccess(player)
      return
    }

    // TPA reject from system
    if ((trimmed.includes('拒绝了你的传送请求') || trimmed.includes('传送请求已过期')) && commandHandler) {
      commandHandler.handleTpaFailed()
      return
    }

    const chatMatch = trimmed.match(/^『[^』]*』(.+?)\s*>\s*(.+)$/)
    if (chatMatch) {
      const playerName = chatMatch[1].trim()
      // Track 拉特兰 tagged players for phome access
      if (trimmed.includes('『拉特兰』')) {
        commandHandler?.addLatelanMember(playerName)
      }
      dispatch(playerName, chatMatch[2].trim(), 'chat')
      return
    }

    const whisper = parseWhisperMessage(trimmed)
    if (whisper) {
      dispatch(whisper.username, whisper.message, 'whisper')
      return
    }

  }

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    dispatch(username, message, 'chat')
  })

  bot.on('whisper', (username, message) => {
    if (username === bot.username) return
    dispatch(username, message, 'whisper')
  })

  getBotClient(bot)?.on('system_chat', (packet: unknown) => {
    try {
      const content = (packet as { content?: unknown }).content
      const message = componentToText(content as Parameters<typeof componentToText>[0])
      if (message) handleSystemText(message)
    } catch (error) {
      console.error('[Command] system_chat 处理失败:', error)
    }
  })

  bot.on('message', (jsonMsg) => {
    try {
      const ansi = jsonMsg.toAnsi()
      console.log(`[MSG] ${ansi}`)
      const text = jsonMsg.toString()
      const lm = text.match(/『拉特兰』([a-zA-Z0-9_]+)/)
      if (lm) commandHandler?.addLatelanMember(lm[1])
    } catch { /* */ }
  })

  bot.on('messagestr', (message, position) => {
    const text = String(message || '').trim()
    if (!text || position === 'chat') return
    handleSystemText(text)
  })

  getBotClient(bot)?.on('player_chat', (packet: unknown) => {
    const p = packet as Record<string, unknown>
    try {
      let message = ''
      let username: string | null = null

      if (p.senderUuid) {
        username = usernameFromUuid(bot, String(p.senderUuid))
      }
      if (!username && p.senderName) {
        username = componentToText(p.senderName as Parameters<typeof componentToText>[0])
      }

      if (p.plainMessage) {
        message = String(p.plainMessage)
      } else if (p.unsignedChatContent) {
        message = componentToText(p.unsignedChatContent as Parameters<typeof componentToText>[0])
      } else if (p.signedChatContent) {
        message = componentToText(p.signedChatContent as Parameters<typeof componentToText>[0])
      } else if (p.message) {
        message = componentToText(p.message as Parameters<typeof componentToText>[0])
      }

      if (username && message) {
        dispatch(username, message, 'chat')
      }
    } catch (error) {
      console.error('[Command] player_chat 处理失败:', error)
    }
  })

  bot.on('playerJoined', (player) => {
    if (player.username === bot.username) return
    if (deduper.shouldSkipEvent(`join:${player.username}`)) return
    console.log(`[MC:join] \x1b[0;92m${player.username}\x1b[0m joined`)
  })

  bot.on('playerLeft', (player) => {
    if (player.username === bot.username) return
    if (deduper.shouldSkipEvent(`leave:${player.username}`)) return
    console.log(`[MC:leave] \x1b[0;91m${player.username}\x1b[0m left`)
  })

  bot.on('death', () => {
    console.log('\x1b[0;91m[MC:death] Bot died\x1b[0m')
  })

  bot.on('respawn', () => {
    console.log('\x1b[0;92m[MC:respawn] Bot respawned\x1b[0m')
  })
}
