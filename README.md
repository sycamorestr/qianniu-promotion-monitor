# 千牛推广巡检：安装、迁移与维护

这是一个可独立复制的 Codex Skill。它按配置逐店读取阿里妈妈万相台的全站推和关键词推广，生成低 ROI 清单，在用户授权时通知或暂停。主脚本只使用 Node.js 内置模块，没有需要在本目录安装的 npm 运行依赖。

## 项目结构

```text
qianniu-promotion-monitor/
├── SKILL.md                   Codex 入口和操作约束
├── README.md                  安装、迁移、架构说明
├── package.json               Node 要求、命令、分享文件白名单
├── config.example.json        不含真实店铺的配置模板
├── runner.mjs                 串行调度、身份核对、规则、审计、通知
├── adapters/
│   ├── scan-campaigns.js       单页合并扫描两类推广
│   ├── pause-campaign.js       写入前重查、暂停、写入后复核
│   └── whoami.js              手工核对页面身份
├── scripts/
│   ├── install.mjs            安装 Skill 和 OpenCLI 适配器
│   └── check.mjs              本地依赖、配置和源码一致性检查
└── tests/                     不连接浏览器或企业微信的离线测试
```

本机运行时另有 `config.json` 和 `audit/`，均不纳入分享文件。

调用链为：Codex → `runner.mjs` → OpenCLI → 已安装适配器 → Browser Bridge → 对应 profile 的阿里妈妈页面。适配器在页面认证上下文中调用既有接口，扫描结果以 JSON 返回；调度脚本筛选计划、写审计，并按模式发送企业微信通知。

`adapters/` 是源码；OpenCLI 加载的是其用户命令目录下的安装副本。修改源码后必须重新运行安装脚本。旧的独立 `list-campaigns`、查询模板和历史验证文档没有加入当前包；合并扫描承担主读取流程。

## 依赖

| 依赖 | 用途与要求 |
|---|---|
| Node.js ≥20 | 文件、子进程、内置 `fetch`、离线测试。整理时本机为 24.19.0 |
| `@jackwener/opencli` | 提供 CLI、profile 和适配器 registry；按本机 1.8.7 接口整理。浏览器相关命令必须支持临时 session、后台窗口及自动释放页面 |
| Browser Bridge | 按 OpenCLI 自身说明安装并连接，与 OpenCLI 版本兼容 |
| 店铺 profile 与登录态 | 在目标机器重新建立，核对实际页面店铺名；分享包不携带 Cookie、密码或 profile 数据 |
| PowerShell 7（Windows） | 使用 OpenCLI 的 `.ps1` 启动器时需能找到 `pwsh.exe` |
| 企业微信 Webhook | 仅 `dry-run`、`execute` 必需，从当前进程 `WECHAT_WEBHOOK_URL` 读取 |

如需安装已知版本的 OpenCLI，可在目标机器执行 `npm install -g @jackwener/opencli@1.8.7`，再按其文档完成 Browser Bridge 和 profile 设置。本包不会自动下载依赖或自动登录。

OpenCLI 1.8.7 正常启动时会自动建立用户命令的 ESM 配置和 registry 包链接，因此新机器只需安装 OpenCLI 并复制适配器，无需迁移旧机器的 `node_modules`。

脚本通过 `PATH` 查找 OpenCLI；也可以设置 `OPENCLI_BIN` 为其可执行文件的完整路径，Windows 使用 `.ps1`，不再绑定某个 pnpm 安装位置。

## 新机器安装

1. 从 GitHub 克隆仓库，或使用仓库页面的 `Code → Download ZIP` 下载并解压；也可解压分享包。进入包含 `SKILL.md` 的目录，准备上述依赖。
2. 复制 `config.example.json` 为 `config.json`，填写目标机器的 profile 与实际店铺名。可以配置任意正数个店铺。
3. 运行 `node scripts/install.mjs --config ./config.json`，安装代码并首次导入配置。
4. 在安装后的 Skill 目录执行 `node scripts/check.mjs`；通过后用 `node runner.mjs --mode report` 验证实际读取。

默认 Skill 安装目录是 `$CODEX_HOME/skills/qianniu-promotion-monitor`，未设置 `CODEX_HOME` 时使用用户目录下的 `.codex/skills/qianniu-promotion-monitor`。OpenCLI 适配器默认安装到用户目录下的 `.opencli/clis/alimama`。

自定义路径：

```text
node scripts/install.mjs --skill-dir <目标Skill目录> --opencli-dir <OpenCLI的alimama命令目录> --config <本机配置文件>
node scripts/check.mjs --config <本机配置文件> --opencli-dir <OpenCLI的alimama命令目录>
```

`--opencli-dir` 必须是目标 OpenCLI 实际会加载的 `alimama` 命令目录；该参数只决定复制和检查位置，不会修改 OpenCLI 的加载配置。

安装前会备份需要覆盖的不同代码文件，备份文件统一追加 `.bak` 后缀，恢复时复制到原位置并去掉该后缀。目标已有的 `config.json` 和 `audit/` 会保留，导入不同配置时不会静默覆盖。备份位置由安装命令输出。

## 从旧版本迁移

保留旧目录，使用新包中的安装器导入本机配置及审计：

```text
node scripts/install.mjs --config <旧目录>/config.json --audit-from <旧目录>/audit
```

审计文件只补充缺失项；同名而内容不同会报错。跨机器时旧 profile ID 通常不能直接复用，应重新建立并修改配置；只把确实需要保留的审计文件单独迁移给有权限的人。

旧版本在 Skill 中写死实现目录，新版入口与运行文件放在同一个 Skill 目录中。原来固定调用旧绝对路径的外部任务不会被安装器改写，需要将它们指向新安装目录的 `runner.mjs`。

## 配置与运行

`profiles` 每项的 `profile` 是 OpenCLI 配置标识，`browserUser` 是便于识别的浏览器用户名，`expectedAlimamaShop` 是页面实际返回的店铺名。`allowedBrowserUsers` 是允许处理的用户白名单；二者必须匹配，profile 不能重复。阈值和读取限制放在配置中，模板给出默认值；填写完成前先运行 `check`。

| 命令 | 行为 |
|---|---|
| `node runner.mjs` | 默认 `report`：只保存本地结果 |
| `node runner.mjs --mode report` | 不发送通知、不暂停，即使已设置 Webhook |
| `node runner.mjs --mode dry-run` | 按用户要求发送最终提醒和待暂停清单，不暂停 |
| `node runner.mjs --mode execute` | 仅在用户明确授权后使用；运行器负责复核、执行、核验和最终通知 |

通知由运行器按配置顺序分店铺分区，使用 `# / ## / ###` 标题层级形成清晰字号，并用 `info`（绿色）、`warning`（橙色）和 `comment`（灰色）表达状态/指标；只展示直接结论与必要指标：`execute` 使用“推广已暂停 / 推广未暂停”，`dry-run` 使用“建议暂停”。数量为 0 的暂停状态不展示；没有候选时直接说明无符合暂停条件的推广。不要把内部状态、trace、归因不确定性或异常原文转发给运营。页面读取、暂停复核、重试和消息长度处理属于实现层，agent 只调用入口并解读审计。

可以用 `--config <文件>`、`--audit-dir <目录>` 指定本地配置和结果位置；读取重试和命令超时可通过环境变量调整。写入暂停不会自动重试，发生不确定结果时应先查看审计和当前页面状态。

执行结果保存到 `audit/<runId>.json`，包含店铺结果、低 ROI 清单、暂停结论、异常和通知状态；运行中的检查点与暂停状态也保存在 `audit/`。发现未完成的 `execute` 检查点时程序会停止，避免跨进程重复写入；失败后先查看审计和当前计划状态，不要直接重跑整个 `execute`。

## 验证与分享

```text
node --test
node scripts/check.mjs
npm pack --ignore-scripts
```

`node --test` 用模拟 OpenCLI 和页面验证流程与边界，不会读取店铺或发消息。`check` 只检查本地依赖、配置、适配器一致性和环境变量是否存在，不验证 Browser Bridge 在线状态、登录态或页面 API 兼容性。

`npm pack` 依据 `package.json.files` 白名单生成可分享 `.tgz`；包名为 `qianniu-promotion-monitor-1.0.0.tgz`。该白名单不包含 `config.json`、`audit/`、`.env`、备份、浏览器 profile 或构建产物。分享通用包即可，收件人自行配置店铺和通知。

适配器依赖阿里妈妈页面的当前运行时；平台变更后应由 agent 先做授权的只读巡检，再维护适配器。安装检查通过不代表线上登录态或页面兼容性已验证。
