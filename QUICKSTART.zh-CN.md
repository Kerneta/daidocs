<p align="center">
  <a href="QUICKSTART.md">English</a> ·
  <b>简体中文</b>
</p>

# 快速上手

五分钟，不预设任何前置知识。如果这个仓库你只读一个文件，就读这一个。

大家需要的其实是**两**步，而第二步正是人人都会跳过的那一步：

1. **连接**存储，让你的助手能够触达你的记忆。
2. **激活阅读**，让它以高效的方式读取那份记忆。

只做第一步不做第二步也能用，但那样它会读取整个文件而不是三段缩放：多花一个数量级的 token，**却毫无准确率上的收益**。两步都在下面。

---

## 第 0 步。把它装到你的机器上

你需要 **Node 18 或更高版本**。用 `node --version` 检查。如果报错，先从 nodejs.org 安装 Node。

最快的方式是一条命令，它会获取工具并配置好一切：

```bash
npx daidocs setup
```

**想要源码和基准测试的原始产物？**改为克隆下来、从那个文件夹里运行 setup。想复现我们的数字时，也用这个版本：

```bash
git clone https://github.com/Kerneta/daidocs daidocs-app
cd daidocs-app
node setup.js
```

每一行都是各自独立的命令。`setup.js` 首次运行时安装依赖，然后完成下面的第一步。`npm run setup` 是同一件事，但在 Windows 上**请用 `node setup.js`**：在更改执行策略之前 PowerShell 根本不肯运行 npm，而 node 不受影响。也不要用 `&&` 把这些行连起来：Windows PowerShell 5.1 会把那当作语法错误。

## 第 1 步。连接

刚才那条命令替你运行了这个：

```bash
node setup.js
```

它什么都不问。它找到你已有的东西并全部配置好，备份每一个它触碰过的文件，之后再次运行也安全。它开启的每一项都能关回去：

```bash
node setup.js --status
```

会列出哪些已开启，以及更改每一项的命令，而 `node setup.js --restore` 把机器完全还原到之前的状态。如果你更想边走边逐项决定，`node setup.js --ask` 会把那些问题带回来。

**使用 Claude 之外的 MCP 客户端？**每个都是一条命令：

```bash
node setup.js --client codex
```

`cursor`、`windsurf`、`cline`、`continue` 和 `zed` 的用法相同，`--client list` 会列出它们以及各自保存配置的文件，而 `node setup.js --client generic --config <文件>` 处理列表之外的任何客户端。这里没有任何需要手改的配置。

**在 Claude 订阅下你不需要密钥。**在 Claude Code 和 Claude Desktop 里，刚刚读过对话的助手会亲自写出提取内容，因此保存是免费的，不产生任何计费。阅读是在索引之上运行的本地代码，在订阅下它展示整个文件索引而不是经过排序的候选短名单，并且会明说这一点。安装时问你一次用哪个模型，此后这个选择处处适用。

**若改用 API key**，转换一段对话是一次小模型调用，用 `gpt-4.1-mini` 大约 $0.003，而阅读会从一次带缓存的 `text-embedding-3-small` 调用中获得一个经过排序的候选短名单。

```bash
# Windows
setx OPENAI_API_KEY "sk-..."

# macOS / Linux
export OPENAI_API_KEY="sk-..."
```

`setx` 把变量写给**将来**的终端，而不是你当前所在的这个，所以在下一步之前请开一个新终端，否则什么都看不到这个密钥。

## 第 1b 步。把你已有的历史带进来

安装程序不会自作主张做这件事：它可能要跑一会儿，而且在有 API key 时会花钱。但如果你已经用了几个月的 Claude Code，正是这一步让存储今天就有用，而不是一周之后：

```bash
node daidocs.js convert
```

它会找到你的 Claude Code 会话、钩子已捕获但尚未转换的内容，或你指给它的一个导出文件夹。它展示找到的内容、问你想要哪些，并在任何付费调用之前给出最坏情况的费用。在 Claude 订阅下这笔费用为零。每个会话都落回它来源的文件夹。

**确认它成功了：**

```bash
npm run selftest
```

每一行都应以 PASS 结尾。

## 第 2 步。激活阅读

这就是那个会被跳过的步骤。找到属于你的那一行。

### 如果你用 Claude Code

```bash
node setup.js --instructions
```

完成。它把阅读协议写进 `~/.claude/CLAUDE.md`，因此从现在起本机上每一个 Claude Code 会话都能正确读取存储。无需记着什么，无需粘贴。随时用 `node setup.js --unregister` 撤销它。

### 如果你用 Claude Desktop

设置，然后 Profile，然后把这段粘进去：

```
When I reference past work or preferences not in this conversation, call
recall_memory before answering, and read stores in three zooms: manifest first,
then a file's Understanding block, then specific segments only if needed.
```

### 如果你在浏览器里用 claude.ai、ChatGPT、Gemini 或本地模型

1. 打开 [`prompts/READER-PROMPT.txt`](prompts/READER-PROMPT.txt)。
2. 全部复制。
3. 作为新对话的第一条消息粘贴进去。
4. 然后粘贴或附上你的 `_index/manifest.jsonl`（在 `~/DaiDocs/_index/` 里找）。
5. 提你的问题。

当助手要某个具体片段时，只给它那一个片段。不要为了省一次往返而粘贴整个文件：那次往返正是关键所在。

### 如果你想在浏览器助手里让它长期生效

同一段提示，但放进持久指令里，而不是每次粘贴。

- **claude.ai**：新建 Project，粘进 Project 指令，把你的 manifest 作为项目知识附上。
- **ChatGPT**：新建 Custom GPT，粘进 Instructions，把 manifest 作为 Knowledge 附上。
- **Gemini**：新建 Gem，粘进 Instructions。

添加文件后要重新附上 manifest。它是唯一会过时的部分。

### 如果你在针对某个 API 写自己的代码

用 `prompts/READER-PROMPT.txt` 作为 `system` 提示。经测量效果最好的答案长度上限：lookup 220、advice 350、timeline 400、tally 400。更长反而更差：抬高预算会招来含糊其辞，而含糊的答案对谁都没用。

---

## 第 3 步。使用它

正常说话就行。

- *「把这段对话存进记忆」*
- *「关于部署流水线我们当时定了什么？」*
- *「关于我的 Valletta 之行你还记得什么？」*

装好 Claude Code 钩子后，每个会话都会自己保存：工作时每新增 4,000 个 token 一次，结束时再一次。提前关掉终端，未转换的部分会被保留在该文件夹存储的 `_unconverted/` 里，并在那个文件夹的下一个会话开头被逐字读入，因此它在转换之前就能用。没有什么需要你记着去做。

你的文件住在 `~/DaiDocs`，或者一旦你声明了某个项目文件夹，就住在那个文件夹里面。要声明它，在那里的一个会话中输入**「把这个文件夹变成一个项目」**。打开文件夹。用记事本读它们。这就是产品本身。

---

## 看看你有些什么

```bash
npm run dashboard
```

在安装文件夹里运行它，也就是放着 `package.json` 的那个。它会在 `package.json` 旁边写出 `daidocs-dashboard.html` 并在你默认使用的浏览器里打开。`--no-open` 则改为打印路径。里面有：每个存储及其大小、每条记忆及其日期和它连着什么、已捕获但尚未转换、按来源项目分组的会话，以及项目文件夹本身以树状呈现。点击一条记忆会把它完整打开，包括提取所依据的逐字原文。

这个页面是构建出来的，不是服务出来的。它展示的一切都是从你的文件里读出并嵌入这一个文件的，因此离线可用，也不需要任何进程在跑。这也意味着它是一张快照：想要当前数字时就重建它。

它由**你的**存储构建，因此它包含你的记忆、你的转录和你的文件夹路径。像对待存储本身那样对待一个构建出的页面，不要把它放进仓库。这就是为什么发布随附的是构建器，而从不是构建好的页面。

---

## 它成功了吗？

| 症状 | 可能原因 | 解决 |
|---|---|---|
| `npm.ps1 cannot be loaded because running scripts is disabled on this system` | PowerShell 的默认执行策略拦下了 npm 自己的脚本。它拦下的是每一条 npm 命令，不只是这一条 | 用 `node setup.js`，它不受影响。若要让 npm 能运行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`（无需管理员） |
| `destination path 'daidocs' already exists and is not an empty directory` | 你在从主目录克隆，而那里的 `daidocs` 就是你的记忆存储：在 Windows 和 macOS 上 `DaiDocs` 和 `daidocs` 是同一个文件夹 | 用一个自己的名字克隆，`git clone <url> daidocs-app`。不要删掉已有的那个文件夹：它装着你的记忆 |
| `could not create work tree dir 'daidocs': Permission denied` | 你在 `C:\\Users` 里，而 Windows 不允许你往那里写 | 在你自己的文件夹里克隆，例如 `C:\\Users\\<you>\\Documents` |
| 安装程序做了你不想要的事 | 它默认会配置好一切 | `node setup.js --status` 给出关闭每一项的命令；`--restore` 撤销全部 |
| 你的另一个 MCP 客户端看不到这些工具 | 它没被配置，或者它不是安装程序能检测到的那种 | `node setup.js --client <name>`，或 `--client generic --config <该客户端的配置文件>` |
| `The token '&&' is not a valid statement separator in this version` | Windows PowerShell 5.1，它没有 `&&` | 每条命令各占一行，或用 `npm run setup` |
| Claude 说它没有记忆工具 | 服务器未注册，或应用没有重启 | `node setup.js --desktop`，然后彻底退出并重新打开应用 |
| Claude Code 从不提供这些工具 | `.mcp.json` 在另一个文件夹里，或服务器未被批准 | `node setup.js --code --project /path/to/repo`，然后在会话启动时批准 `daidocs-mcp` |
| 答案是对的，但又慢又贵 | 第 2 步被跳过了，所以它在读整个文件 | `node setup.js --instructions` |
| 计数类问题算错了 | 它在从散文里数，而不是从事件表里数 | 再做一次第 2 步。那条规则就在协议里 |
| 召回不知道某个最近的会话 | 它还没被转换。召回会把它列在「尚未转换」下并据此作答，而该文件夹的下一个会话会带上它开场 | 说「转换我待处理的会话」，在订阅下免费；或用密钥运行 `npm run catch-up` |
| 它太频繁地回答「我没有关于那个的信息」 | 第 2 步被跳过了，所以弃答没有被限定范围 | `node setup.js --instructions` |
| 你的 API 账单远高于预期 | 你在直接调用引擎，而它不配置提示缓存 | 在你自己的调用里加上 `cache_control`。在 Claude Code 或 Desktop 里通过 MCP，宿主会替你做这件事 |

两种方式都不会丢东西：即便没设密钥，会话也被逐字捕获，`npm run catch-up` 稍后会给它们建索引。

## 改主意了？

```bash
node setup.js --restore
```

把安装程序触碰过的每一个文件完全还原到之前的状态，包括你的 `CLAUDE.md` 和你的 Claude Desktop 配置，并删除它从无到有创建的那些。你的存储不会被动到：无论工具装没装，你的记忆都留在 `~/DaiDocs`。这正是纯文件的意义所在。

---

## 接下来读什么

| 你想要 | 读 |
|---|---|
| 完整的阅读指南，按不同界面分列 | [`docs/READ-DAIDOCS.md`](docs/READ-DAIDOCS.md) |
| 一个 `.dai` 文件究竟是什么 | [`spec/DAIDOCS-STANDARD.md`](spec/DAIDOCS-STANDARD.md) |
| 在任意聊天窗口里用 `.dai`，无需安装 | [`prompts/READER-PROMPT.txt`](prompts/READER-PROMPT.txt) |
| 复现我们的基准数字 | [`docs/REPLICATION.md`](docs/REPLICATION.md) |

---

## 其余一切

这一页是简短版。[`docs/GUIDE.md`](docs/GUIDE.md) 是完整参考：每一条命令及其用途、你的助手得到的六个工具、七种文件夹类型以及各自何时使用、一个短到无法转换的会话会怎样、如何转换你已有的那些、保密文件夹、备份，以及出问题时该检查什么。
