# RadishCloud 后端、部署与数据契约审查笔记

审查日期为 2026-11-12。审查对象为 `D:\Users\Ray\Desktop\project\RadishCloud` 的本地副本。本文供总报告整合及远端 Windows Server 项目 agent 实施使用。

## 范围和证据边界

- 读取了 `src/radishcloud`、`tests`、`deploy`、`scripts`、相关前端调用与 README。未修改该项目的产品代码、配置和部署状态。
- 在项目及上级目录检查了适用 `AGENTS.md`，未发现额外仓库文件。会话要求使用简体中文。
- 运行了静态检查、现有画像纯函数测试及内存 SQLite 复现。对测试连接使用了 `Database.connect` 的内存适配，实际查询、投影、聚合、删除、迁移逻辑均调用原函数。
- 本机 `.venv/pyvenv.cfg` 指向缺失的 `D:\miniconda3`。通过本机已有 Python 3.12.0 与该虚拟环境已有 site-packages 完成部分验证。这个运行环境与项目原始 3.12.8 环境存在差异。
- 完整 pytest 运行在 TestClient/异步相关用例处长时间没有进展，已中止。未将其判为产品测试失败。使用临时目录创建 app 时还遇到当前沙箱 `config.json.tmp` 重命名权限错误。因此 HTTP 端到端、线程并发、Windows 服务及远端 Cloudflare 实际行为均须由远端 agent 复核。
- 当前没有已证实的 P0。下文明确区分函数级已复现、静态已证实与需远端验证的部署条件。

## 现有架构与能力

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

## 可复核问题

### RC-01 · P1 · 已保存记录类型与画像 API 不一致，可使画像页返回 500

- 状态为函数级已复现，HTTP 返回码由调用链静态确定，尚未完成远端 HTTP 复核。
- 位置为 `app.py:218–243`、`collector.py:210–217`、`collector.py:287–290`、`db.py:638–669`、`app.py:390–397`、`app.py:420–424`。
- `/v1/collect` 只严格检查 v、id、ts。`cli=[]` 会被列投影按空对象处理，但 raw 继续保存数组。随后 `identity_counts_batch` 的集合推导直接对 `record.get('cli', {})` 调用 `.get`，抛出 `AttributeError`，导致包含该记录的画像列表失败。
- 更贴近现有合同的输入为 `cli.fpid={"$":"timeout"}`。`_scalar_text` 将列表列写为字符串 `timeout`，raw 保留字典。单条画像却直接把 raw 字典传入 SQLite `identity_counts`，得到 `ProgrammingError: type 'dict' is not supported`。同样适用于 hwid 标记。
- 最小修复是在入口校验 cli/page/meta/privacy 等结构，同时让画像读取层兼容已经保存的旧记录。身份计数统一使用经过验证的指纹文本，缺失标记归为无有效身份。仅新增入口校验无法恢复已有坏记录的可读性。
- 验收需要覆盖 cli 为缺失/null/数组/对象，fpid/hwid 为缺失标记/标量/正常哈希，历史坏记录与正常记录混合分页，所有管理读取应返回可解释结果。若拒绝新坏结构，应返回 400 并记录 bad_body。

### RC-02 · P1 · 聚合版本迁移会删除已清理 raw 的历史聚合

- 状态为内存 SQLite 原逻辑已复现。远端是否存在旧 aggregate_schema、缺失 meta、历史恢复库尚待检查。
- 位置为 `db.py:181–213`，特别是 `db.py:189–205`，原始清理在 `db.py:873–939`。
- 版本不一致或 meta 缺失时，initialize 先清空所有 `facet_daily` 与 `facet_k_daily`，再从尚存的 `facet JOIN visit` 重建。已经 prune 的日期只剩永久聚合，因此会永久消失。
- 复现结果为插入 100 天前记录 → prune(90) → facet_daily 剩 2 行 → 将 aggregate_schema 改为 1 → initialize → facet_daily 变为 0 行。
- 最小修复是显式区分首次建立聚合与已有永久聚合升级。迁移只能针对可重建日期重算，保留已经清理 raw 的历史。对无法无损升级的版本保留旧表或在复制库上迁移，迁移失败不能提交清空结果。
- 验收必须包含一部分日期有 raw、一部分日期只有永久聚合、meta 缺失、迁移重复执行、迁移中失败、恢复备份后再次启动，核对两张聚合表的日期和计数。

### RC-03 · P2 · 日期删除无法删除已 prune 的历史聚合

- 状态为内存 SQLite 已复现，属于现有明确编码行为与管理操作覆盖范围的问题。
- 位置为 `db.py:798–823`、`app.py:458–469`。`db.py:817–819` 注释明确保留只有永久聚合的日期。
- delete_range 先从 visit 查询存在 raw 的日期，再仅删除这些日期的聚合。如果日期范围已全部 prune，会返回 deleted=0，但 IP、指纹等历史维度仍可从永久聚合检索。
- 复现结果为 prune 后对同一天调用 delete_range，返回 0，仍保留 2 条 facet_daily。
- 最小修复是将“删除该日期范围数据”的操作扩展到范围内两张聚合表，并在结果中报告 raw、facet 和聚合各删除多少行。若产品需要保留独立的原始记录删除功能，界面必须明确其操作范围，并提供真正可清理历史聚合的路径。
- 验收覆盖仅 raw、仅聚合、混合日期、空范围、重复删除，确保指定日期范围清空且范围外不变。删除单条原始访问时现有代码会扣减对应聚合，UI 文案也应与之匹配。

### RC-04 · P2 · stuck 过滤匹配 JSON 键名，空数组也会被当成超时

- 状态为原查询已复现。
- 位置为 `db.py:589–592`。
- 当前使用 `v.raw LIKE '%"stuck"%'`。只要采集器正常输出 `meta.stuck=[]`，记录就会命中“仅 stuck”过滤，无法筛出真实超时探针。
- 最小修复是检查 meta.stuck 的数组类型与长度，或在列投影保存布尔 has_stuck 并兼容旧 raw。采用 SQLite JSON 函数前应在实际打包 SQLite 版本验证支持。
- 验收输入应包括键缺失、[]、["webgpu"]、字符串、null 和其他字段内容含 stuck，只有实际非空探针列表命中。

### RC-05 · P2 · ETag 跨域结果不可读，探针含义与浏览器缓存检测存在偏差

- 状态为静态已证实，浏览器实测交由采集端报告与远端验收整合。
- 位置为 `app.py:62–69`、`app.py:291–308`、`db.py:269–290`。
- 允许的跨域响应没有 `Access-Control-Expose-Headers`，浏览器 JS 无法读取 ETag、X-Etag-Seen。若采集器依赖这些字段，DevTools 可见 200 仍不能证明脚本获得数据。
- ETag 由 IP、UA、Accept-Language 确定性计算，seen_before 来自服务器数据库，所以相同 NAT 出口、UA、语言的其他浏览器也能命中。它表达的是服务器近 30 天看到同组合，无法独立证明此浏览器保留缓存标识。
- `/v1/etag` 还会在无 Origin、无 collect 限流的请求上写 etag_seen 和 etag_daily，公开写入负载绕过 collect 的全局上限。
- 最小修复先暴露实际需要的响应头，明确显示“同出口请求组合回访”之类可核对含义。若要验证缓存，应建立服务端随机缓存 token 与实际 If-None-Match 的证据路径，并核实跨域缓存、重验证与隐私策略。所有会写库的公开辅助端点需共享有界限流。
- 验收要求在真实博客域名的浏览器控制台读取结果，分别测试首次、同浏览器重复、新浏览器、同 NAT、禁缓存、跨域重验证和超限，不能只用 curl 看到头便判成功。

### RC-06 · P2 · Team Cymru 解析器从不查询 ASN 名称记录

- 状态为静态代码与官方文档已证实。
- 位置为 `netlookup.py:78–106`，特别是 `netlookup.py:101`，上游选择在 `collector.py:127–136`。
- origin/ origin6 TXT 正常只有 ASN、prefix、country、registry、allocated 五列。代码读取第六列作为 org，所以正常兜底响应 org 总为空，随后画像的运营商与机房关键词分类失去依据。
- 最小修复是在缺少本地 ASN/org 且 origin 返回 ASN 时，按 ASN 查询并缓存 `AS<number>.asn.cymru.com`。也可继续只采用可靠的本地 org，明确将 Cymru 降为 ASN 数字兜底。需要保留整个请求有界耗时与负缓存。
- 多个 origin ASN 的返回也不应静默选第一个后声称唯一归属。保存原始集合或说明选取规则。
- ASN 国家和 prefix 国家是注册信息。`collector.py:136` 用 IP 地理国家补 ASN country 会把不同来源混为同一语义，建议分别保存或保留空值并记录来源。
- 验收使用官方五列响应、多 ASN、NXDOMAIN、超时、本地仅 ASN/仅 org 等夹具，核对 org 来源和失败降级。[Team Cymru 官方格式](https://www.team-cymru.com/ip-asn-mapping)

### RC-07 · P2 · 时间校验与落库使用不同解析器

- 状态为函数级已复现。
- 位置为 `timeutil.py:21–29` 与 `collector.py:219–220`，调用入口为 `app.py:235–243`。
- parse_iso 明确接受小写 z，build_record 只替换大写 Z。合法通过校验的当前时间字符串若以小写 z 结束，后续落库抛 ValueError，collect 异常分支返回 internal 500。
- 最小修复复用 parse_iso 或将已解析 datetime 传到投影，不要二次实现时间合同。
- 验收覆盖 Z、z、正负偏移、小数秒、无偏移、无效时间，校验成功的时间必须能完成投影和入库。

### RC-08 · P2 · 配置读取每次写盘，CLI 与服务可能竞争固定临时文件

- 状态为静态已证实竞态路径，实际并发故障频率待远端复核。
- 位置为 `config.py:49–85`、`config.py:99–111`、`cli.py:55`、`app.py:507–512`。
- Settings.load 每次都保存整个配置，临时路径始终是 config.json.tmp。每日 prune、update-geo、serve 初始化和后台修改保留期可能同时读旧内容、覆盖彼此临时文件并执行 replace，造成更新丢失或 FileNotFound/PermissionError。
- 即使只读的 prune --dry-run 也会写配置。单个替换原子性不能覆盖多个进程的完整读改写周期。
- 最小修复让正常 load 只读，只在初始化或真实配置变更时保存，保存使用唯一临时文件与跨进程锁，持锁期间重读并更新本次变更字段。替换失败时保留完整旧配置。
- 验收并行运行保留期更新、prune --dry-run、update-geo，确认配置始终可解析、保留期最终值准确、无残留临时文件冲突。不得在生产库做破坏性并发测试。

### RC-09 · P2 · 限流拒绝路径仍可放大内存和 SQLite 写入

- 状态为静态路径已证实，实际承载量须远端隔离压测。
- 位置为 `security.py:46–65`、`app.py:190–195`、`db.py:261–267`。ETag 辅助写入见 RC-05。
- RateLimiter 在检查全局已超限之前仍为每个新 IP/UA 摘要加入 _keys。每条被拒绝请求还单独插入 drop_event，攻击流量仍可持续竞争 SQLite 单写者与磁盘。
- 最小修复是全局拒绝后避免新增 per-key 状态，对拒绝计数按分钟和原因进行内存有界聚合并批量落盘。设置明确的状态容量，维持必要可观测性。边缘限流与应用内限流应同时核对。
- 验收在测试环境达到全局上限后继续轮换 UA，确认 key 数量、drop 记录写入速率、内存和数据库体积均有上界，正常管理读取和已有可信流量的失败模式清楚。

### RC-10 · P2 · GeoIP 更新在发布前缺少数据库有效性验证

- 状态为静态已证实。Windows MMDB 打开状态下替换的实际结果待远端验证。
- 位置为 `geodownload.py:22–27`、`geodownload.py:40–55`、`geo.py:19–37`。`scripts/update-geo.ps1` 已经提供停服务、更新、恢复服务的正确入口。
- 下载仅验证 gzip 能解压，随后直接 tmp.replace(target)。一个能解压但非有效 MMDB 的响应会覆盖原库，并在下次启动仅记录加载失败。没有版本/日期/库类型探测与回滚。
- 最小修复在替换前用 maxminddb 打开新文件并检查 metadata、库类型、build_epoch，再执行小量已知格式查询。使用唯一临时文件，失败保留旧库。维护页暴露已加载库日期和状态，更新后重启加载。
- 验收覆盖坏 gzip、有效 gzip 但无效 MMDB、错误库类型、无磁盘空间、断网、同月未发布、并发更新和已打开文件，旧库始终可用。优先复用现有 stop/update/start 脚本。

### RC-11 · P2 · 部署发布缺少可验证版本、失败回滚和严格健康检查

- 状态为脚本行为已证实，实际远端安装状态未读取。
- 位置为 `scripts/build.ps1:26–41`、`deploy/install.ps1:18–43`、`deploy/install.ps1:79–93`、`deploy/install.ps1:106–148`、`radishcloud.spec`。
- 构建使用未冻结的 pnpm install、uv sync，未生成源提交/构建号/静态资源清单/产物校验信息。WinSW 通过 latest 或 alpha 下载，无固定校验。
- 更新在服务 stop 后固定等 2 秒便覆盖正在使用的 exe，没有核实进程退出，也没有备份旧 exe 后自动回退。移除服务后再重装，任何中间失败可能造成服务不可用。
- ACL 第一条命令失败未单独检查，第二条失败也仅 warning。安装最终只判断服务 Running 与端口存在，未请求应用 API 核对版本/数据库初始化，也未校验端口监听地址与 PID 是否属于目标服务。
- 最小修复固定 lockfile 安装与 WinSW 版本/校验，生成含源提交、前端资源 hash、exe hash 的发布清单。更新前做 SQLite 一致性备份和旧产物备份，等待服务进程完全退出后替换，失败自动恢复。验证回环绑定、进程归属、管理 meta/maintenance、实际公共采集合同后才报告成功。
- 验收在复制环境模拟停服超时、exe 被占用、下载失败、ACL 失败、数据库迁移失败、端口被其他进程占用与应用返回 500，确认安装返回失败并恢复原服务。

### RC-12 · P3 · 数据来源、永久保留和运维可观测性缺少统一表示

- 状态为静态已证实，具体人类可读文案在前端专项笔记中展开。
- `collector.py:99–165` 合并 CF 头、DB-IP、手工时区表和 Cymru 后只保留最终 srv 值。`frontend/src/views/MirrorView.vue:124` 把 srv.asn 统一标为 Team Cymru，但本地 ASN 快路径经常根本不查 Cymru。
- `geodata.py:315–336` 仅用城市名/地区名查表，缺少国家作用域。原函数已复现 CA/Ontario/London 被赋 Europe/London。时区和 regionCode 应标推导来源与覆盖范围，城市同名需要国家+行政区消歧。跨国 CF/DB-IP 字段合并还需检测一致性。
- 90 天只作用于 raw visit/facet/drop，facet_daily/facet_k_daily 与 etag_daily 永久保留，且聚合中包含 IP、fpid 等高基数标识。管理界面应明确原始保留期、历史聚合保留范围，并提供历史清理能力。总览基于仍保留的 visit，而分布基于永久聚合，全部时间两页数字可能不同。
- 维护接口现有版本只有固定 0.1.0，没有构建 hash、已加载 GeoIP 元信息、采集器版本分布、字段缺失/timeout/error比例、端到端延迟与服务依赖状态。这些字段可以在现有 maintenance/meta 中增量补充。
- 最小修复在现有 srv 或 meta 增加紧凑 provenance 字典，记录字段来源、推导规则版本和数据库版本。保持原有字段值与接口兼容，不需要拆成多个微服务。

## 架构改进顺序

1. 优先修复 RC-01 和 RC-02，以及前端专项报告中的错误删除目标与 optout 响应合同。先恢复“每条已收记录都能解释、删除/迁移不会误伤”的基础。
2. 统一输入校验、缺失标记、时间和身份字段规范。入口、列投影、画像计数与历史读取共用现有标准化逻辑。
3. 定义删除与保留期合同，完成仅有永久聚合日期的清理路径，建立复制库迁移与恢复验证。
4. 为已有规则画像补来源和证据置信范围。沿用单体 FastAPI、纯规则 mirror、SQLite 与 Vue，先整理 app/db 内部职责和共享纯函数。
5. 修正探针真实性。区分浏览器本机信号、浏览器访问第三方的出口、CF 实测头、本地 GeoIP 推导、无法观测的握手层。JA4/TCP SYN 需要实际链路采样能力，Cloudflare Tunnel 后端不能据客户端自报将其升级为真实观测。
6. 增量加强公开辅助端点限流、拒绝统计有界性、GeoIP 更新与部署回滚。以当前规模的隔离压测结果决定是否需要后台任务或数据库升级。

## 验证记录

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

## 远端 agent 必须复核的事实

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

## 合并时需关联的前端专项缺陷

- optout 画像返回没有 counts，`MirrorView.vue` 直接解引用计数，导致选中隐私记录时异常。这个问题由前端专项笔记提供详细修复和验收。
- `VisitDrawer.vue` 请求竞态、删除目标漂移、确认框 busy 时仍可关闭，以及“聚合不受影响”的错误文案已由前端专项 agent 检出。主报告应把删除相关问题列在优先修复顺序前部。
- 画像中的设备、内存、触摸、GPU、硬解、网络类型与代理判断必须按证据作用域描述，具体字段与反例由前端专项笔记列出。
