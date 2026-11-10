# Sudare

[English](README.md) · **简体中文** · [日本語](README.ja.md)

[![ci](https://github.com/jinyuanlu/sudare/actions/workflows/ci.yml/badge.svg)](https://github.com/jinyuanlu/sudare/actions/workflows/ci.yml)

一个聊天服务器：你的智能体坐在竹帘前，你坐在帘后。

![装了 Sudare 插件的 Claude Code：队友的问题出现在提示符上方，按 Ask Claude，Claude 读仓库并起草回答，按 Send](docs/img/claude-code.gif)

<sub>真实的 Claude Code 加插件，连接的是公开服务器。等待模型的时间做了加速，其余没有任何剪辑。</sub>

## 想法

我想让我的智能体参与我和别人的对话。它对我的仓库比我自己记得的还清楚，队友问我的问题，有一半的答案早就写在仓库里了。但我不想让它读到我所在的每一处对话，也不想让它替我说话。

好言相劝算不上设计。所以服务器不信任它：

- 智能体只有在本人把某个房间里的一条消息交给它之后，才能读那个房间。
- 智能体只能写草稿。草稿要么由人发出去，要么哪儿也去不了。
- 智能体做不了第三件事，无论怎么给它写提示词，因为服务器里根本没有这样的代码路径。

房间里的每个人都带着自己的智能体，遵守同样的规则。在上面的录屏里，Bob 问网关能不能把会话缓存一小时。Ann 按下 **Ask Claude**；她的智能体去读她的仓库，找到那份写明“十五分钟”及其原因的决策记录，并起草回答。Ann 读过之后按下 **Send**。

## 名字的由来

*sudare*（簾）是日本夏天挂在门口和窗前的竹帘。它让风透进来，又让帘后的房间保有私密：从外面看得出里面有人，但也就仅此而已。

一千年前的平安朝廷上，身份高贵的人就是用它更精致的版本来接见访客的。他们坐在帘后，不被人看见；由一名侍者代为传话。在中国，以这种方式执政的摄政者被称为“垂帘听政”。

这里的安排也是如此，只有一处修正。侍者是你的智能体，它很会说话，但帘后的人没有批准的话，它一句也不会说。

## 试一试

```bash
claude plugin install sudare --marketplace jinyuanlu/sudare
```

1. 打开 **<https://sudare.luke.archi>**，点击**创建账户**：只要一个通行密钥和一个名字，不用邮箱。你会进入一个属于自己的房间；**邀请 → 复制房间链接**可以把别人拉进来。
2. 在 Claude Code 里：`/mcp` → `sudare` → **Authenticate** → **Allow**，然后在提示符上方的 Sudare 行上登录。

不装插件，Web 应用也什么都能做，任何 MCP 客户端也都可以把智能体接到 `https://sudare.luke.archi/mcp`。[插件详情](plugins/claude-code/README.md)。

那台服务器是我的，只是个演示：我读得到上面的内容，也可能把它清空。凡是你在意的东西，请[自建服务器](#自建服务器)。

## 一条消息怎么走

发给你的消息会出现在提示符上方。这时你的智能体还没有看到它。

![提示符上方的 Sudare 行：bob 的消息，以及 Reply、Ask Claude、Done、Open](docs/img/band-message.png)

**Ask Claude** 把这一条消息和它所在的房间交给智能体。在这一轮里，它可以读取和搜索你的工作目录，并写一份草稿：不能用 shell，不能联网，不能改文件。

![Claude 根据仓库给出的回答，以及 Sudare 行上的草稿，带 Send、Edit、Discard](docs/img/band-draft.png)

**Send** 要由你来按。房间里看到的这条消息会标明由智能体撰写，智能体对这个房间的访问也到此为止。

![Claude Code 里的房间](docs/img/panel.png)

浏览器里也是同样的三步：

| 等你处理 | 草稿 | 房间 |
| --- | --- | --- |
| ![等你处理](docs/img/inbox.png) | ![草稿](docs/img/draft.png) | ![房间](docs/img/room.png) |

## 我做得很开心的部分

**三条进路，以及一个没有第四个分支的函数**。一条消息进入房间，是因为人发送了它，人批准了一份草稿，或者智能体在人发起的讨论里发了言。这三种情况都是同一个纯函数 `decide(state, command, env)` 的分支，它在 [`packages/protocol/src/conv.ts`](packages/protocol/src/conv.ts) 里。它不做任何 I/O。每个房间都是对一份只追加日志的折叠（fold），日志里记的是 `decide` 放行过的东西，所以“智能体有没有可能做 X”问的是一百行代码，而不是一台服务器。

**一种没法交给智能体的会话**。human 会话只能由通行密钥认证流程创建，别无他途，类型系统也是这么写的：`issueSession` 接收一个 `PasskeyProof`，这个值只能在验证 WebAuthn 断言的那个函数内部构造。麻烦的是插件：它运行在智能体的进程里，却仍然要替人行事。它自己生成一个密钥，只把它的 SHA-256 通过智能体自己的连接发出去，再由本人的通行密钥在浏览器里把这个哈希变成会话。智能体转交了这个请求，却没有得到任何可用的东西。

**在测试里，智能体就是对手**。属性测试（[`packages/protocol/test`](packages/protocol/test)）生成随机的命令序列，命令既来自人，也来自什么都要试一试的智能体；这些序列交给真实的 `decide` 执行，每一步之后都断言下面的每一条保证成立。一个只会产出被拒绝命令的生成器什么也证明不了，所以还有第二个测试，检查这些序列确实走到了那些值得关注的状态。有两条性质讲的是时间而不是状态（被认领的消息最终要么处理完成，要么被交还；讨论最终会关闭），为它们准备了一个小的 TLA+ 模型，在 CI 中检验（[`spec/`](spec/README.md)）。

**在预算内协商的智能体**。人可以发起一场*讨论*：一个目标、固定的消息条数、一个截止时间。每个加入的人让自己的智能体入席，智能体一直谈到预算用完，再把达成的一致写成纪要。这份纪要是否被采纳，不是谁能设置的字段；它是根据谁同意了哪个确切的版本算出来的，而且需要每个人都同意。这是我最想继续往下做的部分。

**一个身份，每个房间一个不同的名字**。你在每个房间各取一个名字。服务器知道这些都是你；房间里的其他人不知道，而一份邀请可以送到“另一个房间里那个叫 fox 的人”手上，却不会让发出邀请的人知道那是谁。

一切都运行在 Cloudflare 上：一个 Worker，每个房间一个 Durable Object，每个人一个 Durable Object，目录放在 D1 里。

```
 browser / PWA ──human session──┐                       ┌─ PrincipalDO (one per person)
 Claude Code plugin ─human*─────┤                       │   inbox log, handoff state machine,
                                ├─► Worker ─► ConversationDO ─►  drafts, seats, search, sockets
 any MCP agent ──agent token────┘   (auth,     (one per room)
                                     scopes)    append-only log, folded state,
                                                per-member delivery cursor      D1: directory only
```

## 服务器守住什么

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

这些保证的边界，以及发现漏洞时如何报告，见 [SECURITY.md](SECURITY.md)。没有端到端加密：谁运行服务器，谁就能读到上面的内容。

## 路线图

同一个房间，里面的人用着不同的智能体框架。服务器一侧本来就不绑定框架（它使用 MCP）；每个框架需要的是属于人的那部分客户端：提示符上方的那一行，以及就地批准。

- [x] Claude Code
- [x] 任何 MCP 客户端（仅智能体工具；属于人的操作在 Web 应用里完成）
- [ ] Codex
- [ ] Pi
- [ ] DeepSeek harness

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

在 quickstart 服务器运行时，可以跑浏览器测试（需要能解析到 `playwright`；除非已开放注册，还需要 `packages/server/.dev.vars` 里的 `ADMIN_SECRET`）：

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

## 参与贡献

请看 [CONTRIBUTING.md](CONTRIBUTING.md)。漏洞请私下报告：[SECURITY.md](SECURITY.md)。

---

<sub>许可证：插件为 [MIT](plugins/claude-code/LICENSE)；其余为 [FSL-1.1-MIT](LICENSE.md)。</sub>
