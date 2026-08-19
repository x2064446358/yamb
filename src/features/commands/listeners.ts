import { componentToAnsi, componentToText, usernameFromUuid } from '../../platform/chat-utils'
import { getBotClient } from '../../platform/bot-client'
import { parseWhisperMessage, shouldIgnoreSystemMessage } from './whisper-parser'
import MessageDeduper from './message-deduper'
import type { CommandSource } from './parser'
import type MinecraftBot from '../../platform/minecraft-bot'
import type CommandHandler from './handler'
import type TeleportIncomingHandler from '../teleport/incoming-handler'
import type SystemMessageBuffer from './system-buffer'
import type WelcomeBindModule from '../welcome-bind'
import { chat, debug, error } from '../../platform/logger'

type BotWithFlag = NonNullable<MinecraftBot['bot']> & { _mchatbotListenersRegistered?: boolean }

// player_info can briefly contain formatted placeholder names while the
// server rebuilds its player list after a respawn or dimension change.
const MINECRAFT_USERNAME = /^[A-Za-z0-9_]{1,16}$/

export function registerChatListeners (
  mcBot: MinecraftBot,
  commandHandler?: CommandHandler,
  teleportHandler?: TeleportIncomingHandler,
  systemBuffer?: SystemMessageBuffer,
  welcomeBind?: WelcomeBindModule
): void {
  const bot = mcBot.bot as BotWithFlag | null
  if (!bot) return
  if (bot._mchatbotListenersRegistered) return
  bot._mchatbotListenersRegistered = true

  const deduper = new MessageDeduper()
  const pendingPlainChats = new Map<string, ReturnType<typeof setTimeout>>()

  function chatKey (username: string, message: string): string {
    return `${username}:${message.trim()}`
  }

  function schedulePlainChat (username: string, message: string, displayName = username): void {
    const key = chatKey(username, message)
    if (pendingPlainChats.has(key)) return
    const timer = setTimeout(() => {
      pendingPlainChats.delete(key)
      dispatch(username, message, 'chat', displayName)
    }, 120)
    pendingPlainChats.set(key, timer)
  }

  function dispatch (
    username: string,
    message: string,
    source: CommandSource,
    displayName = username,
    renderedLine?: string
  ): void {
    const text = message.trim()
    if (!text || !username) return

    const key = chatKey(username, text)
    const fallback = pendingPlainChats.get(key)
    if (fallback) {
      clearTimeout(fallback)
      pendingPlainChats.delete(key)
    }
    if (deduper.shouldSkip(username, text)) return

    chat(`[${source}] ${renderedLine || `${displayName} > ${text}`}`)
    teleportHandler?.handle(text)
    if (commandHandler) {
      void commandHandler.handle(username, text, source)
    }
  }

  function handleSystemText (text: string, renderedLine?: string, component?: unknown): void {
    const trimmed = text.trim()
    if (!trimmed || deduper.shouldSkipSystem(trimmed)) return

    if (shouldIgnoreSystemMessage(trimmed)) return
    welcomeBind?.handle(component ?? text, trimmed)
    observeAfkStatus(trimmed, 'system message')

    // AFK is server-plugin state, not a standard Minecraft protocol field.
    // Record the server's exact transition message so it can be recognized
    // reliably instead of guessing from the outgoing /afk command.
    if (/afk|\u6682\u79bb|\u6302\u673a|\u79bb\u5f00\u4e86\u952e\u76d8|\u56de\u5230\u4e86\u6e38\u620f/i.test(trimmed)) {
      debug(`[AFK] Server message: ${trimmed}`)
    }

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

    // Servers use different title wrappers: 『称号』玩家, [--称号--] 玩家, [称号 玩家], etc.
    // The final Minecraft username before `>` remains the command sender; the full left side is display-only.
    const chatMatch = trimmed.match(/^(.+?)\s*>\s*(.+)$/)
    if (chatMatch) {
      const titleAndName = chatMatch[1].trim()
      const playerName = titleAndName.match(/([A-Za-z0-9_]{1,16})$/)?.[1]
      if (playerName) {
        // Track eligible town-tagged players for phome access.
        if (trimmed.includes('『拉特兰』') || trimmed.includes('『昼寝结社』') || trimmed.includes('『卡兹戴尔』')) {
          commandHandler?.addLatelanMember(playerName)
        }
        dispatch(playerName, chatMatch[2].trim(), 'chat', titleAndName, renderedLine)
        return
      }
    }

    const whisper = parseWhisperMessage(trimmed)
    if (whisper) {
      dispatch(whisper.username, whisper.message, 'whisper')
      return
    }

  }

  function extractNbtText (value: unknown, fieldName = ''): string {
    if (typeof value === 'string') return fieldName === 'text' ? value : ''
    if (value == null || typeof value !== 'object') return ''
    if (Array.isArray(value)) return value.map(part => extractNbtText(part, fieldName)).join('')

    const record = value as Record<string, unknown>
    if ((record.type === 'compound' || record.type === 'list') && 'value' in record) {
      return extractNbtText(record.value, fieldName)
    }
    if (record.type === 'string' && typeof record.value === 'string') {
      return fieldName === 'text' ? record.value : ''
    }

    let text = ''
    if ('text' in record) text += extractNbtText(record.text, 'text')
    if ('extra' in record) text += extractNbtText(record.extra, 'extra')
    if ('with' in record) text += extractNbtText(record.with, 'with')
    return text
  }

  function displayText (value: unknown): string {
    if (typeof value === 'string') return componentToText(value)
    if (value == null) return ''

    const component = componentToText(value as Parameters<typeof componentToText>[0])
    if (component) return component

    const nbtText = extractNbtText(value)
    if (nbtText) return nbtText

    // 1.20.3+ title/action-bar packets may carry an NBT wrapper such as
    // { type: 'compound', value: { text: ... } } instead of a JSON string.
    if (typeof value === 'object' && 'value' in value) {
      return displayText((value as { value?: unknown }).value)
    }
    return ''
  }

  function styledText (value: unknown): string {
    try { return componentToAnsi(value) } catch (err) {
      debug(`[Chat] Color component skipped: ${(err as Error).message}`)
      return ''
    }
  }

  function observeAfkStatus (text: unknown, source: string): void {
    const normalized = displayText(text).trim()
    if (!normalized) return

    // TSL presents AFK transitions as a title rather than a chat message.
    // Mineflayer exposes title/subtitle/action-bar text as regular events.
    if (/[你您]现在是挂机状态/.test(normalized)) {
      const wasAfk = mcBot.isServerAfk()
      mcBot.setServerAfk(true, source)
      if (!wasAfk) debug('[AFK] Server confirmed active')
      return
    }

    if (/你已(?:退出|离开)挂机状态|你现在不是挂机状态|已取消挂机|已结束挂机/.test(normalized)) {
      const wasAfk = mcBot.isServerAfk()
      mcBot.setServerAfk(false, source)
      if (wasAfk) debug('[AFK] Server confirmed inactive')
    }
  }

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    schedulePlainChat(username, message)
  })

  bot.on('whisper', (username, message) => {
    if (username === bot.username) return
    dispatch(username, message, 'whisper')
  })

  getBotClient(bot)?.on('system_chat', (packet: unknown) => {
    try {
      const raw = packet as { content?: unknown; formattedMessage?: unknown }
      const content = raw.content ?? raw.formattedMessage
      const message = componentToText(content as Parameters<typeof componentToText>[0])
      if (message) handleSystemText(message, styledText(content), content)
    } catch (err) {
      error('[Command] system_chat 处理失败:', err)
    }
  })

  // minecraft-protocol's chat plugin exposes the same packets as camelCase
  // events after decorating them (notably profileless_chat/system_chat).
  // Those events contain the formatted component that preserves server colors.
  getBotClient(bot)?.on('systemChat', (packet: unknown) => {
    try {
      const content = (packet as { formattedMessage?: unknown; content?: unknown }).formattedMessage ?? (packet as { content?: unknown }).content
      const message = componentToText(content as Parameters<typeof componentToText>[0])
      if (message) handleSystemText(message, styledText(content), content)
    } catch (err) {
      error('[Command] systemChat 处理失败:', err)
    }
  })

  bot.on('message', (jsonMsg) => {
    try {
      // Mineflayer's ChatMessage keeps the original JSON component on .json.
      // Some proxy/plugin messages only reach this event, so use it as the
      // final styled fallback instead of relying on messagestr (plain text).
      const text = jsonMsg.toString()
      const lm = text.match(/『(?:拉特兰|昼寝结社|卡兹戴尔)』([a-zA-Z0-9_]+)/)
      if (lm) commandHandler?.addLatelanMember(lm[1])

      const component = (jsonMsg as unknown as { json?: unknown }).json
      if (component) {
        // prismarine-chat already resolves translation keys and inherited
        // styles in toAnsi(); prefer it over parsing .json ourselves.
        const toAnsi = (jsonMsg as unknown as { toAnsi?: () => string }).toAnsi
        const styled = typeof toAnsi === 'function' ? toAnsi.call(jsonMsg) : styledText(component)
        const plain = text
        if (plain) handleSystemText(plain, styled, component)
      }
    } catch { /* */ }
  })

  bot.on('messagestr', (message, position) => {
    const text = String(message || '').trim()
    if (!text || position === 'chat') return
    handleSystemText(text)
  })

  function handlePlayerChatPacket (packet: unknown): void {
    const p = packet as Record<string, unknown>
    try {
      let message = ''
      let displayName = ''
      let renderedLine = ''
      let username: string | null = null
      // minecraft-protocol uses senderName/networkName and the server may
      // expose the formatted component under any of these names depending
      // on protocol version. Keep the plain value for command parsing, but
      // render the richest component available for the terminal.
      const senderComponent = p.senderName ?? p.networkName
      const messageComponent = p.unsignedChatContent ?? p.unsignedContent ?? p.signedChatContent ?? p.message ?? p.formattedMessage

      const senderUuid = p.senderUuid ?? p.sender
      if (senderUuid) {
        username = usernameFromUuid(bot!, String(senderUuid))
      }
      if (!username && senderComponent) {
        username = componentToText(senderComponent as Parameters<typeof componentToText>[0])
      }
      if (senderComponent) {
        displayName = componentToText(senderComponent as Parameters<typeof componentToText>[0])
      }

      if (p.plainMessage) {
        message = String(p.plainMessage)
      } else if (p.unsignedChatContent) {
        message = componentToText(p.unsignedChatContent as Parameters<typeof componentToText>[0])
      } else if (p.unsignedContent) {
        message = componentToText(p.unsignedContent as Parameters<typeof componentToText>[0])
      } else if (p.signedChatContent) {
        message = componentToText(p.signedChatContent as Parameters<typeof componentToText>[0])
      } else if (p.message) {
        message = componentToText(p.message as Parameters<typeof componentToText>[0])
      } else if (p.formattedMessage) {
        message = componentToText(p.formattedMessage as Parameters<typeof componentToText>[0])
      }

      const styledName = senderComponent ? styledText(senderComponent) : ''
      const styledMessage = messageComponent ? styledText(messageComponent) : (message ? styledText(message) : '')
      if (styledName || styledMessage) {
        renderedLine = `${styledName || displayName || username || ''} \x1b[38;2;85;85;255m>\x1b[0m ${styledMessage || message}`
      }

      if (username && message) {
        dispatch(username, message, 'chat', displayName || username, renderedLine || undefined)
      }
    } catch (err) {
      error('[Command] player_chat 处理失败:', err)
    }
  }

  getBotClient(bot)?.on('player_chat', handlePlayerChatPacket)
  getBotClient(bot)?.on('playerChat', handlePlayerChatPacket)

  bot.on('playerJoined', (player) => {
    const username = String(player.username || '')
    if (!MINECRAFT_USERNAME.test(username) || username === bot.username) return
    if (deduper.shouldSkipEvent(`join:${username}`)) return
    chat(`[join] ${username} joined`)
  })

  bot.on('title', (text, type) => {
    observeAfkStatus(text, type)
  })

  bot.on('actionBar', (jsonMsg) => {
    observeAfkStatus(jsonMsg.toString(), 'action bar')
  })

  // Mineflayer's title event can expose an NBT object on newer protocols.
  // Read the source packet too so title-only server states are not lost.
  getBotClient(bot)?.on('packet', (packet: unknown, meta: { name?: string }) => {
    const name = meta?.name
    if (name !== 'set_title_text' && name !== 'set_title_subtitle' && name !== 'action_bar') return

    const text = displayText((packet as { text?: unknown })?.text)
    if (text) {
      observeAfkStatus(text, name)
    }
  })

  bot.on('playerLeft', (player) => {
    const username = String(player.username || '')
    if (!MINECRAFT_USERNAME.test(username) || username === bot.username) return
    if (deduper.shouldSkipEvent(`leave:${username}`)) return
    chat(`[leave] ${username} left`)
  })

  bot.on('death', () => {
    chat('[death] Bot died')
  })

  bot.on('respawn', () => {
    chat('[respawn] Bot respawned')
  })
}
