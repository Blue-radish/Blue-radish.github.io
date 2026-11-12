# RadishCloud 审查与远端实施交接报告

面向远端 Windows Server 上的 RadishCloud 开发 agent，日期为 2026-11-12。本文件包含实施任务、运维验收、共享契约、后端和前端的完整审查证据，可一次性传递并独立阅读。

## 执行目标与当前基线

本次审查使用 `D:\Users\Ray\Desktop\project\RadishCloud` 本地源码副本。远端源码、前端构建目录、PyInstaller exe 和已安装服务的版本需要先核对。本地缺失依赖和测试环境差异已记录在文末证据中。

目标是让后台将每次观察讲清楚，并提高数据生命周期、接口与交互可靠性。在现有 FastAPI、SQLite、纯规则画像和 Vue 上渐进实施。两个 P1 数据问题、请求串记录与删除目标漂移应最先处理。

后续任务由实施 agent 执行。本次实际修改为审查报告。Worker、直连探针、新增自查界面和精度更高的实验属于建议路线，依赖具体部署条件。

## 任务 R1，保护历史聚合与升级入口

对应 RC-02、RC-03、RC-12。建议优先于任何会触发 `Database.initialize()` 的新版发布。

**文件范围**为 `src/radishcloud/db.py`、`cli.py`、`tests/test_contract.py` 与维护 UI 中相关说明。

**约定**是迁移完成后保留所有可解释的历史计数，迁移失败保持完整旧数据。raw 可重建区间和仅剩聚合的区间分别处理。

- [ ] 建立 `test_aggregate_upgrade_preserves_pruned_days`，构造 100 天前和今天两条记录，prune 后模拟旧 aggregate_schema，再初始化，断言两张永久聚合表中的历史日期与值保留。
- [ ] 覆盖 meta 缺失、首次初始化、重复初始化、迁移中途异常和恢复后的再次启动。
- [ ] 替换“清空全部聚合再从剩余 raw 重建”的路径。对不可重建版本保留历史表和版本信息，提供明确迁移结果。
- [ ] 新增 `test_delete_range_includes_aggregate_only_days`，覆盖仅 raw、仅聚合和混合日期，删除范围内的目标数据并报告各类行数。
- [ ] 将删除范围、保留期、总览与分布统计的作用域写入 UI。当前 `overview` 使用保留中的 visit，分布使用永久聚合，必须显示各自覆盖范围。
- [ ] 在生产一致性备份的复制库上运行迁移，核对升级前后的行数、日期范围和分组计数，再发布。

**通过条件**为旧聚合在升级后可查，指定范围的清理按 UI 描述完整生效，范围外数据保持一致，回滚与恢复有实际验证。

## 任务 R2，统一采集校验、身份标记和历史读取

对应 RC-01、RC-07、F01。

**文件范围**为 `app.py`、`collector.py`、`normalize.py`、`timeutil.py`、`db.py`、`mirror.py`、`frontend/src/types.ts` 与现有两个测试文件。

**约定**沿用 `v=1` 七字段信封，输入对象形状在边界验证，原有合法缺失标记保持兼容。历史坏记录仍可单条读取和分页展示。

- [ ] 新增 `test_collect_shapes_and_legacy_mirror_reading`，覆盖 cli/page/meta/privacy 的缺失、null、数组、对象，明确新请求接受或 400 的行为。
- [ ] 新增 `test_identity_missing_marker_is_not_sql_parameter`，对 fpid/hwid 的 timeout/unsupported/truncated 对象、空值和正常字符串，断言画像计数与接口正常。
- [ ] 统一可用身份文本的标准化入口，缺失标记在身份查询中表示无有效摘要。批量与单条路径复用该规则。
- [ ] 历史记录的结构错误在读取边界安全降级，包含一条坏记录的列表仍能显示其它记录，并给该条明确状态。
- [ ] 新增 `test_validated_timestamps_can_be_persisted`，覆盖 Z/z、正负偏移、小数秒等，复用 `parse_iso` 或传递已解析时间。
- [ ] 新增 `test_optout_mirror_has_stable_response_shape`，所有返回字段与 TS 接口一致。隐私记录有明确 UI 状态，统计区域按约定显示或隐藏。
- [ ] 服务端执行 optout 字段清理，覆盖客户端仍提交 fpid/hwid 的情况。基础访问字段保留范围与实际文案一致。
- [ ] 对嵌套深度、集合长度、字符串长度、数值有限性和有效字段数设置有界规则，控制畸形输入的存储与解释成本。

**通过条件**为 collect → raw/列投影 → 列表 → 抽屉 → 画像 → 导出全部路径兼容正常、旧版、隐私和缺失标记记录。被拒绝的输入有明确错误与计数。

## 任务 R3，修复前端请求、路由和删除的一致性

对应 F02、F03、F04、F12、F14。

**文件范围**为 `frontend/src/api.ts`、`views/MirrorView.vue`、`views/VisitsView.vue`、`views/FacetDetailView.vue`、`views/DistributionView.vue`、`components/VisitDrawer.vue` 与 `AppModal.vue`。

**接口约定**是一次请求绑定不可变的 ID、查询和 generation。只有仍然属于当前选择的响应可以提交 data/error/loading/cursor。删除确认锁定一个 ID，提交和成功事件复用它。

- [ ] 建立最小前端回归入口，命名用例 `latest selection wins`，受控 A=200ms、B=20ms，最终选中项、正文和计数全部属于 B。
- [ ] 用例 `delete uses confirmed id` 在确认后切换/关闭抽屉，断言 DELETE URL、确认文字和 deleted 事件始终使用确认时的 ID。
- [ ] 将 route query 作为 tab、focus、筛选和画像 id 的权威来源，监听同实例导航和浏览器前进后退。
- [ ] 覆盖画像 → 原始记录、同页 focus、同页 ip/fpid 筛选、直接粘贴 URL 和后退。原始记录入口应打开对应抽屉。
- [ ] 用例 `pagination ignores stale generation` 覆盖加载第二页时更改范围/搜索，旧页结果被忽略，分页中暂停自动 reset。
- [ ] 分布口径标签与数据一起提交，失败时显示错误或回到最后成功口径。
- [ ] meta 加载错误显示重试，服务状态和探测项数量从成功响应取得，读取中与失败时显示明确状态。
- [ ] 弹窗 busy、关闭、焦点恢复和抽屉切换使用一致政策，详情未与当前 ID 对齐时禁用删除。

**通过条件**为快速切换、分页、重试、删除和导航交错时，用户看到的数据与操作对象始终对应。

## 任务 R4，修正画像事实与现有错误快照

对应 F05–F12、RC-06、RC-12。

**文件范围**为 `mirror.py`、`geodata.py`、`collector.py`、`netlookup.py`、`tests/test_mirror.py`、现有画像快照和前端 labels。

- [ ] 新增 `test_missing_observation_remains_unknown`，空记录和 screen-only 记录的 touch、形态、时区差异和本地时间派生保持资料不足。
- [ ] 新增 `test_codec_negative_values_do_not_claim_hardware_decode`，false/unsupported/只支持单编码/旧列表均按实际值解释。播放能力来自 codecs，硬件解码线索来自有效 hwdec 观察。
- [ ] 新增 `test_renderer_has_source_and_scope`，覆盖 ANGLE NVIDIA、Intel、Apple、Mesa、SwiftShader、WebKit WebGL 和 WebGPU-only，通用 renderer 以图形渲染器显示。
- [ ] 新增 `test_battery_explanations`，覆盖满电接通、放电、缺失、unsupported 和旧版值。按共享文案说明浏览器报告及默认读数可能性。
- [ ] CSS 屏幕尺寸、DPR、isExtended 与逻辑处理器按实际方法命名，保留旧 API 键也能先修中文显示名。
- [ ] `_os_name` 统一 UA 大小写处理。Windows 平台版本依据官方口径处理，platformVersion 13 及以上识别为 Windows 11 系列，缺 CH 时表达 UA 的识别范围。
- [ ] 指纹文案按当前保留样本的相同摘要次数表达，时间序号仅在对应查询实现后展示。
- [ ] GeoIP 时区和 regionCode 推断使用国家+行政区+城市作用域，覆盖 CA/Ontario/London、GB/London、多时区国家和夏令时边界。
- [ ] 实际 CF、DB-IP、Cymru、PTR 与静态推断来源进入紧凑 provenance，UI 读实际来源。
- [ ] Cymru origin 的五列按官方格式解析，缺组织名时按 ASN 查询名称或明确降级。多 ASN 和注册国家保留对应含义。
- [ ] 修正与旧误述绑定的快照和断言，让快照记录事实合同，再运行确定性测试。

Windows 10/11 的 UA-CH platformVersion 映射可参照 Microsoft 官方文档。本次已核对其 Windows 11 阈值为 13.0.0 及以上，当前源码只认 19、把 14/15 写成 10 的规则需要更新。[Microsoft 文档](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/how-to-detect-win11)

**通过条件**为每个句子都能追到有效字段。摘要与详细说明的来源、范围和不确定性一致，同一 record 和 counts 的输出稳定。

## 任务 R5，调整画像阅读与可访问性交互

对应 F13、F14、F15。

**文件范围**为 `MirrorView.vue`、`VisitDrawer.vue`、`styles.css`、共享字段展示和基础弹窗组件。

- [ ] 将长数据拼串标题收敛为简短概览，主阅读顺序采用摘要、事实分节、差异、依据与原值。
- [ ] 电池、显卡、屏幕、内存、CPU、网络均提供读数加含义。技术键与原值通过详情展开，长 GPU/PTR/ASN 字符串可以完整读取。
- [ ] 同一事实有一个主展示位置，重复的 summary/full/parts/derived 使用展开和复用组件组织。
- [ ] 正文建议 15–16px，行高 1.6–1.8。证据和标签保持实际可读尺寸与对比度，替换大量 6.5–9.5px 标签。
- [ ] 画像页与抽屉复用一个纯展示的事实说明区域，复用已有 meta 索引。只提取真实共用的视图与焦点逻辑。
- [ ] 为搜索提供稳定 label，为选中/切换状态提供 aria 属性，为图表补文字或表格等价数据。
- [ ] 键盘可进入和离开弹窗，关闭后恢复触发焦点，确认时背景交互受到约束。
- [ ] 在 360/768/1280/1440px、200% 缩放、深浅色和减少动画设置下完成找记录、阅读、查看依据与导出。

**通过条件**为重要信息完整可读、主要操作可由键盘完成、状态有文字反馈，并提供实际页面截图。现有 CSS 未发现大量同选择器覆盖，重构应针对字号、组织和复用的具体收益。

## 任务 R6，修复统计、ETag 与运维成本

对应 RC-03–RC-05、RC-08–RC-10、RC-12。

- [ ] `stuck` 用真实数组长度或兼容投影过滤，新增空数组/非空数组/缺失/畸形值回归。
- [ ] 明确 ETag 表达“服务器见过请求组合”还是“实际浏览器缓存重验证”。选择后一用途时使用随机缓存标识和 If-None-Match 证据，跨域暴露所需响应头。
- [ ] 写库的公开辅助接口共用有界限流，全局上限后 key 容量和拒绝事件写入有上界。
- [ ] `Settings.load` 常规只读，初始化或真实变更再保存。跨进程读改写使用唯一临时文件和锁，覆盖 prune、update-geo 与后台设置并发。
- [ ] 下载 MMDB 后先验证 metadata、库类型和少量查询，再替换。复用现有停服务/更新/启动流程，更新后确认实际加载日期。
- [ ] 高基数永久聚合的保留和删除范围明确，必要时单独设定期限并清理历史。
- [ ] 在现有 maintenance/meta 增量提供构建信息、GeoIP 版本、collector 版本分布和字段状态比例，优先服务诊断问题排查。

**通过条件**为统计含义与 UI 一致，限流与维护任务具有可测上界，配置更新和 GeoIP 失败能保持可用状态。

## 任务 R7，按条件补齐对标能力

本任务依赖 R1–R6 的正确性基础和博客端字段修复。

- [ ] 先展示有效多出口 IP、地址族、时间和状态，按实际地址比较分流，保留 colo 为独立路径信息。
- [ ] 接入 Tor 列表、Wasm 特性和虚拟/软件渲染线索，更新 registry 和状态定义，每项覆盖一个正常与一个失败样例。
- [ ] 对照共享契约中的第二层路线，评估 Worker 提供 CF 元数据的收益，在当前账户上验证字段可见性和费用条件。
- [ ] 采用 Worker 时签名验证边缘字段并绑定采集运行，覆盖伪造头、过期签名与重放。原有客户端字段继续作为客户端来源。
- [ ] 需要 TCP/JA4/H2/QUIC 或完整 DNS 实验时，按第三层路线建立受控探针。记录终止点、权限、CORS、nonce 关联、超时和资源清理。
- [ ] 在能力不可用时显示具体部署前提，在有对应实测读数之后启用相关判断。

**通过条件**为每项能力具有明确方法、可复核原值和真实拓扑对照。HTTP/TLS 版本与连接指纹的显示各自对应实际来源。

## 任务 R8，远端发布、验收和回滚

对应 RC-11。以下步骤用于后续实施交接，远端 agent 应根据实际安装路径核对。

### 发布前清点

- [ ] 记录源码版本、前端 bundle hash、exe SHA-256、安装路径、WinSW 版本、数据路径与运行账户。
- [ ] 记录监听 PID、计划任务、服务器时区、raw/聚合最早日期、aggregate_schema 和最后 prune 时间。
- [ ] 生成 SQLite 一致性备份。在线使用 SQLite backup API，停服备份则等待连接关闭并按 SQLite WAL 状态处理整套文件。验证备份可打开并通过完整性检查。
- [ ] 保存旧 exe、对应静态构建、服务配置和必要数据备份，记录恢复路径。
- [ ] 以复制库进行迁移、prune、删除、坏记录读取和回滚演练。

### 构建与测试

建议在依赖完整的隔离工作副本运行下列命令。前端 build 会生成 `src/radishcloud/static`，后续 exe 打包必须包含该次构建。

```powershell
uv sync --frozen --dev
uv run --frozen ruff check --no-cache src tests
uv run --frozen pytest -p no:cacheprovider
```

```powershell
Set-Location frontend
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

```powershell
Set-Location ..
uv run --frozen pyinstaller --clean --noconfirm radishcloud.spec
Get-FileHash dist\RadishCloud.exe -Algorithm SHA256
```

若冻结安装指出锁文件与清单冲突，先定位具体依赖变化并审查锁文件更新。完整 pytest 若挂起，单独定位该用例及运行环境，取得可解释的测试结果后再宣告验证完成。

### 隔离端到端验收

现有 CLI 固定服务端口为 11451。`scripts/acceptance.ps1` 会写入数据并检查后台接口，优先使用独立测试机器。若在正式服务机器验收，先按实际配置隔离该采集 hostname 的 Tunnel ingress，确认公网流量已无法到达 11451，再停正式服务并使用独立数据目录。共享 Tunnel 的变更应准确作用于对应 hostname，记录维护期间流量的处理方式。测试结束后先恢复正式服务、核对正式数据目录与版本，再恢复该 hostname 的 ingress。

```powershell
uv run --frozen radishcloud --data-dir .audit-data serve
```

在另一终端运行既有验收脚本，并增加本文列出的缺失标记、隐私、乱序、历史数据和前端交互场景。演示种子脚本的 `--reset` 只指向明确的测试目录。

### 正式发布

- [ ] 等待服务进程完全停止，验证 PID 和文件句柄释放，再替换产物。
- [ ] 保留现有数据目录配置，迁移由已验证路径执行。
- [ ] 启动服务后核对 PID、回环地址、实际应用版本、数据库健康和一条受控正常入口。
- [ ] 本机管理台打开总览、筛选、隐私画像、普通画像、原始记录和导出，并执行受控测试数据的删除核验。
- [ ] 从外部确认 `/admin`、`/admin/api/meta` 和管理静态资源的隔离，确认 Cloudflare Host rewrite 与源站 Host 判断相符。
- [ ] 在两个真实博客 Origin 验证 CORS、hints、trace、首次访问与重复访问，实际浏览器确认高熵字段和 ETag 可读性。
- [ ] 验证计划任务的 04:00、系统时区、返回码与日志，重启后数据与画像可读。

### 失败恢复

- [ ] 健康检查、监听、迁移或关键 UI 验收失败时，安装过程返回失败并保留诊断日志。
- [ ] 停止新版，恢复与旧数据库格式兼容的 exe、静态构建和配置。数据库有不兼容迁移时使用已验证的一致性备份恢复。
- [ ] 再次检查回环监听、管理 API、数据范围和任务计划，记录恢复点之后可能产生的数据差额。
- [ ] 在复制环境覆盖 exe 被占用、端口被占用、下载失败、ACL 设置失败和迁移异常，确认恢复步骤实际可执行。

### 最终交付记录

- [ ] 对照 RC-01–RC-12 与 F01–F15，逐项列出已修复、保留现状或待条件具备的原因。
- [ ] 给出实际源码/构建/安装版本和 hash，附测试命令、结果与关键页面截图。
- [ ] 记录与博客端同步的字段、状态、算法版本和共享夹具。
- [ ] 记录升级前后 raw/聚合数据核对结果、备份位置、恢复验证和已知差异。
- [ ] 对尚缺的网络基础设施，列出域名、端口、边缘能力、配置入口、费用条件和下一步可执行动作。



## 共同目标、契约与验收矩阵

审查日期为 2026-11-12，时区为 Asia/Hong_Kong。面向博客项目和 RadishCloud 的开发 agent。

### 1. 交付范围与证据边界

用户要求仔细审查两个项目，给出可执行的详细改进报告，提升设备、浏览器、网络与隐私诊断能力和中文解释质量，同时调整架构与前端，使代码遵循奥卡姆剃刀原则。

本次完成源码审查、现有检查、合成输入复现、参考站实际浏览和少量公开接口只读检查。产品代码修复与远端部署属于报告之后的实施工作。

| 对象 | 本次可复核基线 |
| --- | --- |
| 博客仓库 | `D:\Users\Ray\Desktop\project\Blue-radish.github.io`，HEAD 为 `9d76f94500081227ee65a1f2a76a365947e824f5`，审查起点工作树干净 |
| RadishCloud | `D:\Users\Ray\Desktop\project\RadishCloud` 的本地源码快照，目录中没有可用 Git 仓库元数据，版本声明为 `0.1.0` |
| 远端服务 | 源码说明为 Windows Server 2022、WinSW、Cloudflare Tunnel、回环监听 `127.0.0.1:11451`，本次未登录服务器核对二进制、数据库和隧道配置 |
| 参考站 | 实际浏览 `https://who.1ms.dog/zh-cn/`，等待页面显示 127 项读取完成，检查阅读层级、逐项解释、证据和操作入口 |

发现等级按处理次序使用。P1 指安全、数据损失、主要流程中断或核心结果错误。P2 指功能正确性、可信度、可维护性和发布可靠性。P3 指低影响清理和体验细节。单条发现会进一步注明静态证据、合成复现或待远端验证。

本报告选择 Markdown 作为开发交接格式。推荐的实施路线、UI 尺寸和任务边界由本次审查提出，用户尚未逐项批准。远端 agent 应以服务器当前源码复核行号，并在交付中记录实际版本与偏差。

#### 已执行检查

| 检查 | 结果与适用范围 |
| --- | --- |
| 博客 `node --test tests/*.test.js` | 23 通过，0 失败。测试使用 Node VM 和模拟浏览器环境 |
| `node --check static/radish-collect.js` 与 `node --check docs/radish-collect.js` | 两项语法检查通过 |
| 博客源码与本地发布副本 SHA-256 | 分别为 `C4ABA6F9EB3859C4C412C84A41C68A2BEA0C8D56BF1357DECDD8CC6C0228260A` 和 `635B6D537DBC883FE58378204D6DAE789B823FB073B3818AB6550743431734DC` |
| RadishCloud `tests/test_mirror.py` | 8 通过。使用可运行 Python 加载现有依赖完成该子集 |
| RadishCloud Ruff | 现有规则检查通过，执行使用 `--no-cache` |
| RadishCloud 全套 pytest | 本地 TestClient 阶段挂起，已终止，完整后端测试结果待复核 |
| Vue 类型检查 | 现有 `node_modules` 缺少 `@volar/typescript/lib/quickstart/runTsc`，命令未进入完整类型检查。前端构建和类型正确性尚待验证 |
| 合成复现 | 已复现发送去重、ICE 解析、预算、画像缺字段、错误硬解结论、坏记录污染画像列表、日期解析、聚合迁移丢历史、地名时区冲突等，详见各项目报告 |
| 视觉依据 | 参考站使用当次浏览器页面，RadishCloud 使用仓库已有 `docs/screenshots/profile.png` 演示截图与当前 Vue/CSS 源码，远端实际页面仍待验证 |

#### 公开线上检查

全部使用 HTTP GET，未向生产 `/v1/collect` 提交测试记录。

| URL | 本次结果 |
| --- | --- |
| `https://blog.072120.xyz/radish-collect.js` | HTTP 200，版本 `radish-1.0.4`，响应体 64901 字节，缓存 `max-age=14400` |
| `https://blue-radish.github.io/radish-collect.js` | 本次 HTTP 客户端检查发生异常，版本与缓存状态待远端或开发浏览器复核 |
| `https://radishcloud.072120.xyz/admin` | HTTP 404。其余管理路径与编码变体仍需完整隔离验收 |
| `https://radishcloud.072120.xyz/v1/hints` | HTTP 200。携带博客 Origin 时回显对应 ACAO，`Cache-Control: no-store` |
| `https://radishcloud.072120.xyz/cdn-cgi/trace` | HTTP 200，`Access-Control-Allow-Origin: *` |

本地 `docs/radish-collect.js` 仍为 1.0.3，线上自定义域名为 1.0.4。此事实说明发布产物追踪需要加强。线上全部页面、另一域名和远端源码的一致性需要发布验收证明。

### 2. 总体判断与优先级

两个项目已经形成可用的基本链路，博客负责浏览器采集，RadishCloud 负责可信请求字段补充、SQLite 存储、查询、画像和后台。FastAPI、SQLite、Vue 与静态博客能够继续承载当前需求。

主要差距集中在三处。

1. 探测结果的语义需要校正。多个有值字段测量了别的对象，部分失败状态被写成不支持或拒绝，WebRTC、时钟、多出口和设备形态因此难以形成可靠判断。
2. 画像缺少面向人的逐项解释，已有规则又存在确定性错误。电池已采集却没有进入画像，显示器数量、屏幕尺寸、内存、指纹和硬解支持的表达需要收敛到证据。
3. 跨仓库契约、发布产物、数据生命周期和前端请求状态缺少完整回归。23 个博客测试和 8 个画像测试均通过，已复现问题仍然存在。

| 首批处理 | 原因 | 负责方 |
| --- | --- | --- |
| 标签页 hash/search 的 DOM XSS | 外部输入到 `innerHTML` 的路径已确认，需要修到生成来源 | 博客 agent |
| 聚合版本迁移丢失已 prune 历史 | 已在内存 SQLite 原逻辑复现，升级具有数据损失风险 | RadishCloud agent |
| 合法缺失标记与坏形状导致画像接口失败 | 采集边界、旧数据读取与前端完整性均受影响 | RadishCloud agent |
| optout 响应缺 `counts` 导致界面读取失败 | 后端与 TypeScript 契约直接冲突 | RadishCloud agent |
| 抽屉旧响应串记录与删除目标漂移 | 函数级已复现记录 ID 与正文错配，影响删除操作 | RadishCloud agent |
| 发送状态、离开页面、失败恢复与硬字节预算 | 影响短访问、弱网络和真实采集完整性 | 博客 agent |
| 探针语义及错误画像结论 | 影响“像参考站一样讲清楚”的基础 | 两边协同 |

### 3. 对标目标与能力边界

参考站把摘要、检查结果、逐项读数、解释和操作入口连接起来，并提供历史对照与导出。RadishCloud 应吸收这种阅读顺序，再加入后台已有的历史筛选、聚合和单条追溯能力。参考站也有启发式推断，实施时应逐条检查它们的证据强度。[参考站](https://who.1ms.dog/zh-cn/)、[项目说明](https://github.com/yt1988/who-are-you)

#### 能力矩阵

| 能力 | 当前项目证据 | 改进目标 | 前提与验收 |
| --- | --- | --- | --- |
| 浏览器、系统、语言、时区 | 已采集并参与画像 | UA、Client Hints、运行环境来源分开显示，支持不一致解释 | 首次访问、Firefox、Safari、UA 简化与旧记录均可读 |
| 显卡与渲染器 | WebGL/WebGPU 已有，画像只展示名称 | 名称加实际含义、软件渲染线索与读取限制 | 有独显的笔记本使用核显时文案成立 |
| 电池与供电 | 客户端仅有 `level/charging`，画像缺省 | 电量、充电读数和 API 默认值的说明 | 满电笔记本、台式机、API 不支持分别有样例 |
| 屏幕、刷新率、显示器 | 已有字段，部分语义错误 | CSS 尺寸、DPR、帧率估计和扩展屏幕状态逐项说明 | 后台页面、缩放、三屏、远程显示器情况覆盖 |
| 内存、CPU、外设 | 已有字段和错误替代值 | 浏览器报告档位、逻辑处理器、API 可用与已连接设备区分 | 数据不足时有明确状态与依据 |
| 典型浏览器指纹 | Canvas、音频、WebGL、字体等已采集 | 每部分可比对，摘要有算法版本，样本范围可见 | 同机多浏览器、两台同配置设备、升级前后可解释 |
| 多目的地出口 | trace 输出缺 IP，stack 测量目标错位 | 每个目的地保存实际观察到的出口 IP、地址族、时间和读取状态 | CORS 不可读和同 IP 不同 colo 场景可解释 |
| WebRTC | 当前只有 host candidate，解析存在错误 | 先修 host/mDNS，再按诊断需求增加 STUN 公网候选 | IPv4、IPv6、mDNS、UDP 失败与正常无候选覆盖 |
| DNS 解析路径 | 有第三方读取入口 | 说明测到的解析器范围，完整泄漏实验可通过自有 nonce 域名关联 | 服务提供方、超时、缓存、DoH、分流都记录来源 |
| 连接协议和边缘读数 | trace 提供部分 HTTP/TLS/kex/WARP | 同次连接的可信边缘信息，解释观测终止点 | 浏览器到边缘与隧道到源站的来源可追溯 |
| TCP/JA4/H2/QUIC 指纹 | 五项当前标为 X | 按基础设施条件分阶段补齐 | 详见下方三层路线，先验证数据入口 |
| Tor、Wasm、虚拟环境线索 | 当前 124 项目录缺少对应独立项 | Tor 出口列表匹配、Wasm 特性、软件/虚拟渲染线索 | 每项有新 ID、来源、失败状态和历史兼容 |
| 人类可读诊断 | 已有 6 句画像、证据标签与原始记录 | 摘要 → 事实说明 → 差异解释 → 来源与行动 | 所有重要断言可定位至一个或多个有效观察 |
| 历史对照、导出、纠错 | 已有历史访问、JSON 导出、全文复制 | 同算法同口径的变化对照，脱敏导出和误判反馈 | 统计范围、记录时间、规则版本同时可见 |

124 是当前目录项数。客户端实际注册 100 个探针，再加最多 5 个 trace/hints 派生键，通常形成 105 个 `cli` 键。若干键固定返回占位值，因此有效测量覆盖率需要单独计算。参考站展示的 127 项可作为清单参考，每项验收以真实输入、方法与含义为准。

#### 诊断规则逐项对照

下表按当前项目的实际代码提出补齐任务。每条规则输出观察、解释、证据和状态，优先保存能复核的差异。

| 诊断主题 | 当前短板 | 完成定义 |
| --- | --- | --- |
| 系统时区与出口 | 依赖国家 offset 范围，未知会落为无差异 | 优先使用有效出口 IANA 时区并按观测时间处理 DST，范围规则标出精度 |
| 浏览器语言与地区 | zh 被粗略映射为 CN | 解析具体 locale 地区，海外语言偏好用弱提示解释 |
| 系统语言线索 | 字体/语音可供推测，但来源、裁剪和平台差异缺解释 | 显示发现哪些语言资源，保留数量与平台适用条件 |
| DNS 路径 | 单个第三方返回值缺少实验范围 | 记录解析器来源、查询方式和时间，自有权威实验按 nonce 关联 |
| 多目的地分流 | 输出丢弃实际 IP，部分判断依赖 colo | 按各目的地有效 IP/地址族比较，colo 保留独立信息 |
| WebRTC 出口 | 当前为空 ICE servers，candidate 又解析错位 | 分开显示 host/mDNS 与 STUN 候选，记录候选类型与成功状态 |
| RTT 差异 | Network Information API 估计值与真实请求 RTT 含义不同 | 浏览器按多次请求估计 RTT，边缘 RTT 采用同次可信来源，报告误差范围 |
| 连接层指纹 | 五项为 X | 有实际边缘或直连采样入口后显示原值和采样点，规则按各协议独立验收 |
| 机房网络线索 | 关键词命中被写成高代理可能性 | 展示 ASN/组织/PTR 和命中词，说明分类依据与来源 |
| UA 与系统一致性 | CH 高熵字段不齐，部分版本来自同一个 UA | UA、CH、GPU、Worker 的观察分别保存，只有独立读数参与交叉核对 |
| 环境改写线索 | 简化 lies/shield 可能误述保护状态 | 展示具体不一致接口和干净上下文对照，单项缺失保留状态 |
| 指纹浏览器线索 | engver 当前直接读 UA，Worker 只比 UA | 特性探针和 Worker 真实字段作为独立证据，结果用差异解释 |
| 指纹稳定性 | 摘要含易变字段，rand/shield 有弱代理值 | 在同算法同设置下重复测量各部分，说明稳定范围与变化项 |
| 自动化或代理操作线索 | 依赖 webdriver/Headless/插件等启发式 | 展示具体检测到的信号，普通空插件和兼容环境覆盖反例 |

协议区另行处理 HTTP/3、ECH、后量子密钥交换和 WARP。HTTP/3 显示本次实际协商结果，ECH 需要实际 sni/ECH 读数及目标支持条件，后量子从实际 kex 算法识别，WARP/Gateway 按 trace 返回值展示。每项均覆盖目标未支持、读数缺失与探测失败。

后台历史记录提供查看依据、同口径对比和缺失原因。主动重测在操作者当前浏览器中新建采集运行，附新时间和 ID，再与选定历史样本对照。调整浏览器设置的建议面向实际操作者，后台管理员的主要动作是核对证据和观察变化。

稀有度或“有多少相同结果”使用明确样本集、算法版本和统计时间。单项频率与整组指纹频率分别计算，联合稀有度由联合观察支持。历史次数及环境摘要的比较功能可以在现有查询和聚合上增量实现。

#### 分阶段达到更强能力

**第一层，现有基础设施内改进。** 修复已采字段、发送与存储，完善解释、证据、历史对照和可读 UI。补上 Wasm 特性与虚拟/软件渲染线索。Tor 可使用定期更新的出口列表进行 IP 匹配，并标出列表时间。该阶段能明显提高日常可读性和后台追溯能力。

**第二层，评估 Cloudflare 边缘补充。** Worker 的 `request.cf` 可提供 ASN、地理位置、HTTP/TLS、部分 ClientHello 摘要与 RTT。通过受控边缘入口，将允许字段附带到采集请求，能够改善源站缺失数据。JA4 等 Bot Management 字段受套餐和功能条件影响，应在账户中实测。Worker 引入属于建议，需要实际部署条件支持。[Cloudflare Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/)

**第三层，完整连接层与自有主动探针。** TCP SYN 操作系统线索、自定义 H2 SETTINGS 和 QUIC 特征，需要接住相应客户端连接的采集设施。规划独立直连探针域名、公网可达地址、TLS 终止、TCP/UDP 443、CORS、短期 nonce 与采集运行的关联。DNS 实验可使用带 nonce 的权威域名，识别到达权威服务器的递归解析器。先部署单个有明确用途的探针，再根据读数扩展。

源站经 Tunnel 观察到的是转发后的 HTTP 请求。TCP 连接端系统推断还受到 VPN、NAT、负载均衡和代理终止位置影响。完整能力验收需要对照网络拓扑。旧规格中“永久不可见”“以后不要评估”的措辞应更新为带部署前提的能力状态，方便未来扩展。

### 4. 两边共同采用的观测契约

以下是改进建议，新增字段采用兼容增量演进。现有 `v=1` 七字段信封继续读取，采集器版本负责区分历史语义。实施时由两个 agent 将最终约定同步到各自仓库的契约文件。

#### 4.1 身份、运行和时间

- `id` 表示一次采集运行，失败重试沿用该 ID，后端按 ID 幂等写入。
- `session` 明确为标签页会话。现有“一会话只发一次”会把访问数压成每个标签页一条，默认阶段沿用该口径并更新 UI 名称。若要增加逐页 PV，应单独说明采集事件和去重粒度，再联动修改两端。
- `ts` 使用含时区的 ISO8601。后端统一解析成 UTC，`ts_day` 按 Asia/Shanghai 归档。另存服务器 `received_at`，用来区分用户错钟、延迟和补发。
- `meta.collector` 保留，新增 `fingerprint_version` 和 `interpretation_version`，版本缺失的记录按遗留规则解释。
- `fpid/hwid` 作为环境摘要和相似线索。界面以“相同摘要出现 N 次”表述，并展示算法和样本范围。

#### 4.2 数值与缺失状态

成功观察继续放在 `cli.<id>`，现有 `{$: kind}` 标记保持可读。新增状态采用有限枚举，建议包括 `not_run`、`unsupported`、`denied`、`timeout`、`unreadable`、`error`、`truncated`。浏览器对网络和 CORS 的错误可见性有限，统一 `unreadable` 时在方法说明中给出可能原因。

| 状态 | 面向人的含义 |
| --- | --- |
| 成功，值为 false 或空集合 | 该测量已完成，结果为否或没有匹配项目 |
| `not_run` | 这项检测尚未运行，可注明所需动作 |
| `unsupported` | 当前浏览器或环境未提供所需接口 |
| `denied` | 实际权限请求或权限查询明确报告拒绝 |
| `timeout` | 规定时间内没有获得结果 |
| `unreadable` | 请求结果无法在当前浏览器中读取 |
| `error` | 测量执行失败，保留简短可分类原因 |
| `truncated` | 已保存部分内容，数量及裁剪范围明确 |

旧采集器硬编码的 `denied` 应显示为“旧采集器未运行此项”。缺失 `touch`、国家、时区、GPU 或外设字段时，相应派生字段保持空值。三态比较保留 `true/false/null`，UI 将 null 显示为“资料不足”。

对关键观察可在 `meta.observations[id]` 增量附带 `source`、`method`、`observed_at` 与 `reason`，先用于出口、位置、协议和重要设备解释。读数和状态维持一个来源。该元数据具体命名属于建议，两个 agent 应一次统一后实施。

#### 4.3 来源与信任

- 浏览器测量、用户代理字符串和客户端时间均属于客户端上报。
- `srv` 由服务端创建。边缘输入从允许字段读取，客户端 payload 中的 `srv` 被丢弃。
- Cloudflare 元数据、本地 MMDB、DNS 查询和静态地名推断分别记录来源与更新时间。
- 若增加 Worker，边缘代理应覆盖客户端同名头，源站校验签名、时间窗口和采集 ID 绑定，确保受信任元数据可验证。秘密仅配置于边缘和源站。
- Origin/CORS 用于浏览器来源控制。公开收集接口同时按限流、大小、形状、成本和旧数据容错控制输入。

#### 4.4 隐私分支和保留期

现有规格允许 DNT/GPC 时保存服务端可见访问字段，因此文案要明确“跳过浏览器指纹采集，保留基础访问字段”。后端同样执行 optout 字段清理，覆盖伪造或遗留客户端。按用户后续要求，可以再选择更小的保存范围。

当前永久聚合保留 IP、PTR、指纹等高基数原值，详情过期之后这些取值仍可查。保留策略应对高基数标识单独设置保留期或转为有期限的聚合，并为历史数据提供清理路径。UI 同步显示原始、聚合和日志的实际范围。删除功能应明确作用对象及影响行数。

#### 4.5 返回契约与回归夹具

`MirrorResponse` 的所有分支保持相同外形，至少保留 `short`、`summary`、`full`、`parts`、`derived`、`proxy`、`missing` 和 `counts`。optout 返回空派生与隐私说明，同时提供完整 `counts` 形状。前端模板仍处理读取中的空响应。

每项重要解释通过 `parts` 关联实际依据。建议每项输出 `key`、`sentence`、`evidence`、`certainty` 和 `rule`，后两项只在确有展示或回放用途时加入。置信度先使用“直接读数／规则推断／资料不足”，数值概率应由验证数据支持。

两个仓库共用一小组无真实访客信息的 JSON 夹具，覆盖正常、隐私、缺失、裁剪、旧版本和畸形记录。字段名称、类型、来源和中文含义在契约中各维护一处，测试检查差异。已有后端 registry 继续承担后台元数据职责，跨语言共享优先采用简单 JSON 清单。

### 5. 中文解释与前端阅读规格

#### 推荐信息顺序

1. 简短身份摘要，表达这次观察中的系统、浏览器和出口，标题控制在两行内。
2. 最重要的已确认事实与待核验差异，直接展示本次涉及的字段和解释。
3. 设备、网络、浏览器与隐私的中文说明，每条包含读数、含义、依据与适用范围。
4. 全部字段与原始 JSON，提供搜索、复制和单条导出。
5. 历史变化、同口径样本统计与诊断动作，保持时间、样本范围和来源可见。

RadishCloud 当前截图将较长的数据拼串用作大标题，下方又重复摘要、六句、派生字段和证据标签。改进时让每个信息拥有一个主展示位置，详细依据通过展开或点击定位。正文建议 15–16 px、行高 1.6–1.8，次要文字保持可读对比。桌面正文每行约 30–45 个中文字符或 60–75 个拉丁字符，再按实际字体校验。

360、768、1280 和 1440 px 宽度及 200% 缩放应能完成找记录、读画像、看依据和导出。移动端采用单列，筛选和观测列表使用可收起面板。状态同时使用文字和视觉符号，键盘可操作标签页、抽屉和弹窗，关闭后恢复焦点。错误反馈提供重试入口，并准确保留本次选择上下文。

#### 核心文案样例

| 观察 | 推荐表达与要求 |
| --- | --- |
| WebGL 报告具体 NVIDIA/Intel/AMD 渲染器 | “浏览器绘制内容时使用 NVIDIA …。笔记本可能选择核显，也可能按页面负载切换渲染器。”说明依据为 WebGL renderer |
| renderer 为 SwiftShader、llvmpipe 等 | “当前由软件渲染器绘制，可能与远程环境、驱动设置或浏览器策略有关。”保留原值和规则依据 |
| 电量 100%，charging=true | “浏览器报告电量 100%，供电状态为已接通。满电设备、台式机和部分默认读数可能得到相同结果。” |
| 电量 63%，charging=false | “浏览器报告电量 63%，正在使用电池。”仅在有效读数时输出 |
| Battery API 缺失 | “这个浏览器没有提供电池读数。”详情页显示状态，摘要可省略 |
| screen.w/h 与 DPR | “浏览器报告屏幕 1920×1080 CSS 像素，设备像素比 1.5。”物理像素推算单独标为估计 |
| `isExtended=true`，无授权屏幕清单 | “检测到扩展屏幕。”具体数量等待有明确来源的读数 |
| `hardwareConcurrency=20` | “浏览器可使用 20 个逻辑处理器。”解释系统或浏览器可能限制报告值 |
| `deviceMemory=8/16/32` | “浏览器报告内存档位为 N GiB，经过近似和可能的上下限处理。”实际容量范围依实现版本进一步说明 |
| `codecs` 支持 HEVC/AV1 | “浏览器支持播放这些编码格式。”硬解线索从 `hwdec` 的有效查询结果读取 |
| 只有时区和出口地区差异 | “系统时区与出口地区不同，可能来自跨地区网络、旅行或系统设置。”保留其它证据再判断 |
| 相同指纹再次出现 | “相同环境摘要在当前保留数据中出现 N 次。”附观察范围和算法版本 |

电池规范允许在读不到实际状态时给出模拟满电、接通电源的默认值。`screen` API 使用 CSS 像素。WebGL renderer 反映底层渲染驱动字符串。内存 API 使用近似值与实现自定上下限，因此文案中的精确硬件结论需要额外证据。[Battery Status](https://www.w3.org/TR/battery-status/)、[CSSOM View](https://www.w3.org/TR/cssom-view-1/)、[WebGL 扩展规范](https://registry.khronos.org/webgl/extensions/WEBGL_debug_renderer_info/)、[Device Memory 文档](https://www.w3.org/TR/device-memory/)

W3C 的 Device Memory 文档当前标为 Discontinued Draft。实现阶段应同时核对目标 Chromium 实现与真实浏览器读数，保持“浏览器报告档位”的稳健解释，避免统一固定上限。

缺失详情保留具体状态，叙述摘要省略无依据句子。像“高消费力”“游戏玩家”“国籍”“真实人类”等标签应有独立可验证依据，设备性能线索适合表述为设备能力。

### 6. 架构收敛与实施顺序

本次推荐渐进收敛。整体重写会同时改变博客生成、采集协议、数据模型和 UI，扩大回归范围。先修根因和契约，再根据重复逻辑的实际需要拆分文件。

| 阶段 | 博客交付 | RadishCloud 交付 | 联合验收 |
| --- | --- | --- | --- |
| A，安全与数据完整性 | XSS 生成来源修复、产物测试门禁 | 聚合迁移保护、输入边界、optout 与缺失标记响应、记录正文与删除目标一致性及确认 ID 锁定 | 当前版本可安全发布，旧数据可读，已有数据有可验证备份 |
| B，采集与解释正确性 | 单次运行状态、硬预算、ICE、时钟、真实字段语义 | 对齐新旧字段、修正设备/编码/时区等画像规则 | 共享合成夹具逐项断言，跨版本读写兼容 |
| C，人类可读前端 | 可选静态自查入口、方法与状态说明 | 画像阅读层级、其余列表请求竞态、筛选路由和键盘交互 | 多尺寸、200% 缩放、快速切换与错误恢复 |
| D，能力补齐 | 双栈与多出口有效观察、Wasm 等基础能力 | 结果展示、比较与可解释统计 | 每个能力有方法、样例、失败状态和来源 |
| E，基础设施增强 | 按确定入口接入边缘与主动探针 | 签名校验、运行关联、历史展示 | Worker/直连/DNS 组件分别在真实拓扑验收 |

每阶段使用小提交和独立回归。阶段完成后给出版本、命令、结果和截图，再进入依赖它的阶段。耗时由实施 agent 根据远端差异估计，报告中的阶段不承诺日历工期。

#### 奥卡姆剃刀验收

- 保留有业务理由的职责边界，采集负责观察，后端负责可信补充与投影，画像负责解释，前端负责交互与展示。
- 运行状态只维护一份。相同运行内共享 WebGL、字体和 UA 高熵读取，结束后清理临时资源。
- 先使用现有 FastAPI、SQLite、Vue 和浏览器 API。新依赖必须对应已确认的问题和维护收益。
- CSS 回到一组生效规则，移除已被覆盖的旧方案，组件样式贴近组件，通用 token 集中管理。
- Registry、契约、规则和 UI 标签各自有明确权威位置，重复清单通过测试或简单生成同步。
- 每次抽象应消除已存在的重复或隔离稳定边界，交付中记录删除的死代码、旧样式和过时说明。

### 7. 联合验收总矩阵

| 场景 | 应观察到的结果 |
| --- | --- |
| 正常 Chromium，第一次来访 | 一次运行一个 ID，读数与协议来源明确，后端只保存一条 |
| 同运行并发入口、正常完成与 pagehide 交错 | 复用运行状态，部分发送与最终完成遵守同一去重闸门 |
| 离线后恢复、429、5xx | 有限恢复行为，ID 稳定，发送状态区分排队与确认 |
| 一个探针永不完成，用户立即离开 | 事件处理器内排队已完成部分，其余有状态，资源可清理 |
| 多字节与超长数组/字符串 | 最终序列化 UTF-8 字节数满足客户端硬预算，服务端继续限制总大小和复杂度 |
| DNT/GPC 与伪造 optout payload | 前后端共同执行约定的最小采集，画像响应完整可渲染 |
| 存储禁用、API 不支持、权限拒绝、尚未运行 | 不同状态有对应中文，任何单项失败保持其余功能可用 |
| `fpid/hwid` 缺失标记、cli 非对象、历史坏记录 | 新输入得到明确校验结果，旧数据查询能够逐条容错 |
| Windows/Mac/iPhone/Android/触屏笔记本 | 形态、OS、GPU、CPU、电池与屏幕文案均有有效依据 |
| 两屏以上、CSS 缩放、浏览器后台 | 显示器数量与帧率估计的表达符合实际方法 |
| 家宽、机房、多出口、VPN、双栈/单栈 | 展示具体观察和差异，同 colo 与同 IP 的含义独立处理 |
| 中文/英文同名城市、夏令时、国家多时区 | 地名补全考虑国家和行政区，时区判断注明时间点和精度 |
| 快速点选两条记录、筛选变化、请求倒序返回 | 标题、内容、选中记录、计数和路由保持一致 |
| prune 后升级、删除、恢复备份 | 永久聚合按明确定义处理，升级保留历史，删除统计与界面一致 |
| 重跑博客生成、缓存命中、双域名发布 | 生成来源包含修复，最终 artifact 被测试，部署版本有可核对标识 |

### 8. 报告使用方式

`01-博客项目-agent交接报告.md` 与 `02-RadishCloud-agent交接报告.md` 都包含本共享约定、各自发现和实施任务。将对应完整文件交给各项目 agent 即可开始复核与实施。RadishCloud 文件另外包含服务器验收、发布和回滚步骤，适合一次性传给远端开发者。

三个 `*-audit-notes.md` 保存具体源码证据与本地复现过程。源码行号以本次快照为准，实施时以函数和行为重新定位。

## 后端与部署审查完整证据

审查日期为 2026-11-12。审查对象为 `D:\Users\Ray\Desktop\project\RadishCloud` 的本地副本。本文供总报告整合及远端 Windows Server 项目 agent 实施使用。

### 范围和证据边界

- 读取了 `src/radishcloud`、`tests`、`deploy`、`scripts`、相关前端调用与 README。未修改该项目的产品代码、配置和部署状态。
- 在项目及上级目录检查了适用 `AGENTS.md`，未发现额外仓库文件。会话要求使用简体中文。
- 运行了静态检查、现有画像纯函数测试及内存 SQLite 复现。对测试连接使用了 `Database.connect` 的内存适配，实际查询、投影、聚合、删除、迁移逻辑均调用原函数。
- 本机 `.venv/pyvenv.cfg` 指向缺失的 `D:\miniconda3`。通过本机已有 Python 3.12.0 与该虚拟环境已有 site-packages 完成部分验证。这个运行环境与项目原始 3.12.8 环境存在差异。
- 完整 pytest 运行在 TestClient/异步相关用例处长时间没有进展，已中止。未将其判为产品测试失败。使用临时目录创建 app 时还遇到当前沙箱 `config.json.tmp` 重命名权限错误。因此 HTTP 端到端、线程并发、Windows 服务及远端 Cloudflare 实际行为均须由远端 agent 复核。
- 当前没有已证实的 P0。下文明确区分函数级已复现、静态已证实与需远端验证的部署条件。

### 现有架构与能力

```text
博客采集器 / 浏览器探针
  → Cloudflare HTTPS / Tunnel
  → 127.0.0.1:11451 FastAPI
  → Origin、体积、时间偏差、限流、id 幂等
  → HTTP 头与离线 GeoIP / DNS 补充
  → raw + visit 列投影 + facet + 每日永久聚合
  → 本机 /admin Vue 管理台
```

- `src/radishcloud/app.py` 负责公开采集、hints/etag、管理 API 和静态资源。
- `collector.py` 还原 `srv`、构建列表列与 facet。客户端原始嵌套数据保存在 `raw`，服务端覆盖上报的 `srv`。
- `db.py` 提供 SQLite WAL、增量聚合、游标分页、中文地点检索、删除和原始数据保留期清理。
- `mirror.py` 为纯规则画像生成器，已有确定性和快照测试。它可以直接服务可读诊断改造，无需引入模型服务。
- `registry.py` 是 124 项维度注册表。`normalize.py` 保留 unsupported、timeout 等缺失标记，数组去重且 facet 最多展开 64 项。
- `geo.py` 使用 DB-IP Lite City/ASN MMDB。`collector.py:109–118` 按字段合并 CF 与本地数据，`netlookup.py` 提供 Team Cymru DNS 与 PTR 兜底。
- `paths.py:8–9` 固定回环监听。`security.py:103–110` 的管理访问检查同时要求回环 socket 与回环 Host。`app.py:50–58` 有 CSP、防 iframe 与 nosniff 头。
- 前端位于本项目 `frontend/src`。真实入口为 `/admin/visits?tab=profile`，`VisitsView.vue` 嵌入 `MirrorView.vue`。`frontend/src/router.ts` 中 `/mirror` 是重定向。单条抽屉由 `components/VisitDrawer.vue` 提供，画像后端为 `/admin/api/visit/{id}/mirror`。
- 部署采用 PyInstaller 单文件 exe、WinSW 服务与每日 04:00 计划清理任务，数据默认位于 `C:\ProgramData\RadishCloud`。`frontend/vite.config.ts` 构建覆盖 `src/radishcloud/static`，exe 又包含该静态目录，因此存在前端源码、已构建静态资源、已打包 exe、已安装 exe 四层版本状态。

### 可复核问题

#### RC-01 · P1 · 已保存记录类型与画像 API 不一致，可使画像页返回 500

- 状态为函数级已复现，HTTP 返回码由调用链静态确定，尚未完成远端 HTTP 复核。
- 位置为 `app.py:218–243`、`collector.py:210–217`、`collector.py:287–290`、`db.py:638–669`、`app.py:390–397`、`app.py:420–424`。
- `/v1/collect` 只严格检查 v、id、ts。`cli=[]` 会被列投影按空对象处理，但 raw 继续保存数组。随后 `identity_counts_batch` 的集合推导直接对 `record.get('cli', {})` 调用 `.get`，抛出 `AttributeError`，导致包含该记录的画像列表失败。
- 更贴近现有合同的输入为 `cli.fpid={"$":"timeout"}`。`_scalar_text` 将列表列写为字符串 `timeout`，raw 保留字典。单条画像却直接把 raw 字典传入 SQLite `identity_counts`，得到 `ProgrammingError: type 'dict' is not supported`。同样适用于 hwid 标记。
- 最小修复是在入口校验 cli/page/meta/privacy 等结构，同时让画像读取层兼容已经保存的旧记录。身份计数统一使用经过验证的指纹文本，缺失标记归为无有效身份。仅新增入口校验无法恢复已有坏记录的可读性。
- 验收需要覆盖 cli 为缺失/null/数组/对象，fpid/hwid 为缺失标记/标量/正常哈希，历史坏记录与正常记录混合分页，所有管理读取应返回可解释结果。若拒绝新坏结构，应返回 400 并记录 bad_body。

#### RC-02 · P1 · 聚合版本迁移会删除已清理 raw 的历史聚合

- 状态为内存 SQLite 原逻辑已复现。远端是否存在旧 aggregate_schema、缺失 meta、历史恢复库尚待检查。
- 位置为 `db.py:181–213`，特别是 `db.py:189–205`，原始清理在 `db.py:873–939`。
- 版本不一致或 meta 缺失时，initialize 先清空所有 `facet_daily` 与 `facet_k_daily`，再从尚存的 `facet JOIN visit` 重建。已经 prune 的日期只剩永久聚合，因此会永久消失。
- 复现结果为插入 100 天前记录 → prune(90) → facet_daily 剩 2 行 → 将 aggregate_schema 改为 1 → initialize → facet_daily 变为 0 行。
- 最小修复是显式区分首次建立聚合与已有永久聚合升级。迁移只能针对可重建日期重算，保留已经清理 raw 的历史。对无法无损升级的版本保留旧表或在复制库上迁移，迁移失败不能提交清空结果。
- 验收必须包含一部分日期有 raw、一部分日期只有永久聚合、meta 缺失、迁移重复执行、迁移中失败、恢复备份后再次启动，核对两张聚合表的日期和计数。

#### RC-03 · P2 · 日期删除无法删除已 prune 的历史聚合

- 状态为内存 SQLite 已复现，属于现有明确编码行为与管理操作覆盖范围的问题。
- 位置为 `db.py:798–823`、`app.py:458–469`。`db.py:817–819` 注释明确保留只有永久聚合的日期。
- delete_range 先从 visit 查询存在 raw 的日期，再仅删除这些日期的聚合。如果日期范围已全部 prune，会返回 deleted=0，但 IP、指纹等历史维度仍可从永久聚合检索。
- 复现结果为 prune 后对同一天调用 delete_range，返回 0，仍保留 2 条 facet_daily。
- 最小修复是将“删除该日期范围数据”的操作扩展到范围内两张聚合表，并在结果中报告 raw、facet 和聚合各删除多少行。若产品需要保留独立的原始记录删除功能，界面必须明确其操作范围，并提供真正可清理历史聚合的路径。
- 验收覆盖仅 raw、仅聚合、混合日期、空范围、重复删除，确保指定日期范围清空且范围外不变。删除单条原始访问时现有代码会扣减对应聚合，UI 文案也应与之匹配。

#### RC-04 · P2 · stuck 过滤匹配 JSON 键名，空数组也会被当成超时

- 状态为原查询已复现。
- 位置为 `db.py:589–592`。
- 当前使用 `v.raw LIKE '%"stuck"%'`。只要采集器正常输出 `meta.stuck=[]`，记录就会命中“仅 stuck”过滤，无法筛出真实超时探针。
- 最小修复是检查 meta.stuck 的数组类型与长度，或在列投影保存布尔 has_stuck 并兼容旧 raw。采用 SQLite JSON 函数前应在实际打包 SQLite 版本验证支持。
- 验收输入应包括键缺失、[]、["webgpu"]、字符串、null 和其他字段内容含 stuck，只有实际非空探针列表命中。

#### RC-05 · P2 · ETag 跨域结果不可读，探针含义与浏览器缓存检测存在偏差

- 状态为静态已证实，浏览器实测交由采集端报告与远端验收整合。
- 位置为 `app.py:62–69`、`app.py:291–308`、`db.py:269–290`。
- 允许的跨域响应没有 `Access-Control-Expose-Headers`，浏览器 JS 无法读取 ETag、X-Etag-Seen。若采集器依赖这些字段，DevTools 可见 200 仍不能证明脚本获得数据。
- ETag 由 IP、UA、Accept-Language 确定性计算，seen_before 来自服务器数据库，所以相同 NAT 出口、UA、语言的其他浏览器也能命中。它表达的是服务器近 30 天看到同组合，无法独立证明此浏览器保留缓存标识。
- `/v1/etag` 还会在无 Origin、无 collect 限流的请求上写 etag_seen 和 etag_daily，公开写入负载绕过 collect 的全局上限。
- 最小修复先暴露实际需要的响应头，明确显示“同出口请求组合回访”之类可核对含义。若要验证缓存，应建立服务端随机缓存 token 与实际 If-None-Match 的证据路径，并核实跨域缓存、重验证与隐私策略。所有会写库的公开辅助端点需共享有界限流。
- 验收要求在真实博客域名的浏览器控制台读取结果，分别测试首次、同浏览器重复、新浏览器、同 NAT、禁缓存、跨域重验证和超限，不能只用 curl 看到头便判成功。

#### RC-06 · P2 · Team Cymru 解析器从不查询 ASN 名称记录

- 状态为静态代码与官方文档已证实。
- 位置为 `netlookup.py:78–106`，特别是 `netlookup.py:101`，上游选择在 `collector.py:127–136`。
- origin/ origin6 TXT 正常只有 ASN、prefix、country、registry、allocated 五列。代码读取第六列作为 org，所以正常兜底响应 org 总为空，随后画像的运营商与机房关键词分类失去依据。
- 最小修复是在缺少本地 ASN/org 且 origin 返回 ASN 时，按 ASN 查询并缓存 `AS<number>.asn.cymru.com`。也可继续只采用可靠的本地 org，明确将 Cymru 降为 ASN 数字兜底。需要保留整个请求有界耗时与负缓存。
- 多个 origin ASN 的返回也不应静默选第一个后声称唯一归属。保存原始集合或说明选取规则。
- ASN 国家和 prefix 国家是注册信息。`collector.py:136` 用 IP 地理国家补 ASN country 会把不同来源混为同一语义，建议分别保存或保留空值并记录来源。
- 验收使用官方五列响应、多 ASN、NXDOMAIN、超时、本地仅 ASN/仅 org 等夹具，核对 org 来源和失败降级。[Team Cymru 官方格式](https://www.team-cymru.com/ip-asn-mapping)

#### RC-07 · P2 · 时间校验与落库使用不同解析器

- 状态为函数级已复现。
- 位置为 `timeutil.py:21–29` 与 `collector.py:219–220`，调用入口为 `app.py:235–243`。
- parse_iso 明确接受小写 z，build_record 只替换大写 Z。合法通过校验的当前时间字符串若以小写 z 结束，后续落库抛 ValueError，collect 异常分支返回 internal 500。
- 最小修复复用 parse_iso 或将已解析 datetime 传到投影，不要二次实现时间合同。
- 验收覆盖 Z、z、正负偏移、小数秒、无偏移、无效时间，校验成功的时间必须能完成投影和入库。

#### RC-08 · P2 · 配置读取每次写盘，CLI 与服务可能竞争固定临时文件

- 状态为静态已证实竞态路径，实际并发故障频率待远端复核。
- 位置为 `config.py:49–85`、`config.py:99–111`、`cli.py:55`、`app.py:507–512`。
- Settings.load 每次都保存整个配置，临时路径始终是 config.json.tmp。每日 prune、update-geo、serve 初始化和后台修改保留期可能同时读旧内容、覆盖彼此临时文件并执行 replace，造成更新丢失或 FileNotFound/PermissionError。
- 即使只读的 prune --dry-run 也会写配置。单个替换原子性不能覆盖多个进程的完整读改写周期。
- 最小修复让正常 load 只读，只在初始化或真实配置变更时保存，保存使用唯一临时文件与跨进程锁，持锁期间重读并更新本次变更字段。替换失败时保留完整旧配置。
- 验收并行运行保留期更新、prune --dry-run、update-geo，确认配置始终可解析、保留期最终值准确、无残留临时文件冲突。不得在生产库做破坏性并发测试。

#### RC-09 · P2 · 限流拒绝路径仍可放大内存和 SQLite 写入

- 状态为静态路径已证实，实际承载量须远端隔离压测。
- 位置为 `security.py:46–65`、`app.py:190–195`、`db.py:261–267`。ETag 辅助写入见 RC-05。
- RateLimiter 在检查全局已超限之前仍为每个新 IP/UA 摘要加入 _keys。每条被拒绝请求还单独插入 drop_event，攻击流量仍可持续竞争 SQLite 单写者与磁盘。
- 最小修复是全局拒绝后避免新增 per-key 状态，对拒绝计数按分钟和原因进行内存有界聚合并批量落盘。设置明确的状态容量，维持必要可观测性。边缘限流与应用内限流应同时核对。
- 验收在测试环境达到全局上限后继续轮换 UA，确认 key 数量、drop 记录写入速率、内存和数据库体积均有上界，正常管理读取和已有可信流量的失败模式清楚。

#### RC-10 · P2 · GeoIP 更新在发布前缺少数据库有效性验证

- 状态为静态已证实。Windows MMDB 打开状态下替换的实际结果待远端验证。
- 位置为 `geodownload.py:22–27`、`geodownload.py:40–55`、`geo.py:19–37`。`scripts/update-geo.ps1` 已经提供停服务、更新、恢复服务的正确入口。
- 下载仅验证 gzip 能解压，随后直接 tmp.replace(target)。一个能解压但非有效 MMDB 的响应会覆盖原库，并在下次启动仅记录加载失败。没有版本/日期/库类型探测与回滚。
- 最小修复在替换前用 maxminddb 打开新文件并检查 metadata、库类型、build_epoch，再执行小量已知格式查询。使用唯一临时文件，失败保留旧库。维护页暴露已加载库日期和状态，更新后重启加载。
- 验收覆盖坏 gzip、有效 gzip 但无效 MMDB、错误库类型、无磁盘空间、断网、同月未发布、并发更新和已打开文件，旧库始终可用。优先复用现有 stop/update/start 脚本。

#### RC-11 · P2 · 部署发布缺少可验证版本、失败回滚和严格健康检查

- 状态为脚本行为已证实，实际远端安装状态未读取。
- 位置为 `scripts/build.ps1:26–41`、`deploy/install.ps1:18–43`、`deploy/install.ps1:79–93`、`deploy/install.ps1:106–148`、`radishcloud.spec`。
- 构建使用未冻结的 pnpm install、uv sync，未生成源提交/构建号/静态资源清单/产物校验信息。WinSW 通过 latest 或 alpha 下载，无固定校验。
- 更新在服务 stop 后固定等 2 秒便覆盖正在使用的 exe，没有核实进程退出，也没有备份旧 exe 后自动回退。移除服务后再重装，任何中间失败可能造成服务不可用。
- ACL 第一条命令失败未单独检查，第二条失败也仅 warning。安装最终只判断服务 Running 与端口存在，未请求应用 API 核对版本/数据库初始化，也未校验端口监听地址与 PID 是否属于目标服务。
- 最小修复固定 lockfile 安装与 WinSW 版本/校验，生成含源提交、前端资源 hash、exe hash 的发布清单。更新前做 SQLite 一致性备份和旧产物备份，等待服务进程完全退出后替换，失败自动恢复。验证回环绑定、进程归属、管理 meta/maintenance、实际公共采集合同后才报告成功。
- 验收在复制环境模拟停服超时、exe 被占用、下载失败、ACL 失败、数据库迁移失败、端口被其他进程占用与应用返回 500，确认安装返回失败并恢复原服务。

#### RC-12 · P3 · 数据来源、永久保留和运维可观测性缺少统一表示

- 状态为静态已证实，具体人类可读文案在前端专项笔记中展开。
- `collector.py:99–165` 合并 CF 头、DB-IP、手工时区表和 Cymru 后只保留最终 srv 值。`frontend/src/views/MirrorView.vue:124` 把 srv.asn 统一标为 Team Cymru，但本地 ASN 快路径经常根本不查 Cymru。
- `geodata.py:315–336` 仅用城市名/地区名查表，缺少国家作用域。原函数已复现 CA/Ontario/London 被赋 Europe/London。时区和 regionCode 应标推导来源与覆盖范围，城市同名需要国家+行政区消歧。跨国 CF/DB-IP 字段合并还需检测一致性。
- 90 天只作用于 raw visit/facet/drop，facet_daily/facet_k_daily 与 etag_daily 永久保留，且聚合中包含 IP、fpid 等高基数标识。管理界面应明确原始保留期、历史聚合保留范围，并提供历史清理能力。总览基于仍保留的 visit，而分布基于永久聚合，全部时间两页数字可能不同。
- 维护接口现有版本只有固定 0.1.0，没有构建 hash、已加载 GeoIP 元信息、采集器版本分布、字段缺失/timeout/error比例、端到端延迟与服务依赖状态。这些字段可以在现有 maintenance/meta 中增量补充。
- 最小修复在现有 srv 或 meta 增加紧凑 provenance 字典，记录字段来源、推导规则版本和数据库版本。保持原有字段值与接口兼容，不需要拆成多个微服务。

### 架构改进顺序

1. 优先修复 RC-01 和 RC-02，以及前端专项报告中的错误删除目标与 optout 响应合同。先恢复“每条已收记录都能解释、删除/迁移不会误伤”的基础。
2. 统一输入校验、缺失标记、时间和身份字段规范。入口、列投影、画像计数与历史读取共用现有标准化逻辑。
3. 定义删除与保留期合同，完成仅有永久聚合日期的清理路径，建立复制库迁移与恢复验证。
4. 为已有规则画像补来源和证据置信范围。沿用单体 FastAPI、纯规则 mirror、SQLite 与 Vue，先整理 app/db 内部职责和共享纯函数。
5. 修正探针真实性。区分浏览器本机信号、浏览器访问第三方的出口、CF 实测头、本地 GeoIP 推导、无法观测的握手层。JA4/TCP SYN 需要实际链路采样能力，Cloudflare Tunnel 后端不能据客户端自报将其升级为真实观测。
6. 增量加强公开辅助端点限流、拒绝统计有界性、GeoIP 更新与部署回滚。以当前规模的隔离压测结果决定是否需要后台任务或数据库升级。

### 验证记录

所有 Python 检查设置 `PYTHONDONTWRITEBYTECODE=1`。ruff 使用 no-cache，pytest 使用 no:cacheprovider。

| 命令或检查 | 结果 |
| --- | --- |
| `.\.venv\Scripts\python.exe -m pytest -p no:cacheprovider ...` | 无法启动，虚拟环境基础解释器 D:\miniconda3\python.exe 缺失 |
| `.\.venv\Scripts\ruff.exe check --no-cache src tests` | `All checks passed!` |
| 本机 Python312，加 src 与 .venv/Lib/site-packages 到 sys.path，`pytest.main(['-p','no:cacheprovider','tests/test_mirror.py'])` | `8 passed, 1 warning in 0.02s`，warning 为 Starlette/httpx 迁移提示 |
| 同解释器运行完整 pytest | TestClient/异步用例长时间无进展后中止，未取得全套结果 |
| 单独选择 registry、GeoIP 纯辅助和 ASN 跳过用例 | registry 输出通过点，异步相关阶段无进展后中止，未取得完整结果 |
| `node frontend/node_modules/vue-tsc/bin/vue-tsc.js --noEmit --incremental false -p frontend/tsconfig.app.json` | 现有依赖缺 `@volar/typescript/lib/quickstart/runTsc`，无法运行类型检查 |
| 内存 SQLite 原 build_record/build_facets/Database 复现 | stuck 空数组误命中、cli 数组批量画像异常、身份缺失字典 SQL 绑定异常、prune 后范围删除聚合残留、聚合迁移历史丢失均复现 |
| 原 parse_iso/build_record | 小写 z 校验成功但构建失败已复现 |
| 原 render_mirror/build_record/build_facets | optout 分支缺 counts 已复现，客户端仍提供指纹时 raw 与 facet 继续保留已复现 |
| 原 enrich_location | CA/Ontario/London → Europe/London 已复现 |

以下为核心内存复现方式，所有数据库状态均只存在内存。运行目录为 RadishCloud。

```python
import sys
sys.path[:0] = [
    r'D:\Users\Ray\Desktop\project\RadishCloud\src',
    r'D:\Users\Ray\Desktop\project\RadishCloud\.venv\Lib\site-packages',
]
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from radishcloud.collector import build_record, build_facets
from radishcloud.db import Database
from radishcloud.timeutil import ts_day

connection = sqlite3.connect(':memory:')
connection.row_factory = sqlite3.Row

@contextmanager
def memory_connect(self):
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise

with patch.object(Database, 'connect', memory_connect):
    database = Database(Path('audit.db'))
    database.initialize()
    old = datetime.now(UTC) - timedelta(days=100)
    payload = {
        'v': 1, 'id': 'old', 'ts': old.isoformat(),
        'cli': {'tz': 'Etc/UTC'}, 'meta': {'stuck': []},
    }
    server = {'ip': '8.8.8.8'}
    database.insert_visit(build_record(payload, server), build_facets(payload, server))
    print('stuck matches', len(database.list_visits(
        None, None, None, None, None, None, None, None, False, True
    )['items']))
    database.prune(90)
    print('range deleted', database.delete_range(ts_day(old), ts_day(old)))
    print('aggregates before migration', connection.execute(
        'SELECT COUNT(*) FROM facet_daily'
    ).fetchone()[0])
    connection.execute("UPDATE meta SET v='1' WHERE k='aggregate_schema'")
    connection.commit()
    database.initialize()
    print('aggregates after migration', connection.execute(
        'SELECT COUNT(*) FROM facet_daily'
    ).fetchone()[0])
```

预期输出依次为 stuck matches 1、range deleted 0、aggregates before migration 2、aggregates after migration 0。

### 远端 agent 必须复核的事实

- 读取部署 exe、静态资源、源码版本与 SHA256，判断本地副本能否代表已部署服务，避免按本地已修代码推断远端状态。
- 核对 WinSW 实际账户、进程、exe 路径、数据目录、服务工作目录、环境变量及日志，禁止复制或公开 config 的 hmac_secret 和 Tunnel token。
- 核对监听仅为 127.0.0.1:11451，公网 `/admin`、`/admin/api/meta`、`/admin/assets/*` 均阻断，Cloudflare host rewrite 没有把外部 Host 改成回环 Host。
- 核对 Cloudflare 实际传入 CF-Connecting-IP、CF-IPCountry、CF-Ray 和转发链，验证 IPv4/IPv6、缺头场景及信任边界。CF 的请求头重写、Workers、Pseudo IPv4、Transform Rules 只能在实际配置和请求上确认。
- 在独立测试数据目录重放当前采集器上报，确认缺失标记、cli类型、DNT/GPC、meta.stuck、proto/ch、预算裁剪、重复 id 与乱序情况均能从 collect 到列表/抽屉/画像完整读取。
- 核对生产 meta.aggregate_schema、last_prune_cutoff、raw最早日期、聚合最早日期以及两张聚合计数，先用一致性备份在复制库上测试 RC-02/RC-03。
- 识别历史 malformed cli、fpid/hwid非文本记录，制定兼容读取或定向修复，不能直接丢整行。
- 在真实博客 Origin 浏览器内验证 ETag 头可读、缓存语义、Client Hints 协商和 CORS 预检。curl 的响应成功只能验证 HTTP 层。
- 核对实际加载的 DB-IP City/ASN metadata、构建日期、更新任务及停服窗口，验证 Cymru/PTR 实际解析结果和超时。
- 核对计划任务每天 04:00 的系统时区、上次返回码与失败记录。ts_day 使用 Asia/Shanghai，日志轮转和 Windows 任务按本机时区运行，需明确当前时区一致性。
- 在隔离环境执行限流、SQLite并发写入、备份恢复和发布失败回滚演练后，才确定容量与运维参数。

### 合并时需关联的前端专项缺陷

- optout 画像返回没有 counts，`MirrorView.vue` 直接解引用计数，导致选中隐私记录时异常。这个问题由前端专项笔记提供详细修复和验收。
- `VisitDrawer.vue` 请求竞态、删除目标漂移、确认框 busy 时仍可关闭，以及“聚合不受影响”的错误文案已由前端专项 agent 检出。主报告应把删除相关问题列在优先修复顺序前部。
- 画像中的设备、内存、触摸、GPU、硬解、网络类型与代理判断必须按证据作用域描述，具体字段与反例由前端专项笔记列出。


## 前端与画像审查完整证据

审查时间为 2026-11-12。源码根目录为 `D:/Users/Ray/Desktop/project/RadishCloud`。此笔记供主审合并进远端开发 agent 的一次性交接报告。未修改产品源码、未安装依赖、未访问生产数据库。

### 已执行的验证与边界

- 静态逐行检查 `frontend/src`、`src/radishcloud/mirror.py` 和相关 API、计数、删除实现。
- 使用现有 Python 3.12 运行纯函数合成输入。解释器为 `C:/Users/Ray/AppData/Local/Programs/Python/Python312/python.exe`，以 `-B -` 从标准输入执行。脚本将 `RadishCloud/src` 和 `.venv/Lib/site-packages` 加入 `sys.path`。没有加载应用和数据库。
- 使用现有 Node.js 和 TypeScript 的 `transpileModule`，在内存 VM 中提取并运行 SFC 的原始脚本，mock Vue 的 ref/computed、路由和 API，控制 Promise 返回顺序。确认 MirrorView、VisitDrawer 旧响应覆盖新响应。此验证属于函数级运行验证，未进行真实浏览器挂载或网络请求。
- 尝试只读类型检查 `node node_modules/vue-tsc/bin/vue-tsc.js --project tsconfig.app.json --noEmit --incremental false`，现有 node_modules 缺少 `@volar/typescript/lib/quickstart/runTsc`，工具启动失败。未完成类型检查，不应将该结果写成类型错误或编译通过。
- CSS 数字来自只读脚本扫描，未执行浏览器缩放、键盘、屏幕阅读器或新截图验收。

### P1 先修复真实错误

#### F01 隐私记录的画像响应缺少必填 counts

位置为 `src/radishcloud/mirror.py:921–930`、`src/radishcloud/app.py:416–424`、`frontend/src/types.ts:133`、`frontend/src/views/MirrorView.vue:346–357`。

触发条件是任一 `meta.privacy.optout=true` 的记录。后端直接返回隐私分支对象，未补齐 `counts`，前端随即求值 `mirror.counts.total_visits` 等表达式。纯函数运行已确认返回对象中 `counts` 为缺失。模板抛错属于静态确定结果，尚未真实挂载页面。

最小修复是统一响应形状，决定隐私状态下计数的显示政策，并让 UI 对明确的隐私状态隐藏计数区域。避免拿虚构零值冒充已计算统计。验收需通过正常 API 入口打开一条隐私记录，显示隐私说明且无渲染异常，响应形状与 TS 声明一致。

#### F02 画像与详情异步响应可以串记录，删除目标随 props 漂移

位置为 `MirrorView.vue:159–176,179–211`、`VisitDrawer.vue:105–125,152–179`、`api.ts:40–57`。

函数级运行验证中，先请求 A 后请求 B，让 B 先返回，最后页面状态被 A 覆盖。MirrorView 最终 `mirror.short='A'`，VisitDrawer 最终 `visitId='B'` 而 `detail.record.id='A'`。真实 UI 中标题 ID、下载链接、当前选中项来自 B，正文来自 A。删除处理始终读取 `props.visitId`，因此用户可能依据 A 的正文删除 B。DELETE 完成后第 159 行再次读取 props，若此时切换为 C 或关闭抽屉，父级收到的 deleted 事件又会是 C 或 null。

最小修复是在各请求入口捕获不可变的 request id/query snapshot，用递增 token 或 Vue watch cleanup 判断响应仍对应当前选择。仅当前请求允许提交 data/error/loading/finally 状态。DELETE 在确认弹窗打开时固定待删除 ID，提交和完成事件使用同一值。详情未成功载入且与当前 ID 一致时，删除入口应禁用。

验收使用 mock A=200ms、B=20ms，以及请求中关闭、切换、删除三种情况。任何响应都不能改变其他记录的数据或 loading。删除请求 URL 与确认框里的 ID、deleted 事件必须完全相同。无需引入通用缓存框架或复杂全局状态机。

#### F03 从画像点击“原始记录”无法打开同一条详情

位置为 `MirrorView.vue:336–343`、`VisitsView.vue:171–179,188–194,205–210`。

“原始记录”链接跳到同一个 VisitsView 实例并修改 query，`tab` watcher 会清空 selectedId。读取 `focus` 的 `maybeOpenFocus()` 仅在 onMounted 中运行，已有实例不会重新挂载，因此 focus 留在地址栏，抽屉未打开。类似的同组件 query 导航也不会重新执行 `applyRouteFilters()`，因为其仅在第 206 行执行。当前代码仅 watch tab，未 watch focus 或查询过滤字段。

最小修复是由 route query 驱动 tab、focus、筛选，在对应 watcher 中统一解析并加载，避免另维护一份不自动同步的 route 状态。验收必须覆盖画像→原始记录、同页面变更 focus、同页面变更 ip/fpid 查询、回退导航和直接粘贴 URL，记录与筛选始终匹配 URL。MirrorView 还需 watch `route.query.id`，现有第 231 行仅 watch 日期，外部修改 id 不会更新选中画像。

#### F04 列表刷新、分页、切换筛选的响应会混在一起

位置为 `VisitsView.vue:74–101,197–202`、`MirrorView.vue:179–211`、`FacetDetailView.vue:63–105,146–153`、`DistributionView.vue:156–188`。

这些入口均无失效守卫。典型触发为加载第 2 页时更改日期/搜索条件，旧分页结果随后追加到新列表。VisitsView 的自动刷新只检查 `loading`，没有检查 `loadingMore`，第一屏有 50 条且分页中，5 秒 tick 可同时 reset，导致列表/游标顺序取决于返回时序。FacetDetailView 的搜索防抖只减少请求次数，不处理已发出请求的返回顺序。分布页切换单卡口径后立刻改变标签，失败时旧数据仍显示在新口径下，且旧单卡请求可返回到另一个分组。

最小修复为每次 reset 增加查询 generation，分页绑定同一份已提交查询快照和 cursor，旧 generation 全部丢弃。分页期间暂停自动刷新。口径标签和数据一起提交或失败回滚。清理卸载时的搜索 timer。验收采用受控延迟，覆盖搜索 A→B、时间范围改变、分页→重置、分组→口径改变，保证列表无混入、无重复，标签始终对应实际数据。

#### F05 缺失输入被写成确定的“鼠标键盘”“无差异”

位置为 `mirror.py:228–242,249–265,716–725`、`MirrorView.vue:109–112`。

纯函数验证中，空 record 返回 `input_class='鼠标键盘'`、`geo_conflict=false`。原因是 `_touch_info()` 将缺失数据归零，`conflict is False` 又把 unknown 归为 false。只有 `{screen:{w:390,h:844,dpr:3}}` 的记录会生成“设备是桌面机”和“输入是鼠标键盘”，这是没有依据的肯定陈述。

最小修复是保留 touch/hover/geo comparison 的三态值，缺失时派生字段为 null，并省略该句或显示未取得信息。仅宽度不足以定为桌面机，缺少 form/可靠 UA 时使用“设备形态未知”。验收用空 record、screen-only、unsupported/denied、明确 touch=0、有触控但无 hover，逐一确认未知不会变成否定或默认设备类型。

#### F06 codec 名称出现就声称硬解，负面值同样命中

位置为 `mirror.py:680–687` 和 `tests/test_mirror.py:37,71–103`。

纯函数验证输入 `{'cli':{'codecs':{'hevc':False,'av01':False}}}`，输出“HEVC / AV1 都能硬解”。当前做法只将所有键值串起来搜索名称，既没检查成功值，也没有硬件解码证据。

最小修复是按实际 collector 合同解释明确的成功值，将普通播放能力写成“报告支持 HEVC / AV1 播放”。只有采集到可解释的硬件/功耗效率信息时才使用限定文案。验收应包含 false/空字符串/unsupported、只支持一种、列表式旧记录和含完整 MIME 类型的记录。现有测试和快照也需纠正，避免继续固化误述。

#### F07 显卡泛化 renderer 被当作硬件型号

位置为 `mirror.py:335–361,823–825`、`MirrorView.vue:73–74,98–104`。

纯函数验证 `webgl.renderer='WebKit WebGL'` 会生成“显卡 WebKit WebGL”。`WebGL renderer`、`unmaskedRenderer`、`WebGPU architecture` 的来源和可靠性在派生结果中丢失，软件渲染器与泛化字符串均可能被写成显卡硬件。

最小修复是在既有派生结构中保留最小的来源/状态信息，明确区分“浏览器报告的图形渲染器”和“可能的 GPU 型号”，识别已知泛化、软件 renderer。不能根据缺少硬件型号直接断言无显卡。验收输入 ANGLE NVIDIA、Apple、Mesa、SwiftShader、WebKit WebGL、缺 WebGL 但有 WebGPU、两者矛盾，确认正文保留原始可核对字符串并使用适当限定语。

#### F08 指纹总次数被写成访问序号及真人回头客

位置为 `mirror.py:894–902,968–971`、`db.py:638–654`。

`identity_counts` 统计当前全部保留 visit 行，没有按这条记录的时间截断。因此打开任一旧记录得到的 N 是当前库中相同值的总数，无法作为这条记录的“第 N 次出现”。相同 fpid 多次也不足以断言“属于回头客”。“硬件号”本身仍是浏览器采集值，不具备物理硬件唯一性证明。

最小修复只改文案为“当前保留记录中，相同指纹出现 N 次”，把 hwid 展示为“设备特征标识”并保留技术键用于核对。需要真正的历史序号时再扩展查询，本轮无需为文案另建身份系统。验收同时打开同一 fpid 的早晚两条记录，两处均陈述总计口径，并在删除/保留期清理后正确说明统计范围。

### P2 按实际证据修正文案

#### F09 屏幕与 DPR 名称超出字段含义

位置为 `mirror.py:710–743,867–886`、`MirrorView.vue:75–76`。`screen_phys` 直接拼上报的 screen.w/h，DPR 直接乘 100 写为“缩放”。纯函数 screen-only 案例已确认产生 390×844、300%。对接 collector 需确认 w/h 的单位，若为 screen.width/height，则标签应为 CSS 像素屏幕尺寸。DPR 应写设备像素比，不能直接当浏览器或系统缩放百分比。保留历史 API 键也可先修显示名，避免无必要的兼容迁移。验收覆盖 DPR=1/1.25/2/3 和页面缩放，不声称量出物理尺寸或真实显示器像素。

#### F10 macOS 标准 UA 解析遗漏与 Client Hints Windows 映射

位置为 `mirror.py:268–301`。纯函数验证标准大写 `Macintosh; Intel Mac OS X ...` UA 且无 cli.os 时 os_name 为 null，原因是第 285 行在原始 ua_text 中使用小写匹配。统一小写后解析即可。Windows 第 280–283 行只将 major 19 写 11，却将 14/15 写 10。该版本阈值须按当前官方 UA-CH 文档重新核验，不能凭旧映射继续推断。验收含标准 macOS UA 与 platform-version 的版本边界，以及 client 声明和 UA/CH 不一致的输入。

#### F11 代理“可能性较高”由关键词直接产生

位置为 `mirror.py:19–63,381–395,547–559,640–658`、`MirrorView.vue:393–399`。当前只要 ASN/PTR/部分出口 ISP 中包含关键词即 strong，并直接输出代理或 VPN 可能性较高。未知文本默认成“商用线路”。语言映射把全部 zh 归 CN，zh-TW/zh-HK 在其惯常地区也可成为弱信号。时区和语言同时偏离即 medium，缺少对独立性和概率的证明。

最小修复是保留可解释事实“出口所属网络含某关键词”“系统时区与出口国有差异”，将未知网络类型留空，避免把启发式等级写成经过标定的概率。若保留语言提示应处理具体语言地区并避免直接计入代理判断。验收含台湾 zh-TW、香港 zh-HK、海外中文用户、企业云桌面、缺 ASN、关键词只在无关字段出现、分流与 IPv4/IPv6 差异。TLS/JA4 不可见的说明宜简短且对应实际服务端采集能力。

#### F12 来源名、摘要、时间与缺失状态仍有事实偏差

- `MirrorView.vue:122–124` 将 ASN 固定标为 Team Cymru，但 `collector.py:127–129` 优先使用 DB-IP 的 ASN。应显示真实来源或只标 ASN 数据，验收两条不同来源记录。
- `VisitDrawer.vue:257–258` 将 IP 地理时区优先显示为“时区”，系统时区被遮蔽。分开标为出口地理时区和浏览器系统时区，验收二者不同时均能读出。
- `mirror.py:210–225,747` 无 offset/tz 时回退 ts.hour 并称“本地时间”。纯函数仅有 UTC ts 会得到 local_hour='中午 12 点'。未知客户端时区应返回 null，验收仅 srv.ts 的记录无本地时间推断。
- `VisitDrawer.vue:375` 声称“聚合表 facet_daily 不受影响”，但 `db.py:783–793` 确实扣减并清理聚合。应与实际删除语义一致。
- `MirrorView.vue:408` 固定“六句话”，后端还可包含 bot/privacy，数量不固定。直接改为“访问解读”并移除装饰编号。
- `mirror.py:993–1003` 将 full 限制在 400 字并跳过整句，而 UI `MirrorView.vue:329,334`、`VisitDrawer.vue:299` 称“完整叙述/复制文案”。保留现有 API 长度合同的最小修复是改称“短文案”，另让 parts 显示所有事实，避免承诺完整。
- `App.vue:119–138` 服务运行、127.0.0.1:11451、仅回环、默认 total=124 均硬编码，meta 请求失败也看起来正常。`App.vue:61` 吞掉 meta 错误，分布页 `DistributionView.vue:210–216` 又以“parent handled”吞掉错误，可能长时间显示空分组和假默认值。至少展示元信息加载失败与重试，把未知状态显示为未知，标题使用动态探测项数。
- 电池在 `registry.py:129` 已定义，mirror.py 完全未消费 battery。应先确认 collector 历史数据形状，再将电量/充电状态/不支持/拒绝等转为人类可读条目。不要从无 battery 字段推断台式机，充电或电池缺失均不足以确定设备形态。

### P2 可读性、可访问性与 CSS 的最小改造

#### F13 信息密度与截断妨碍读取核心证据

`styles.css` 有 5,182 行，扫描到 232 处固定 px 字号，其中 200 处不超过 12px。画像区第 2362–3037 行有 35 处固定 px 字号，31 处不超过 12px，23 处低于 10px。主标题另用 22–31px 的 clamp，见 2589–2595 行。与之相邻的正文 11px（2602）、叙述 11.5px（2882）、依据 7.5px（2897/2906）、派生标签 7.5px（2941）、派生值 9.5px（2948）、技术键 6.5px（2959），比例失衡。

`proxy-signal-body > strong` 第 2779–2784 行和 `.derived-item > strong` 第 2944–2951 行固定单行省略，模板第 387、446 行没有 title 或展开入口。显卡型号、ASN/PTR、多出口值最容易变成用户无法完整读出的关键证据。

最小改造是在既有 MirrorView 中保留简短标题与一段摘要，按网络/设备/浏览器/隐私分节显示事实，技术证据通过原生 details 展开。让主正文和数值采用明确一致的可读字号，证据与长字符串允许换行。删除重复出现的同一设备/GPU/计数，不再同时维护大标题拼串、summary、full、parts、平铺 derived 五种同屏叙述。

验收用现有 profile 场景和极长 GPU/PTR，在 1440/1024/390px、浏览器 200% 缩放下完整读取主要信息，无横向溢出。新增或调整字号的具体基准属于设计决策，应由开发在交付时明确说明。

#### F14 对比度与键盘操作

CSS 变量浅色 `--faint=#929292` 位于第 26 行，白色 surface 下计算对比度约 3.11，surface-2 下约 2.90。深色 `--faint=#6f6f6f`（第 56 行）、surface=#0e0e0e（第 50 行）约 3.84。画像标签/证据大多采用 faint 且字体远低于大字标准。这里是代码色值计算，尚未实际取屏渲染像素。

`VisitDrawer.vue:194`、`AppModal.vue:55` 声明 aria-modal，却没有入场焦点、焦点约束、背景 inert、关闭后焦点归还。键盘可留在背景；AppModal busy 时仍能 Escape、蒙层或右上角关闭（29/54/61），与禁用取消按钮行为不一致。VisitDrawer 的 deleteOpen 也不随 visitId=null 清除，关闭抽屉后确认框仍可能存在。

`VisitsView.vue:229–249`、`DistributionView.vue:262–278` 使用 tab 角色但没有方向键、Home/End、tabindex 管理、tabpanel 关联。`VisitsView.vue:292–299` 和 `FacetDetailView.vue:255–259` 的搜索 label 没有有效文字，图标/占位文字未提供稳定命名。RangePicker、统计模式、自动刷新按钮缺少可访问的 pressed/checked 状态。`TrendChart.vue:125–128` 只有泛化 aria-label，逐日数值仅鼠标悬停可读。

最小修复采用一处共享弹窗焦点逻辑，统一 drawer/modal 的焦点生命周期和关闭政策。简单双按钮切换可改用 group+aria-pressed，避免假 tab 语义。搜索补明确 label。图表补可展开数据表或文字列表。验收全程仅键盘，焦点可见、顺序稳定，确认框打开时背景不可操作，关闭返回触发位置，屏幕阅读器可读搜索名称及当前选中状态。

#### F15 控制改造范围，避免为了拆分而拆分

静态扫描未发现大量同选择器互相覆盖的追加补丁。顶层精确重复主要为 `.mirror-missing`（2819、2964）和 `.system-card`（4108、4441），分别声明 padding 与 margin，当前均为互补样式。因此不能以“CSS 大量重复覆盖”为既成事实要求全盘重写。

可复用处应只做有明确收益的提取。`VisitDrawer.vue:71–94` 每个 group/row 重复 flatMap/find 定义，已有 `stores/meta.ts:10–20,46–54` 的索引与 facetDef/groupOf 可复用。画像区样式第 2362–3037 行可迁入画像组件附近，并复用已有 card、标题、按钮、字段容器。优先修复请求生命周期和路由状态单一来源，再根据新的事实分节结果提取一个仅展示的画像组件，供抽屉与画像页复用。保留 API 模块和现有 Vue/Router 技术栈，避免额外引入全局缓存、规则插件系统、复杂 schema 渲染器或设计系统工程。

建议远端执行顺序为 F01–F04 保证正确记录与交互，F05–F12 修正事实和文案，F13–F14 完成可读性与键盘验收，最后仅做 F15 中直接降低重复维护成本的整理。类型检查与真实浏览器验收仍需在依赖完整的远端环境完成。
