# HANDOFF —— 当前状态与决策记录

> 用途：会话上下文过长时，新开会话直接读本文件即可接手，不需要翻历史。
> 最后更新：2026-11-04（对应 1.4.0 / 见 `git log`）

## 1. 现在是什么状态

| 项 | 值 |
| --- | --- |
| 版本 | **1.4.0**（`package.json`） |
| 工具数 | **17**（`node selfcheck.mjs` 必须输出「17 个工具」） |
| 双远端 | `origin`=GitHub `queyuan072/dsh-douyin-audio`；`gitcode`=AtomGit 同名仓库 |
| npm | **停在 1.2.3 未更新**（用户明确选择「只升版本打 tag，先不发 npm」） |
| tag | `v1.3.0`、`v1.4.0` 已推双端 |

**改完代码必须做**（顺序固定）：
1. 复制到安装副本 `C:\Users\20155\.dsh\profiles\desktop\node_modules\dsh-douyin-audio`（index.js / client.js / selfcheck.mjs / README.md / package.json / scripts/*.py / lib/*.mjs）
2. 在安装副本里跑 `node selfcheck.mjs`，必须 EXIT=0 且 17 个工具
3. **重启 DSH**（bundle 层只在启动时叠加）
4. `git commit` → `git push origin main` → `git push gitcode main`（**两个都要推，别只推 origin**）

## 2. 这一轮做完的事（都有实测数据）

### 2.1 长音频静默截断（最关键的修复）
同一段 120 秒音频（`video_002.mp4` 前 120s），同机同线程：

| 模式 | 字数 | 残句 | 说明 |
| --- | --- | --- | --- |
| 整段一次解码（旧） | **37** | — | 退出码 0，但 80% 内容被静默丢弃 |
| 30s 硬切分片 | 177 | 2 | 有整片只出 1 字（60–90s 那段） |
| **分片 + 静音吸附（现在）** | **305** | **0** | `CHUNK_SEC=30`，切点在 20–32s 窗口内找 ≥0.25s 的 −35dB 静音取中点 |

相关实现：`scripts/transcribe_douyin.py` 的 `_decode_once` / `_pick_quiet_cut` / `transcribe_media`；CLI 有 `--chunk`（0=旧行为）`--no-snap``--srt`。

### 2.2 第 17 个工具 `douyin_fetch`（链接驱动 + 字幕优先）
- **有字幕** → `yt-dlp --write-subs` 抓下来解析 vtt/srt，**不下载音轨、不跑 ASR**
- **无字幕** → 下载音轨 → 复用上面的分片+吸附管线
- **抖音页面链接** → yt-dlp 拿不到（要 a_bogus 签名），改走 **Playwright 拦截 `douyinvod` 直链** → 下载 → ASR（`resolvedBy:"browser"`，`mediaUrl` 已脱敏）
- 真机结果：抖音 `/video/7698723598362368697` → ok，title=「就让坚持拍电影感但毫无流量的我们…」，author=鹤望兰；B 站 `BV1GJ411x7h7` → 296 字 / 7 片 / 8.2s
- 图文 `/note/` → 2.4s 内判「无音轨」快速失败

### 2.3 选择器体检 `douyin_status({selftest:true})`
真机结果：热榜 ok(71)、推荐 ok(3，改指 `/friend` 后)、私信 ok(3)、通知 **notfound**。
`verdict` 取值：`ok` / `missing`（地址对但选择器全 0）/ `notfound`（抖音 404 页）/ `unknown`（验证墙、需登录）。

## 3. 挖出并修掉的真 bug（都是「静默失败」类）

| 问题 | 真相 | 修法 |
| --- | --- | --- |
| `douyin_messages` 永远空 | `/messages` 是 404 页 | 真路径是 **`/chat`**（实测拿到 JSEN/妙咪/舟懿 三个会话） |
| `douyin_notes` 永远空 | 通知页 **Web 端不存在**（实测 25 个候选 URL 全 404） | 保留常量但明确判 `notfound`，报错写明「Web 端无独立通知页，入口是页内弹层」 |
| `preferSubtitle` 传了不生效 | 脚本没有对应开关 | 脚本新增 `--no-subtitle`，宿主透传 |
| 截断 text 却不报原长 | 调用方无法判断结果可信度 | 脚本只截 text、segments 保留完整时间轴，回报 `textLength`/`truncated` |

**判断标准（沿用）**：一个结果要么可信，要么明确说不可信；不允许「看起来成功、实际是假的」。

## 4. 安全修复（1.2.2 那一批，已合入）
C1 插件 HTTP 路由加同源门（token / Sec-Fetch-Site / Origin==Host + **Host 白名单防 DNS rebinding**）；H1 tier 闸门不可由 agent 自解锁；H2 Cookie 域名白名单；H3 SSRF 域名校验；H4 计数不可观测时不反向补点；H5 登录只认 session cookie。
**注意**：1.2.2 曾有回归（同源门过严导致设置页 403），1.2.3 已修；现在门是「只按正面证据拒绝」。

## 5. 已知限制（别再重复踩）
- 抖音页面链接靠浏览器兜底，**headless 可能被风控拦** → 加 `--window-offscreen`（可见窗口移屏幕外）可过
- 只下发分离视频轨的视频 → 报「只有视频轨、没有音轨」（不做 mux）
- `codegeex-4`（智谱代码模型）**不支持工具调用**（`tool_choice=required` 也返回 0 个 tool_calls）→ 不能当子代理
- 智谱 `glm-5.3`/`glm-4.7` **不支持图片输入**（400：content.type 只允许 text）；识图用 `glm-4.5v`/`glm-4v-plus`
- `-realtime` / `-audio` / `-embedding` / `-rerank` 类模型在 Chat Completions 下不可用（500/400）
- 抖音 `/models` 之类目录不等于可用：`cmaas-qwen3.8-flash` 会 403
- 千问 `qwen3.8-max` 实际 ID 是 `qwen3.8-max-0902`

## 6. 待办（按优先级）

**P0（用户要求过、还没做）**
- 通知改走接口：拦截 `/aweme/v1/web/notice/…`（XHR 已确认存在），让 `douyin_notes` 真能用
- 密钥文件从 `D:\大肥鱼\工作区\ai\key.txt` 挪到 `C:\Users\20155\.dsh\ai\key.txt`（工作区已两次被清空导致两个工具失效）

**P1**
- 默认 `--chunk` 是否降到 20–25s（目前保持 30，靠吸附规避）
- 选择器体检加一条「推荐页依赖登录」的说明（游客态 `/friend` 是登录墙 → unknown）

**P2**
- npm 发 1.4.0（需要用户提供令牌）
- FunASR/GPU 后端（本机无 NVIDIA GPU，性价比最低，暂不做）
- 转写后自动总结/入库（下游管道）

## 7. 环境（本机实测值）
- python（带 playwright + sherpa）：`C:\Users\20155\AppData\Local\Doubao\User Data\sandbox_runtime\bases\9f6d27f23933fb44a3a1c728c88a5ce4\python\python.exe`
- node：`C:\Users\20155\nodejs\node-v22.23.4-win-x64\node.exe`
- ffmpeg：`C:\Users\20155\.dsh\bin\ffmpeg.exe`；模型：`C:\Users\20155\.dsh\models\sherpa-sense-voice\sherpa-sense-voice-zh-en-ja-ko-yue-2024-07-17`
- cookie：`C:\Users\20155\.dsh\cookies\douyin_cookies.txt`（账号 鹊渊 / 69154390456）
- 状态目录：`C:\Users\20155\.dsh\douyin-duty\`（config.json / duty.json / account.json / setup.log / diag-*.txt）

## 8. 模型 provider（用户 2026-11-04 在设置里自行添加）
- `qwen`：`https://dashscope.aliyuncs.com/compatible-mode/v1`，OpenAI Chat Completions
  模型：`qwen3.8-flash`（文本）、`qwen3.8-max-0902`（文本）、`qwen3.8-omni-flash`（文本+图片）
- `zhipu`：`https://open.bigmodel.cn/api/paas/v4`，OpenAI Chat Completions
  模型：`glm-5.3`、`glm-5.3-flash`（文本）、`glm-4.5v`（文本+图片）、`codegeex-4`（文本，**无工具调用**）
- 两家都实测支持工具调用（除 codegeex-4）
