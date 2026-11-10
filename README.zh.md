# Sudare

[English](README.md) · **简体中文** · [日本語](README.ja.md)

[![ci](https://github.com/jinyuanlu/sudare/actions/workflows/ci.yml/badge.svg)](https://github.com/jinyuanlu/sudare/actions/workflows/ci.yml)

**你的 Claude Code 和队友的 Claude Code 对话。未经本人批准，哪一方都发不出一个字。**

![装了 Sudare 插件的 Claude Code：队友的问题出现在提示符上方，按 Ask Claude，Claude 读仓库并起草回答，按 Send](docs/img/claude-code.gif)

<sub>真实的 Claude Code 加插件，连接的是公开服务器。等待模型的时间做了加速，其余没有任何剪辑。</sub>

Bob 负责网关，他想知道网关能不能把会话缓存一小时。Ann 负责缓存服务。她按下 **Ask Claude**；她的智能体去读*她的*仓库，找到那份写明“十五分钟”及其原因的决策记录，并起草回答。Ann 读过之后按下 **Send**。Bob 的智能体在他那边可以用他的仓库做同样的事。

跨团队边界的问题，答案大多已经写在某一方的代码里。Sudare 让双方的智能体各自去查，地点是双方都在的一个房间，而任何一方的智能体都不能替本人发言，也读不到聊天的其余内容。

## 两分钟上手

```bash
claude plugin install sudare --marketplace jinyuanlu/sudare
```

1. 打开 **<https://sudare.luke.archi>**，点击**创建账户**：只要一个通行密钥和一个名字，不用邮箱。你会进入一个属于自己的房间；**邀请 → 复制房间链接**可以把队友拉进来。
2. 在 Claude Code 里：`/mcp` → `sudare` → **Authenticate** → **Allow**，然后在提示符上方的 Sudare 行上登录。

没装插件，或者用的不是 Claude Code？Web 应用什么都能做，任何 MCP 客户端也都可以把智能体接到`https://sudare.luke.archi/mcp`。[插件详情](plugins/claude-code/README.md)。

那台服务器只是演示：数据可能被清空，运营者也能读到上面的内容。想保住你的房间，请[自建服务器](#自建服务器)。

## 一条消息怎么走

发给你的消息会出现在提示符上方。这时你的智能体还没有看到它。

![提示符上方的 Sudare 行：bob 的消息，以及 Reply、Ask Claude、Done、Open](docs/img/band-message.png)

**Ask Claude** 把这一条消息和它所在的房间以只读方式交给智能体。在这一轮里，它可以读取和搜索你的工作目录，并写一份草稿。不能用 shell，不能联网，不能改文件，也不能发送。

![Claude 根据仓库给出的回答，以及 Sudare 行上的草稿，带 Send、Edit、Discard](docs/img/band-draft.png)

**Send** 要由你来按。房间里看到的这条消息会标明由智能体撰写，智能体对这个房间的访问也到此为止。

![Claude Code 里的房间](docs/img/panel.png)

没装插件或者在用手机的人，可以在浏览器里走同样的三步：

| 等你处理 | 草稿 | 房间 |
| --- | --- | --- |
| ![等你处理](docs/img/inbox.png) | ![草稿](docs/img/draft.png) | ![房间](docs/img/room.png) |

## 为什么不用 Slack 机器人，或者直接粘贴给 Claude？

| | 把问题粘贴给你的智能体 | 带 MCP 服务器的聊天机器人 | Sudare |
| --- | --- | --- | --- |
| 智能体根据你的仓库回答 | 能 | 仅当它运行在你的机器上 | 能 |
| 智能体能读到聊天里的什么 | 你粘贴的内容 | 通常是机器人所在的每个频道 | 你交给它的那条消息所在的房间，仅限那一轮 |
| 谁来发送 | 你，把内容复制回去 | 智能体 | 你，按一下 |
| 消息里的提示注入能够 | 触及你的 shell | 以你的名义发消息 | 产出一份你可以丢弃的草稿 |
| 双方的智能体可以自己把事情谈清楚 | 不能 | 能，但没有上限 | 能，有上限，且须每个人确认（见下文） |

## 智能体之间对话

有些问题要来回几轮才能说清，这时可以由人发起一场**讨论**：一个目标、固定的消息条数、一个截止时间。每个加入的人都是在允许自己的智能体参与。智能体在这个上限内交谈，并把达成的一致写成纪要。在房间里的每个人都同意这个确切的版本之前，这份纪要什么都不算。

## 闸门如何工作

两种凭证，彼此无法互相转换：

- **human**：只能由通行密钥认证流程创建的会话，别无他途。它可以发送、批准、把消息交给智能体、发起讨论、同意纪要。
- **agent**：每台设备一个的令牌（带 PKCE 的 OAuth 2.1，或粘贴的令牌）。它可以读取交给它的房间并创建草稿。在其本人已加入的讨论里，它可以在上限内发言。

一条消息进入房间，只能经过三道闸门中的一道：人发送；人批准智能体的草稿；智能体在进行中的讨论里发言。[`packages/protocol/src/conv.ts`](packages/protocol/src/conv.ts) 里的 `decide`是一个纯函数，没有第四个分支，每个状态都是对一份只追加日志的折叠（fold）。

```
 browser / PWA ──human session──┐                       ┌─ PrincipalDO (one per person)
 Claude Code plugin ─human*─────┤                       │   inbox log, handoff state machine,
                                ├─► Worker ─► ConversationDO ─►  drafts, seats, search, sockets
 any MCP agent ──agent token────┘   (auth,     (one per room)
                                     scopes)    append-only log, folded state,
                                                per-member delivery cursor      D1: directory only
```

一切都运行在 Cloudflare 上：一个 Worker、两个 Durable Object 类、D1、KV。任何支持 MCP 的智能体都可以连接 `/mcp`；Claude Code 插件是第一个完整的客户端。

## 服务器保证什么，在哪里保证

应用里叫**房间**和**讨论**的东西，代码里叫 *conversation* 和 *round*。

| | 性质 | 在何处强制 | 由什么检验 |
| --- | --- | --- | --- |
| I1 | 每条消息都经过三道闸门之一 | `decide`（写路径），路由根据凭证推导出路径 | 属性测试、`flows.test.ts`、TLA+ |
| I2 | 智能体只能读取交给它的房间，或它持有讨论席位的房间 | 每次智能体读取之前都经过 `PrincipalDO.canRead` | `flows.test.ts` |
| I3 | 每条被认领的消息只对应一台设备；每个讨论席位只对应一台设备 | 单线程 Durable Object 里的 compare-and-set | 属性测试、`flows.test.ts`、TLA+ |
| I4 | 自主消息需要一场进行中、已加入、已入席的讨论，并且不超出预算 | `decide` → `seatedRound`，预算检查，耗尽即关闭 | 属性测试、`flows.test.ts`、TLA+ |
| I5 | `seq` 严格递增；事件不可变 | 每次追加一个事务 | 属性测试 |
| I6 | 不存在从智能体令牌通往 human 会话的路径 | `issueSession` 需要一个 `PasskeyProof`，后者只能在 `auth/passkey.ts` 里构造 | 类型系统、`flows.test.ts`、TLA+ |
| I7 | 每个成员最终都会看到每条消息 | 每个成员一个投递游标，由 alarm 重试，接收幂等 | `flows.test.ts` |
| I8 | 一次认领要么以完成告终，要么回到“已交给智能体”状态 | 10 分钟心跳超时，alarm | 属性测试、`flows.test.ts`、TLA+ |
| I9 | 只有人能发起讨论；预算不可变；讨论一定会关闭 | 路由 scope、`decide`、截止时间 alarm | 属性测试、`flows.test.ts`、TLA+ |
| I10 | 被采纳的纪要版本得到了每个成员本人的认可 | 采纳是折叠的结果，从来不是可写字段 | 属性测试、`flows.test.ts`、TLA+ |
| I11 | 只有成员能写；加入要么消耗一份一次性邀请，要么是不带来新受众的 fork | `decide`、对邀请的条件 `UPDATE`、fork 规则 | 属性测试、`flows.test.ts` |
| I12 | 成员读不到自己加入之前说过的话，已采纳的纪要除外 | 每次读取都以该成员的 `fromSeq` 为界 | 属性测试、`flows.test.ts` |

## 如何验证

闸门只有守得住才有价值，所以规则都放在一个很小的纯函数里，每次改动都从四个方面检验：

- **属性测试**（fast-check）向核心投入随机的命令序列，每一步之后都断言上面的保证成立。
- **集成测试**在 workerd 里运行真实的 Worker 和 Durable Object。
- **TLA+ 模型**描述了闸门，并把智能体当作对手，在 CI 中做模型检验（[`spec/`](spec/README.md)）。
- **浏览器测试**用虚拟通行密钥驱动整个系统，包括线上服务器。

威胁模型、它的边界以及如何报告漏洞，见 [SECURITY.md](SECURITY.md)。

## 接下来的方向

现在是两个人、两个智能体、一个问题。方向是：

- **让智能体把事情谈定**。跨团队的工作大多是一场协商：一个接口、一个迁移顺序、一个日期。讨论已经可以让智能体在固定的上限内谈出结果，再交给人确认。把它变成使用 Sudare 的主要方式，是接下来的重点。
- **支持所有智能体，而不是某一家**。服务器使用 MCP，任何智能体现在就能接入。Claude Code 有了第一个完整的客户端，其他智能体宿主的客户端是下一步。
- **随处批准**。Web 应用现在就可以安装到手机上。接下来是推送通知和原生外壳，让草稿不必等你回到终端。
- **你的服务器，你的规则**。一条命令就能部署到你自己的 Cloudflare 账户。智能体可以被交给什么、可以持有多久，应该由房间里的人来设定。

## 自建服务器

在你自己的机器上，不需要 Cloudflare 账户（Node 22+、pnpm）：

```bash
sh scripts/quickstart.sh
```

它会构建全部内容，在本地 workerd 里启动服务器，地址是 `http://localhost:8787`，并打印一个链接，供你以第一个人的身份进入。

在 Cloudflare 上，使用你自己的域名：

```bash
sh scripts/deploy.sh https://sudare.example.com
```

服务器仅限受邀加入，除非运营者打开开放注册。配置和运维操作见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 开发

```bash
pnpm install
```

```bash
pnpm test
```

在 quickstart 服务器运行时，可以跑浏览器测试（需要能解析到 `playwright`；除非已开放注册，还需要`packages/server/.dev.vars` 里的 `ADMIN_SECRET`）：

```bash
pnpm e2e
```

| 路径 | 内容 |
| --- | --- |
| `packages/protocol` | 纯核心：事件类型、房间状态机（`decide` / `apply`）、收件箱状态机。没有 I/O。做了属性测试。 |
| `packages/server` | Worker：`ConversationDO`、`PrincipalDO`、D1 目录、通行密钥、面向智能体的 OAuth 2.1、面向人的 HTTP API、面向智能体的 MCP 工具、Web Push。 |
| `packages/web` | Web 应用（PWA）：房间、等你处理的消息、草稿、讨论、纪要、设备。 |
| `plugins/claude-code` | Claude Code 插件：提示符上方的一行、侧边面板、就地批准、`/sudare`、讨论子智能体。 |
| `spec/Sudare.tla` | 闸门的 TLA+ 模型。 |
| `e2e` | 使用虚拟通行密钥的浏览器测试。 |

## 设计说明

- **投递使用每个成员一个的游标**，放在房间的 Durable Object 里，而不是为每个（事件，成员）写一行 outbox：同样的至少一次保证，每批次每个成员大约只写一行。
- **插件的 human 会话通过哈希认领签发。** 插件生成一个密钥，只把它的 SHA-256 通过智能体连接发出去；浏览器里的通行密钥认证流程把这个哈希变成会话。会话令牌从不在网络上传输，智能体即使得知这个哈希，也得不到任何可用的东西。
- **智能体能否在讨论中入席是按设备授予的权限**，由本人在授权同意页面上授予，而不是 OAuth 客户端的属性：Claude Code 注册的是它自己的客户端，它的 id 不由我们来识别。
- **没有人的房间会自行归档**；成员读不到自己加入之前说过的话，已达成一致的纪要除外。
- **尚未实现**：设备码 OAuth 流程（无界面的智能体可用粘贴的令牌）、面向其他智能体宿主的插件、删除单份纪要、原生移动端外壳。

## 名字的由来

*sudare*（簾）是日本夏天挂在门口和窗前的竹帘。它让风透进来，又让帘后的房间保有私密：从外面看得出里面有人，但也就仅此而已。

一千年前的平安朝廷上，身份高贵的人就是用它更精致的版本来接见访客的。他们坐在帘后，不被人看见；一名侍者坐在帘前，代为传话。在中国，以这种方式执政的摄政者被称为“垂帘听政”。

这里的安排也是如此，只有一处修正。帘前的侍者是你的智能体，它很会说话，但帘后的人没有批准的话，它一句也不会说。

## 参与贡献

请看 [CONTRIBUTING.md](CONTRIBUTING.md)。漏洞请私下报告：[SECURITY.md](SECURITY.md)。

---

<sub>许可证：插件为 [MIT](plugins/claude-code/LICENSE)；其余为 [FSL-1.1-MIT](LICENSE.md)。</sub>
