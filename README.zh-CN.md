<p align="center">
  <a href="README.md">English</a> ·
  <b>简体中文</b>
</p>

<div align="center">
  <img src="assets/brand/dai-file.svg" alt="" width="88" height="88">

  <h1>.dai</h1>

  <p><b>面向 AI 记忆的开放纯文本格式（2026 年 9 月发布）。</b><br>
  你的助手的记忆变成磁盘上的文件，可以打开、可以 grep、可以留存。</p>

  <p><b>在 LongMemEval-S 排行榜上位列第二</b>，仅统计任何人都能自行复现的记忆系统，<b>比同一模型在没有任何记忆系统时高出 22.40 分</b>，且每个问题读取的 token 少约 10 倍。<br>
  这里的每个数字都附带逐题的评审判定和一份 sha256 清单。</p>

  <p>
    <a href="QUICKSTART.zh-CN.md"><b>快速上手</b></a> ·
    <a href="docs/GUIDE.md"><b>使用指南</b></a> ·
    <a href="docs/RESULTS.md"><b>基准测试</b></a> ·
    <a href="spec/DAIDOCS-STANDARD.md"><b>格式规范</b></a> ·
    <a href="docs/REPLICATION.md"><b>复现结果</b></a>
  </p>

  <p><b>发布版本 V4.4n32，2026 年 9 月 12 日。</b> <a href="CHANGELOG.md">更新内容。</a></p>

  <p>
    <a href="https://github.com/Kerneta/daidocs/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Kerneta/daidocs?style=social"></a>
    <a href="https://discord.gg/DHDtfPx7jw"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white"></a>
    <a href="LICENSE"><img alt="licence: Apache-2.0" src="assets/badges/licence.svg"></a>
    <a href="package.json"><img alt="node: 18+" src="assets/badges/node.svg"></a>
    <a href="docs/INTEGRATION.md"><img alt="MCP: server included" src="assets/badges/mcp.svg"></a>
    <a href="docs/RESULTS.md"><img alt="LongMemEval-S: 83.00% gpt-4o" src="assets/badges/lme-gpt4o.svg"></a>
    <a href="RESULTS-ACTORS.md"><img alt="LongMemEval-S: 92.00% Claude Fable 5" src="assets/badges/lme-fable.svg"></a>
    <a href=".github/workflows/ci.yml"><img alt="checks: offline, no API key" src="assets/badges/checks.svg"></a>
  </p>

  <p><sub>如果 <code>.dai</code> 对你有用，点一个 <a href="https://github.com/Kerneta/daidocs/stargazers">star</a> 能帮更多人找到它。</sub></p>
</div>

<div align="center">
  <img src="assets/demo/product-demo.gif" alt="完整产品一镜循环：一行安装、Claude Code 边建站边在文件夹里生成文件、记忆地图、同样六个问题分别用 61.2 万 token 的历史与 DaiDocs 作答（共读 3,674,880 对 392,120 个 token），以及一份 .dai 文件由 ChatGPT 保存后沿连线被 Gemini 和本地模型读取" width="900">
  <p><sub><b>整个产品，一个循环。</b>安装、构建、记住、召回：一个存储、每个模型，token 约为原来的十分之一。录制使用虚构数据。</sub></p>
  <p><sub><a href="https://daidocs.com/demo.html">&#9654; 想看更高画质，请在浏览器里观看实时演示</a></sub></p>
</div>

---

## 与语言无关，与模型无关

一个 `.dai` 文件由三段纯文本组成：一段 YAML 头部、一段被围栏包裹的 JSON 块，以及正文。没有二进制，没有数据库，读取它也不需要任何 SDK。

- **任意编程语言。** 参考引擎用 Node 写成。用 Python、Rust 或 Go 写一个读取器只是一个下午的工作，而[规范](spec/DAIDOCS-STANDARD.md)是规范性的，其写法保证了两个独立实现能互相吻合。
- **任意模型。** 存储由一个廉价的观察者模型写入一次，再由任意回答模型读取。同一份存储用五个回答模型测量：从 78% 到 92%。换模型，留记忆。
- **任意工具。** `grep`、`git log`、`diff`、你的编辑器、一段 Shell 脚本。让记忆听命于最普通的工具。

用另一种语言写一个读取器并提交 PR：那是最有价值的贡献。

---

**本仓库里有什么：**读写 `.dai` 文件的 Kerneta 引擎 V4.4n、把它连接到你的助手的 MCP 服务器，以及下文引用的每一个数字的完整证据：基准测试的运行记录、评审对全部 500 个问题逐一给出的判定，以及五模型对比。每一份证据文件都在 [`MANIFEST.sha256`](MANIFEST.sha256) 里有哈希，你可以核对所描述的是否就是所测量的；具体做法见 [`docs/PROVENANCE.md`](docs/PROVENANCE.md)。

<div align="center">
  <img src="assets/charts/ranking.png" alt="LongMemEval-S 上严格同设置的排名：Mastra OM 84.80%，.dai v4.4n 83.00%，Supermemory 81.60%，Mastra RAG topK 20 81.20%，EmergenceMem Simple Fast 79.00%，TiMem 76.88%，Zep 71.20%，Feather 69.30%，GPT-4o 配 Chain-of-Note 64.00%，GPT-4o 无记忆系统 60.60%" width="820">
  <p><sub><b>排行榜第二。</b>每一行都用同一套设置：LongMemEval-S、GPT-4o 回答、全部 500 个问题、微平均，且只收录非厂商内部人员也能复现的配置。最底下一行是同一个 GPT-4o 在没有任何记忆系统时，把整段历史粘贴进上下文再作答：<b>比我们低 22.40 分</b>。这里的每个数字都带一条注意事项，且注意事项随数字一起出现，见 <a href="docs/RESULTS.md">docs/RESULTS.md</a>。</sub></p>
</div>

<p align="center"><b>不在那张表里？</b>Graphify、Hindsight、Mem0 等系统公布的数字，测量所用的回答模型、分母或基准各不相同，因此无论朝哪个方向，都无法与一行 GPT-4o 500/500 的结果并排比较。它们每一个都列在 <a href="https://daidocs.com/results.html"><b>daidocs.com/results.html</b></a>，附上各自的数字究竟测量了什么，以及我们相对它处于何处。</p>

<div align="center">
  <img src="assets/charts/actors.png" alt="相同存储、相同提示、相同评审：五个回答模型在 LongMemEval-S 上的表现" width="820">
  <p><sub>一层记忆，五个回答模型，各答 500 个问题。每一行的检索完全相同（由一份逐字节相同的诊断文件证明）。细节与注意事项见 <a href="RESULTS-ACTORS.md">RESULTS-ACTORS.md</a>。</sub></p>
</div>

---

## 为什么会有这个项目

市面上的每一款记忆产品都把你的历史存放在它自己的服务里，再通过它自己的 API 交还给你。`.dai` 押的是相反的注：**记忆是一种文件格式**，就像照片是 JPEG 一样。每段对话三个纯文本区块，旁边一份小小的派生索引，任何模型、任何工具或 `grep` 都能读取。

| | 记忆作为服务 | 记忆作为格式（`.dai`） |
|---|---|---|
| 你的历史存在哪里 | 它们的数据库 | 你的磁盘，纯文本 |
| 谁能读取 | 它们的 SDK | Claude、GPT、Gemini、Cursor、本地模型、`grep`、`git` |
| 厂商消失时 | 记忆也随之消失 | 文件在任何编辑器里依然可读 |
| 你如何审视一次召回 | 有日志的话看日志 | 打开答案所引用的那个文件 |
| 一个基准数字意味着什么 | 某个产品的一条流水线 | 一个存储，按回答模型分别测量，所以你可以自己挑模型 |

存储由一个廉价的**观察者**模型构建一次，再由任意**回答**模型读取。用好模型转换，再用最便宜、最快或本地的模型作答。数字见下文。

---

## 配合使用

一个存储，通过 MCP 连接，由你已经在用的工具读写。`node setup.js` 检测并配置其中每一个，并备份它触碰过的文件；[安装](#安装)一节有逐个工具的命令。

| 助手 | 编辑器与 IDE | CLI 与任意 MCP 客户端 |
|---|---|---|
| Claude Desktop、Claude Code、任意经 MCP 的模型 | Cursor、Windsurf、Zed、Cline、Continue | Codex CLI，以及经 `--client generic --config <文件>` 的任意 MCP 客户端 |

**任意支持 MCP 的运行时也可以。** 该服务器是一个普通的 stdio MCP 服务器，因此说 MCP 的框架无需写任何适配器即可调用 `save_memory` 和 `recall_memory`：OpenAI Agents SDK、Vercel AI SDK、LangGraph、LangChain、CrewAI 和 LlamaIndex 都能把一个 MCP 服务器当作工具来源。把它们指向 `node mcp_server.mjs`。

**把你的历史带进来。** 本机上的 Claude Code 会话会自动转换。对于任何其他工具，导出一个装着 `.txt`、`.md` 或 `.jsonl` 的文件夹，运行 `node daidocs.js convert`。从更多工具原生导入历史在[路线图](#参与贡献)上。

---

## 安装

Node 18 或更高版本。

```bash
npx daidocs setup
```

一条命令。它会检测 Claude Desktop、Claude Code、Cursor、Windsurf、Codex、Cline、Continue 和 Zed，把它们全部配置好，装上会话钩子、阅读协议和 `.dai` 图标，并备份它触碰过的每一个文件。在 Claude 订阅下不需要 API key，也没有任何费用。

**也想要源码和基准测试产物？**那就克隆下来，改从克隆目录里运行 setup：

```bash
git clone https://github.com/Kerneta/daidocs daidocs-app
cd daidocs-app
node setup.js
```

克隆目录特意命名为 `daidocs-app`。否则 `git clone` 会创建一个名为 `daidocs` 的文件夹，而默认的记忆存储叫 `DaiDocs`：在 Windows 和 macOS 上这两者是同一个文件夹，因此从主目录做的克隆会覆盖到你自己的记忆上。万一真的发生，安装程序会拒绝从存储内部运行。

`setup.js` 首次运行时安装依赖，然后配置好一切。`npm run setup` 做的是同样的事，但在 Windows 上要用 `node setup.js`：在你更改执行策略之前 PowerShell 根本不肯运行 npm，而 node 不受此影响。上面每一行都是各自独立的命令，因为 Windows PowerShell 5.1 没有 `&&`。

安装程序什么都不问。它检测你已有的东西并全部配置好：Claude Desktop、Claude Code、会话钩子、Cursor、Windsurf、Codex、Cline、Continue、Zed、阅读协议以及 `.dai` 文件图标。它会备份每一个它触碰过的文件。

```bash
node setup.js --status     显示哪些已开启，以及更改每一项的命令
node setup.js --ask        改为让你自己逐项选择
node setup.js --restore    把机器完全还原到之前的状态
```

它唯一不会自作主张去做的，是转换你已有的历史，因为那可能要跑一会儿，而且在有 API key 时会花钱。你想要它时它只是一条命令，而且值得想要：见[把你已有的东西带进来](#把你已有的东西带进来)。

**另一个 MCP 客户端？**每个都是一条命令，无需手改配置：`node setup.js --client codex`（或 `cursor`、`windsurf`、`cline`、`continue`、`zed`），其余任何客户端用 `node setup.js --client generic --config <该客户端的配置文件>`。`node setup.js --client list` 会列出这些名称以及各自的配置文件所在位置。

在 Claude Code 里，每个会话都会在你工作时自己保存，无需你记着什么。在任何其他已连接的助手里，说一句**「把这段对话存进记忆」**。要给某个文件夹它自己的项目记忆，在该文件夹里说**「把这个文件夹变成一个项目」**，或在其子文件夹里说以创建一个子项目。

### 把你已有的东西带进来

安装这个的人多半在磁盘上已经躺着好几个月的对话。一条命令就能把它们变成记忆，这就是「今天下午就能用」和「从现在起慢慢攒满」两种存储之间的区别：

```bash
node daidocs.js convert
```

它读取三类历史，方式都一样：

- **本机上的 Claude Code 会话**，来自 `~/.claude/projects`
- **已捕获但尚未转换的会话**，即 `_pending` 标记及其在 `_unconverted/` 里的文本
- **任意来源的一个导出文件夹**：`.txt`、`.md` 或 `.jsonl`

它会带上日期、项目和大小列出找到的内容，问你要转换哪些（`all`，或 `1,3,5-8`），问你存储放在哪里，并在任何付费调用之前**给出最坏情况的 token 数和费用**。在 Claude 订阅下这笔费用为零：会话中的助手会亲自写出提取内容。每一项一完成就立刻写入，因此崩溃最多丢失一份文档，重新运行会跳过已经转换好的部分。会话落在它们各自来源的文件夹里，因此一个项目的历史最终进入该项目自己的存储，而不是堆在一处。

每个问题都有对应的参数，因此可以脚本化：

```bash
node daidocs.js convert --source claude --project atlas-api --pick 1-5 --to ~/DaiDocs --yes
```

[使用指南](docs/INTEGRATION.md#converting-existing-history)列出了每一个参数。

### 之后一切自动进行

你不必记着去保存任何东西。钩子一旦装好，每个会话都会自己保存：

- **每新增 4,000 个 token**，到目前为止的会话就在后台被转换，进入你正在工作的那个文件夹。它由对话里已有的助手写出，因此不需要 API key，也没有额外调用。
- **比这更早关掉终端**也不会丢东西。每次回复之后，尚未转换的文本就被写入该文件夹存储里的 `_unconverted/`，因此即便终端被强杀，最多也只丢失最后一次往来。再次在该文件夹里打开会话，那段文本会在开头被逐字读入，`recall_memory` 也会读到它，因此一个 2k 的会话在转换之前就能使用。等待中的内容计入下一次保存，所以昨天的 2k 和今天的 2k 会一起转换，文件夹也随之清空。
- **你第一次在某个文件夹里打开会话时**，会先被问一个问题：这个文件夹的记忆是留在这里、作为一个独立的项目，还是放进和其他一切在一起的通用存储？无论怎么回答都会被记住，因此该文件夹不会再问你第二次。

所以你唯一要做的就是工作。[使用指南](docs/GUIDE.md)有细节，下方的示意图展示了整条路径。

---

## 你得到的是什么

一个文件夹。全部诀窍就在这里。

```
~/DaiDocs/
├── 2026-07-12_deploy-debug.dai     每段对话一个文件，三个区块
├── 2026-07-18_q3-planning.dai
├── _index/                         检索所读取的：manifest、facts、events、profile
├── _unconverted/                   尚未转换的内容，很小，由下一个会话读取
└── _raw/                           你的原文，逐字节保留，永不删除
```

没有数据库，没有记忆服务器，也没有厂商攥着你的历史。一个存储同时服务 Claude、GPT、Gemini、Cursor 和本地模型，而且在它们中任何一个消失后依然可读。

也就是说，你的记忆听命于最普通的工具：

```console
$ grep -l "Casa do Rio" ~/DaiDocs/*.dai
/home/you/DaiDocs/chat_20260720_e0546121.dai

$ head -12 ~/DaiDocs/chat_20260720_e0546121.dai
---
daidocs: "4.4"
id: "chat_20260720_e0546121"
type: "chat"
title: "Valletta trip planning chat"
lang: "en"
source: {"app": "claude", "native_id": "chat_20260720_e0546121"}
span: null
messages: 3
class: {"category": "general", "priority": "normal", "actionable": false, "sensitivity": "public", "confidence": 0.9}
summary: "User booked a summer trip to Valletta staying at the Casa do Rio guesthouse."
tags: ["x.travel"]
```

没有客户端，没有查询语言，没有导出步骤。愿意的话，可以给你的记忆 `git log`。

### 想看的时候，还有一张它的地图

```bash
npm run dashboard
```

<div align="center">
  <img src="assets/demo/dashboard-demo.gif" alt="记忆地图的点击浏览：每个存储及其占用的磁盘空间、按项目分组的转换积压、一个存储里的记忆以及相关记忆之间的连线、作为独立页面的单条记忆、文件的三个区块加上逐字保留的原文、实时搜索、带备份和文件夹类型的文件夹页面，以及项目文件树" width="900">
  <p><sub>记忆地图的点击浏览：每个存储及其文件夹类型与磁盘占用、一个存储里的记忆及相关记忆之间的连线、作为独立页面的单条记忆、文件的三个区块与未改动原文并列。由你自己的文件构建成离线可用的单页。录制使用虚构数据。</sub></p>
</div>

**如何打开：**在安装文件夹里运行 `npm run dashboard`。它会在 `package.json` 旁边写出 `daidocs-dashboard.html` 并在你的默认浏览器里打开。一个文件，离线，无需服务器。如果你只想让它告诉你路径，传 `--no-open`。

它是一张快照，所以显示的是构建那一刻的状态。若想在工作时让它保持最新：

```bash
npm run dashboard-live
```

它会在任何存储发生变化时重建页面，并在你停止操作后让页面自行重新加载，回到你刚才在看的那个存储。它绝不会在你阅读中途或点击时重新加载。

### 会话很短时也不会丢东西

<div align="center">
  <img src="assets/diagrams/lifecycle.png" alt="一个会话会经历什么：每次停止时钩子都检查是否新增了 4,000 个 token；超过阈值就立即转换，未达阈值则未转换文本进入 _unconverted 并在 _pending 里留一个标记，等你下次打开那个文件夹时被读入，等它值得成为一条记忆时再转换" width="880">
</div>

新增不足 4,000 个 token 的会话还不会被转换。它的文本被写入该文件夹存储里的 `_unconverted/`，而该文件夹里的下一个会话会在助手面前以逐字形式带上它开场，因此说过的话不会丢失也不会不可读；`recall_memory` 也会读到它。关掉终端不改变任何事：文本和它的标记都是磁盘上的文件。你可以随时转换积压，一次一个项目，每一个都落回它来源的文件夹。一旦某个被转换，它就离开 `_unconverted/`。[使用指南](docs/GUIDE.md)有细节。

### 记忆属于它所关于的那个文件夹

<div align="center">
  <img src="assets/diagrams/folder-types.png" alt="七种文件夹类型：normal、locked、frozen、connected、shared、confidential 和 temporary，以及每一种对该文件夹记忆的作用" width="880">
</div>

声明一个文件夹，它的记忆就住在它内部并随它一起走。这个文件夹**是什么**，接着就决定这份记忆会怎样：`locked` 文件夹保留它已有的、不再接收新内容，`frozen` 文件夹已经完结，`confidential` 文件夹永远不会被纳入任何更大范围的读取。在会话里说一句、在地图里设置，或传 `--project-type`。

不用等别人来问你。在该文件夹里的一个 Claude Code 会话中，输入**「把这个文件夹变成一个项目」**；这就是全部指令。一个由多个部分组成的项目，比如一个网站、一个应用，就是多个项目：在顶层**「把这个文件夹变成一个会读取各部分的项目」**，在每个部分里**「把这个文件夹变成一个项目」**，这样一个会话只加载它那部分的记忆，而当某个部分需要时再**「也去主项目的记忆里看看」**；它只问一次。[使用指南](docs/GUIDE.md#say-it-in-the-terminal)有一步步的说明。

---

## 它到底管不管用

在 **LongMemEval-S** 上 **83.00%**（415/500）：500 个问题跨越平均 103,601 个 token 的对话历史，由本仓库里的适配器（[`benchmark/run_longmemeval.mjs`](benchmark/run_longmemeval.mjs)）在从数据集全新构建的存储上测量，由基准作者自己的 `evaluate_qa.py`、评审快照 `gpt-4o-2024-08-06`、GPT-4o 回答来评分。按任务平均：84.02%。

[`docs/RESULTS.md`](docs/RESULTS.md) 记录了完整条件、含最弱几行在内的分类细目，以及对一切因针对此基准开发而受影响之处的披露。

引擎读取的是存储中一小片与问题相关的切片，而不是整段历史：**每个问题 10,065 个 token，对应 103,601 个 token 的历史，约少 10.3 倍**，两侧用同一个分词器计数。检索几乎全是在索引之上运行的代码；它唯一的外部依赖是一次带磁盘缓存的 `text-embedding-3-small` 调用，用来给阅读模型看到的内容排序（计数类和建议类读取会对候选事实再做一次调用）。

**基准第二**，仅统计其配置能被非厂商内部人员复现的记忆系统。有一个系统公布了更高的数字：Mastra Observational Memory 为 84.80%，在同一个 GPT-4o 回答者上领先 1.80 分、9 个问题，这个差距落在 n=500 时的单次运行噪声之内（标准误 1.68 分）。相对基准作者自己的全上下文基线，即同一个模型阅读粘贴进来的历史，它领先 22.40 分。完整表格、决定谁能入表的规则，以及每个数字所带的注意事项都在 [`docs/RESULTS.md`](docs/RESULTS.md) 里；数字本身连同来源作为数据记录在 [`tools/references.json`](tools/references.json)。

引擎用一个针对问题文本的正则分类器，把问题路由到四种阅读策略之一（lookup、tally、timeline、advice）。这是否是为基准量身定制，是一个合理且可核查的问题：分类器只读问题文本，无法访问数据集，任何调用方都不能覆盖它。从随附源码里把它打印出来并自己测量：

```bash
node tools/verify_router.mjs /path/to/longmemeval_s.json
```

[那次测量能排除什么、不能排除什么。](docs/RESULTS.md#you-classify-the-questions-isnt-that-gaming-the-benchmark)

### 一层记忆，五个回答模型

存储在模型之间是可移植的；分数不是。于是同样这 500 个问题被重新回答一遍，其余一切都保持固定（相同存储、相同渲染后的提示、相同正则路由、相同评审），只替换回答模型：

| 回答模型 | 准确率 | 正确数 | +/- 1 标准误 | 任务平均 |
|---|--:|--:|--:|--:|
| Claude Fable 5 | **92.00%** | 460/500 | 1.21 | 91.94% |
| Claude Opus 5 | **91.00%** | 455/500 | 1.28 | 90.94% |
| Claude Sonnet 5 | **85.60%** | 428/500 | 1.57 | 86.75% |
| `openai:gpt-4o`（发布运行） | **83.00%** | 415/500 | 1.68 | 84.02% |
| Claude Haiku 4.5 | **78.00%** | 390/500 | 1.85 | 77.66% |
| `openai:gpt-4o`，无记忆系统 | 60.60% | 303/500 | 2.19 | 未公布 |

最后一行是同一个模型在**完全没有记忆层**时的表现：基准作者自己的全上下文基线，即把整段历史粘贴进上下文窗口、模型据此作答。这是他们在他们的框架上的测量，不是我们的运行。它的正确数和标准误是在那个已公布的百分比、n = 500 上用给每一行标准误的同一个公式做的算术；任务平均一列留空，因为那需要六个分类型的准确率，而他们只公布了一个总体数字。把它对着我们的 `gpt-4o` 那一行读，是可得的最干净的对比，因为回答者完全相同，唯一的变量就是记忆：**83.00% 对 60.60%，相差 22.40 分**，而且这是运行成本最高的一行，因为粘贴历史正意味着每个问题一次 100,000 个 token 的提示。

Fable 5 和 Opus 5 彼此在一个标准误之内，应当视为并列。整个差距全落在**多会话综合**上（从 88.72% 到 69.92%）；每一行的检索都完全相同，由一份逐字节相同的逐题诊断文件证明。Claude 那几行是通过 `manual` 提供方路线而非 API 产生的，这是一个真实的差异，在 [`RESULTS-ACTORS.md`](RESULTS-ACTORS.md) 里有完整披露。

### 单独测量检索本身

一次仅测检索的扫描，在 k = 1 到 15 上重读同样这 500 个问题、完全不调用模型：**内容召回在 k=1 时为 96%，从 k=3 起为 98%**，k=5 以上再无变化。随附的工作点（k=5，10,065 个 token）正处在曲线已经走平之处。多会话在 gpt-4o 下是 99% 的内容召回和 72.18% 的准确率，这是最清楚的证据，说明剩下的错误是阅读错误，而不是搜索错误。

<div align="center">
  <img src="assets/charts/recall.png" alt="LongMemEval-S 上随 k 变化的召回" width="820">
</div>

完整表格、两种召回定义，以及零网络调用的证明都在 [`experiments/recall-sweep/`](experiments/recall-sweep/)。

---

## 它何时物有所值，何时不是

**在大约 2 万 token 历史以下，没多少可存的。**你只是问几个问题，整段对话仍然装得进窗口，所以用到的是原文，DaiDocs 帮你做的事不多。过了那个点，历史就装不下了，`.dai` 存储正是让答案保持可用的东西。后台转换无论如何都在跑，每 4,000 个 token 一次，所以等你越过那条线时，存储早已在那里。

**智能体轨迹是它唯一处理得不好的形态。**工具调用、堆栈跟踪和文件转储看起来一点也不像对话，今天转换它们会产出很差的存储。这是一个真实的缺口，正在解决中。

**想让我们替你运行？**这里的引擎就是完整的引擎，而且永远会是，自托管、在 Apache-2.0 下免费。如果你不愿自己运维，我们提供托管：转换、存储和召回作为一项托管服务，格式相同、文件相同，随时可导出。这里的工作正是靠这个来资助的。见 [daidocs.com](https://daidocs.com)。

---

## 选择你的模型

**安装时问你一次，此后这个选择处处适用。**转换、钩子、MCP 服务器和 CLI 都用它，直到你更改为止。

**在 Claude 订阅下，在 Claude Code 里：用 Opus。**这是我们的推荐，而在订阅下，转换由对话里已有的助手写出，因此没有 API key，也没有额外要付的钱。

**用 API key：用 `openai:gpt-4.1-mini`。**低成本、高准确率，而且它就是本仓库每一个已公布数字所用的观察者。`gemini:gemini-3.1-pro` 是另一个不错的选择。

**转换在 token 上很便宜。**转换一个会话的成本大致相当于该会话本身占用的量，再加一两个同等大小的问题。它不是对你整段历史的第二遍扫描；它只读取新增的部分，一次。

**想更高就更高，但别更低。**观察者的输出被永久烤进文件，因此每一个未来的答案都受限于它第一次捕获到了什么。一个只捕获了 65% 而非 96% 重要内容的模型，日后给你的不是稍差一点的召回：而是一个不再包含答案的存储。上面的五模型对比正是这一点的测量版本：相同存储、相同问题，14 分的差距纯粹来自谁在阅读。

回答模型是便宜的决定，可以按问题更换。观察者才是值得花钱的那个，因为你只有一次机会运行它。

---

## 使用它

MCP 上的六个工具：`save_memory`、`recall_memory`、`list_memories`、`read_memory`、`declare_project` 和 `brief_parent`。你从不直接调用它们；你自然地开口就行：

- *「把这段对话存进记忆」*
- *「关于部署流水线我们当时定了什么？」*

装好 Claude Code 钩子后，每个会话都在你工作的同时自己保存，无需你记着什么。

**高效读取一个存储，是与连接一个存储分开的一步**，而这一步正是大家会跳过的。加载整个 `.dai` 文件而不是三段缩放，会多花一个数量级的 token 却毫无准确率上的收益。`setup.js` 会把协议装进你的 `~/.claude/CLAUDE.md`；同样的规则也在 [`prompts/READER-PROMPT.txt`](prompts/READER-PROMPT.txt) 里，可粘贴进任何助手。

```bash
node daidocs.js ingest ./my-chats ./my-store    # 转换一个文件夹
npm run check                                    # 验证一次安装，无需 API key
```

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DAIDOCS_STORE` | `~/DaiDocs` | 存储所在位置 |
| `DAIDOCS_OBSERVER` | 你安装时选的模型 | 为单次运行覆盖该选择 |
| `DAIDOCS_DISABLE` | 未设置 | 跳过自动归档钩子 |
| `DAIDOCS_NO_PING` | 未设置 | 无需询问即拒绝那次一次性、需选择加入的安装 ping |

---

## 复现我们的数字

你通过运行来复现数字，而不是下载我们的答案文件。三样东西，全部公开：**数据集**（LongMemEval-S）、**引擎**（`lib/methods/daidocs-v44n`，在本仓库里）以及**评分器**（基准作者自己的 `evaluate_qa.py`）。协议见 [`docs/REPLICATION.md`](docs/REPLICATION.md)。

逐题结果在 [`benchmark/`](benchmark/) 里，因此你可以找出哪些问题不同，而不是比较两个总数。**如果你无法复现某个数字，那是你能提的最有价值的 issue**，我们会公开这么说，而不是悄悄改掉页面。

---

## 仓库地图

| 路径 | 是什么 |
|---|---|
| [`QUICKSTART.md`](QUICKSTART.md) | 五分钟，什么都不预设 |
| [`spec/DAIDOCS-STANDARD.md`](spec/DAIDOCS-STANDARD.md) | `.dai` 格式规范 |
| [`docs/RESULTS.md`](docs/RESULTS.md) | 条件、披露，以及每个数字一经测量后的记录 |
| [`docs/REPLICATION.md`](docs/REPLICATION.md) | 如何复现它们 |
| [`docs/READ-DAIDOCS.md`](docs/READ-DAIDOCS.md) | 阅读协议，按不同界面分列 |
| [`docs/INTEGRATION.md`](docs/INTEGRATION.md) | 配合 Claude Code 使用：钩子、转换历史、无密钥保存 |
| [`prompts/`](prompts/) | 作为随处可粘贴提示的协议 |
| [`daidocs.js`](daidocs.js) | CLI：convert、pending、stores、backup、scrub、ingest、ask |
| [`setup.js`](setup.js) | 一条命令的安装与配置 |
| [`lib/methods/daidocs-v44n/`](lib/methods/daidocs-v44n/) | 引擎，即本仓库随附的那套配置 |
| [`mcp_server.mjs`](mcp_server.mjs) | MCP 服务器 |
| [`session_archiver.mjs`](session_archiver.mjs) | Claude Code 的 SessionEnd 钩子 |
| [`session_context.mjs`](session_context.mjs) | SessionStart 钩子：记忆在会话开始时加载 |
| [`session_autosave.mjs`](session_autosave.mjs) | Stop 钩子：会话自己保存，无需 API key |
| [`verify_surfaces.mjs`](verify_surfaces.mjs) | `npm run verify`：每一个界面，免费且离线 |
| [`keyless_check.mjs`](keyless_check.mjs) | 证明运行起来不需要任何 API key |
| [`lock.js`](lock.js) | `npm run lock`：把这个文件夹设为只读 |
| [`assets/`](assets/) | 品牌标记、图表、示意图和演示 |
| [`benchmark/run_longmemeval.mjs`](benchmark/run_longmemeval.mjs) | 基准适配器，让这次运行可核查 |
| [`benchmark/`](benchmark/) | 逐题结果 |
| [`RESULTS-SUMMARY.md`](RESULTS-SUMMARY.md) | 发布运行，gpt-4o，一页纸 |
| [`RESULTS-ACTORS.md`](RESULTS-ACTORS.md) | 五个回答模型跑在完全相同的记忆层上 |
| [`run-artifacts/`](run-artifacts/) | 答案、评审判定、诊断和运行清单，按回答模型分列 |
| [`experiments/recall-sweep/`](experiments/recall-sweep/) | recall@k，k = 1 到 15，仅检索，零 API 调用 |
| [`MANIFEST.sha256`](MANIFEST.sha256) | 每个文件冻结时的 sha256；[`docs/PROVENANCE.md`](docs/PROVENANCE.md) 说明如何核验 |
| [`docs/GAPS.md`](docs/GAPS.md) | 诚实列出尚未完成的事 |
| [`tools/verify_router.mjs`](tools/verify_router.mjs) | 从源码打印路由器并测量它 |
| [`tools/check_numbers.mjs`](tools/check_numbers.mjs) | 若任何已公布数字与证据产物发生漂移就让 CI 失败 |
| [`tools/make_charts.py`](tools/make_charts.py) | 从数字重新生成图表 |
| [`tools/chart_theme.py`](tools/chart_theme.py) | daidocs.com 的图表外观，移植到 matplotlib |
| [`tools/make_diagrams.py`](tools/make_diagrams.py) | 重新生成讲解示意图 |
| [`tools/dashboard/`](tools/dashboard/) | `npm run dashboard`：构建记忆地图。构建出的页面从不随仓库发布 |
| [`docs/GUIDE.md`](docs/GUIDE.md) | 每一条命令、工具、脚本和文件夹类型，汇于一页 |
| [`tools/make_badges.py`](tools/make_badges.py) | 顶部的徽章，作为本地文件而非在线抓取 |
| [`CHANGELOG.md`](CHANGELOG.md) | 每次发布改了什么 |
| [`SECURITY.md`](SECURITY.md) | 如何上报问题，以及哪些在范围内 |
| [`RUNBOOK.md`](RUNBOOK.md) | 发布运行，一步一步 |

---

## 参与贡献

格式才是重点，所以最有用的贡献，是那些把它带到更多地方去的贡献。

**集成。**一个只有一个助手能读的存储不是格式，而是多绕了几步的数据库。MCP 服务器覆盖了 Claude Desktop、Claude Code、Cursor 和 Windsurf。其余一切都开放：给另一个编辑器的扩展、给另一个智能体框架的插件、给另一个运行时的加载器、给某个说着 MCP 之外协议的助手的适配器。如果你正在接一个，而格式里有什么和你较劲，那是格式的 bug，值得开一个 issue。有两个我们点名想要：一个 **OpenRouter** 提供方后端，一个 key、数百个模型，把「自带模型」变成一行配置，并以同样小的契约嵌入 `lib/providers/`，与 `anthropic`、`openai` 和 `gemini` 并列；以及一个 **Hermes 智能体**集成，让运行那套技术栈的人能把它指向一个存储、让记忆生效。

**第二个实现。**一个不是这份代码的读取器或写入器。它被特意做得小到一个下午就能写完：UTF-8、一个 YAML 头部、一个 JSON 区块和文本。两个独立实现，正是文件布局与文件格式之间的区别。

**对记忆本身的改进。**更好的提取、更好的检索、更好地处理目前还行不通的那些形态。智能体轨迹是最明显的一个：工具调用和堆栈跟踪今天转换得很差，谁把它解决了，就是替所有人解决了。任何让召回更准、或让存储读起来更便宜的改进，都欢迎。

**bug 与粗糙之处。**尤其在 macOS 和 Linux 上，它们经过审计，但在这里远不如 Windows 常用。如果某处是令人困惑而非真的坏了，那也值得上报：一个没人找得到的功能，就是一个不存在的功能。

小改动欢迎，无需先问。任何改动格式本身的，请在写代码之前先开一个 issue，因为那是别人的工作赖以保持不变的部分。

参与贡献即表示你同意你的成果以 Apache-2.0 授权，并声明你有权提交它（[DCO](https://developercertificate.org/)）。

---

## 统计安装量：需选择加入，且默认关闭

DaiDocs 以本地优先，工具本身不会主动发送任何东西。只有一个例外，一次性的安装 ping，而它的设计是为了守住这个承诺，而不是绕过它：

- 它**只询问一次**，在第一次交互式 `setup` 时，之后再不询问。
- 默认是**否**：直接回车即为拒绝，且在非交互式运行时从不提示。
- 若选择是，则发送**一次**匿名请求：一个随机 id、版本号和一个时间戳。不含任何能识别你、你的文件或你的记忆的信息。
- `DAIDOCS_NO_PING=1` 无需询问即彻底拒绝它。
- 你的选择记录在 `~/.daidocs/install.json`；删除该文件即可再次被询问。

它的存在只是为了让项目能统计有多少人安装了它。如果你宁愿它根本不存在，那一个变量就能把它永久关闭。

---

## 授权

规范、引擎和 MCP 服务器均为 **Apache-2.0**，含专利授予。商业使用、修改和再分发都没问题。不存在一个落后的免费版：这里发布的就是实际运行的。

由 [Kerneta](https://daidocs.com) 打造。

---

<p align="center"><sub>本文件是英文 <a href="README.md">README</a> 的中文版。若两者有出入，以英文版为准。</sub></p>
