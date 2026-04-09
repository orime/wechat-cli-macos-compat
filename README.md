# 原项目

原作者项目：<https://github.com/freestylefly/wechat-cli>

原项目一句话：

**`wechat-cli` 是一个用命令行查询本机微信聊天记录的工具。**

# 这个仓库是干啥的

这个仓库一句话：

**如果原版 `wechat-cli` 在你的 macOS 微信上跑不通，这个仓库就是拿来把它修到能用的。**

# 你什么时候需要它

如果你在 macOS 上用原版 `wechat-cli` 时遇到这些问题，就用这个仓库：

- 找不到微信数据库目录
- `init` 之后还是报解密失败
- `sessions` / `history` 查不了
- 私聊里“我发的”和“对方发的”显示反了

# 它怎么解决

一句话：

**它不是新工具，它还是 `wechat-cli`，只是补了 macOS 兼容问题。**

它主要做了这几件事：

- 兼容 macOS 微信数据库目录
- 兼容当前这类数据库解密方式
- 兼容联系人、会话、消息表结构
- 修复私聊说话人显示错误

# 小白怎么用

就 4 步：

```bash
git clone https://github.com/orime/wechat-cli-macos-compat.git
cd wechat-cli-macos-compat
pnpm install
pnpm link --global
```

然后执行：

```bash
pnpm setup-compat-dir
```

再执行：

```bash
sudo wechat-cli init --db-dir "$HOME/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/compat/db_storage" --force
```

最后直接查：

```bash
wechat-cli sessions --format text
wechat-cli history "某个联系人或群名" --limit 20 --format text
wechat-cli search "关键词" --limit 20 --format text
```

# 你只需要记住一句

**原版能用，就用原版。原版在 macOS 上用不了，再用这个兼容版。**
