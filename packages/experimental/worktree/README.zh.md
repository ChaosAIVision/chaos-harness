---
description: "按照调用 Session 的文件策略创建并进入保留的 Git 工作树。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-worktree

[English](README.md) | 中文

## 概述

从本地提交创建隔离的检出目录，并在其中继续同一个 Session。每次操作创建新的具名分支，源检出目录保持不变。所有写入均受现有沙箱约束。离开检出目录会保留文件与分支。另一项操作在私有检出目录中运行委派任务，并在任务未留下任何内容时移除该检出目录。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将服务与 `workingDirectory`、`fs`、`subprocess`、`sandbox` 和 `sandboxPolicy` 提供方一起挂载。模型需要此操作时，再添加工具包。

```yaml
- name: '@deepseek-ai/dsh-experimental-worktree'
- name: '@deepseek-ai/dsh-experimental-tool-worktree'
```

`ctx.worktrees.create(agent, { name?, from? }, signal?)` 创建新分支与检出目录，再通过 `ctx.workingDirectory.set` 进入规范化的检出目录。`from` 在创建前解析为本地提交，默认是 `HEAD`；暂存、未暂存、未跟踪以及被忽略的源文件均不复制。`baseCommit` 报告解析出的提交对象名称；仓库本地的替换引用仍作用于检出的内容。检出操作禁用已配置的 Git clean、smudge 和 process 过滤器，不修改仓库配置。分支或检出路径已存在时会报错。返回记录包含 `path`、`branch`、`baseCommit` 和 `repositoryRoot`。

`ctx.worktrees.isolate(agent, { cwd? }, start, onKept, signal?)` 在私有检出目录中运行委派任务，且从不移动调用方的工作目录。它先回收已失效的租约，在新分支 `dsh/lease/<nonce>` 上创建 `<pool>/dsh/lease/<nonce>`，以检出目录加上调用方在其仓库内的偏移量调用 `start(cwd)`，并在所返回 activation 的 `result` 完成或被拒绝时结算。结算使用不带 `--force` 的 `git worktree remove` 移除检出目录，仅当分支仍指向基准提交时才删除该分支。存在已跟踪修改、未跟踪文件、`node_modules` 之外的被忽略文件、提交、在其分支上创建的 `git stash` 条目、分离或切换的 HEAD，或在移除期间出现文件的检出目录会被保留，`onKept` 会收到其 `path`、`branch`、`baseCommit`、`headCommit`、`uncommitted` 和 `reason`。被忽略的文件会计入，因为 `git worktree remove` 会删除它们（如 `.env`、构建产物）；名为 `node_modules` 的依赖目录不计入，因此只含这些内容的检出目录仍会被移除。在 Git 工作树之外或没有提交的仓库中，`start` 在调用方目录运行，`isolation.kind` 为 `degraded` 并给出原因。结果包含 `activation`、`isolation` 和 `settled`；`settled` 在结算后完成，且从不拒绝。

租约基准由 `baseRef` 决定。默认值 `remote-default` 解析本地 `refs/remotes/origin/HEAD` 的目标且不获取远端，无法解析时回退到 `HEAD`，并在 `isolation.baseLabel` 中注明回退；`head` 始终使用 `HEAD`。`ctx.worktrees.list(agent)` 返回每个租约的 `path`、`branch` 和 `status`，其值为 `live`、`dead`、`foreign`、`kept`、`unowned` 或 `missing`。`ctx.worktrees.reap(agent)` 结算调用方仓库中每个 `dead` 租约并返回结算结果。`isolate` 会先执行同样的清扫，并报告同一 Session 此前崩溃的运行所保留的租约。名称 `dsh`、`dsh/lease` 以及 `dsh/lease/` 下的所有名称归租约所有；名为 `dsh` 或 `dsh/lease` 的分支会阻塞所有租约引用，因此 `create` 会拒绝这些名称，`namePrefix` 也不得使用。

默认检出目录是 `<current checkout root>/.agents/worktrees/<name>`。返回的 `repositoryRoot` 是调用方当前检出目录的顶层目录；如果它是链接检出目录，工作树父目录就嵌套在其中。省略名称时，使用 `worktree-` 加 UUID。仅当服务的分配操作创建了父目录时，服务才会写入内容为 `*` 加换行符的 `.gitignore`；已有文件与忽略规则保持不变。相对路径 `directory`、生成名称使用的 `namePrefix`、可执行程序与进程限制可在[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-worktree)中查阅。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

Git 与目录分配通过挂载的子进程及沙箱提供方执行，沿用调用 Session 的文件策略。创建操作不会扩大目标目录或共享 Git 管理目录的写权限。目录创建独占申请目标路径；取消或初始化失败可能留下已有产物，错误会包含其路径。服务销毁会中止待完成操作，并等待它们结束。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务外观：配置、保留式 `create`，以及 `isolate`、`reap` 和 `list` 入口 |
| [`src/leases.ts`](src/leases.ts) | 租约生命周期：创建、结算、保留、清扫与元数据访问 |
| [`src/checkout.ts`](src/checkout.ts) | 创建 `create` 与租约共用的分支和检出目录，并禁用已配置的过滤器 |
| [`src/git-context.ts`](src/git-context.ts) | 将 Git 与 Node 命令绑定到策略并定位仓库 |
| [`src/lease.ts`](src/lease.ts) | 纯函数：所有权分类、结算决策、孤立分支决策与工作树列表解析 |
| [`src/owner.ts`](src/owner.ts) | 主机名、进程启动时间与所有者存活判断 |
| [`src/process.ts`](src/process.ts) | 约束字面参数、限制输出并等待进程终止 |
| [`src/directory.ts`](src/directory.ts) | 申请目标目录、初始化新建工作树父目录的忽略文件，并以原子方式替换租约元数据文件 |

租约是位于 `dsh/lease/` 分支上的链接工作树，加上该工作树自身 Git 管理目录中的一个文件 `dsh-lease.json`。Git 会随工作树一并删除该文件，因此元数据不会比其描述的对象存活更久。文件记录 `provisioning`、`held`、`settling` 或 `kept` 状态，以及所属 Session、主机、pid、进程启动时间和基准提交。服务根据仓库自身的 `worktrees/<id>/gitdir` 记录找到租约的管理目录，并用 `--git-dir` 针对该目录运行 Git，从不信任检出目录内的 `.git` 指针文件，因为委派任务可以改写它。元数据文件按严格规则解析：基准提交必须是完整的对象标识，分支必须位于 `dsh/lease/` 之下，否则该租约视为 `unowned`。只要受限的 `workspace-write` 策略允许 `git worktree add`，就允许此写入，因此租约不增加写权限。存活判断依据主机、pid 与进程启动时间：其他主机上的租约绝不回收，pid 存在且启动时间与记录一致的租约绝不回收，无法读取启动时间则视为存活。没有心跳，也没有过期时间。元数据缺失或无法解析的租约为 `unowned`，不会被触碰。

清扫会重放被中断的转换。所有者已死的 `provisioning` 租约先完成检出再结算。所有者已死的 `held` 或 `settling` 租约与其他租约一样结算。工作树已消失的租约分支，仅当其最早的 reflog 条目为 `branch: Created from` 且与分支末端相同时才会删除。同一服务内的创建与清扫逐个执行；该锁仅在进程内有效，不协调两个进程，两个进程之所以仍然安全，只因每一步都是幂等的，且 Git 拒绝而不强制执行。结算与清扫使用与创建相同的禁用过滤器的 Git 环境，因此仓库过滤器与钩子从不运行。

本包不发布运行时不变量伴随入口：Git 拥有工作树注册信息，工作目录服务拥有 Session 目录；除每个工作树的元数据文件外，本包不保留二者的独立投影。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [工作树子系统](../../../docs/subsystems/worktrees.zh.md)——请求、结果与服务参考。
- [工作目录](../../session/working-directory/README.zh.md) — 记录的 Session 目录与目录切换。
- [工作树工具](../tool-worktree/README.zh.md) — 面向模型的创建操作。
- [子进程](../../subprocess/subprocess/README.zh.md) — 进程所有权与执行环境。
- [创建决策](../../../.agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.zh.md) — 保留检出目录与既有写权限。

-----

<a id="model-experience"></a>
## 模型体验

通过工作树工具的创建结果与工作目录服务记录的 Session 上下文间接影响模型。调用 `isolate` 的消费方负责子任务的目录说明，以及它根据 `onKept` 构造的保留检出目录消息。

#### KV Cache 影响

本包不贡献提示文本。其消费方负责追加工具结果与记录的目录上下文。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **保留产物**——离开工作树会保留其分支和文件。初始化失败也可能留下部分产物；移除、清理注册信息与删除分支由用户或其他消费方负责。
- **保留的租约会累积**——存在修改的检出目录绝不会被自动移除。`list` 与 `git worktree list` 会显示它们，由人工合并或删除。
- **租约崩溃窗口**——进程在 `git worktree add` 与首次写入元数据之间被终止，会留下无人认领（`unowned`）的租约，任何清扫都不会触碰。目录被手动删除的租约为 `missing`，可用 `git worktree prune` 清除。服务在委派任务仍在运行时被释放，不会结算该租约；进程退出后，下一次清扫会结算它。
- **仅限同一主机**——记录在其他主机名下的租约会被跳过，共享文件系统上也一样。存活判断假定每个主机名对应一个 PID 命名空间，因此与宿主机同名但 PID 命名空间不同的容器可能被误判为已死。macOS 的主机名可能随网络变化，其留下的租约随后会显示为 foreign，且永远不会被回收。
- **跨进程创建窗口**——在 `git worktree add -b` 与首次写入元数据之间，另一进程的清扫会看到没有元数据的租约分支。它不会触碰该租约，但进程内的锁无法跨进程关闭这一窗口。
- **威胁边界**——能写入自身检出目录的委派任务可以修改其工作文件和 `.git` 指针，服务不信任后者。它也可以写入沙箱允许其写入的其他位置，包括共享的 stash 引用；在租约分支上创建的 stash 条目会使该检出目录被保留。
- **远程默认分支可能过时**——`remote-default` 读取本地远程跟踪引用，从不获取远端。
- **仅限本地提交**——创建操作不会获取远端提交或部分克隆中缺失的对象、初始化子模块、安装依赖或复制未提交文件。Git 满足执行要求时，本地对象缺失会导致创建失败。
- **过滤器处理前的内容**——检出时跳过已配置的过滤器，以避免执行仓库配置的程序或隐式下载。Git LFS 指针与加密 blob 保持存储时的形式；拉取实体内容或解密由用户另行执行。
- **执行要求**——子进程提供方必须在与文件系统提供方相同的执行环境中提供 Git 与 Node。Git 必须识别 `GIT_NO_LAZY_FETCH`：Git 2.45 及 2.39.4、2.40.2、2.41.1、2.42.2、2.43.4、2.44.1 维护版本均支持；更早的版本会忽略该变量并继续执行而不报错，因此创建操作可能从 promisor 远程获取缺失的部分克隆对象。`git --no-lazy-fetch` 选项会拒绝这些版本，但它仅在 Git 2.45 及以后存在，也会拒绝上述已修补的维护版本。现有沙箱必须允许写入检出目录与共享 Git 元数据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

沙箱内的 Node 子进程提供[文件系统服务](../../fs/fs/src/index.ts)未公开的独占目录创建能力，并确定父目录是否由本服务创建。文件系统契约允许 [fs-local](../../fs/fs-local/src/index.ts) 等普通提供方在写入时忽略 `sandboxPolicy`；`createIfAbsent` 保护文件，但既不执行权限约束，也不确定目录由谁创建。将目录分配和忽略文件创建放在与 Git 相同的进程沙箱内，可保留对已有检出路径的拒绝行为，并落实创建 `.gitignore` 的条件。

</details>
