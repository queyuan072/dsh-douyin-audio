# HANDOFF —— dsh-douyin · 下一轮接手唯一入口

> 2026-11-05 更新（1.5.0 轮收尾）。新会话只读这一份即可接手；本文件取代 2026-11-04 版，旧结论（「通知接口未打通」「默认 /messages」）一律作废。
> 深读顺序：**`docs/notice-api.md`**（通知接口权威结构，已从被 ignore 的 `_diag/` 挪进版本库）→ `_diag/reviews/silent-failures-verify.md`（复核判定，本地残留）→ `_diag/INTERRUPT-STATE.md`（中断现场/残局记录，本地残留）。

## 0. 2026-11-25 复检（工作区曾被清空后的恢复记录）

- 本地仓库与插件曾随工作区清空一起消失。恢复路径：从 **gitcode**（GitHub 当时不可达）克隆 → `dsh plugin --profile desktop add 'file:D:/大肥鱼/工作区/dsh-douyin'` → 安装副本里 `node selfcheck.mjs`（EXIT=0、17 工具）。
- 🔴 **工具名冲突会让整个插件不激活（2026-11-26 实录）**：`dsh-douyin-scroll`（单工具老插件）与本插件都注册 `douyin_scroll`，DSH 全局工具名唯一 → 本插件注册时抛 `tool "douyin_scroll" is already registered`，于是**整个插件被标异常**、其余 16 个工具一起不生效（表现为 `douyin.log` 从不被写、`apply` 没跑）。排查顺序：插件页看红字原因 → 确认同名工具来自哪个插件 → 卸掉其一。本机已卸 `dsh-douyin-scroll`，保留本插件（功能是超集）。
- ⚠️ 半途踩过的坑：**直接把目录拷进 profile 的 node_modules 不够** —— 那只建了普通目录，没进 `node_modules/.modules.yaml`，DSH 加载器不认，工具不会出现；必须走 pnpm（`dsh plugin ... add`）注册。对照证据：能加载的 `dsh-cookie-guard` 是 pnpm junction 且在 .modules.yaml 里。
- `_diag/notes-probe/notice-schema.md` 原版在原清空中丢失（根因：`_diag/` 被 `.gitignore` 忽略）。已按代码实测注释**重建**并挪到被跟踪的 `docs/notice-api.md`（标题标明「重建版」，冲突以代码为准）。

## 1. 现状表

| 项 | 值 | 来源 |
| --- | --- | --- |
| 版本 | **1.5.0**（已提交 `83f64a2`） | package.json:3 |
| 工具数 | **17**；本轮实跑 `node selfcheck.mjs` EXIT=0、「✓ 预检通过：17 个工具」 | selfcheck 实测 |
| 双远端 | `origin`=github.com:queyuan072/dsh-douyin-audio；`gitcode`=**gitcode.com** 同名仓库（旧档写「AtomGit」与 remote URL 不符，以 URL 为准） | git remote -v |
| npm | 停在 **1.2.3**（沿用旧档，本轮未联网复核） | 旧 HANDOFF §1 |
| tag | v1.2.0 ~ **v1.5.0** 已打 | git tag -l |
| 工作树 | 干净（HEAD=`83f64a2`，1.5.0 已发布；`node selfcheck.mjs` 复检 EXIT=0 / 17 工具） | git status / selfcheck |

## 1.5.1 视频/图文详情改走接口（免验证码）

- **病灶**：`video` / `note` 走 Playwright + Edge，被抖音「验证码中间页」拦死（无头、可见窗口都拦；`verifyWait` 等满也过不去）。而 `notes` 走纯 HTTP 一直正常 —— 说明问题在浏览器链路，不在插件。
- **实测结论（本机 cookie）**：
  - `/aweme/v1/web/aweme/detail/` → **403** `Blocked by ArgusSecurityPlugin Uifid Not Found`（单条详情接口要 uifid，走不通）
  - `/aweme/v1/web/multi/aweme/detail/?aweme_ids=[<id>]&…` → **status_code=0 + 真实数据，不需要任何签名**
- **实现**：`scripts/douyin_read.py` 新增 `AWEME_API_PATH`/`AWEME_API_QS`、`_aweme_id_of`（短链先 `_resolve_short_url` 再取 id）、`_aweme_api_fetch`、`_aweme_item`、`_api_item_or_none`；`run()` 里 `video`/`note` **接口优先**，任何一类失败都回落浏览器（老行为），CLI 新增 `--no-api` 强制浏览器。
- **诚实回报**：条目里 `resolvedBy: "api"|"browser"`；顶层 `browser: "http"` 表示本次没开浏览器。
- **真机实测**：`douyin_video` 0.72s、`douyin_note` 0.39s（图文 6 张图），均 `browser: http`，字段与页面一致（点赞 6750 / 评论 823 / 分享 1304 / 收藏 3393，发布时间 2025-07-24 21:47:49）。
- **热榜同样接口化（同轮）**：`/aweme/v1/web/hot/search/list/` 实测 `status_code=0` + 51 条 `word_list`，**免签名**；`cmd_hot` 改为接口优先（`_hot_api_items`），名次用 `position`、置顶条目无 position 时按序号回退并去重，热度 `hot_value` 格式化成亿/万。真机：`douyin_hot` 0.4s、`browser: http`、名次 1..5。
- **搜索探过了、没走通**：`/aweme/v1/web/general/search/single/` 与 `/aweme/v1/web/search/item/` 都返回 `status_code=0` 但 **`items/aweme_list` 为空** —— 说明仍需 a_bogus 类签名，故 `search` 保持浏览器路径。
- ⚠️ **仍走浏览器、仍可能被验证码拦**：`search` / `comments` / `messages`（这三个还没接口化；comments 与 search 同族，通常也要签名）。
## 2. 本轮成果

### 2.1 通知接口已打通（本轮最大成果）

- `douyin_notes` 弃「抓不存在的通知页」旧路线，改**纯 HTTP 直连** `GET /aweme/v1/web/notice/?…&notice_group=<GROUP>`，不开浏览器。三要点：参数名是 **`notice_group` 不是 `notice_type`**（用错恒空）；**完全不需要 a_bogus / msToken 等任何签名**；数据在 **`notice_list_v2`**（`notice_list` 恒为空数组）。
- 落点：`scripts/douyin_read.py` 的 `cmd_notes` + `_notice_api_fetch`（douyin_read.py:1888-1905：分组遍历 + `nid` 去重、v2 空才退 v1、错误码 0/5/8 分明）；工具描述见 index.js:2191（未支持的类型只带类型号、不猜字段）。
- **权威结构说明 = `docs/notice-api.md`**（请求药方、type 31/33 字段路径、已验证/未验证清单）。原放在 `_diag/` 被 gitignore 掉、随工作区清空丢失，2026-11-25 已按代码重建并挪进版本库；与代码冲突时以 `scripts/douyin_read.py` 为准。
- 运营注意：`/notice/count/` 的非零分组号是**动态的**（同账号两次采样都可能不同），必须现取：count>0 的 group + 960/700/401/2 兜底（notice-schema.md §2）。
- 样本来源：宿主浏览器打开通知弹层抓包——沙箱内拿不到（原因见 §3）。

### 2.2 静默失败 15 条：复核判定 + 处理结果

复核（silent-failures-verify.md；基准 `git archive HEAD@e696b15` 快照、三问法、立场=假设报告有错）：**15 条没有整条误判；#13 主论点误判（`resolve(null)` 只是内层 code 变量，runViaCmd 返回恒为对象）；属实 6（含 2 潜伏）、部分属实 9；#9/#10 的触发场景（传错 --cookies）在插件工具链路上不可达**。**结论：复核价值在定级校正而非推翻，没有任何已落改动需要回退**（INTERRUPT-STATE.md §8.2 同判定）。

| # | 复核判定 | 本轮处理（行号 = 本轮实测 grep） |
| --- | --- | --- |
| 1 时长未知回退整段解码 | 部分属实 | ✅ 盲切循环 + `durationUnknown`（transcribe-final-verify.md §1，broken.mp4 实测 exit 1） |
| 2 分片失败吞成空串 | **属实** | ✅ 信封 `chunksFailed/failedRanges/failedSeconds/emptySeconds` + ≥1/3 闸门（同上 §2） |
| 3 config set 丢 saveCfg | **属实** | ✅ 检查写盘结果（index.js:2725） |
| 4 NO_AUDIO 标记过不了 JS | 部分属实（后果放大） | ✅ parseManifest 解析标记 → `noAudio`/`audioUnknown` 两义分开（index.js:316-354、1718） |
| 5 ffmpeg 缺失误报「含音轨」 | 部分属实（后果放大） | ✅ manifest 显式 `# AUDIO_UNKNOWN`，绝不冒充（douyin_scroller.py:1074） |
| 6 window 登录崩溃 → poll 永远 waiting | **属实** | ✅ window 分支传 `--state-dir`（index.js:2340-2343） |
| 7 unlike 计数读不到假成功 | 部分属实 | ✅ 读不到计数 → 不点击 → `state=uncertain`（douyin_action.py:870-874）；按钮形态真机频率未核实 |
| 8 runAction 不校验退出码 | 部分属实 | ✅ 双闸对齐 runRead（index.js:2255-2257） |
| 9 cookie 游客态无标注 | 部分属实（触发面不可达） | ✅ 信封带 `cookie:{guest,cookieCount,injected?,note?}`（douyin_read.py:1115-1125） |
| 10 fetch 丢 --cookies 无声 | 部分属实（触发面不可达） | ✅ 路径不存在 → 警告 + `cookieNote`（douyin_fetch.py:830-836） |
| 11 duty.json 损坏当没跑过 | 部分属实 | ✅ `stateReadError`（lib/duty.mjs:206） |
| 12 快捷方式扫描吞错误 | **属实** | ✅ 各失败出口带 note（index.js:212-238） |
| 13 runViaCmd resolve(null) | **主论点误判** | 只修真问题：超时 taskkill /T /F 杀进程树（lib/runner.mjs:98-99）；outFile 残留清理未核实 |
| 14 truncated 兜底撒谎 | **属实（潜伏）** | ✅ 脚本没回报 → `null` + `truncateNote`「未知」，不假装完整（index.js:2022-2029）；selfcheck.mjs 断言同步改（+7/−4，1263-1274）并实测通过 |
| 15 setup 猜 installed | **属实（潜伏）** | ✅ action 缺失 → `unknown`（index.js:1902-1911） |

另修：manifest 写失败不再吞——`_append_manifest` 抛 `ManifestWriteError` 终止整次运行（douyin_scroller.py:209-215）；fetch 侧接 `stats_out`（douyin_fetch.py:945），<1/3 丢片对 fetch 也可见。
复核 §四 新挖 6 点的落地状态：manifest 写失败、cookie 标注两条已修；**lib/state.mjs 本轮零改动 → loadCfg 幽灵重置（其 §四.1）确认未修**；fetch 成功后 errors 蒸发、runViaCmd outFile 残留、spawnLoginBg 200ms 乐观判定三项未核实。

### 2.3 转写 P1 修复（已验收）

- P1-1（时长未知不再整段一次解码）/ P1-2（分片失败进信封 + ≥1/3 闸门）真修好：结论、实测数据、可复现命令都在 `_diag/transcribe-final-verify.md`。
- 7 个 Python（py_compile）+ 7 个 JS（node --check）编译全过（INTERRUPT-STATE.md §1）；selfcheck EXIT=0。

## 3. 沙箱死结（成本极高的教训，禁止重试）

- **DSH 沙箱内 Chromium 完全起不来**：Mojo IPC 需要的命名管道创建被沙箱拒绝，`--single-process` 下直接 `FATAL mojo\public\cpp\platform\platform_channel.cc:187 Check failed 拒绝访问 (0x5)`（notice-probe-notes.md §5，多轮实测）。
- 后果：**playwright 脚本与 raw CDP 在沙箱内都不可行**（同族死法：asyncio 命名管道 `PermissionError: [WinError 5]`）。沙箱子代理做不了任何浏览器真机验证——通知接口最后是在宿主浏览器抓包才打通的。
- 浏览器真机验证只有两条路：**宿主工具 `douyin_status({selftest:true})`**（300s 预算、真开浏览器、唯一免能力闸门的入口）；或宿主浏览器人工抓包。
- 别再写「沙箱里跑 Chromium/CDP」的探针，全是沉没成本。

## 4. 改完代码的固定流程（顺序固定，本轮还没跑）

1. **同步安装副本** `C:\Users\20155\.dsh\profiles\desktop\node_modules\dsh-douyin-audio\`（index.js / client.js / selfcheck.mjs / README.md / package.json / scripts\*.py / lib\*.mjs）。宿主工具跑的就是这份副本：**.py 每次现读、改完即时生效；index.js / client.js 改动要重启 DSH**。副本目录在（douyin_status 实测），是否已含本轮代码未核实——发布前整份重同步。
2. 安装副本上真机 `douyin_status({selftest:true})` 复验。
3. `node selfcheck.mjs`：必须 EXIT=0 且「**17 个工具**」。
4. `git commit` → **`git push origin main` 和 `git push gitcode main` 两个都要推** → 打 tag（本轮 `v1.5.0`）并推 tag。
- ⚠️ 沙箱写不了 `.git`（任何 git 写操作）也写不了 `C:\Users\20155\.dsh\`（含安装副本同步）→ 步骤 1/4 必须 **danger-full-access** 升级会话后做。
- npm 发版需用户提供令牌（npm 还停在 1.2.3）。

## 5. 环境事实（douyin_status + 实跑核过）

- python（playwright+sherpa 可用，3.13.13）：`C:\Users\20155\AppData\Local\Doubao\User Data\sandbox_runtime\bases\9f6d27f23933fb44a3a1c728c88a5ce4\python\python.exe`。**PATH 裸 python 是 Store 占位 stub（退出码 9009），一律用绝对路径。**
- node：`C:\Users\20155\nodejs\node-v22.23.4-win-x64\node.exe`（Test-Path 实测在）
- ffmpeg：`C:\Users\20155\.dsh\bin\ffmpeg.exe`（在）；**ffprobe 不装**（setup 只装 ffmpeg.exe，时长探测走 Duration 行兜底，silent-failures-verify.md §1）
- 模型目录：`C:\Users\20155\.dsh\models\sherpa-sense-voice\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`（在；旧档少写 `onnx-`，以此为准）
- cookie：`C:\Users\20155\.dsh\cookies\douyin_cookies.txt`（在；账号 鹊渊 / 69154390456）
- 状态目录：`C:\Users\20155\.dsh\douyin-duty\`（=`$DSH_HOME/douyin-duty`，lib/state.mjs:34-36；config.json / duty.json / login\ / videos\）
- 浏览器：仅 msedge 在（chrome/chromium/firefox/webkit 均无）
- 以上 `C:\Users\20155\.dsh\*` 在沙箱内**只读**。

## 6. 已知限制（别重复踩）

1. 通知 `general_notice` 兜底**未验证**：样本中 title/content/sender_name/schema_url 全空串（notice-schema.md §7）。
2. 通知 type 除 31/33 **无样本**；未知 type 必须显式报「未支持的类型 N」，不许猜（已按此实现）。
3. 通知**翻页语义未验证**（min_time/max_time 传 0、has_more 恒 0）；`is_mark_read=1` 已读回写未验证——只读原则下别开。
4. 转写 `failedRanges` 条目 `dur` 可能为 **null**（盲切/单片失败时有意为之），JS 消费须容忍（transcribe-final-verify.md §5b）。
5. package.json `files` 的 `scripts/*.py` **只匹配单层**：scripts 下加子目录会漏打包（package.json:37）。
6. `client.js:36` `require('react')` **依赖宿主注入 react**。
7. `vcd_toast_text` 是常驻文案（零通知时也存在、值相同），**不是诊断字段**，别拿它判成败（notice-schema.md §3）。
8. headless 可能被抖音风控拦 → `--window-offscreen`（可见窗口移屏幕外）可过（沿用旧档，本轮未复核）。

## 7. 待办（按优先级）

1. **发布流程本体**（§4 全套，最高优先）：12 文件未提交；安装副本重同步 → 真机 selftest → selfcheck（17 工具）→ 升 1.5.0 → commit → push 双远端 → tag `v1.5.0`。全程需 danger-full-access。
2. npm 发 1.5.0（需用户令牌）。
3. `douyin_transcribe` 工具描述补分片统计新字段（chunksFailed / failedRanges / durationUnknown…；字段经 `...parsed` 已透传可达，只是描述没列）。
4. 通知接口未验证项按需推进：general_notice 兜底、31/33 之外的 type 样本、翻页语义（notice-schema.md §7）。
5. 实证 `runViaCmd` 的 cmd 传参「重定向是否真能跑通」（INTERRUPT-STATE.md §4；taskkill 已修，三种传参方式的实证没做完）。
6. 复核 §四 剩余 4 点逐条核对：loadCfg 幽灵重置（确认未修）、fetch errors 蒸发、outFile 残留、spawnLoginBg 200ms（后三项未核实）。
7. 旧档小项（未复核沿用）：`--chunk` 默认是否降 20–25s；selftest 补「推荐页依赖登录」说明。

## 8. 模型 provider 现状与教训（本轮额度三连灭）

- 用户自配两家（旧档 §8，本轮未复核）：`qwen` = dashscope compatible-mode（qwen3.8-flash / qwen3.8-max-0902 / qwen3.8-omni-flash）；`zhipu` = open.bigmodel.cn（glm-5.3 / glm-5.3-flash / glm-4.5v 识图 / codegeex-4——**无工具调用**，不能当子代理；glm-5.3/4.7 不支持图片输入）。
- **现状**：本轮 qwen 403（免费额度耗尽）/ glm-5.3 429（资源包 0）/ glm-5.3-flash 429（烧完），额度三连灭把本轮打断多次，**6 个子代理中途暴毙**（各代理临死发现都汇总在 `_diag/INTERRUPT-STATE.md`；其中 index.js 六条、cookie/manifest、转写验证此后已补完，见 §2.2）。
- **教训：派活前先探测额度**——先用一次轻量调用（如 `glm_ask` 打 glm-5.3-flash）确认非 429/403 再派活；并行子代理越多额度烧得越快，死一半就留残局，恢复成本高于重派。
