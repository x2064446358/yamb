# yamb

**Yet Another MChatBot** — 基于 [Mineflayer](https://github.com/PrismarineJS/mineflayer) 的 Minecraft 游戏内机器人。

支持私聊/公屏命令、传送与白名单、玩家交互（骑乘/攻击/上车）、容器登记与存取、背包管理、待命与 AFK、可选网页 Viewer，以及 AstrBot HTTP API 集成。

## 功能概览

- **命令渠道**：私聊无前缀；公屏需在`command.json`配置前缀
- **权限**：SQLite 白名单 + `.env` 管理员列表
- **传送**：自动接受传送、传送点、锁定
- **交互**：骑乘玩家、上车、攻击、（WIP）亲亲
- **物品**：容器登记、存取、丢弃、查背包
- **待命**：自动回家、吃饭、闲置
- **AstrBot**（可选）：提供 QQ 机器人接口
- **Viewer**（可选）： `prismarine-viewer` 网页可视化
- （WIP）**酿造**：占位模块，待实现
- （WIP）**多用户**：自由切换账号和对应配置。
- （WIP）**bot集群**
- （WIP）**哈气模式**
- （WIP）**远程存取**
- （WIP）**互动回应**



## 安装

```bash
yarn install
cp .env.example .env
# 编辑 .env 与 config/game/
yarn start
```

开发模式（免编译）：

```bash
yarn dev
```

## 配置

| 层级 | 位置 | 内容 |
|------|------|------|
| 部署/账号 | `.env` | MC 账号、服务器、`MC_ADMIN_LIST`、API 密钥 |
| 游戏行为 | `config/game/*.json` | 前缀、待命、传送点、交互距离、viewer 等 |

详见 [config/game/README.md](config/game/README.md)。

### Viewer

启用 viewer 需安装原生模块：

```bash
yarn add canvas
```

在 `config/game/viewer.json` 中设置 `"enabled": true`，启动后访问 `http://localhost:3007`（端口可配置）。

## 游戏内命令

私聊无需前缀；公屏需 `{prefix}`（见 `config/game/command.json`）。`allowPublicCommands` 为 `false` 时仅私聊可用。

### 白名单

| 命令 | 说明 |
|------|------|
| `help` | 帮助 |
| `status` | 状态 |
| `phome <别名>` | 经传送点拉取玩家 |
| `mount [玩家]` / `cart` / `unmount` | 骑乘（默认为自己）/ 登上最近矿车 / 下来 |
| `attack` | 攻击（调试用） |
| `lock` / `lock hover` / `unlock` | 锁定 / 滞空锁定 / 解锁 |
| `store <容器> <物品> [数量]` | 存入已登记容器 |
| `take <容器> <物品> [数量]` | 从容器取出 |
| `drop <物品> [数量]` | 丢弃背包物品 |
| `container list` / `info` | 查看已登记容器 |

白名单玩家对 bot 发送 `/tpa` 或 `/tpahere` 时 bot 会自动接受（无回复）。

### 管理员

| 命令 | 说明 |
|------|------|
| `inv` | 查看 bot 背包 |
| `container add <别名>` | 登记容器（需对准方块） |
| `container remove <别名>` | 删除容器记录 |
| `add <游戏名>` / `remove <游戏名>` | 白名单管理 |
| `say <消息>` | 发送公屏消息 |
| `forward <消息>` | 发公屏并转发随后系统消息 |

## AstrBot 集成（可选）

1. 在 `.env` 设置 `ASTRBOT_ENABLED=true` 与 `API_KEY`
2. 将 `integrations/astrbot-plugin/` 安装到 AstrBot
3. 配置插件中的 API 地址与密钥

HTTP 路由见 `src/api/routes/`。



## 许可证

本项目采用 [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html)（GPL-3.0）。

基于 GPL 发布：你可以自由使用、修改和分发本软件；若分发修改后的版本，须以相同许可证公开源代码。
