# MChatBot

Minecraft传送机器人，通过QQ群控制Minecraft服务器内的传送功能。

## 功能

- 传送请求 (`/ybot tp <游戏名>`)
- 白名单管理 (`/ybot add/remove <游戏名>`)
- 机器人状态查看 (`/ybot status`)
- 在线玩家查看 (`/ybot players`)
- 公屏消息发送 (`/ybot say <消息>`)

## 安装

1. 克隆仓库
```bash
git clone git@git.gudosuy.top:river_tao/mchatbot.git
cd mchatbot
```

2. 安装依赖
```bash
npm install
```

3. 配置环境变量
```bash
cp .env.example .env
# 编辑 .env 文件，填入你的配置
```

4. 启动机器人
```bash
npm start
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `MC_HOST` | Minecraft服务器地址 | `mc.zenoxs.cn` |
| `MC_PORT` | Minecraft服务器端口 | `25565` |
| `MC_USERNAME` | 微软账号邮箱 | (必需) |
| `API_PORT` | HTTP API端口 | `15100` |
| `API_KEY` | API密钥 | (必需) |
| `QUEUE_MAX_SIZE` | 消息队列最大大小 | `100` |
| `QUEUE_DELAY_MS` | 消息发送间隔(毫秒) | `1000` |

## AstrBot插件

将 `astrbot_plugin_mchatbot` 目录安装到AstrBot，配置以下参数：

- `mchatbot_api_url`: `http://localhost:15100` (或你的服务器地址)
- `mchatbot_api_key`: 你的API密钥
- `admin_qq_list`: 管理员QQ号，逗号分隔

## 命令列表

| 命令 | 权限 | 说明 |
|------|------|------|
| `/ybot tp <游戏名>` | 所有人 | 向指定玩家发送传送请求 |
| `/ybot add <游戏名>` | 管理员 | 添加白名单 |
| `/ybot remove <游戏名>` | 管理员 | 移除白名单 |
| `/ybot list` | 所有人 | 查看白名单 |
| `/ybot status` | 所有人 | 查看机器人状态 |
| `/ybot players` | 所有人 | 查看在线玩家 |
| `/ybot say <消息>` | 管理员 | 发送公屏消息 |
| `/ybot help` | 所有人 | 显示帮助 |

## 许可证

ISC
