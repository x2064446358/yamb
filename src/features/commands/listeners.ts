import { componentToText, usernameFromUuid } from '../../platform/chat-utils'
import { getBotClient } from '../../platform/bot-client'
import { parseWhisperMessage, shouldIgnoreSystemMessage } from './whisper-parser'
import MessageDeduper from './message-deduper'
import type { CommandSource } from './parser'
import type MinecraftBot from '../../platform/minecraft-bot'
import type CommandHandler from './handler'
import type TeleportIncomingHandler from '../teleport/incoming-handler'
import type SystemMessageBuffer from './system-buffer'
import { chat, info, error } from '../../platform/logger'

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
    if (!text || !username) return

    if (deduper.shouldSkip(username, text)) return

    chat(`[${source}] ${username}: ${text}`)
    teleportHandler?.handle(text)
    if (commandHandler) {
      void commandHandler.handle(username, text, source)
    }
  }

  function handleSystemText (text: string): void {
    const trimmed = text.trim()
    if (!trimmed || deduper.shouldSkipSystem(trimmed)) return

    if (shouldIgnoreSystemMessage(trimmed)) return

    // console is only for chat/whisper in dispatch — system text handled silently here
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

    // TPA reject from system (兜底：非 phome 的拒绝消息)
    if ((trimmed.includes('拒绝了你的传送请求') || trimmed.includes('传送请求已过期')) && commandHandler) {
      commandHandler.handleTpaFailed()
      return
    }

    const chatMatch = trimmed.match(/^『[^』]*』(.+?)\s*>\s*(.+)$/)
    if (chatMatch) {
      const playerName = chatMatch[1].trim()
      // Track 拉特兰 / 昼寝结社 tagged players for phome access
      if (trimmed.includes('『拉特兰』') || trimmed.includes('『昼寝结社』')) {
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
    } catch (err) {
      error('[Command] system_chat 处理失败:', err)
    }
  })

  bot.on('message', (jsonMsg) => {
    try {
      // 拉特兰 / 昼寝结社 tag tracking only — no console spam (duplicated by player_chat/system_chat)
      const text = jsonMsg.toString()
      const lm = text.match(/『(?:拉特兰|昼寝结社)』([a-zA-Z0-9_]+)/)
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
    } catch (err) {
      error('[Command] player_chat 处理失败:', err)
    }
  })

  bot.on('playerJoined', (player) => {
    if (player.username === bot.username) return
    if (deduper.shouldSkipEvent(`join:${player.username}`)) return
    chat(`[join] ${player.username} joined`)
  })

  bot.on('playerLeft', (player) => {
    if (player.username === bot.username) return
    if (deduper.shouldSkipEvent(`leave:${player.username}`)) return
    chat(`[leave] ${player.username} left`)
  })

  bot.on('death', () => {
    chat('[death] Bot died')
  })

  bot.on('respawn', () => {
    chat('[respawn] Bot respawned')
  })
}
