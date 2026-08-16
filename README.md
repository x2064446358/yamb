# yamb

**Yet Another MChatBot** — 基于 [Mineflayer](https://github.com/PrismarineJS/mineflayer) 的 Minecraft 游戏内机器人。

支持私聊/公屏命令、多级权限、编号传送点、锁定与滞空、骑乘、容器与背包管理、自动待命、酿酒流水线、定时提醒、断线重连、多 bot 协作、网页 Viewer 与可选 AstrBot API。

---

## 安装

需要 Node.js 22 或更高版本（项目使用 `node:sqlite`）。

Windows PowerShell：

```powershell
npm install
Copy-Item .env.example .env
# 编辑 .env，填写 MC 账号和管理员名单
npm run dev
```

macOS / Linux：

```bash
npm install
cp .env.example .env
# 编辑 .env，填写 MC 账号和管理员名单
npm run dev
```

云电脑部署（无 Node.js 自带环境）：

```bash
# 本地编译后复制 dist/、node_modules/、config/、.env、mc-tokens/ 和 data/ 到云电脑
npm run build
node dist/index.js
```

`npm run dev` 适合开发；`npm run build` 后执行 `node dist/index.js` 适合长期运行。首次 Microsoft 登录会在 `mc-tokens/` 保存令牌，请一并保留。

## 多 Bot 启动

最多 7 个 bot 共用一份代码，各自加载不同的 `.env.botN`：

| Bot | 配置文件 | 传送点文件 |
|-----|---------|-----------|
| Bot1 | `.env.bot1` | `teleport.json` |
| Bot2 | `.env.bot2` | `teleport2.json` |
| Bot3 | `.env.bot3` | `teleport3.json` |
| Bot4 | `.env.bot4` | `teleport4.json` |
| Bot5 | `.env.bot5` | `teleport5.json` |
| Bot6 | `.env.bot6` | `teleport6.json` |
| Bot7 | `.env.bot7` | `teleport7.json` |

```powershell
# PowerShell：分别启动指定 bot
$env:DOTENV_CONFIG_PATH = '.env.bot1'; npm run dev
$env:DOTENV_CONFIG_PATH = '.env.bot2'; npm run dev
$env:DOTENV_CONFIG_PATH = '.env.bot3'; npm run dev
```

在 cmd.exe 中可用 `set DOTENV_CONFIG_PATH=.env.bot1 && npm run dev`；在 macOS / Linux 中使用 `DOTENV_CONFIG_PATH=.env.bot1 npm run dev`。

或使用 `npm run start:all` / 双击 `start_all.bat` 一次启动全部 7 个 bot。每个环境文件至少应有独立的 `MC_USERNAME`、`BOT_INDEX` 与 `BOT_TELEPORT_CONFIG`；使用同一账号重复启动会被拒绝。

## 游戏内命令

公屏加 `%` 前缀，私聊无需前缀。回复均为私聊（`replyAlwaysWhisper: true`）。

### 传送

| 命令 | 说明 |
|------|------|
| `挂机 [备注]` | 请求传送（锁定后自动拒绝其他玩家） |
| `%1` ~ `%N` | 按编号触发已配置的传送点（各 bot 只响应自己归属的点） |
| `%0` | 列出传送点（仅 `phome_towns.json` 配置的主 bot 响应） |

编号与别名在对应的 `teleport*.json` 中配置。多个 bot 属于同一小镇时，归属 bot 被锁定后可由空闲的同镇 bot 代为执行共享传送点。

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
| `使用 [次数/无限] [间隔1h30m]` | 右键使用手持物品；仅在检测到服务器同步的物品变化后计数 |
| `放置 <方块名> [次数/无限] [间隔Xs]` | 破基岩追踪放置：持续在目标方块正下方放朝下活塞 |
| `放置 <方向> [次数/无限] [间隔Xs]` | 相对放置：在 look/看向 选定的方块方向放置（上方/下方/前/后/左/右；前=面向 bot 的那面，后=背面，左/右=bot 视角） |
| `look <横°> <纵°>` | 按 F3 角度瞄准 |
| `看向 x y z` | 看向坐标 |
| `丢弃 <物品> [数量]` | 丢弃指定物品 |
| `丢弃全部` | 丢弃全部物品 |
| `装水 [瓶\|桶]` | 从附近水源装满玻璃瓶或桶 |

#### 物品识别与定时使用

- `inv` 会显示药水的效果、等级和时长，例如 `抗火药水（8分钟）`、`力量药水（II级，1分30秒）`；不祥之瓶会显示 I-V 级。
- `手持`、`丢弃` 可使用这些完整名称精确选择物品。等级可用中文、阿拉伯数字或罗马数字，例如 `手持 不祥之瓶 二级`、`手持 不祥之瓶 3级`、`丢弃 抗火药水 8分钟 1`。
- `使用 10次 间隔1h30m` 会在每个 1 小时 30 分钟间隔结束后尝试右键一次；每次确认成功后才计数，累计成功 10 次后完成。时长支持组合的 `h`、`m`、`s`，也支持 `小时`、`分钟`、`秒`。
- 一次使用只会在服务器同步到物品数量、种类、耐久或 NBT 状态变化后计数。有限次数任务未确认成功会停止并提示；成功计满后提示“使用完毕”。完全不改变物品状态的右键行为无法被服务器状态确认，因此不会计数。
- 使用 `使用 停止` 可手动停止；`使用 无限次 间隔20s` 会按设定间隔持续尝试。

### 跳跃

| 命令 | 说明 |
|------|------|
| `跳跃` | 跳一次 |
| `跳跃 10` | 连跳 10 次 |
| `跳跃 无限` | 无限跳 |
| `跳跃 停止` | 停止 |

连续跳跃仅会在 bot 落地后触发下一跳，并在空中释放跳跃键，以避免重复短按导致的漏跳和不自然节奏。

### 定时提醒

| 命令 | 说明 |
|------|------|
| `定时 <标签> <时长>` | 到点私信提醒发起者，不锁定 bot |
| `定时 取消 <标签>` | 取消自己的同名定时 |
| `定时 列表` | 查看自己的定时 |

时长支持 `秒`、`分`/`分钟`、`小时`、`游戏日`；1 游戏日为 20 分钟。示例：`定时 发酵 12分钟`、`定时 陈酿 200游戏日`。

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

### 酿酒与节点

酿酒需管理员或酿酒白名单权限。配方位于 `config/recipes/*.json`，酒庄设备和容器别名位于 `config/game/brew.json` 与节点登记中。

| 命令 | 说明 |
|------|------|
| `酿酒 开始 <配方>` | 启动指定配方的发酵、装瓶、蒸馏与陈化流程 |
| `酿酒 状态` | 查看当前流程和等待中的陈化任务 |
| `酿酒 取消` / `酿酒 停止` | 请求取消 / 强制停止当前流程 |
| `酿酒 重载` | 重新读取配方（管理员） |
| `加酿酒白名单 <玩家>` | 授予酿酒权限（管理员） |
| `移除酿酒白名单 <玩家>` | 移除酿酒权限（管理员） |
| `酿酒白名单列表` | 查看酿酒白名单 |
| `node 登记 <别名> <x> <y> <z> [-混合] [-区域 <名称>]` | 登记酿酒节点或容器（管理员） |
| `node 列表 [区域]` / `node 详情 <别名>` | 查看已登记节点 |
| `node 删除 <别名>` | 删除节点（管理员） |

### 管理（管理员）

| 命令 | 说明 |
|------|------|
| `加白名单 <名>` | 添加白名单 |
| `移除白名单 <名>` | 移除白名单 |
| `白名单列表` | 查看白名单 |
| `加管理员 <名>` | 添加管理员 |
| `移除管理员 <名>` | 移除管理员 |
| `管理员列表` | 查看管理员 |
| `加黑 <名>` | 加入黑名单 |
| `say <消息>` | 公屏发消息 |
| `指令 <命令>` | 以 bot 执行命令（管理员） |
| `指令循环 间隔Xs <命令>` | 定时循环执行 |
| `指令循环 停止/状态` | 管理循环 |
| `加phome点 <名称> <指令>` | 添加传送点 |
| `移除phome点 <编号>` | 删除传送点 |
| `加phome白名单 <名>` | 添加 phome 白名单 |
| `移除phome白名单 <名>` | 移除 phome 白名单 |
| `phome白名单列表` | 查看 phome 白名单 |
| `加phome超管 <名>` | 添加 phome 超管（管理员） |
| `移除phome超管 <名>` | 移除 phome 超管（管理员） |
| `phome超管列表` | 查看 phome 超管（管理员） |

### 权限与渠道

- 公屏命令必须以 `command.json` 中的前缀开头，默认是 `%`；私聊和终端不需要前缀。
- 普通游戏内操作要求玩家在白名单中；管理员名单由 `MC_ADMIN_LIST` 配置。`inv`、丢弃、手持和容器管理只能在私聊或终端使用，避免公屏误操作。
- 酿酒可单独授予酿酒白名单；传送点还有 phome 白名单与 phome 超管两级权限。
- 回复渠道由 `command.json` 的 `replyAlwaysWhisper` 决定。修改命令、消息或游戏配置后请重启对应 bot；`重载` 仅可从终端触发。

## 配置

| 位置 | 内容 |
|------|------|
| `.env` / `.env.botN` | 服务器、账号、认证方式、管理员、消息队列、API 和 bot 身份环境变量 |
| `config/game/command.json` | 命令前缀、公屏开关与回复方式 |
| `config/game/bot.json` | 待命、AFK、交互距离、循环命令限制与 bot 默认行为 |
| `config/game/teleport*.json` | 每个 bot 的传送点与传送指令；由 `BOT_TELEPORT_CONFIG` 选择 |
| `config/game/phome_towns.json` | 主 bot 与各 bot 所属小镇，用于共享传送点代执行 |
| `config/game/messages.json` | 游戏内回复文案和帮助文本 |
| `config/game/item-names.json` | 物品 ID 的中文显示名 |
| `config/game/brew.json` | 酒庄组、设备别名、容器和酿造行为 |
| `config/recipes/*.json` | 酿酒配方：原料、发酵、蒸馏和陈化 |
| `config/game/viewer.json` | 网页 Viewer 的启用状态、端口、视角与渲染视距 |
| `config/game/README.md` | 游戏配置字段的补充说明 |

`.env.example` 列出可用环境变量。多 bot 时应为每个 `.env.botN` 设置 `BOT_INDEX`、`BOT_TELEPORT_CONFIG`、`BOT_NAME`，并按需设置基地范围 `BOT_BASE_MIN_X`、`BOT_BASE_MAX_X`、`BOT_BASE_MIN_Z`、`BOT_BASE_MAX_Z`。

### 网页 Viewer

将 `config/game/viewer.json` 的 `enabled` 设为 `true` 后，bot 登录时会启动 Prismarine Viewer。默认访问地址为 `http://localhost:3007`；端口、第一/第三人称和渲染视距均在同一文件配置。多 bot 同时启用时必须分配不同端口。

### AstrBot API

在 `.env` 中设置 `ASTRBOT_ENABLED=true` 和非空 `API_KEY` 可开启 HTTP API，默认端口为 `15100`。所有请求必须带 `x-api-key` 请求头。

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/api/status` | 获取 bot 状态 |
| `GET` | `/api/players` | 获取在线玩家信息 |
| `POST` | `/api/say` | 让 bot 公屏发言，Body: `{ "message": "..." }` |
| `POST` | `/api/tp/accept` | 接受传送，Body: `{ "game_name": "..." }` |
| `POST` | `/api/home` | 执行传送点，Body: `{ "game_name": "...", "waypoint": "..." }` |
| `POST` | `/api/lock` / `/api/unlock` | 锁定或解锁，Body: `{ "game_name": "..." }` |
| `GET` / `POST` | `/api/whitelist/*` | 白名单查询与管理 |

## 功能特性

- **多级权限**：白名单、管理员、酿酒白名单、phome 白名单与 phome 超管
- **Phome 传送点**：编号传送、按 bot 归属、同镇 bot 代执行
- **锁定机制**：锁定后仅锁定人和管理员可操作；支持滞空锁定（跳起悬停）；锁定时可转移锁定人；拒绝时主动发送 `/tpdeny`；状态持久化（断线重连恢复）
- **自动待命**：90s 无交互自动 `/ts` 回家 + `/afk`，锁定时跳过
- **自动进食**：回家后自动吃金胡萝卜
- **断线重连**：无限次，20s 间隔，spam 踢 30s
- **防重复启动**：同账号重复启动自动拒绝
- **受击 AFK**：被攻击自动 `/afk`
- **酿酒流水线**：支持发酵、装瓶、蒸馏、陈化、暂存背包和进度通知
- **可观测性**：终端状态面板、可选网页 Viewer、可选 AstrBot API
- **聊天彩色**：终端保留 Minecraft § 颜色代码

## 技术栈

TypeScript + Mineflayer + SQLite + Vec3 + mineflayer-pathfinder
