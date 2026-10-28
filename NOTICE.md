# 第三方代码与署名说明

本项目 `dsh-douyin-audio`（刷抖音 + 音频转写，作者：**大肥鱼、豆老师**）本体以 **MIT** 协议发布，
正文见同目录 `LICENSE`。

## 包含的第三方代码

### lib/hostdeps.mjs

- 来源项目：**dsh-bili-scroll**（中文名「刷B站」）
- 作者：**c1overzz**
- 仓库：https://github.com/c1overzz/dsh-bili-scroll
- 协议：MIT
- 使用方式：**逐字节原样拷贝，未做修改**
- 文件：`lib/hostdeps.mjs`（7098 字节，SHA256 `6ADCD90C8CA33B7BB5DF3AEFD790A7452AC088D81465912CEDEA085C0318D35F`）
- 作用：在 DSH 桌面版上解析宿主侧的 `@deepseek-ai/*` 依赖
  （桌面版 profile 是 `autoInstallPeers: false`，这类 optional peer 永远不会被装上），
  拿不到宿主那棵树时退回本地等价实现，避免「一个 import 让整条插件不激活」。
- 保留原样的理由：该文件承载的是原作者踩坑得到的解法，改动即失去可对照性。

### 未随包分发的运行时依赖

以下依赖由使用者环境提供，本项目不打包、不修改、不重新分发：

- **ffmpeg**（LGPL/GPL，视构建而定）—— 用于音频转码与音轨探测
- **sherpa-onnx** + **SenseVoice 模型**（Apache-2.0 / 模型自带协议）—— 本地语音识别
- **Python 3** 标准库与 `numpy`、`soundfile`
- **Playwright** 及其浏览器 —— 页面自动化

## 本项目自有部分

除上述 `lib/hostdeps.mjs` 外，其余文件为本项目自行编写：

| 文件 | 说明 |
|---|---|
| `index.js` | host 半端：4 个工具 + HTTP 接口 + 配置 |
| `client.js` | 浏览器半端：设置页（注册 `settings.section`） |
| `lib/runner.mjs` | Python 探测与执行（含沙箱降级） |
| `lib/state.mjs` | 状态目录、配置、日志轮转 |
| `scripts/douyin_scroller.py` | 刷抖音脚本（候选分组 / 去重 / 音轨校验） |
| `scripts/transcribe_douyin.py` | 转写 CLI |
| `selfcheck.mjs` | 预检（假 ctx 真跑 `apply()`） |
| `README.md` | 使用文档 |
