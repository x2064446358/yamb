# 游戏内配置说明

配置文件支持 `//` 行注释与 `/* */` 块注释（由程序加载时剥离）。

配置优先级：`.env` > `config/game/*.json`

## 文件一览

| 文件 | 用途 |
|------|------|
| `command.json` | 命令前缀、公屏/私聊渠道、回复方式 |
| `bot.json` | 待命、AFK、交互距离、转发等待、循环命令限制和默认 bot 名 |
| `teleport*.json` | 各 bot 的传送指令和编号传送点；由 `BOT_TELEPORT_CONFIG` 选择 |
| `phome_towns.json` | 主 bot、bot 身份和所属小镇；同镇 bot 可在归属 bot 被锁时代理共享传送点 |
| `viewer.json` | 网页可视化 viewer |
| `brew.json` | 酒庄组、发酵设备数量、水源和容器别名、交互延迟 |
| `../recipes/*.json` | 酿酒配方：原料、发酵时长、可选蒸馏和陈化 |
| `item-names.json` | Minecraft 物品 ID 的中文显示名 |
| `messages.json` | 所有命令回复文案（唯一文案来源） |

## 环境变量（.env）

账号、服务器、管理员等敏感或部署相关项见项目根目录 `.env.example`。

- `MC_ADMIN_LIST`：管理员游戏名，逗号分隔
- `MC_USERNAME`：微软账号邮箱（必填）
- `BOT_INDEX`：当前 bot 编号，`1` 对应 `teleport.json`，`2` 对应 `teleport2.json`，依此类推
- `BOT_TELEPORT_CONFIG`：当前 bot 使用的传送点文件名
- `BOT_NAME`：phome 协作识别使用的 bot 名称
- `BOT_BASE_MIN_X`、`BOT_BASE_MAX_X`、`BOT_BASE_MIN_Z`、`BOT_BASE_MAX_Z`：基地范围，可按需设置
- `ASTRBOT_ENABLED`、`API_PORT`、`API_KEY`：可选 HTTP API；启用时必须设置非空 `API_KEY`

## messages.json

占位符用 `{name}` 形式，运行时替换。常用变量：

- `{prefix}` — 公屏命令前缀
- `{cmd}`、`{message}`、`{gameName}`、`{waypoints}` 等见各模板

## 生效方式

游戏配置和消息文案在 bot 启动时读取。修改 `command.json`、`bot.json`、`messages.json`、`teleport*.json`、`viewer.json` 或 `phome_towns.json` 后需要重启对应 bot。酿酒配方可通过 `酿酒 重载` 重新读取（管理员）。
