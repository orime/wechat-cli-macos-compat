# Upstream Reference

原作者项目：<https://github.com/freestylefly/wechat-cli>

# wechat-cli-macos-compat

这是一个针对 macOS 微信数据库兼容性问题整理出来的新仓库。目标不是替代 upstream 的全部能力，而是先把这类机器上最常见、最影响可用性的几类问题解决掉，让 `sessions`、`unread`、`contacts`、`history`、`search` 先稳定可用。

## 为什么会做这个仓库

在一台实际的 macOS 微信环境里，原项目 `wechat-cli@0.2.4` 出现了下面几类问题：

1. 微信数据库真实目录布局与原项目假设不一致
2. `init` 已经匹配到了数据库 key，但终端最后仍然显示“提取到 0 个密钥”
3. key 明明正确，后续查询仍然报 `无法解密 session.db` / `file is not a database`
4. 即使手动解密成功，原查询 SQL 依然因为表结构不同而失败

这些问题叠在一起时，表面现象会看起来像“init 失败”或者“微信版本太低”，但真实原因更复杂：

- 数据目录布局变了
- 数据库文件命名变了
- 加密页参数变了
- SQLite schema 也变了

## 这次改了什么

这个仓库当前整理的兼容改动主要有：

### 1. 兼容另一套 macOS 微信数据库布局

当前实现支持直接读取这类结构：

- `contact/contact.db`
- `session/session.db`
- `message/message_*.db`

这层通常由一个 compat 映射目录提供，用来把微信真实库：

- `Contact/wccontact_new2.db`
- `Session/session_new.db`
- `Message/msg_*.db`

映射成 `wechat-cli` 能处理的统一结构。

### 2. 改掉了解密参数假设

在实际样本里，正确可用的参数是：

- `page size = 1024`
- `reserved bytes = 48`

而不是原工具链默认假设的那组值。原问题里，`all_keys.json` 已经拿到了正确 key，但后续仍然报解密失败，本质上就是因为用错了页参数。

### 3. 支持 WAL 补丁写回

除了主库 `.db`，实现里还会把 `-wal` 内容解开并回写到缓存数据库，避免只读到旧快照。

### 4. 改成适配当前 schema

当前兼容实现不再假设旧的会话表结构，而是直接适配：

- `WCContact`
- `SessionAbstract`
- `SessionAbstractBrand`
- `Chat_<md5(username)>`

这也是为什么这个仓库能解决“解密成功但 SQL 还是挂掉”的问题。

### 5. 保留原始二进制作为 fallback

对于还没有在兼容层里自己实现的命令，当前入口会优先转发给 upstream 二进制，避免把现有能力全部推倒重来。

## 已解决的问题

这类环境下，当前仓库已经解决了：

- `init` 后 key 文件实际非空，但终端提示误导的问题
- `sessions` 报 `无法解密 session.db`
- `file is not a database`
- 联系人库、会话库 schema 不匹配导致的查询失败
- 常见 XML 消息预览不友好
- 读取不到 WAL 最新消息的问题

## 当前可用命令

```bash
wechat-cli sessions --format text
wechat-cli unread --format text
wechat-cli contacts --query "张" --limit 10 --format text
wechat-cli history "qqmail" --limit 20 --format text
wechat-cli search "Steam" --chat "qqmail" --limit 20 --format text
wechat-cli new-messages --limit 100 --format text
```

## 安装

建议使用 `pnpm`：

```bash
pnpm install
pnpm link --global
```

要求：

- Node.js >= 22
- 已经准备好 `~/.wechat-cli/config.json`
- 已经准备好 `~/.wechat-cli/all_keys.json`

`config.json` 至少需要：

```json
{
  "db_dir": "/path/to/compat/db_storage"
}
```

## 与 upstream 的关系

这个仓库是基于 upstream 项目的实际使用问题整理出来的兼容版思路，不是官方分支，也不是对 upstream 全功能的完整重写。

更准确地说，它现在是：

- 一层 macOS 微信兼容实现
- 一层更贴近当前数据库形态的查询适配
- 一层对原始二进制命令的 fallback

如果后面继续完善，下一步适合做的事情包括：

1. 自动探测更多数据库布局
2. 动态探测解密页参数，不再写死
3. 做更稳的坏页/WAL 容错
4. 增加 `doctor` 子命令，直接输出路径、布局、页参数、schema 版本
5. 补齐 `export`、`stats`、`favorites` 等命令

## 说明

README 开头保留了原作者项目链接，是为了明确致谢和说明参考来源。这个仓库的重点是把“为什么原项目在某些 macOS 微信环境里会失败”说清楚，并把已经验证过的兼容方案沉淀下来。
