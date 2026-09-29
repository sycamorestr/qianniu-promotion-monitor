# 多店配置、运行与恢复

## 准备环境

本技能目录固定命名为 `qianniu-promotion-monitor-playwright`，与原 `qianniu-promotion-monitor` 并存。安装到 Codex 的 `skills` 目录时复制整个新目录，不覆盖旧技能，也不修改旧 OpenCLI 的命令目录或配置。

准备 Python 3.11 及以上和原生 Edge/Chrome。选择已有可导入 Playwright 的 Python；缺依赖时只为本次选定解释器安装：

```powershell
& $python -m pip install -r "$skill/requirements.txt"
& $python "$skill/scripts/run_batch.py" --help
```

运行采用原生浏览器 + `connect_over_cdp()`，不需要 `playwright install`、Browser Bridge 或长期后台 Python/Node 进程。默认处理完一店后将 taobao/tmall/alimama 会话保存到原 Profile，再正常关闭浏览器并确认退出，之后才打开下一店。下次按需启动并重新核验；保存会话不保证平台 session 永不过期。

私有工作目录内保存店铺清单、推广配置、浏览器配置与输出。先复制 `assets/promotion-config.example.json` 到自己的 `promotion-config.json`。已有开票浏览器工作台时直接使用其私有 `shops.json`，无需复制新的店铺示例，更不要另建已有店铺的 Profile。

通知地址单独保存在已安装技能根目录的 `config.json`：初次配置时复制同目录 `config.example.json`，将 `wechat_webhook_url` 填为用户提供的企微 Webhook。程序按技能所在目录定位文件，无需环境变量或额外启动器；根目录通知配置不改变 `--config` 指定业务阈值与请求限制的用法。实际地址只保留在本机配置中，不打印、不写入报告、日志、审计或命令行参数；分享技能时只保留 `config.example.json` 或地址为空的 `config.json`。

```json
{
  "wechat_webhook_url": ""
}
```

配置完成后可做本地只读检查，不启动或连接浏览器：

```powershell
& $python "$skill/scripts/check.py" `
  --registry "$work/shops.json" --config "$work/promotion-config.json"
```

该检查验证 Python 版本、Playwright 可导入和配置结构，返回 `authentication: not_checked`。

## 接入现有店铺清单

`shops.json` 顶层是对象，`shops` 是店铺数组，可保留工作台或开票所需的其他字段。每店读取这些字段：

| 字段 | 用途 |
| --- | --- |
| `id` | 稳定店铺 id，以小写字母开头，仅字母、数字、下划线和连字符；不使用 `shared`、`piaoju` |
| `store` | 报告显示名；真实店铺名和完整账号都未提供时，同时作为精确店铺身份 |
| `browser_config` | 已有原生浏览器配置文件；相对路径按登记文件所在目录解析 |
| `login_username` | 可选，已确认的完整登录账号；业务查询前与页面运行时完整昵称精确比较 |
| `expected_alimama_shop` | 可选，阿里妈妈返回的真实店铺名；显式填写后始终严格核验，不被账号匹配放宽 |

身份选择按以下顺序处理：

1. 显式填写 `expected_alimama_shop`：平台店铺名必须与其精确一致；若同时提供 `login_username`，完整账号也必须精确一致。
2. 未填写真实店铺名，但已有已确认的 `login_username`：在任何业务查询前精确核验页面运行时的完整昵称，再绑定实际返回的 `shopName/nickName`。这条路径允许直接使用开票工作台清单，`store` 保留友好显示别名，不必猜测对应的阿里妈妈店铺名。
3. 两者都未提供：按 `store` 精确核验平台店铺名，此时不能把随意别名当作真实店铺身份。

账号必须完整匹配，不能截取冒号前缀、做模糊匹配或根据账号推猜店铺名。首次观察身份绑定后，全站推、关键词推广、暂停及恢复均要求同一实际店铺与完整账号。扫描结果为零条也会把身份写入 `scan_identity`，不因无候选而失去恢复约束。

同目录 `.browser-workbench-shops.json` 的新增店铺按原登记顺序合并；主清单与旁侧清单出现重复 id 会明确报错，不覆盖，也不静默跳过。新批次缺省处理合并后的所有店铺；`--shops` 限定处理范围与顺序。恢复只使用原批次冻结的选中店铺，后加店铺不会自动扩入旧批次。

清单内已有 `issuer`、`jst_browser_config` 等开票字段可以保留，推广不连接共享票聚。每店浏览器数据目录必须独立且互不嵌套，CDP 端口必须非零且互不相同。清单内的账号与真实店铺名应由用户确认，不从其他店铺或公开示例猜测。

若尚无可复用环境，将 `assets/shops.example.json` 复制到私有工作目录，将 `assets/browser-config.example.json` 分别复制到该目录的 `config/shop01.json`、`config/shop02.json`，再填写已确认身份并为每店设置独立目录和端口。下面是一店浏览器配置示例，不是真实登录资料：

```json
{
  "schema_version": 1,
  "browser": "Edge",
  "user_data_dir": "../profiles/shop01",
  "profile_directory": "Default",
  "remote_debugging_port": 9224,
  "download_dir": "../downloads/shop01",
  "browser_sessions": {
    "home": { "url": "https://myseller.taobao.com/" }
  }
}
```

相对 `user_data_dir` 和下载目录按该浏览器配置文件所在目录解析。非标准浏览器安装可用 `executable_path` 指向原生浏览器程序。只有 `home` 的工作台配置会在内存中增加推广角色，不改写原主页配置；已存在的推广页优先复用，缺页时补齐一次。首次登录可由用户在这个原生浏览器内完成；不要把原 OpenCLI profile 字符串直接填入 `user_data_dir`。

运行持有登记清单所在目录的 `.promotion-monitor.lock`，使使用同一登记目录的整轮定时批次互斥，避免两个批次分别打开不同店铺。同时取得同开票技能兼容的数据目录锁。遇到其他批次、开票或其他作业持锁、端口占用、浏览器归属不明时停止对应操作，不删除锁、换端口、换目录或反复重启。这不改动工作台全局调度。新批次默认执行以下单店顺序：

1. 按原数据目录和端口启动或复用本店浏览器，核验身份并扫描。
2. `execute` 在已有授权内逐计划写前复核、暂停及写后核验；其他模式不执行暂停。
3. 将业务结果和检查点落盘并标记 `closing`，保存 taobao/tmall/alimama 会话到本店原 Profile。
4. 通过正常 `Browser.close` 关闭本店浏览器，确认进程退出后才确认该店收尾完成，释放控制连接与目录锁，再进入下一店。

会话保存或关闭失败时保留现场，不强杀浏览器，停止继续打开下一店；最终报告列出尚未执行的店铺。登录失效、接口失败等单店业务异常在会话保存与关闭成功后可以继续。空指标按 0 正常处理。`--keep-browser` 用于人工检查，结束时只断开控制并保留窗口；新批次将选择写入 `close_after_shop`，恢复时不能更改。旧批次没有该字段时继续保留浏览器。

业务结果已经落盘不等于关闭已经完成。中断时仍处于 `closing` 的店铺恢复时不会按成功店铺跳过，必须完成相应收尾。Ctrl+C 或取消会保存 `stopped` 和已有结果，但取消清理期间不发通知；后续可恢复原批次，或另行 `--finalize` 发送已保存结果。

此处只管理本批次依次处理的浏览器，不修改工作台全局调度。其他已经打开的窗口或工作台保活任务仍可能占用资源，因此不能保证机器上始终只运行一个浏览器。

首次人工登录可先明确启动一店：

```powershell
& $python "$skill/scripts/manage_browsers.py" `
  --registry "$work/shops.json" start --shops shop01
```

用户在出现的原生浏览器内完成对应店铺登录。只读连接诊断使用：

```powershell
& $python "$skill/scripts/manage_browsers.py" `
  --registry "$work/shops.json" status --shops shop01
```

`status` 不启动进程、不补页，返回 `authentication: not_checked`；连接成功不能证明店铺身份或登录有效，正式巡检仍会核验。省略 `--shops` 会处理清单内全部环境，初次配置通常先检查一店。

## 日常命令

以下变量由使用者按本机实际路径设置：`$python` 是 Python 程序，`$skill` 是本技能目录，`$work` 是私有工作目录。

默认只读巡检全部登记店铺，并明确报表日期：

```powershell
& $python "$skill/scripts/run_batch.py" `
  --registry "$work/shops.json" --config "$work/promotion-config.json" `
  --date '2026-09-26' --mode report --output-root "$work/outputs"
```

省略 `--date` 使用 Asia/Shanghai 当天；需要历史日期时必须明确传入。新批次会冻结该日期并传给各次查询，不依赖持久页面当前日期选择器。

只巡检两店，且只连接已打开的浏览器：

```powershell
& $python "$skill/scripts/run_batch.py" `
  --registry "$work/shops.json" --config "$work/promotion-config.json" `
  --date '2026-09-26' --mode report --shops shop01 shop02 `
  --output-root "$work/outputs" --connect-only
```

省略 `--connect-only` 时已运行则附着，确认未运行才按原配置启动一次。此选项只禁止启动进程，仍允许补齐业务页、执行所选模式，并按本批次关闭策略正常关闭。需要保留窗口进行人工检查时，在创建新批次时增加 `--keep-browser`；`--connect-only` 本身不代表不关闭。

用户已要求发提醒时把模式设为 `dry-run`；用户已授权暂停符合条件的计划时设为 `execute`。`execute` 默认包含批次处理结束后的汇总通知，只有暂停授权时必须加 `--no-notify`，此时只写本地结果且不要求 Webhook。`dry-run --no-notify` 无效；仅报告应使用 `report`。启用通知时直接读取本技能根目录 `config.json` 的 `wechat_webhook_url`；本地验证只确认配置可读取，不输出地址。仅创建本技能不构成暂停或消息发送授权；已有明确授权时沿用，无需反复确认。

已授权暂停但未要求发消息：

```powershell
& $python "$skill/scripts/run_batch.py" `
  --registry "$work/shops.json" --config "$work/promotion-config.json" `
  --date '2026-09-26' --mode execute --no-notify `
  --output-root "$work/outputs"
```

推广配置示例：

```json
{
  "thresholds": {
    "notifyRoiBelow": 2,
    "closeChargeAbove": 30,
    "closeRoiBelow": 1.5
  },
  "limits": {
    "pageSize": 500,
    "maxPages": 50,
    "retries": 2,
    "requestTimeoutSeconds": 90
  }
}
```

规则的比较均严格使用 `<` / `>`。导航后先由宿主进程等待 4 秒，再检查页面运行时就绪。`limits.retries` 只控制就绪轮询的轮数，每轮最多 10 次、间隔 0.5 秒；一旦页面业务请求开始，不会因该参数重复请求或暂停写入。`requestTimeoutSeconds` 限制单次页面接口等待时间。变更阈值后应创建新批次；不要修改旧批次冻结的配置以扩大恢复范围。

## 恢复和有限重试

先查看运行器输出的作业目录、逐店错误和逐计划最终状态。修复登录、权限、页面或连接问题后恢复原作业：

```powershell
& $python "$skill/scripts/run_batch.py" `
  --registry "$work/shops.json" --config "$work/promotion-config.json" `
  --resume "$work/outputs/原作业目录"
```

普通恢复先按 `batch-state.json` 的指针读取 `shops/<id>/checkpoints/<sha>.json`，校验文件哈希；成功店铺直接跳过，仅继续未完成的扫描，并对未完成店铺的已有候选 ID 只读核验。检查点是不可变的正式恢复依据，`audit.json` 只是便于查看的最新副本。不把旧执行批次的 `--resume` 当作继续暂停命令，不重扫成功部分来覆盖原证据。恢复重新核验所选环境身份、冻结配置与已保存的 `scan_identity`，即使此前扫描为零条也不能改换店铺或账号；选中店铺或配置不一致时先处理原因，不手工编辑检查点。恢复沿用冻结的 `close_after_shop`，不能用 `--keep-browser` 改变原批次策略；无该字段的旧批次保持留开。恢复也支持 `--connect-only`，此参数不更改关闭策略。

新批次使用 `after_batch` 通知策略。已经发送汇总、但业务仍未完成的批次可 `--resume` 只读恢复；原发送快照和检查点引用保存在 `notification_history`，本次恢复结束后另发一轮新汇总。已经 `complete` 的批次恢复时跳过，不重新查询或发送。`sending` / `delivery_unknown` 仍阻止恢复和重发，先核对实际投递结果。旧批次没有通知策略时沿用原来的完成后发送规则，不将已发旧批次自动迁移为可恢复。

`pending` 且已经送达部分条目时，禁止 `--resume` 改写本轮文本与检查点快照；使用 `--finalize` 续发已冻结消息中的剩余条目。`pending` 但尚未送达任何条目时，可恢复业务处理并重建未发快照。不能把部分送达当作完全未发，也不能仅因本地命令退出就重发整套消息。

如果用户要求取消后续通知，可用 `--resume <原作业目录> --no-notify` 单向关闭，后续恢复或 `--finalize` 都不会重新启用。该选项不会撤回已发送记录，也不能绕过 `sending` / `delivery_unknown` 阻断。

当前规则将 ROI、花费空值按 0 参与阈值判断，不因单条或整类计划空指标报异常。ROI 空且花费大于 30 时仍符合默认暂停条件；花费空或两者都空时不暂停。旧审计中的 `report_metrics_unavailable` 是历史规则记录，不修改旧检查点或已发送消息来消除它；新运行使用现行规则，普通 `--resume` 仍只读，不自动重放暂停。非空非法指标、登录、身份和接口失败仍按真实异常处理。

暂停调用失败后，先按目标 ID 查最新状态。明确已停用则保存核验结果；仍活动且仍符合条件也不能立即重发：需证明该目标同轮旧操作已经结束。普通超时、断开客户端或只知道列表为空都不足以证明旧写入结束。

只有用户已有本轮 `execute` 授权，且逐目标证据充分时，才准备精确目标 JSON 并增加 `--retry-targets`。文件须声明每个目标的 `operation_settled: true` 和具体 `reason`，仅声明确已核实的目标，不使用整店笼统声明。示例结构如下；其中身份与原因必须换成实际核实的记录，不能原样作为证据：

```json
[
  {
    "shopId": "shop01",
    "promotionType": "全站推",
    "campaignId": "123456789",
    "operation_settled": true,
    "reason": "已核实此目标的原页面操作完成，保留了完成记录；本轮只读回查仍处于活动状态"
  }
]
```

`promotionType` 只使用 `全站推` 或 `关键词推广`；计划 ID 使用字符串。目标必须属于原作业已保存的候选清单。

```powershell
& $python "$skill/scripts/run_batch.py" `
  --registry "$work/shops.json" --config "$work/promotion-config.json" `
  --resume "$work/outputs/原作业目录" `
  --retry-targets "$work/retry-targets.json"
```

运行器重新检查原候选身份、活动状态、按空值归零规则处理的指标与本轮日期，然后只对选中的目标允许最多一次恢复写入。最新指标不再符合条件则跳过。失败记录、逐目标写入预算与核验结果保留在原作业中；重开命令不会重置预算。旧操作无法证明结束时保留待核验记录并报告具体缺少的证据。

## 批次通知和交付

新批次默认采用 `after_batch`：每次正常批次处理结束发送一次当前结果汇总，状态为 `complete`、`needs_review` 或非取消导致的 `stopped` 都包含在内；仍需复核或尚未执行的店铺必须在汇总中说明。Ctrl+C / 取消只保存状态，不在取消清理时发送。企业微信长度限制可能将同一汇总拆为多条。发送前冻结实际消息文本和当时的检查点引用，之后恢复产生的新数据不能改写旧发送记录，分条续发使用原文。`report` 和禁用通知的批次始终不发消息。

需要单独发送本次已保存且尚未发送的审计快照时使用：

```powershell
& $python "$skill/scripts/run_batch.py" --finalize "$work/outputs/原作业目录"
```

`--finalize` 不连接浏览器，不新扫描，不执行暂停；同一通知快照已发送时不重复发送。`sending` / `delivery_unknown` 先检查企业微信实际收到情况，不通过重新巡检补发，也不手改状态绕过阻断。使用 `after_batch` 的已发未完成批次可按上节恢复并生成新汇总；旧批次无该策略时仍受原发送规则约束。`report`、以 `--no-notify` 创建的作业，以及恢复时已单向关闭通知的作业均保持不通知。

作业目录包含：

```text
batch-state.json                     冻结配置及关闭策略、检查点指针、通知快照与历史
batch-summary.json                   逐店汇总
batch-summary.csv                    便于核对的逐店汇总
report.md                            本轮业务报告
shops/<id>/checkpoints/<sha>.json     不可变的正式检查点
shops/<id>/audit.json                便于查看的最新审计副本
```

批次 `complete` 表示所选店铺都完成本轮模式的处理；`needs_review` 表示仍有需核验项；`stopped` 表示批次被故障中止，后续店铺可能未执行。退出码 0 为完成，2 为需继续处理，1 为中止或配置错误。异常时看逐店审计，不能仅凭退出码推断某计划是否已收到暂停请求。

`batch-summary.json` / `.csv` 不再输出 `missing_metrics`，报告与通知也不提醒或统计空指标。空 ROI 按 0 可进入低 ROI 列表；空花费按 0 不满足默认暂停条件。报告的 ROI 和花费显示两位小数，非空数值保持原始精度，规则判断不使用显示值。

向用户交付真实存在的报告与审计，说明日期、所选店铺、已完成/失败/未执行范围，以及本轮待暂停与已暂停情况。有待核验项时明确标注，不宣称全部执行成功。Webhook、Cookie、CSRF、完整浏览器运行参数不出现在公开报告中。

## 本地验证与线上验收

在技能目录运行离线测试：

```powershell
& $python -m unittest discover -s "$skill/tests" -p 'test_*.py'
node --test "$skill/tests/test_adapters.mjs"
```

Node.js 仅用于页面适配器的离线测试，不是日常巡检依赖。测试检查规则边界、身份不符、分页、恢复、浏览器收尾与通知状态机，仅使用模拟页面或数据，不连接真实店铺、不发送消息、不暂停推广。`--help` 成功或 CDP 连接成功只证明对应局部能力。本次逐店关闭与批次结束通知优化的实际测试结果以本地验收记录为准，不沿用之前版本的测试数量作为本次结论。

之前版本已通过本机原生 Edge 的隔离 CDP 冒烟测试，覆盖启动、页面执行、断开后重连与测试进程清理。本次优化已通过 localhost 原生 Edge 正常关闭及重启测试，确认测试 Cookie 与 Local Storage 保留；需要在另一台机器验证这些本地能力时可选运行：

```powershell
& $python "$skill/tests/smoke_cdp.py"
& $python "$skill/tests/smoke_lifecycle.py"
```

这些测试只创建临时非业务 Profile 和 localhost 测试页面，不读取已登记店铺、不访问业务网站。`smoke_lifecycle.py` 覆盖附着已有测试浏览器、保存会话、正常关闭、原 Profile 重启后的 Cookie 与 Local Storage 验证；只在确认测试浏览器正常退出后清理临时目录，失败时保留现场。测试证明本机浏览器、CDP 和本地会话保存流程可用，不证明阿里妈妈身份、页面接口、平台会话有效期或推广业务成功。

2026-09-29，采用空值归零规则的最新真实 `execute` 巡检已完成 9 店、385 条计划，全部店铺正常完成，登录态保存与浏览器关闭均成功。企微汇总 5 条均获接口成功响应，整轮耗时 3 分 34 秒。本轮无符合条件的暂停候选，实际暂停 0 条，因此真实暂停接口尚未在线上触发。当前版本通过 98 项 Python 与 17 项适配器离线测试；隔夜登录未验收。旧审计和已发送消息保留原快照，不按新规则改写历史记录。

此前逐店关闭优化通过离线测试、真实两店原 Profile 重开身份核验，以及 localhost 隔离关闭重启和会话保留验证。当前变更的测试结果以本地验收记录为准；真实暂停尚未在线上触发，隔夜登录未验收。浏览器退出或通知发送成功不能代替对业务数据与暂停结果的核验。

维护时修改本技能的 `scripts/` / `adapters/`，同步相关文档和行为测试。分享只包含通用代码、说明和合成配置模板，排除私有配置、输出、运行时登记、浏览器 Profile、缓存和通知凭据；根目录通知配置只包含 `config.example.json` 或地址为空的 `config.json`，不打包本机实际地址。新旧两版审计保持独立，旧版审计不能直接用作新版检查点。
