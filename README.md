# Upstream Reference

原作者项目：<https://github.com/freestylefly/wechat-cli>

# wechat-cli-macos-compat

一句话先说清楚：

这是 `freestylefly/wechat-cli` 的一个 **macOS 兼容 fork / 补丁版**。  
它不是新的微信客户端，也不是发消息机器人。它只做一件事：

**把原版 `wechat-cli` 在部分 macOS 微信环境里跑不通的问题修好，让你能正常查询本机聊天记录。**

## 这个仓库解决什么问题

如果你在 macOS 上用原版 `wechat-cli`，遇到过下面这些情况，这个仓库就是给你用的：

- `init` 找不到微信数据库目录
- `init` 明明扫到了东西，最后却显示“提取到 0 个密钥”
- `wechat-cli sessions` 报 `无法解密 session.db`
- 报 `file is not a database`
- 联系人、会话、消息查询直接挂掉
- 私聊里“我发的”和“对方发的”显示反了
- 私聊 `--format text` 看不出到底是谁在说话

## 它到底是什么

用人话说：

- **它本质上还是 `wechat-cli`**
- 只是加了一层 **macOS 兼容补丁**
- 让原版没覆盖到的那类微信数据库，也能正常读出来

更准确一点：

- `init` 这一步，还是复用原版二进制去提取密钥
- `sessions` / `unread` / `contacts` / `history` / `search` / `new-messages` 这些查询命令，走这个仓库里的兼容实现
- 还没改到的命令，会继续 fallback 到原版

所以你可以把它理解成：

**“原版 wechat-cli + macOS 兼容层 + 一些已经修好的查询逻辑”**

## 它不是什么

避免误会，先说清楚它不做什么：

- 不是官方仓库
- 不是 GUI 工具
- 不是自动发消息工具
- 不是全平台方案，目前重点就是 **macOS**
- 不是从零替代原项目，而是补原项目在一部分 macOS 微信上的兼容坑

## 哪些人适合直接用

你满足下面这几个条件，基本就可以直接按 README 走：

- 你是 `macOS`
- 你装的是桌面版微信，而且已经登录过
- 你想查本机聊天记录，而不是做发消息自动化
- 你试过原版 `wechat-cli`，但在你的机器上不稳定或者直接不可用

如果你原版 `wechat-cli` 本来就完全正常，那你其实 **不一定需要这个仓库**。

## 小白用户怎么用

就按下面 4 步走，不要自己脑补。

### 0. 先准备好这些

- macOS
- 微信桌面端，且已经登录
- 给你正在用的终端开启“完全磁盘访问权限”
- Node.js `>= 22`
- `pnpm`

建议先确认：

```bash
node -v
pnpm -v
```

### 1. 安装这个仓库

```bash
git clone https://github.com/orime/wechat-cli-macos-compat.git
cd wechat-cli-macos-compat
pnpm install
pnpm link --global
```

执行完以后，系统里的 `wechat-cli` 就会指到这个兼容版入口。

### 2. 自动生成 compat 目录

原版 `wechat-cli` 只认它自己那套数据库布局，但你的微信真实数据库往往不是那种名字。

这个仓库带了一个脚本，会自动把微信真实数据库映射成它能识别的结构：

```bash
pnpm setup-compat-dir
```

正常情况下它会输出类似：

```bash
Compat db_storage 已准备好
来源目录: /Users/you/.../com.tencent.xinWeChat/.../某个账号目录
目标目录: /Users/you/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/compat/db_storage
```

这一步做完后，你就有了一个兼容目录：

```bash
~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/compat/db_storage
```

### 3. 初始化密钥

```bash
sudo wechat-cli init --db-dir "$HOME/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/compat/db_storage" --force
```

这一步需要注意：

- 微信最好保持打开并已登录
- 如果弹出权限相关问题，优先看原作者 README 里的 macOS 说明
- 如果报 `task_for_pid failed`，通常不是这个仓库的问题，而是 macOS 权限 / 签名问题

初始化成功后，会写出：

- `~/.wechat-cli/config.json`
- `~/.wechat-cli/all_keys.json`

### 4. 直接开始查聊天记录

最近会话：

```bash
wechat-cli sessions --format text
```

未读消息：

```bash
wechat-cli unread --format text
```

找联系人：

```bash
wechat-cli contacts --query "李" --limit 20 --format text
```

查某个私聊或群最近消息：

```bash
wechat-cli history "小白李强" --limit 20 --format text
wechat-cli history "Ai-n8n学术交流群" --limit 20 --format text
```

搜关键词：

```bash
wechat-cli search "Claude" --limit 20 --format text
wechat-cli search "Steam" --chat "qqmail" --limit 20 --format text
```

## 这个仓库帮你做了哪些修复

当前已经落地的修复包括：

- 兼容另一套 macOS 微信数据库目录和文件命名
- 兼容当前样本里的解密页参数
- 兼容联系人库、会话库、消息库的 schema 差异
- 兼容 WAL，避免读到旧快照
- 修复私聊消息方向位判定
- 修复私聊 `--format text` 的说话人显示

你可以把它理解成：

**它不是增加了很多新功能，而是把“原版本来该能用但在你机器上用不了”的部分修到能用。**

## 这仓库目前最适合谁

最适合这两类人：

### 1. 普通用户

目标很简单：

- 我要查聊天记录
- 我要搜关键词
- 我要看某个群今天聊了什么

那你就按上面的“4 步”走，够了。

### 2. 开发者

如果你是想继续把它做成一个更完整的 fork，这个仓库现在提供的是：

- 一套已经验证过的 macOS 兼容方向
- 一套能跑通的查询实现
- 一套可继续扩展的补丁入口

## 当前可用命令

当前我重点保证的是这几个命令：

```bash
wechat-cli sessions --format text
wechat-cli unread --format text
wechat-cli contacts --query "张" --limit 10 --format text
wechat-cli history "qqmail" --limit 20 --format text
wechat-cli history "小白李强" --limit 20 --format text
wechat-cli search "Steam" --chat "qqmail" --limit 20 --format text
wechat-cli new-messages --limit 100 --format text
```

## 私聊“谁说的”现在怎么判断

这个问题单独说一下，因为很容易踩坑。

当前补丁版已经修正了私聊方向位：

- `mesDes = 0` 表示 **我发的**
- `mesDes = 1` 表示 **对方发来的**

所以现在：

- `--format json` 里的 `outgoing` 可以直接信
- `--format text` 也会明确显示 `我:` 或 `对方名:`

也就是说，私聊里不会再出现“明明是对方说的话，却被标成我发的”这种情况。

## 和原版的关系

这个仓库不是为了“替代原作者”，而是为了：

- 明确保留原作者项目链接
- 把参考来源写清楚
- 把这次实际踩到的兼容问题说清楚
- 把已经验证过的修复沉淀下来

所以它更像一个：

**面向 macOS 微信兼容问题的可用 fork**

而不是一个完全脱离 upstream 的新项目。

## 后面可能继续做什么

如果继续往下做，下一步比较值得补的是：

1. 自动探测更多数据库布局
2. 自动探测解密页参数，不再写死
3. 做更稳的坏页 / WAL 容错
4. 增加 `doctor` 子命令
5. 补 `export`、`stats`、`favorites` 等命令

## 最后一句

如果你是普通用户，只要记住一句话：

**这个仓库不是让你学微信数据库结构的，它是让你在 macOS 上把 `wechat-cli` 用起来的。**
