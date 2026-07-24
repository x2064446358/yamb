# yamb

**Yet Another MChatBot** — 基于 [Mineflayer](https://github.com/PrismarineJS/mineflayer) 的 Minecraft 游戏内机器人。

支持私聊/公屏命令、多级权限管理、传送点系统(phome)、锁定机制、骑乘、容器管理、自动待命、断线重连、多 bot 互通、附魔查询等。

---

## 安装

```bash
npm install
cp .env.example .env
# 编辑 .env，填写 MC 账号
npm run dev
```

云电脑部署（无 Node.js 自带环境）：

```bash
# 本地编译后复制 dist/ + node_modules/ + config/ 到云电脑
node dist/index.js
```

## 多 Bot 启动

3 个 bot 共用一份代码，各自加载不同的 `.env`：

| Bot | 配置文件 | 传送点文件 |
|-----|---------|-----------|
| Bot1 (WLLBot) | `.env.bot1` | `teleport.json` |
| Bot2 (SecondBot) | `.env.bot2` | `teleport2.json` |
| Bot3 (ThirdBot) | `.env.bot3` | `teleport3.json` |

```bash
# 三个终端分别启动
set DOTENV_CONFIG_PATH=.env.bot1 && npm run dev
set DOTENV_CONFIG_PATH=.env.bot2 && npm run dev
set DOTENV_CONFIG_PATH=.env.bot3 && npm run dev
```

或双击 `start_all.bat` 一键启动。

## 游戏内命令

公屏加 `%` 前缀，私聊无需前缀。回复均为私聊（`replyAlwaysWhisper: true`）。

### 传送

| 命令 | 说明 |
|------|------|
| `挂机 [备注]` | 请求传送（锁定后自动拒绝其他玩家） |
| `%1` ~ `%15` | 按编号触发传送点（各 bot 只响应自己的点） |
| `%0` | 列出全部传送点（仅 Bot1 响应） |
| `phome <别名>` | 按别名触发传送点 |

### 锁定

| 命令 | 说明 |
|------|------|
| `锁定` | 原地锁定，仅锁定人和管理员可发 tpa/tpahere |
| `锁定 滞空` | 滞空锁定，跳起后悬停空中 |
| `解锁` | 解除锁定（普通/滞空均适用） |
| `解锁all` | 解锁所有 bot（管理员） |
| `改锁定 <玩家>` | 将锁定转移给目标玩家（管理员） |

锁定状态下：
- 锁定者和管理员可以 tpa
- 非锁定者 tpa 会被 `/tpdeny` 拒绝并收到锁定通知
- `跳跃` / `xjump` / `改锁定` 锁定状态下也可使用

### 状态

| 命令 | 说明 |
|------|------|
| `状态` / `状态2` / `状态3` | 查看指定 bot 状态（公屏 %状态→Bot1） |

### 骑乘

| 命令 | 说明 |
|------|------|
| `坐 <玩家>` | 骑乘玩家（6格内，InteractAt） |
| `下车` | 下马/下车（多次潜行重试，可靠脱离插件云座） |
| `上车` | 上最近矿车 |
| `蹲下` | 切换潜行状态（蹲下↔起身） |

### 物品

| 命令 | 说明 |
|------|------|
| `手持 <物品>` | 手持指定物品（模糊匹配） |
| `use [次数/无限] [间隔Xs]` | 右键使用手持物品 |
| `place [次数/无限] [间隔Xs]` | 放置方块（需先 look 瞄准） |
| `look <x> <y> <z>` | 看向坐标（place 前置） |
| `丢弃` | 丢弃手中物品 |
| `丢弃全部` | 丢弃全部物品 |

### 跳跃

| 命令 | 说明 |
|------|------|
| `跳跃` | 跳一次 |
| `跳跃 10` | 连跳 10 次 |
| `跳跃 无限` | 无限跳 |
| `跳跃 停止` | 停止 |

### 查询

| 命令 | 说明 |
|------|------|
| `查 附魔 <名称>` | 附魔百科查询（28条，仅 Bot1 公屏响应） |
| `help` / `帮助` | 帮助 |

### 仓库/背包

| 命令 | 说明 |
|------|------|
| `inv` | 查看 bot 背包（管理员） |
| `store <容器> <物品> [数量]` | 存入容器 |
| `take <容器> <物品> [数量]` | 取出物品 |
| `container add <别名>` | 登记对准的容器（管理员） |
| `container remove <别名>` | 删除容器 |
| `container list` | 列出容器 |

### 管理（管理员）

| 命令 | 说明 |
|------|------|
| `加白名单 <名>` | 添加白名单 |
| `移除白名单 <名>` | 移除白名单 |
| `白名单列表` | 查看白名单 |
| `加管理员 <名>` | 添加管理员 |
| `移除管理员 <名>` | 移除管理员 |
| `管理员列表` | 查看管理员 |
| `超管 add/remove <名>` | 超管管理 |
| `超管列表` | 查看超管 |
| `加黑 <名>` | 加入黑名单 |
| `say <消息>` | 公屏发消息 |
| `指令 <命令>` | 以 bot 执行命令（超管） |
| `指令循环 间隔Xs <命令>` | 定时循环执行 |
| `指令循环 停止/状态` | 管理循环 |
| `加phome点 <名称> <指令>` | 添加传送点 |
| `移除phome点 <编号>` | 删除传送点 |
| `加phome白名单 <名>` | 添加 phome 白名单 |
| `移除phome白名单 <名>` | 移除 phome 白名单 |
| `phome白名单列表` | 查看 phome 白名单 |

### Bot 间互通

白名单、黑名单、phome 白名单的增删操作会自动通过私聊 whisper 同步到其他 bot。

## 配置

| 位置 | 内容 |
|------|------|
| `.env` / `.env.bot*` | MC 账号、服务器、管理员、同步目标 |
| `config/game/command.json` | 命令前缀、公屏开关、回复模式 |
| `config/game/teleport.json` | 传送点列表（`ownedStart`/`ownedEnd` 控制归属） |
| `config/game/teleport2.json` | Bot2 传送点 |
| `config/game/teleport3.json` | Bot3 传送点 |
| `config/game/bot.json` | 待命超时、交互距离、重连等行为配置 |
| `config/game/messages.json` | 所有回复文案 |

## 功能特性

- **多级权限**：白名单 → 管理员 → 超管 → Phome超管 → Phome白名单
- **Phome 传送点**：编号传送、别名传送、各 bot 独立归属
- **锁定机制**：锁定后仅锁定人和管理员可操作；支持滞空锁定（跳起悬停）；锁定时可转移锁定人；拒绝时主动发送 `/tpdeny`；状态持久化（断线重连恢复）
- **自动待命**：90s 无交互自动 `/ts` 回家 + `/afk`，锁定时跳过
- **自动进食**：回家后自动吃金胡萝卜
- **断线重连**：无限次，20s 间隔，spam 踢 30s
- **防重复启动**：同账号重复启动自动拒绝
- **受击 AFK**：被攻击自动 `/afk`
- **聊天彩色**：终端保留 Minecraft § 颜色代码

## 技术栈

TypeScript + Mineflayer + SQLite + Vec3 + mineflayer-pathfinder
