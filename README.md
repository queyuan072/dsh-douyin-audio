# dsh-douyin-audio

给 DSH 用的「刷抖音 + 音频转写」插件：用 Playwright 打开抖音网页版自动下滑、逐屏截图并把视频下载到本地，再用 ffmpeg + sherpa-onnx SenseVoice 在**本机**把声音转成文字（不联网调 ASR 服务）。

另外提供 7 个**只读**查询工具：`douyin_hot` / `douyin_search` / `douyin_video` / `douyin_comments` / `douyin_note`（① 只读级），以及 `douyin_notes` / `douyin_messages`（② 通知级，读通知摘要与私信会话列表）。同样用 Playwright 打开抖音网页版读页面。全程只读——不点赞、不关注、不发评论、不发布任何内容，通知/私信这一档额外保证**不发消息、不标记已读**。

- 包名 `dsh-douyin-audio`，当前版本 `1.2.3`（见 `package.json`）
- **一行装好**：`dsh plugin --profile <你的 profile> add dsh-douyin-audio@latest` —— profile 名怎么查、tgz/源码三种装法见第 2 节
- 运行要求：Node `>=22`、DSH `>=0.1.7-rc.1`（`package.json` 的 `engines`）
- 插件对 DSH 的注入：`name = 'douyin-audio'`、`inject = ['tools']`（`index.js`）

---

## 1. 十六个工具

### 1.1 只读查询（5 个）

这五个工具共用一支脚本 `scripts/douyin_read.py`（CLI 契约见第 7.2 节），工具参数与 CLI 参数一一对应：

| 工具 | 参数 | 对映的 CLI | 返回 `items` 字段 |
| --- | --- | --- | --- |
| `douyin_hot` | `limit`(number, 1–50, 默认 20) | `hot --limit N --json` | `rank` / `title` / `hot` / `url` |
| `douyin_search` | `keyword`(string, 必填) / `limit`(number, 1–50, 默认 20) / `order`(`totalrank`\|`click`\|`pubdate`, 默认 `totalrank`) | `search --keyword K --limit N --order O --json` | `title` / `author` / `like` / `url` / `duration` |
| `douyin_video` | `url`(string, 必填, http/https) | `video --url U --json` | `title` / `author` / `desc` / `like` / `comment` / `share` / `url` / `tags[]`；顶层另有 `music`（脚本给 `{name,author}` 或 `null`，原样透传）与 `musicNote`（`music` 为 `null` 时补一句「页面未提供音乐信息（未登录时抖音不渲染音乐名）」，不编造） |
| `douyin_comments` | `url`(string, 必填, http/https) / `limit`(number, 1–50, 默认 30) | `comments --url U --limit N --json` | `user` / `text` / `like` / `time` |
| `douyin_note` | `url`(string, 必填, http/https；图文页 `https://www.douyin.com/note/<id>` 或短链 `https://v.douyin.com/xxxx/`) | `note --url U --json` | `title` / `author` / `desc` / `publishTime` / `like` / `comment` / `share` / `collect` / `images[]` |

返回的是脚本那层统一信封：成功 `{ ok: true, items: [...], elapsed: 1.2 }`，失败 `{ ok: false, error: "一句话原因", items: [] }`。插件原样回传并补一个 `exitCode`；解析时从 stdout 的**第一个** `{` 开始（脚本把进度写在 stderr），拿不到 JSON 才退化成 `{ ok: false, reason: '脚本输出不是 JSON', output: <日志尾巴> }`。超时上限：`hot` 120s、`search` 150s、`video` 150s、`comments` 180s、`note` 150s（超时 taskkill 整个进程树）；`verifyWait` > 0 时该次调用的预算再加 `verifyWait + 15` 秒。

`douyin_note` 读的是**图文**页（短链 `https://v.douyin.com/xxxx/` 常跳到 `https://www.douyin.com/note/<id>`）：页面标记是 `[data-e2e="note-detail"]` 而不是 `video-detail`，所以 `douyin_video` 拿不到它的正文，得用这个工具。返回 `title`（`document.title` 去掉 ` - 抖音`）/ `author` / `desc`（正文）/ `publishTime`（发布时间）/ `like` / `comment` / `share` / `collect`（赞、评、分享、收藏）/ `images[]`（页面里的图片地址，只收 `naturalWidth > 200` 的，滤掉头像与图标）。同样是 ① 只读闸门（`tierRead`），不点赞、不收藏、不评论。

### 1.2 通知摘要 / 私信（2 个，② 通知级）

这两个工具跟 1.1 一样走 `scripts/douyin_read.py`，同一套 `{ ok, items, elapsed }` 信封、同样的 `limit` 1–50 校验与「不夹取」策略，区别只有两点：**闸门是 `tierNotify`**（② 通知，默认**关**），以及读的是**登录后**才渲染的页面。

| 工具 | 参数 | 对映的 CLI | 返回 `items` 字段 |
| --- | --- | --- | --- |
| `douyin_notes` | `limit`(number, 1–50, 默认 20) | `notes --limit N --json` | `type` / `user` / `text` / `time` / `url` |
| `douyin_messages` | `limit`(number, 1–50, 默认 20) | `messages --limit N --json` | `user` / `lastText` / `time` / `unread` |

- `type`：按**动作句**归类，取值只有 `点赞` / `评论` / `@我的` / `关注` / `私信` / `其他`。归类规则是逐行扫关键词，认不出的归 `其他`（**不猜**，也不编造类型）。
- `unread`：整数。优先取行内的纯数字角标，其次取 `[class*="badge"]` / `[class*="unread"]` 之类的角标节点（没有数字的纯红点按 `1` 计）；读不到就是 `0`。
- 超时上限：`notes` 150s、`messages` 180s。
- 没有登录态时**不启浏览器**：脚本先查 cookie，直接返回 `{ ok: false, error: "notes: 需要登录态：没读到 cookie（<路径>）；先跑 scripts/douyin_login.py 或用 --cookies 指定", items: [] }`。
- 这两页的 URL 与 DOM **没有在本仓库验证过**（默认 `/notifications` 与 `/messages`），路径不对时用 CLI 的 `--url` 覆盖（工具层没有暴露这个参数，需要时直接跑脚本，见 7.2）。

### 1.3 刷屏 / 转写 / 自检 / 配置（原有 4 个）

| 工具 | 参数 | 行为 | 依赖 |
| --- | --- | --- | --- |
| `douyin_scroll` | `count`(number) / `delay`(number) / `headless`(boolean) / `saveAll`(boolean) | 打开 `www.douyin.com` 推荐页，下滑 N 屏、逐屏截图；`saveAll` 为真时逐屏下载视频：候选直链先按 `/tos-xxx/<token>/` 段分组，只保留与当前 `currentSrc` 属于同一条视频的候选，下载后再按 SHA256 内容哈希去重（换屏却下到上一条流会被丢掉），然后校验音轨；没有可用音轨的屏会在 manifest 里写 `# NO_AUDIO`。返回统计、退出码、工作目录，另加给「人挑」的清单 `items[]` / `totalMB` / `manifestPath`（见 1.4）。配置 `autoTranscribe` **关着时返回体里 `autoTranscribe: null`（零开销）**；开着时刷完自动转清单里最新的 1 条，结果放在 `autoTranscribe: { ok, attempted, threads, items:[{file,text,error,hasSpeech}], reason? }`，**转写失败不会让 scroll 变失败** | Python + playwright（走 Edge 通道）、ffmpeg |
| `douyin_transcribe` | `screens`(array) / `files`(array) / `modelDir`(string) / `limit`(number) | 把本地视频/音频转成文字（SenseVoice 本地推理）。三种选文件的优先级：**`screens`（按 manifest 屏号取 `videos/video_<屏号三位>.mp4`）> `files`（明确路径）> 自动**（扫**工作目录** `videos/` 下的 `mp4/m4a/wav/mp3`，按修改时间倒序取 `limit` 个，返回里 `order:"mtime-desc"`）。底层以 `--json` 调用 CLI，配置里的 `asrThreads` 透传成 `--threads`，结果原样回传并补 `order` / `screens` / `threads`。**每条 item 再补三个字段做兜底**：`screen`（从文件名 `video_<三位屏号>.mp4` 解析，认不出就是 `null`）、`title`（manifest 里该屏标题，`screen` 认不出也 `null`）、`hasSpeech`（`text` 去掉空白后长度 ≥ 2 为真）；`hasSpeech === false` 的条目再加一句 `note`：「无语音（纯 BGM 或静音），可看 title 判断内容；需要更多信息可调用 douyin_video 看 tags」。返回体顶层另有 `summary: { transcribed, empty, totalMB }`（有语音条数 / 无语音条数 / 选中文件总大小） | Python + sherpa_onnx、ffmpeg、SenseVoice 模型目录 |
| `douyin_status` | 无 | 自检：两个 Python 能力、ffmpeg、模型目录、cookie 文件、两个脚本是否存在，并报告 `stateDir`（配置/日志家）、`workDir`（产物家）、已下载视频列表、当前配置 | 无（纯检查） |
| `douyin_config` | `action`(`get`/`set`) / `key` / `value` | `get` 读出当前配置 + 状态目录；`set` 改一个键并落盘 `config.json`（布尔按 `true`/`false`，数字自动转 number；数值有底线：`count>=1`、`delay>=0`、`downloadTimeout>=30`，非法直接拒）。**`tier*` 五个能力等级键它一律拒绝**：等级只能由用户在设置页改 | 无 |

参数取值会被夹到安全区间：`count` 1–200、`delay` 0.5–30（秒）、`limit` 1–20。

### 1.4 先给清单让人挑，再按屏号转写

`douyin_scroll` 刷完会读 `%TEMP%\douyin\manifest.txt` 的每一行「屏号|标题|直链」，配上 `videos/` 里**同名屏号**的文件（`video_<屏号三位>.mp4`），给出一张清单：**屏号对文件，绝不按修改时间排序**（下载顺序和屏号顺序可以不一样）。

```json
{ "ok": true, "screens": 3,
  "items": [
    { "screen": 1, "title": "第一条视频的标题前 60 字", "file": "%TEMP%\douyin\videos\video_001.mp4", "sizeMB": 3.42, "hasFile": true },
    { "screen": 2, "title": "第二条…", "file": null, "sizeMB": 0, "hasFile": false }
  ],
  "totalMB": 3.42,
  "manifestPath": "%TEMP%\douyin\manifest.txt" }
```

`screens` 是**实际**刷到的屏数（脚本输出里的「下滑屏数」那一行，取不到就看 manifest 行数），不是入参
`count`：撞登录墙 / 验证码被提前挡下时两者会不一样，回请求值等于骗人。请求值另存在 `screensRequested`。

- `hasFile: false` / `file: null` = 这一屏没下到文件（下载失败、内容重复被跳过、或 `saveAll` 关着）。
- `title` 来自 manifest 第二列（脚本抓的页面标题签名，最长 60 字，可能为空串）。
- 挑好屏号后直接交给转写：`douyin_transcribe screens=[1,3]`，一个屏号一个文件，不会再对错。

> ⚠️ 自动模式按修改时间倒序返回，**请按每条的 source/file 或 screen 字段对照，不要按数组下标**——下标 `0` 只是「最近下载的那条」，不等于「第 1 屏」。

只读工具（1.1）**不夹取**：`limit` 越界、`order` 不在三种取值内、`url` 不是 http(s)、`keyword` 为空，都直接返回 `{ ok: false, reason: '…' }`，不会带着坏参数去跑脚本（HTTP 的 `/run` 走同一套校验）。

### 1.5 登录（2 个，基础能力，**不设等级闸门**）

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `douyin_login_start` | `mode`(`window`\|`qr`；不给就取配置 `loginMode`) | `window` = **后台派生**一个可见 Edge 窗口（同样不阻塞、stdout 重定向到 `login/login.log`，脚本侧 `--wait` 300s），立刻返回 `{ ok, started:true, mode:'window', phase:'waiting', pid, stateFile, log, hint }`，之后用 `douyin_login_poll` 看进度（cookie 落地即 `phase:'ok'`）；`qr` = **后台派生**脚本进程（不阻塞、stdout 重定向到 `login/login.log`），最多等 15s 让 `qr.png` 出现，返回 `{ ok, mode:'qr', qrPath, stateFile, imageUrl, phase, hint }` |
| `douyin_login_poll` | 无 | 读 `<状态目录>/login/state.json`，返回 `{ ok, phase, loggedIn, cookiePath, message, at, mode, stateFile, qrPath, hasQr }`。`phase` ∈ `waiting` / `scanned` / `ok` / `expired` / `error`（没有 state.json 时是 `none`），**`ok` 与 `loggedIn` 都只在 `phase === 'ok'` 时为 true** |

这两个工具**不受能力等级限制**：读不到登录态，只读/通知那些开关一个也用不上。两种模式的区别、状态文件、图片端点见第 5 节。

### 1.6 轻互动（1 个，③A 轻互动级，**默认关**）

**这是本插件唯一的写操作**：点赞 / 取消赞 / 收藏 / 取消收藏。走 `scripts/douyin_action.py`，闸门是 `tierReact`（③A，默认 `false`）。

| 工具 | 参数 | 对映的 CLI | 返回字段 |
| --- | --- | --- | --- |
| `douyin_react` | `url`(string, 必填, http/https) / `action`(`like` \| `unlike` \| `collect` \| `uncollect`, 必填) | `--url U --action like --json`，另可带 `--no-headless` / `--verify-wait N` / `--browser-channel` / `--browser-executable` | `ok` / `action` / `url` / `before` / `after` / `changed` / `state` / `needLogin` / `clicks` / `corrected`（脚本另带 `browser` / `elapsed`，插件补 `exitCode`） |

怎么判断「点上了没有」——**不靠 class、不靠 aria-label**（真机上两者都没有，只有 `data-e2e`）：

1. 只点两个真机核实过的按钮：点赞 `[data-e2e="video-player-digg"]`、收藏 `[data-e2e="video-player-collect"]`（评论 `feed-comment-icon` / 分享 `video-player-share` 只用于定位页面，不会被点）；
2. **点之前**读一次按钮 `innerText` 里的数字 → `before`；点完等 1.5–2.5 秒（必要时轮询到 6 秒）再读一次 → `after`；
3. `after > before` → 已点赞 / 已收藏（`changed: true`）；`after < before` → 取消成功；两者相等 → `state: "uncertain"`（没点中、或被风控拦住），**绝不假装成功**。一次没到位脚本会再校一次（`clicks` = 点了几次、`corrected` = 有没有做第二次纠正），两次都校不回来就是 `ok: false` + `state: "uncertain"`；`state` 的取值只有 `liked` / `unliked` / `collected` / `uncollected` / `uncertain`；
4. 点完页面出现「登录后」字样、或冒出 login 相关的 `data-e2e` 节点 → 直接返回 `needLogin: true`，不再猜状态。

出错时的形状：`url` 不是 http(s) / `action` 不在四个取值内 → `{ ok: false, reason }`（插件层，不会带着坏参数去点）；脚本不存在（插件版本对不上）→ `{ ok: false, reason: "动作脚本不存在（插件版本过旧？）" }`；脚本输出不是 JSON → `{ ok: false, reason: "脚本输出不是 JSON（动作 like 那一步）", output: <日志尾巴> }`；脚本自己失败 → `{ ok: false, error: "一句话原因", state, needLogin, … }` 原样透出（`error` 是脚本层的键，与只读那几个工具一致，退出码挂在 `exitCode`）。超时上限 150s（`verifyWait` > 0 时再加 `verifyWait + 15` 秒）。

---

### 1.7 装入配置环境（1 个，基础能力，**不设等级闸门**）

装依赖是基础能力，跟等级开关无关：五个等级**全关**也能调。

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `douyin_setup` | `mode`（`auto` \| `scan` \| `minimal` \| `full` \| `minimal-force` \| `full-force`，默认 `auto`） | `auto`（设置页那个【一键配置环境】按钮）= 先扫描，**有能用的 Python（playwright + sherpa_onnx 都能 import）就直接复用它并把路径写进 `pythonPath`**，没有就在 `<插件根>/venv` 建独立 venv 装依赖，返回 `action: reused \| installed \| failed`；`scan` = 只体检不改动，回 inventory；`minimal` / `full` = **后台派生**去装（起来就返回 `started: true`）；`*-force` 再加 `--force-venv`（强制新建 venv，不复用已有解释器）。走 `scripts/douyin_setup.py` |

权限模型：「装环境」是基础能力，**不设等级闸门**。执行形态有两条路：

- **MCP 工具调用**：`auto` / `scan` 前台同步（等它跑完拿结论，`auto` 30 分钟上限、`scan` 2 分钟）；`minimal` / `full` / `*-force` 后台派生，起来就返回。
- **设置页按钮**：HTTP `POST /run {action:'setup_auto'}` 也走**后台派生**，**立刻**回 `{ ok:true, started:true, action:'started' }` —— 首次装依赖几分钟，长请求会被宿主 HTTP 掐断，掐断后用户看到失败、脚本其实还在跑，所以界面不能等；装的结果由脚本写 `<状态目录>/setup-result.json`，前端每 3 秒轮询一次 `douyin_status` 直到 `env.setupRunning` 变 false，再读 `env.setupResult`。

已经在装（锁文件 `<状态目录>/setup.lock` 在，或 `setup.log` 最近 60 秒内有新行）时返回 `{ ok: false, reason: '已经有一个安装进程在跑' }`。

`douyin_status` 多了个 `env` 字段给设置页画状态：`venv` / `venvPython` / `venvUsable` / `basePython` / `playwright` / `sherpa` / `canReusePython` / `reusePythonPath` / `reuseSource` / `scan`（上次扫描的 inventory）/ `setupRunning` / `setupWhy` / `setupResult`（`{action, pythonPath, version, hasPlaywright, hasSherpa, missing, nextSteps, at}` 或 `null`）/ `setupLog` / `setupLogTail`（最近 20 行）。

> `venvUsable` 是真起一个子进程跑 `import playwright, sherpa_onnx`（8 秒超时，失败算 false），所以**同一次运行只探一次**：缓存 key 带着 `setup.log` 的 mtime，装完日志一变就重探，既不会让 `douyin_status` 变慢，也不会「刚装完还显示 false」。`setupResult` 读不出来（没文件 / 坏 JSON）一律当 `null`，绝不抛。

装到哪、怎么复用、升级后为什么要重装 —— 见第 3.5 节。

## 2. 安装

本包自带挂载声明（`cordis.patch.yml`），装好后 profile 只要在 `dsh.profile.bundles` 里列出包名即生效，**不需要再手改 profile 自己的 `cordis.patch.yml`**。

### 2.1 先确认你的 profile 名

```text
目录：%USERPROFILE%\.dsh\profiles\<profile>\        # 里面那个唯一的名字就是它
```

常见是 `desktop` 或 `web`。**下面命令里的 `<profile>` 都换成你自己的那个**，写错会提示找不到 profile。

### 2.2 三选一

```text
# ① 从 npm 装（推荐给使用者；当前 latest = 1.2.3）
dsh plugin --profile <profile> add dsh-douyin-audio@latest

# ② 从本地 tgz 装（不联网、不经 npm 源；tgz 见 Release 或作者给的交付包）
dsh plugin --profile <profile> add "D:\path\to\dsh-douyin-audio-1.2.3.tgz"

# ③ 从源码目录装（开发/改代码即时生效；npm 会把文件复制进 node_modules，不是软链）
dsh plugin --profile <profile> add link:D:\path\to\dsh-douyin
```

> ⚠️ 第 ③ 种是**复制**不是软链：改完源码要让运行中的副本跟上，需要重跑一次这条命令（或点设置页的【检查更新】→「拉取最新源码」，它会自动 `git pull` + `npm install` 同步副本）。

### 2.3 装完

1. 确认 profile 的 `dsh.profile.bundles` 里出现 `dsh-douyin-audio`。
2. **重启 DSH。** bundle 层的 patch 只在启动时叠加，只有 profile 自己那一层是热重载的；改完 `bundles` 不重启不会看到工具。
3. 打开设置页 → 「大肥鱼刷抖音网页版」，能读到配置就说明挂上了。

装好后的挂载项（`cordis.patch.yml`）：`id: douyin-audio`、`name: dsh-douyin-audio`、`config.enabled: true`。那个 `id` 同时也是配置命名空间名（在 profile 里写 `douyin-audio: { ... }` 就是给本插件配参数）。

> 配置优先级（`index.js` 的 `merged()`）：profile 里 `douyin-audio: {...}` 传进来的值 > 状态目录 `config.json`（`douyin_config set` 写的） > 代码里的 `DEFAULTS`。

---

## 3. 依赖与自检

不装 Python 也能先跑一遍 `node selfcheck.mjs`（见第 9 节第 1 步）：它只验证插件能否被宿主正常加载、16 个工具是否齐全，不依赖 Python、不联网。

装完跑一次 `douyin_status`。它的 `ok` 字段 = 「Python(playwright) 找到」且「Python(sherpa_onnx) 找到」且「`~/.dsh/bin/ffmpeg.exe` 存在」且「模型目录存在」。

| 依赖 | 用在哪 | 缺失时会发生什么 |
| --- | --- | --- |
| Python + `playwright`（脚本用 `channel="msedge"`，需本机有 Edge） | `douyin_scroll`；五个只读工具 `douyin_hot` / `douyin_search` / `douyin_video` / `douyin_comments` / `douyin_note`；两个通知工具 `douyin_notes` / `douyin_messages`（还需登录态 cookie） | 该工具直接返回 `{ ok: false, reason: '找不到带 playwright 的 Python…' }`，不启动浏览器。探测顺序：`pythonPath` 配置 → `DSH_PYTHON` → `PYTHON3` → `PYTHON` → `python3` → `python`，每个候选跑一次 `python -c "import playwright"`，单个候选最多等 15 秒 |
| Python + `sherpa_onnx` | `douyin_transcribe` | 返回 `{ ok: false, reason: '找不到带 sherpa_onnx 的 Python…' }`。两个能力可以装在**不同**解释器里，插件分别探测 |
| `ffmpeg` | ① 下载后校验是否有音轨；② 转写前把音频转成 16kHz 单声道 WAV | `douyin_status` 的 `ok` 变 `false`；音轨校验退化为「未知」，于是每个视频的第一个候选都被认为可用，也就不再写 `# NO_AUDIO` 标记；转写则整条以「找不到 ffmpeg」失败。`douyin_status` 只认 `~/.dsh/bin/ffmpeg.exe`，而转写脚本还会去 `PATH` 找 —— 可能出现「自检说没有、转写却能跑」，把 ffmpeg 放 `~/.dsh/bin/` 最稳 |
| SenseVoice 模型目录 | 转写推理 | 转写失败（模型加载不到）。默认路径 `~/.dsh/models/sherpa-sense-voice/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`；可用 `douyin_transcribe` 的 `modelDir` 参数或脚本的 `--model-dir` 指向别处。`douyin_status` 检查模型目录时认环境变量 `DOUYIN_MODEL_DIR`，但该变量**不会**被传给转写脚本，想换目录请用 `modelDir` / `--model-dir` |
| cookie 文件 `~/.dsh/cookies/douyin_cookies.txt`（netscape 格式，可选） | 下载视频、转写脚本抓直链时带上，避免 CDN 降级只给视频流 | 没有也能跑，但更容易拿到**无音轨**的纯视频流，从而出现 `# NO_AUDIO` |
| **可写的临时目录** | 下载件、截图、manifest、转写中间 WAV 都落在这里 | 受限沙箱里系统 `%TEMP%` 可能不可写（open 直接 Errno 13、ffmpeg 开不出输出文件），此时下载/转写会报错。转写脚本会依次试 `DSH_DOUYIN_TMP` → 系统临时目录 → 脚本旁 `tmp/` → 当前目录 `tmp/`，第一个能写的胜出；刷屏脚本的工作目录固定为「系统临时目录 `/douyin`」（`tempfile.gettempdir()`，同样跟随 `TMP`/`TEMP`）。插件侧 `lib/runner.mjs` 的 `runPython(..., { tmpDir })` 会给子进程注入 `DSH_DOUYIN_TMP` 并预建目录（当前 `index.js` 的两个调用点没有传 `tmpDir`，所以默认仍用系统临时目录）；要整体换盘，就在启动 DSH 的环境里把 `TMP`/`TEMP` 指到可写目录 |

> 想固定解释器：把路径写进 `pythonPath` 配置（`douyin_config set key=pythonPath value=<解释器绝对路径>`），探测会先试它。

---

## 3.5 装入配置环境（一键）

设置页「环境与诊断」页的主区域只有一个按钮【一键配置环境】（其余开关都收在下面的「高级选项」里），它走 HTTP `setup_auto` → 后台派生 `scripts/douyin_setup.py --mode auto`：

1. **先扫描**：看本机有没有一个解释器**同时能 import playwright 与 sherpa_onnx**；
2. **扫到了就复用**：把那个 python 路径直接写进配置的 `pythonPath`，一个字节都不装，`action: "reused"`；
3. **扫不到才装**：在 `<插件根>/venv` 建一个独立 venv（装好后就是 `node_modules/dsh-douyin-audio/venv`，Windows 下解释器是 `venv\Scripts\python.exe`），`pip install playwright sherpa-onnx`；装完由脚本自己把 `<插件根>/venv\Scripts\python.exe` 写进 `pythonPath`，`action: "installed"`；失败是 `action: "failed"` + 原因（设置页这时给一个【查看日志】按钮）。

**结果怎么回到界面**：脚本把结论写进 `<状态目录>/setup-result.json`（`{ action, pythonPath, version, hasPlaywright, hasSherpa, ffmpeg, model, missing, nextSteps, at, elapsed }`），插件只读它 + 看锁文件 / `setup.log` 的活跃度，合成 `douyin_status.env` 的 `setupRunning` / `setupResult`。前端点完按钮就每 3 秒轮询一次 `status`（最多 30 分钟），看到 `setupRunning === false` 且 `setupResult.at` 是这次点击之后写的，才把那一行结果画出来（旧结果不会被误当成本次结果）。

### 基础解释器不用你自己装

venv 是基于 **DSH 自带的那份 python** 建的 —— `%USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\python\python.exe`（本机是 `dsh-primary-runtime` 下的 3.12），所以**不需要用户先自己装 Python**。脚本侧选基础解释器的优先级：`--base-python` > DSH 自带 python > 配置里的 `pythonPath` > `PATH` > 报错让你装一个。

venv 到底基于谁，看 `douyin_status.env.basePython`（来源是 `venv/pyvenv.cfg` 的 `home=` 行，读不到再退回 `setup.log` 里脚本打的 `base python: …`）。

### 两种模式（在「高级选项」里）

| 模式 | 装什么 | ffmpeg | SenseVoice 模型 |
| --- | --- | --- | --- |
| 精简 `minimal` | venv + playwright + sherpa-onnx | **检测到就复用**；缺了只明确提示怎么装（`winget install ffmpeg`，或把 `ffmpeg.exe` 放进 `<状态目录>\bin`） | **检测到就复用**；缺了提示手动解压到 `<状态目录>\models\` |
| 完整 `full` | 精简 + 下载 ffmpeg + 下载模型 | 自动下载到 `<状态目录>\bin\ffmpeg.exe` | 自动下载到 `<状态目录>\models\` |

勾上「强制新建独立 venv（不复用已有 Python）」= 给脚本加 `--force-venv`（对应 `douyin_setup` 的 `minimal-force` / `full-force`）：即使扫到能用的解释器也照建 venv。

高级选项里另外两个按钮：**只看扫描结果**（`setup_scan`，只体检、不改任何配置或文件，回一张 Python / ffmpeg / 模型 / cookie 的小表 + 一句结论）、**刷新状态**（重跑 `douyin_status` 读最新的 `env`）。

### ⚠️ 插件升级 / npm install 会清掉 venv

venv 建在**插件的安装目录里**，所以：

- 升级 / 重装 / `npm install` 都可能把整个包目录替换掉，**venv 跟着没了**；升级完请回来再点一次【一键配置环境】（通常几十秒，pip 有缓存）。
- `pythonPath` 这时会指向一个不存在的路径 —— 探测会自动跳过它去找别的解释器，不会把插件弄挂；只是转写在重装环境之前会报「找不到带 sherpa_onnx 的 Python」。

进度都写在 `<状态目录>\setup.log`（逐行追加、带时间戳）：页面上点【查看日志】，或者读 `douyin_status.env.setupLogTail`（最近 20 行）。装好的判据是 `douyin_status.env.venvUsable === true`（= venv python 在，且 `import playwright, sherpa_onnx` 成功）。

---

## 4. 配置项

配置存在状态目录的 `config.json`，缺字段用代码里的 `DEFAULTS` 补齐（`lib/state.mjs`）；可以用 `douyin_config` 改，也可以在 profile 的 `douyin-audio:` 命名空间里给初始值。

| 键 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `count` | number（正整数） | `3` | 一轮刷几屏。实际调用时夹到 1–200 |
| `delay` | number | `1.5` | 每屏停留秒数。实际调用时夹到 0.5–30 |
| `headless` | boolean | `true` | 无头（后台）运行；`false` 会弹窗口（只管 `douyin_scroll`） |
| `readHeadless` | boolean | `true` | 五个**只读**工具（`douyin_hot` / `douyin_search` / `douyin_video` / `douyin_comments` / `douyin_note`）是否后台运行。`true`（默认）传 `--headless`、行为与历史完全一致；`false` 时插件给脚本加 `--no-headless`，弹一个**移出屏幕外**的可见窗口（`--window-position=-3000,-3000`）——headless 打开抖音必吃验证码，带窗口的能过风控。`douyin_react`（③A 轻互动）也读这把键 |
| `verifyWait` | number（秒） | `0` | 命中「验证码中间页」时最多等多少秒让人工去过验证，超过就照旧如实报错。`0`（默认）= 不等，行为与历史一致；`>0` 时给脚本加 `--verify-wait N`，并把这次调用的超时预算加上 `N + 15` 秒（否则窗口刚弹出来就被 taskkill）。`douyin_react` 同样认这把键 |
| `saveAll` | boolean | `true` | 是否逐屏下载视频（关掉就只截图，后续没东西可转写） |
| `downloadTimeout` | number（正整数，秒） | `300` | 单个视频下载超时 |
| `transcribeModel` | string | `''` | **当前仅占位**：`config.json` 里有这个键，但没有任何工具读取它（转写模型目录请用 `douyin_transcribe` 的 `modelDir` 参数） |
| `pythonPath` | string | `''` | 指定 Python 解释器；空 = 自动探测。**装完环境后它指向插件内的 venv python**（`<插件根>/venv/Scripts/python.exe`）—— 这个值是 `scripts/douyin_setup.py` 自己写的，插件不额外加配置键 |
| `asrThreads` | number（正整数） | `8` | SenseVoice 本地推理线程数，范围 1–64，实际建议不超过本机逻辑核（设置页按 `GET /sysinfo` 读到的核数夹取，读不到就按 1–64）。`douyin_transcribe` 与「刷完自动转写」都把它透传成 `--threads`（1–64 夹取，0/非法值就不带） |
| `autoTranscribe` | boolean | `false` | **关（默认，推荐）= 刷完只给清单，由你决定转哪条（返回体 `autoTranscribe: null`）；开 = 刷完立刻转清单里最新的 1 条**。转写结果放在 `autoTranscribe` 字段里；找不到 sherpa_onnx 的 Python、脚本报错、没有任何已下载文件时只把原因写进该字段，**scroll 本身仍照旧返回 `ok`** |
| `browserChannel` | string | `msedge` | 让三个会起浏览器的脚本（`douyin_scroller.py` / `douyin_read.py` / `douyin_login.py`）用哪个浏览器。**两类取值**：① 已知内核 `msedge` \| `chrome` \| `chromium` \| `firefox` \| `webkit` → 插件给脚本加 `--browser-channel <值>`；② 自定义浏览器（配置 `browserExtras` 里的 id，如 `custom-1`）或**一个 exe 完整路径**（开始菜单 / 桌面快捷方式扫描出来的项就是这样存的）→ **不加** `--browser-channel`，改加 `--browser-executable <路径>`。默认 `msedge` = 你装的 Microsoft Edge（实测最稳，抖音风控对真浏览器宽松）；`chromium` = Playwright 自带的内置浏览器（没有真实用户的浏览痕迹，**最容易撞验证码**，只建议排查问题时用）。脚本侧候选链只限于 Chromium 家族：`msedge → [msedge, chrome, chromium]`、`chrome → [chrome, msedge, chromium]`、`chromium → [chromium]`、`firefox → [firefox]`、`webkit → [webkit]` —— `firefox` / `webkit` 是不同引擎，**不装了就直接报错**（错误里写「先运行 `npx playwright install firefox`」），绝不静默退回 Edge。自定义项若路径没了 / id 找不到，插件**一个浏览器参数都不传**（脚本走自己的默认 msedge 候选链），并把原因写进 `douyin_status` 的 `browserNote`。旧版脚本不认这些参数时（`--help` 里没有）就不带，行为与升级前一致。⚠️ 换浏览器后需要**重启 DSH** 才生效 |
| `browserExtras` | string（JSON 数组，默认 `[]`） | `[]` | **手动添加的浏览器**，元素是 `{"id":"custom-1","label":"公司装的 Chrome","path":"D:\\tools\\chrome.exe"}`（`id` 自造、`path` 必填、`label` 可省）。设置页「环境与诊断」里的【手动添加】就是往这里写；写成**字符串**而不是数组是为了避开旧宿主的类型兼容问题，解析失败一律当空数组（绝不抛错）。选中某一项时 `browserChannel` 存的就是它的 `id`，下发时变成 `--browser-executable <path>`。开始菜单 / 桌面快捷方式里扫到的浏览器**不会**写进这里（那是动态扫出来的），只是当次渲染出来给你选 |
| `loginMode` | string（`window`\|`qr`） | `window` | 登录方式：`window` = 前台弹真窗口人工扫码（推荐，最稳）；`qr` = 后台驻留抓二维码到设置页扫。`douyin_login_start` 不传 `mode` 时用它，设置页「登录」区块的两个单选也读写它 |
| `autoRun` | boolean | `false` | **谷时自动刷**：开 = 插件自己按 60 秒 tick 检查，满足「谷时窗口内 + 今日额度未满 + 距上次 ≥ `dutyIntervalMin` 分钟 + 没有正在跑的 run」才自己刷一轮；默认关 |
| `dutyWindow` | string | `12:00-14:00,18:00-23:59` | 谷时窗口，逗号分隔多个 `HH:MM-HH:MM`；支持跨零点（如 `23:00-02:00`） |
| `dailyLimit` | number | `5` | 每天最多刷几屏（单位是屏，不是视频条数）；`0` = 不自动跑（仍可手动） |
| `dutyIntervalMin` | number | `30` | 两次自动刷之间至少隔多少分钟 |
| `uiLayout` | string | `classic` | 设置页布局：`classic` = 一长条平铺；`tabs` = 四标签页（采集 / 转写 / 权限与登录 / 环境与诊断） |
| `tierRead` | boolean | `true` | **① 只读**：解锁 `douyin_hot` / `douyin_search` / `douyin_video` / `douyin_comments` |
| `tierNotify` | boolean | `false` | **② 通知**：解锁 `douyin_notes` / `douyin_messages`（读通知摘要、私信会话列表；仍然只读，不发消息、不标已读） |
| `tierReact` | boolean | `false` | **③A 轻互动**：解锁 `douyin_react`——点赞 / 取消赞 / 收藏 / 取消收藏（见 1.6）。**默认关**；这一档**真的会写**：以你的账号点赞、收藏（可撤回，但会动你的互动记录）。关着时 `douyin_react` 返回 `TIER_DISABLED(tier=react)` |
| `tierComment` | boolean | `false` | **③B 评论回复**：发评论 / 回复（预留；会以你的账号公开发言，发出后收不回） |
| `tierPublish` | boolean | `false` | **④ 发布**：上传视频到抖音（预留；会向你的账号投稿） |

**能力等级（五个开关）**

五个 `tier*` 键就是「能力等级」开关，**只能在设置页的「能力等级」那一节由用户自己点**。
`douyin_config` 会明确拒绝改 `tier*`（返回 `{ok:false, error:"能力等级只能由用户在设置页修改"}`）——
让 agent 能自己解锁，闸门就等于没设。设置页走的是 `POST /api/douyin-audio/config`（要过同源门那一条，
见第 5 节），那条路照旧能写 `tier*`，因为那是你自己点的开关。

- 基础四件（`douyin_scroll` / `douyin_transcribe` / `douyin_status` / `douyin_config`）**不受等级限制**——它们不碰抖音的写接口。
- **依赖规则**：`tierReact` / `tierComment` / `tierPublish` 任一为真时，`tierRead` 在判断上视为真（**不会改写你存的值**）。
- **③ 为什么拆两档**：点赞收藏可撤回，评论回复公开且不可撤回——风控强度差一个量级，所以给了两个独立开关。
- 等级没开时，对应工具不报错也不崩，返回：

```json
{ "ok": false, "code": "TIER_DISABLED", "tier": "read",
  "reason": "该能力属于「只读」，当前未开启",
  "hint": "在设置页「能力等级」打开 tierRead（这一档只能由用户自己开：douyin_config 会拒绝改 tier*）" }
```

说明：`douyin_scroll` / `douyin_transcribe` 真正读取的是 `count`/`delay`/`headless`/`saveAll`/`downloadTimeout`/`pythonPath`/`asrThreads`；五个只读工具额外读取 `readHeadless`/`verifyWait`（见上表）；`transcribeModel` 只在配置里保留，`autoTranscribe` 目前也只存值（设置页上的「刷完自动转写」开关，存值本身不触发任何动作）。

**提速（本地转写是纯 CPU 活）**

- **线程数按逻辑核调**：设置页「提速 → 线程数 asrThreads」旁边会显示 `本机 N 逻辑核`（来自只读端点 `GET /api/douyin-audio/sysinfo`），输入框上限就是 N；填超了会按核数夹回去并提示「已按本机 N 逻辑核调整为 X」。建议 8–16，再大只是把 CPU 占满，转写不会更快。
- **只转片段**：`--start` / `--dur` 能只截取一段来转（比如只想知道第 12 秒到第 42 秒说了什么），比整条快得多；插件层目前透传的是 `--threads`，截取请直接跑脚本（见 7.1）。
- **纯 BGM 的视频可以跳过**：没有口播的视频转出来只有几句歌词甚至空白，先看 `douyin_scroll` 返回的 `items[]` 标题与大小，挑有内容的那几屏再转，比整批硬转省时间。

---


### 4.3 `douyin_status` 里的浏览器探测（设置页据此决定可选列表）

`douyin_status` 的返回体里有两块浏览器信息，设置页只靠它决定「列表里给哪几个可选」：

```jsonc
{
  "browsers": {
    "msedge": true, "chrome": false, "chromium": false, "firefox": false, "webkit": false,
    "paths": { "msedge": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "chrome": null, "chromium": null, "firefox": null, "webkit": null },
    "extras": [ { "id": "custom-1", "label": "公司装的 Chrome", "path": "D:\\tools\\chrome.exe", "exists": true } ],
    "shortcuts": [ { "name": "Chrome", "path": "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe" } ]
  },
  "browserNote": ""   // 当前 browserChannel 解析不成时的原因（正常是空串）
}
```

- `msedge` / `chrome` 按常见安装路径探测（Program Files、Program Files (x86)、LOCALAPPDATA）；`chromium` / `firefox` / `webkit` 看 `ms-playwright` 里有没有对应子目录。
- `shortcuts` 是把开始菜单（`%ProgramData%`、`%APPDATA%`）与桌面（`%USERPROFILE%`、`%PUBLIC%`）里的 `.lnk` 交给 PowerShell 解析出来的目标 exe，**按 exe 名单过滤**（只认 msedge / chrome / firefox / brave / opera / vivaldi / chromium / 360se / 360chrome / qqbrowser / sogoupv / ucbrowser），同路径去重、已知安装路径已命中的不再重复列。结果**按进程缓存**——点设置页的【扫描已安装的浏览器】才带 `scan:true` 重扫（`douyin_status` 的 `scan` 参数）。
- 全部探测都在 try/catch 里：扫不到就是 `false` / 空数组，绝不影响 `douyin_status` 其它字段。
- 设置页的规则：**只列真能用的**（已知安装路径命中的、快捷方式发现的、手动添加的）+ 当前选中值；未安装的内核不渲染成按钮。当前选中但探测不到时照样显示并标「未安装」。

---

## 5. 登录：两种模式

只读 / 通知 / 私信这些工具吃的是同一份 cookie（`~/.dsh/cookies/douyin_cookies.txt`），**登录 = 把这份 cookie 写出来**。插件提供两种登录方式：共用同一支脚本 `scripts/douyin_login.py` 与同一个状态文件，区别只在「窗口在哪、谁在等」。

| | `window`（默认，推荐） | `qr` |
| --- | --- | --- |
| 怎么跑 | **后台派生**一个**可见**的 Edge 窗口（`--mode window`，不阻塞，工具立刻返回 `started`） | **后台派生**脚本进程（不阻塞，`--mode qr`），脚本 headless 驻留，同一个浏览器上下文里等你扫完 |
| 你要做的 | 在窗口里扫码 / 拖滑块过验证，随便刷两下 | 看设置页里那张二维码（每 3 秒自动换时间戳刷新），用手机抖音扫它 |
| 进度从哪看 | 也看 `douyin_login_poll`（脚本只写 cookie、不写 `state.json`，所以 poll 会拿 cookie 的 mtime 跟本次开始时间比：更新了就是 `ok`） | `douyin_login_poll` 读 `state.json`：`waiting` / `scanned` / `ok` / `expired` / `error` |
| 适合 | 第一次登录；撞了人机验证（滑块常常只有在真窗口里才过得去）；cookie 过期重登 | 已经登录过、只想在设置页里换一次 cookie；不想被弹窗抢焦点、不想挂着一个窗口 |
| 代价 | 抢焦点；窗口最多驻留 5 分钟（`--wait`），等不到就自己退出，**要自己轮询才知道结果** | 二维码是**截图**，个别缩放比例下可能糊；要设置页开着轮询；起不来时先看 `login/login.log` |

**状态文件与临时目录**（`stateDir` = `$DSH_HOME/douyin-duty`）：

```text
$DSH_HOME/douyin-duty/login/
  qr.png      二维码截图（qr 模式，后台每 3 秒覆盖刷新）
  state.json  { "phase": "waiting|scanned|ok|expired|error", "at": <epoch ms>,
                "message": "一句话", "cookiePath": "<成功时写的 cookie 路径>", "mode": "window|qr" }
  login.log   qr 模式派生进程的 stdout + stderr（工具起不来时第一个该看的文件）
```

**二维码图片端点**（设置页 `<img src="/api/douyin-audio/qr?t=时间戳">` 直接用；它和其它路由一样要过同源门，
`<img>` 带不了请求头，所以客户端拿到 token 时会额外拼 `&token=…`）：

```text
GET /api/douyin-audio/qr    ->  200  image/png（login/qr.png，cache-control: no-store）
                               404  { ok:false, error:"二维码还没生成（先调用 douyin_login_start 的 qr 模式）", qrPath, stateFile }
```

**所有插件 HTTP 路由都要过同源门**（`/config` / `/run` / `/sysinfo` / `/qr` / `/duty` / `/token`）：

```text
放行（满足其一，按顺序判）:
  1) 请求头 x-dsh-douyin-token 是插件签发过且没过期的 token
     （GET 也可以用 ?token=…：给 <img> 这种带不了请求头的地方）
  2) Sec-Fetch-Site: same-origin      <- 现代浏览器同源请求必带，设置页靠这条
  3) Origin 的 host:port 等于本次请求的 Host
否则一律:
  403  { ok:false, error:"forbidden: cross-origin or missing token" }   <- 动作不执行

GET /api/douyin-audio/token   ---- 它自己也要过同源门（否则等于没加）
  -> 200 { ok:true, token:"<32 hex>", expiresInMs:600000, header:"x-dsh-douyin-token" }
```

token 只在内存里：10 分钟内可复用，进程（宿主）重启就作废，客户端重新取一次即可。
既没有 Origin 也没有 Sec-Fetch-Site 的请求（curl / 本地进程 / 跨站表单）**默认拒绝**——
这正是审查报告里 `/api/douyin-audio/config` 不带 cookie 就能读、`POST /run` 带
`Origin: https://evil.example` 还能真的执行的那个口子。

**设置页「登录」区块**（在「提速」和「跑一下」之间）：两个模式单选（`真窗口（推荐）` / `抓二维码到设置页`，切换即 `POST /config {key:'loginMode'}`）＋ 一个「开始登录」按钮（`POST /run {action:'login_start', mode}`）。两种模式随后都每 3 秒 `POST /run {action:'login_poll'}`，出结果（`ok` / `expired` / `error`）就停；成功后显示「已登录，cookie 已写入」。

**命令行等价物**（不经过 DSH 也能登，契约见 7.3）：

```bash
python scripts/douyin_login.py --mode window --wait 300
python scripts/douyin_login.py --mode qr --state-dir "%DSH_HOME%\douyin-duty\login" --wait 300
```

两种模式成功后都把 netscape cookie 写到 `--out`（默认 `~/.dsh/cookies/douyin_cookies.txt`，可用 `DOUYIN_COOKIE_FILE` 覆盖），旧文件备份成 `.bak`。

---

## 6. 两个目录

**产物（工作目录）**：下载件、截图、manifest 都在系统临时目录下的 `douyin/`。刷屏脚本按 `tempfile.gettempdir()` 拼这个路径，插件的 `workRoot()` / `workVideos()` 用同一个约定，因此 `douyin_scroll` 返回的 `dirs`、`douyin_transcribe` 的自动扫描、`douyin_status` 的 `workDir`/`videos` 都指向同一处：

```text
%TEMP%\douyin\                      ← douyin_status 的 workDir
├─ videos\video_001.mp4             下载的视频（带音轨的成功件）
├─ videos\video_001.mp4.part        下载中的临时文件（失败/重复会删）
├─ manifest.txt                     清单：每屏一行 "屏号|标题|直链"；无音轨追加 "# NO_AUDIO screen=<屏号> url=<直链>"
└─ scroll_001_123456.png 等          截图（目录内最多保留 60 张）
```

**状态目录（配置与日志）**：`$DSH_HOME/douyin-duty/`，`$DSH_HOME` 未设置时回退 `~/.dsh`。不写插件包目录（装进 `node_modules` 后可能只读、升级会被覆盖）：

```text
$DSH_HOME/douyin-duty/
├─ config.json    用户配置（douyin_config set 写入，字段齐全）
├─ douyin.log     运行日志（每行带 ISO 时间戳）
├─ douyin.log.1   上一份日志（超过 2MB 时轮转，只留一份历史）
├─ videos/        预留目录
└─ shots/         预留目录
```

插件启动时（`apply`）会幂等创建 `douyin-duty/`、`videos/`、`shots/`。**注意**：真正被工具读取的 `videos/` 是上面工作目录里的那个，`douyin-duty/videos/` 只是预留位。

---

## 7. 直接跑脚本（可选）

### 7.1 `transcribe_douyin.py`（转写）

`scripts/transcribe_douyin.py` 是独立 CLI（v1.2.0），不装插件也能单跑。插件内部等价的调用是 `--json --file <每个文件>`，需要时再加 `--model-dir`：

```text
python scripts\transcribe_douyin.py --file "%TEMP%\douyin\videos\video_001.mp4"
python scripts\transcribe_douyin.py --file a.mp4 --file b.mp4 --json --out result.txt
```

| 参数 | 说明 |
| --- | --- |
| `target`（位置参数，可省） | 单个媒体文件或视频直链（兼容旧用法） |
| `--file PATH`（可重复） | 要转写的本地文件 |
| `--files LIST` / `--manifest LIST`（可重复） | 清单文件（一行一个路径或直链） |
| `--out PATH` | 把结果写成文本文件 |
| `--json` | 输出 JSON 给程序解析（信封里带 `threads`） |
| `--threads N` | 本地转写线程数（默认取 `DOUYIN_ASR_THREADS`，再默认脚本内置值）；**插件调用时用配置里的 `asrThreads`**（设置页「提速」那个输入框）传它 |
| `--start SEC` | 只转写从该秒数开始的区间（可选，用 ffmpeg `-ss` 截取） |
| `--dur SEC` | 转写区间长度（秒，可选，用 ffmpeg `-t` 截取） |
| `--model-dir DIR` | SenseVoice 模型目录，默认 `~/.dsh/models/sherpa-sense-voice/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` |
| `--ffmpeg EXE` | 指定 ffmpeg；默认 PATH → `~/.dsh/bin` 探测 |
| `--yt-dlp EXE` | 输入里有直链时需要；同样 PATH → `~/.dsh/bin` 探测 |
| `--cookies FILE` | yt-dlp 用的 cookie，默认 `~/.dsh/cookies/douyin_cookies.txt`（存在才带） |
| `--version` | 打印脚本版本 |

`--json` 的输出结构：

```json
{ "ok": true, "items": [ { "source": "<文件或直链>", "text": "<转写文本>", "error": null } ], "model": "<模型目录名>", "elapsed": 12.34 }
```

`ok` 为真表示所有条目都成功；某条失败时该条 `text` 为空、`error` 带原因，整体 `ok` 为假。

**空结果会带 title 兜底**：纯 BGM / 静音的视频转出来就是空串，脚本这层不会替你判断"这条是什么"。插件那层（`douyin_transcribe`）会用 manifest 的屏号补上 `screen` / `title` / `hasSpeech`，无语音的再补一句 `note`，顶层给 `summary`——所以要判断"值不值得看"请看这几个字段，别只看 `text` 是不是空。

---

### 7.2 `douyin_read.py`（只读查询）

同一个脚本六个子命令，全都支持 `--json`（**stdout 只输出 JSON，进度信息走 stderr**）：

```text
python scripts\douyin_read.py hot      --limit 20 --json
python scripts\douyin_read.py search   --keyword 关键词 --limit 20 --order totalrank --json
python scripts\douyin_read.py video    --url https://www.douyin.com/video/<id> --json
python scripts\douyin_read.py comments --url https://www.douyin.com/video/<id> --limit 30 --json
python scripts\douyin_read.py notes    --limit 20 --json
python scripts\douyin_read.py messages --limit 20 --json
```

| 参数 | 说明 |
| --- | --- |
| `hot` / `search` / `video` / `comments` / `notes` / `messages` | 子命令（位置参数，必填） |
| `--limit N` | 取几条，1–50（`hot` / `search` / `notes` / `messages` 默认 20，`comments` 默认 30） |
| `--keyword K` | `search` 必填 |
| `--order O` | `search` 的排序：`totalrank`（综合）/ `click`（播放）/ `pubdate`（最新） |
| `--url U` | `video` / `comments` 必填，视频页链接（`https://www.douyin.com/video/<id>`）；`notes` / `messages` **可选**，用来覆盖默认的通知页 / 私信页地址（默认 `https://www.douyin.com/notifications` / `…/messages`） |
| `--json` | 输出 JSON 给工具层解析（插件调用的就是这个形态） |
| `--cookies FILE` | cookie 文件；默认取环境变量 `DOUYIN_COOKIE_FILE`，再退回 `~/.dsh/cookies/douyin_cookies.txt`（与 `douyin_scroller.py` 的 `_resolve_cookie_file` 同一套优先级，不硬编码用户名） |
| `--headless` | 无头（不弹窗）运行；**默认就是开**，插件调用不传这个参数 |
| `--timeout 秒` | 单步等待上限，默认 30（插件侧另有整体超时，见 1.1） |

`--json` 的输出信封（四个子命令一致）：

```json
{ "ok": true, "items": [ ... ], "elapsed": 1.2 }
{ "ok": false, "error": "热榜页没等到列表容器", "items": [] }
```

`items` 的字段见 1.1 的表。脚本只读页面：不点赞、不关注、不发评论、不发布。抖音的 DOM 会变，因此每个字段都是**多候选选择器 + 兜底**，取不到就返回 `ok: false` 并在 `error` 里写明**哪一步**失败（一句话原因），不拿半截空列表冒充成功。

---

### 7.3 `douyin_login.py`（登录 / 撞验证码后恢复）

抖音会对**自动化浏览器**做风控打分，连续多次 headless 访问后，`/`、`/hot`、`/video/`、`/search` 会全部跳「验证码中间页」。自动化过不去（本插件也不做绕过），但**可见窗口不受影响**，所以这个脚本用「开真窗口让你手动过验证 → 自动导出 cookie」的办法恢复：

```bash
python douyin_login.py                # 最多等 10 分钟
python douyin_login.py --wait 900     # 自定义等待
python douyin_login.py --out D:\my\cookie.txt
```

流程：
1. 弹出一个可见的 Edge 窗口，打开 `https://www.douyin.com/`
2. 你在窗口里手动完成验证码，随便刷两下
3. 脚本每 3 秒检查一次页面是否恢复（标题不含「验证码」且正文 > 800 字）
4. 恢复正常后等 5 秒，把 cookie 写成 netscape 格式覆盖 `~/.dsh/cookies/douyin_cookies.txt`（旧文件备份成 `.bak`）

退出码：`0` = 已写入；`2` = 超时 / 二维码过期（窗口会关掉，可重跑）。
写完后 headless 的 `douyin_read.py` / `douyin_scroller.py` 就能复用这套凭据。

> 两种模式（`--mode window` / `--mode qr --state-dir <登录临时目录>`）的差别、`state.json` 字段与图片端点见第 5 节；插件里的 `douyin_login_start` / `douyin_login_poll` 就是按那份契约调用它的。

---

## 8. 已知限制

1. **无音轨不装成功。** 抖音 DASH 会下发分离的音频/视频两路，某些直链只有视频流。脚本下载后逐个候选做音轨校验，只有带音轨的才正常打印；只剩无音轨候选时会在 `manifest.txt` 里写一行 `# NO_AUDIO screen=… url=…` 并打印「无音轨，该屏无法转写」，而不是假装成功。ffmpeg 不可用时校验退化为「未知」，该标记不会出现。
2. **下载可能撞上重复内容，脚本会跳过。** 抖音换屏时页面里常残留上一条视频的流，脚本按 SHA256 内容哈希去重：与已下载内容相同的候选会被丢弃并换下一个，全部重复则该屏跳过（manifest 只记一行，不留视频）。
3. **浏览器自动化在受限沙箱下需要放宽权限。** Playwright 起浏览器、脚本子进程都可能被沙箱拒。插件对此做了降级：（a）Python 探测/执行先走 `stdio: pipe`，遇到 spawn 被拒（EPERM）自动改用 `cmd /c "... > 临时文件 2>&1"` 再读文件；（b）临时目录不可写时按第 3 节的办法换盘；（c）沙箱彻底不放行时，仍需给 DSH 会话放宽权限（workspace-write 及以上）才能真的跑起来。
4. **安装/改配置需要重启才生效。** bundle 层 patch 在启动时叠加，改 `dsh.profile.bundles` 后必须重启 DSH。`config.json` 与工具参数是每次调用现读的，改完不需要重启。
5. **路径全部可配，但有优先级**（1.2.0 起不再硬编码）。cookie：`--cookies` > 环境变量 `DOUYIN_COOKIE_FILE` > `~/.dsh/cookies/douyin_cookies.txt`；ffmpeg：`--ffmpeg` > 环境变量 `FFMPEG` > `PATH` 里的 `ffmpeg` > `~/.dsh/bin/ffmpeg.exe`；产物目录：`--work-dir` > 环境变量 `DSH_DOUYIN_TMP` > `<系统临时目录>/douyin`；转写模型目录：`--model-dir` > 环境变量 `DOUYIN_MODEL_DIR` > `~/.dsh/models/sherpa-sense-voice/...`。注意 `douyin_status` 显示的 cookie 路径是按 `%USERPROFILE%` 拼的，若你用环境变量把它指到别处，status 不会反映——以实际调用时的优先级为准。
6. **只看推荐页。** `douyin_scroll` 固定以 `--tab recommend` 调用；脚本本身支持 `feed`（精选）但没暴露成参数。
7. **长任务超时受预算约束。** 刷屏超时 = `count × (delay + 12) + 120` 秒；转写超时 = `180 + 300 × 文件数` 秒；超时会 taskkill 整个进程树。
8. **只在 Windows 上验证。** 进程收尾用 `taskkill`、降级路径用 `cmd`；非 Windows 平台未做兼容。
9. **会撞上抖音风控（人机验证），而且自动化过不去。** 连续多次自动化访问后，抖音会给这个浏览器上下文打分到阈值以下，此后 `/`、`/hot`、`/video/`、`/search` 全部跳「验证码中间页」（标题 `验证码中间页`、正文只有几个字），而 `/jingxuan` 之类轻量页仍正常。**这是分页面风控，不是 IP 被封。**

   现象（五个只读工具都会这样返回，不会崩）：

   ```json
   { "ok": false, "error": "hot: 被抖音人机验证拦截（页面标题=验证码中间页，正文 4 字）", "items": [] }
   ```

   本插件**不做任何绕过**（不换 UA、不模拟点击验证、不接打码），遇到就如实报错。恢复办法：

   1. **用第 5 节的登录功能**：设置页「登录」区块点「开始登录」（或调 `douyin_login_start`）——`window` 模式弹一个**可见**的 Edge 窗口，你在里面手动过验证、随便刷两下，脚本自动把 cookie 写好；不想被弹窗打扰就用 `qr` 模式，二维码抓到设置页扫。命令行等价物 `python scripts/douyin_login.py --mode window`（见 7.3）；也可以自己用浏览器过验证后导出 netscape cookie；
   2. 把该浏览器的 cookie 导出成 netscape 格式，覆盖到 `~/.dsh/cookies/douyin_cookies.txt`（或用 `DOUYIN_COOKIE_FILE` 指向它）；
   3. 再让我重跑；或干脆等几小时自然冷却。

   **只想让这一次调用过验证（不想走登录流程）**：把 `readHeadless` 设成 `false`、`verifyWait` 设成 `120`（`douyin_config` 两次 set：`{"action":"set","key":"readHeadless","value":"false"}`、`{"action":"set","key":"verifyWait","value":"120"}`，或直接改 `config.json`），再调只读工具就会弹一个**可见窗口**：你在窗口里点滑块 / 过验证，脚本等你过完继续把那一页读完，超时才报错。窗口会被**移到屏幕外**（`--window-position=-3000,-3000`，不打断手头的事），过验证时用 Alt+Tab 切过去。用完记得把 `readHeadless` 改回 `true`、`verifyWait` 改回 `0`，否则之后每次调用都要白等你那 120 秒。⚠️ `--verify-wait` 是脚本层参数：脚本版本不认识它会以 argparse 报错退出（`unrecognized arguments: --verify-wait`），那就把 `verifyWait` 改回 `0`。
   预防：**不要连续快速跑**这些只读工具。一次少量（如 `hot limit=5`）、跑完隔几分钟再跑下一次。

10. **只读工具依赖页面结构，抖音改版就会失效。** `douyin_read.py` 每个字段都写多候选选择器并逐级兜底，取不到时返回 `{ ok: false, error: "…" }` 而不是半个空列表；真失效了就按 6.2 手动跑同一个脚本，看 `--json` 的 `error` 定位到哪一步，再去补选择器。

11. **通知/私信需要更完整的登录态，抓取规则也比公开页面更容易变。** `douyin_notes` / `douyin_messages` 读的是登录后才有内容的页面：没有 cookie 时脚本在**起浏览器之前**就返回 `{ ok: false, error: "notes: 需要登录态：没读到 cookie（<路径>）…" }`；有 cookie 但登录态过期（页面弹登录墙/只显示半截）时，返回的是「命中 N 个通知节点但内容为空」或「选择器全部未命中」这类**明确 error**，不会是伪装成成功的空列表。另外这两页默认地址（`/notifications` / `/messages`）与 DOM **没有在真机上验证过**，`type` 归类、`unread` 角标都是「多候选 + 兜底」的启发式，抖音改版后可能退化成 `其他` / `0`；这时用 CLI 的 `--url` 指对地址，再按 6.2 手动跑一次看 `--json` 的 `error` 定位到哪一步。

12. **③A（`douyin_react`）是写操作，会撞「互动风控」——建议一天几次、别批量刷。** 点赞/收藏对抖音是计数的互动行为：短时间集中点、脚本式连点、或者本来就被自动化风控打了分的账号，很容易换来 `state: "uncertain"`（点了但数字没变）、或者直接跳登录/验证页（返回 `needLogin: true`）。**一批不要超过几条、每条之间隔几十秒、别拿它刷赞数**；吃到 `uncertain` 就停手，等几小时自然冷却，或按第 9 条的办法过一次验证，不要靠反复重试硬撞。这一档也不适合和只读工具的高频连跑混在一起。

---

## 9. 怎么验证装好了（三步）

**第 1 步：插件自身预检（不需要 Python、不联网）**

```text
node selfcheck.mjs
```

退出码 `0` = 通过：它会用假 ctx 真跑一次 `apply()`，断言导出的 `name`/`inject` 正确、恰好注册 16 个工具（原有 4 + 只读 5 + 通知 2 + 登录 2 + 轻互动 1 + 谷时自动刷 1 + 装入配置环境 1）、每个工具都有 `description`/`parameters`/`execute`、参数 schema 里 `type: "object"` 的节点都带 `additionalProperties`（宿主缺这个会抛 `JsonSchemaError`，整条插件不激活，日志里只会留一句 warning）。它会把 `DSH_HOME` 临时指到系统临时目录下再跑，跑完删掉，不碰你真正的状态目录。

**第 2 步：环境自检**

```text
douyin_status
```

期望：`ok: true`，`pythonScroll` / `pythonAsr` / `ffmpeg` 都不是「未找到」，`modelDir.exists: true`，`scripts.scroll` 与 `scripts.transcribe` 都是 `true`，`workDir` 指向可写目录。

**第 3 步：最小实跑一屏，再转写它**

```text
douyin_config  action=get
douyin_scroll  count=1
douyin_transcribe
```

期望：`douyin_config` 返回 9 个键的默认值（`count=3`、`delay=1.5`、`headless=true`、`saveAll=true`、`downloadTimeout=300`、`transcribeModel=""`、`pythonPath=""`、`asrThreads=8`、`autoTranscribe=false`）和 `stateDir`；`douyin_scroll` 返回 `ok: true` 且 `output` 尾部含「本次刷视频统计」；`douyin_transcribe` 不带参数时会自动扫 `workDir/videos` 下最新的视频并返回 `{ ok: true, items: [...] }`。若它报「没有可转写的文件」，检查 `douyin_status` 的 `videos` 是否为空（`saveAll` 关掉时确实不会有下载件）。

只读工具想先验一下：

```text
douyin_hot  limit=3
douyin_search  keyword=美食  limit=5  order=click
```

期望：`ok: true` 且 `items` 不超过 `limit` 条；返回 `ok: false` 时 `error` 会写明卡在哪一步（常见是没登录 → 先确认第 3 节那个 cookie 文件）。

---

## 10. 变更记录

### v1.2.3 — 修 1.2.2 的设置页 403（2026-10-29）

**1.2.2 有回归：任何机器装上后设置页都读不到配置（HTTP 403）。请直接用 1.2.3。**

原因：1.2.2 的同源门规则是「没有同源证据就拒绝」，而 DSH 界面经桥接通道发请求时**既不带 Origin 也不带 Sec-Fetch-Site**，于是被自己的门拦死。

修法：改成「**只按正面证据拒绝**」——

| 请求形状 | 判定 |
| --- | --- |
| 带 Sec-Fetch-Site: same-origin | 放行 |
| 带 cross-site / same-site / none | **403** |
| 带 Origin 且等于本请求 Host | 放行 |
| 带 Origin 但不等于本请求 Host | **403** |
| 两个头都没有 | 放行（curl / Electron 桥接 / 本机进程） |

威胁模型没变：**浏览器页面发起的跨站请求一定会带这两个头**，所以 C1 的网页攻击路径依旧被堵；而本机进程从来不是这条路由能防住的（它本来就能直接改 config.json）。

### v1.2.2 — 安全修复（2026-10-29）

**这是一个安全版本，1.2.0 / 1.2.1 请勿对外分发。**

| 级别 | 问题 | 修复 |
| --- | --- | --- |
| **Critical** | 插件 HTTP 路由（`/config` `/run` `/sysinfo` `/qr` `/duty`）无鉴权且接受跨站请求：任意网页可改写 `pythonPath` 再调 `/run`，等于本地任意程序执行 | 所有路由前置同源门（`token` / `Sec-Fetch-Site: same-origin` / `Origin == Host` 三选一），不满足直接 403 且**不执行任何动作**；新增 `GET /token` 一次性令牌 |
| High | 能力等级闸门可被 agent 自己打开（`douyin_config` 能写 `tier*`） | 工具层拒绝写 `tier*`，只能用户在设置页点；设置页（同源 HTTP）不受影响 |
| High | 抖音 Cookie 会被发到任意外部主机（候选直链只做子串匹配，无条件附 Cookie） | 用 `urlsplit().hostname` 做后缀白名单，非抖音 CDN 域**不带 Cookie** |
| High | 任意 `http(s)` 地址直通浏览器（SSRF），可把内网页文本读回 | `_assert_douyin_url` 只放行抖音域与短链域，否则 `StepError` 且不调 `page.goto` |
| High | 点赞/收藏的「纠偏二次点击」在计数被缩写（`1.2万`）时会把状态翻反 | 计数不可观测时**不补第二枪**，返回 `state:'uncertain'` + 原因 |
| High | 登录假成功（找不到登录按钮就当成已登录，导出无 `sessionid` 的 cookie） | 成功判据只认 `sessionid/sid_tt` 等 session cookie；导出前后各校验一次 |

顺带修：数值校验（`count` / `downloadTimeout` 非法直接拒）；`douyin_scroll` 的 `screens` 改为**实际**屏数（`duty.json` 额度不再虚记）；`window` 登录改后台派生 + `douyin_login_poll` 轮询（不再阻塞 5 分钟）；netscape cookie 支持 `#HttpOnly_` 前缀（原来会丢掉 `sessionid`）；pip 回退镜像去掉 `--trusted-host`；下载加整体 deadline / `max_bytes` / `Content-Length` 校验；`files` 收紧为 `scripts/*.py`，`py_compile` 的 `.pyc` 不再进包。

> ⚠️ 副作用：`curl` 等本机脚本现在**打不通**插件 HTTP 路由（拿不到令牌）。这是堵住 C1 的必然代价；调试请走 MCP 工具。

### v1.2.1 — 装入配置环境（2026-10-29）

- 新增 `douyin_setup`（16 个工具）：扫描本机 Python / ffmpeg / 模型 / cookie，能复用就不装；需要时才建独立 venv 并装 `playwright` + `sherpa-onnx`。
- 设置页「环境与诊断」页只有一个【一键配置环境】按钮，其余收在「高级选项」里。
- 新增 ③A 轻互动 `douyin_react`（点赞 / 取消赞 / 收藏 / 取消收藏），仍受 `tierReact` 闸门约束、默认关闭。
- venv 基于 **DSH 自带 Python**，用户无需自己安装 Python；⚠️ 插件升级 / `npm install` 会清掉 `<插件根>/venv`，需重装。

### v1.2.0 — 首个公开版本（2026-10-28）

- 16 个工具 + 五档能力闸门（① 只读 / ② 通知 / ③A 轻互动 / ③B 评论 / ④ 发布，默认只开只读）。
- 刷屏下载、本地 SenseVoice 转写、只读四件（热榜 / 搜索 / 视频 / 评论）、图文、通知与私信、双模式登录、谷时自动刷调度。
- 设置页两套布局可切（`classic` 平铺 / `tabs` 四标签页），顶部状态栏显示环境 / cookie / 素材 / 版本。
- 浏览器内核可选（`msedge` / `chrome` / `chromium` / `firefox` / `webkit`），支持扫描开始菜单与桌面的 `.lnk`、手动添加自定义 exe。
## 附：维护者笔记

| 文件 | 职责 |
| --- | --- |
| `index.js` | 16 个工具的实现（原有 4 + 只读 5 + 通知 2 + 登录 2 + 轻互动 1 + 谷时自动刷 1 + 装入配置环境 1）+ zod `Config` + 配置合并优先级 + `workRoot()`/`workVideos()` 工作目录约定 + manifest 解析（`parseManifest` / `manifestItems`）+ HTTP `/api/douyin-audio/{config,run,sysinfo,qr}` 路由（`run` 用 `douyin_` + `action` 映射到已注册工具；`sysinfo` 只读返回 `cores`/`platform`/`arch`/`totalMemGB`；`qr` 直接回 `login/qr.png` 的 PNG 字节） |
| `selfcheck.mjs` | 本地预检：假 ctx 跑一次 `apply()`，校验工具注册与参数 schema；`node selfcheck.mjs`，退出码 0=通过 |
| `lib/state.mjs` | 家的路径（`DSH_HOME`）、`DEFAULTS`、`loadCfg`/`saveCfg`、日志轮转 |
| `lib/runner.mjs` | Python 探测（按模块名 import 试探）、脚本执行、pipe→cmd 沙箱降级、`childEnv()` 注入 `DSH_DOUYIN_TMP` |
| `lib/hostdeps.mjs` | 从宿主加载 `defineTool` / `z` |
| `scripts/douyin_scroller.py` | Playwright 刷屏 + 截图 + 下载（候选分组 + SHA256 去重 + 音轨校验）+ manifest；启动时把 stdout/stderr 钉成 UTF-8，避免 GBK 控制台打印中文抛异常吞掉主流程 |
| `scripts/transcribe_douyin.py` | ffmpeg 转 WAV → SenseVoice 本地转写，v1.2.0 CLI，`--json` 输出给工具层解析 |
| `scripts/douyin_read.py` | 只读查询 CLI：`hot` / `search` / `video` / `comments` / `notes` / `messages` 六个子命令（后两个要登录态，可用 `--url` 覆盖默认地址），统一 `--json` 信封，选择器多候选 + 兜底；`lib/runner.mjs` 的 `SCRIPT_READ` 指向它 |
| `cordis.patch.yml` | bundle 挂载声明（`id: douyin-audio`） |

改默认行为改 `lib/state.mjs` 的 `DEFAULTS`；改工具签名改 `index.js`；两边要同步（`index.js` 的 `Config` 也要跟着加键，否则 profile 传进来的值会被忽略）。

`package.json` 的 `files` 已包含 `selfcheck.mjs`，因此 npm 包里带着它，可以直接 `node node_modules/dsh-douyin-audio/selfcheck.mjs` 自检。新增源文件记得同步加进 `files`，否则不会被发布。

### 发版（npm）

已发布：<https://www.npmjs.com/package/dsh-douyin-audio>（维护者 `queyuan`）

1. **改版本号**（`package.json` 的 `version`），语义化版本：
   - 修 bug / 改文案 → `1.2.1`
   - 加功能 → `1.3.0`
   - 破坏性变更（改配置键名、改工具参数、改返回结构）→ `2.0.0`
2. **提交并推两个远端**：`git add -A && git commit -m "release: v1.2.1" && git push`
3. **登录并发布**：
```bash
npm login                 # 浏览器授权一次；网络超时就重试，registry 会间歇性抽风
npm publish --otp=123456  # 123456 换成手机验证器里当前的 6 位码
```
   ⚠️ **不要用「绕过 2FA」的令牌发布**：npm 会把这类发布转入分阶段审核（`0.0.0-stage` 占位版本就是这么来的），还得去网页手动批准。用 `npm login` + `--otp` 走正规 2FA 是长期有效路径（2027 年 1 月起，绕过 2FA 的令牌将无法直接发布）。
4. **验证**：`https://registry.npmjs.org/dsh-douyin-audio` 的 `dist-tags.latest` 应为新版本号。npm 会提示 "may take a few minutes"，实测 1–2 分钟内生效。

> 包里还留着一个 `0.0.0-stage` 占位版本（首次发布被转入分阶段审核时产生）。它不影响 `latest`，安装时只会拉 `latest`，可以无视。
