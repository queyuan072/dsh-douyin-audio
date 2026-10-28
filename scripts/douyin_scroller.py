# -*- coding: utf-8 -*-
"""
抖音自动刷视频工具 (Douyin Auto Scroller) v1.1.1
=============================================
用浏览器自动化打开抖音网页版，自动下滑浏览推荐视频流。

v2.1 修复：失败一律 exit 2；滚动位置真实性校验；截图入 %TEMP%/douyin；参数上限
v2.2 修复：定位真正的滚动容器（内容区在内部 div）；强制移除弹窗并解锁滚动
v2.3 修复：
  - 登录墙检测不再只靠类名（抖音弹窗类名是 douyin_login_new_class，
    不含 modal/dialog/popup），改为 文本信号 + 全屏覆盖层层级信号 双重检测
  - 每屏都查登录墙/验证码：检测到就移除；移除后仍复现 → 如实报失败 exit 2
  - 超时强杀进程树（taskkill /T /F，不残留 msedge）
  - 截图目录只保留最近 20 张
  - 滚动到底部（内容加载完）按正常结束处理，不再误判 stall
v2.4 新增：--tab 参数切换 推荐/精选 页（默认推荐）
v2.5 新增：推荐页模式适配（单视频全屏流，滚轮切视频 + 标题变化校验 + 关闭新手引导）
v2.6 新增：推荐页每个视频都截图（精选页仍按 shot-every 间隔）
v2.7 新增：
  - 每屏抓取视频真实直链（mp4），写入 %TEMP%/douyin/manifest.txt（屏数|标题|直链）
  - --save-all：把每个视频下载为 mp4（含音轨）存到 %TEMP%/douyin/videos/
    声音识别链路：下载 mp4 → 提取音频转写文本 → DeepSeek 读懂内容

用法:
    python douyin_scroller.py                     # 默认刷 60 屏，每屏停留 2.5 秒
    python douyin_scroller.py --count 30          # 只刷 30 屏
    python douyin_scroller.py --minutes 10        # 刷满 10 分钟自动停
    python douyin_scroller.py --delay 3.0         # 每屏停留 3 秒
    python douyin_scroller.py --headless          # 后台刷（不弹窗口）

退出码: 0 = 正常刷完; 2 = 失败（验证码/登录墙挡死、页面卡死、浏览器异常）
按 Ctrl+C 随时停止。
"""

import argparse
import hashlib
import os
import shutil
import subprocess
import sys

# Windows 控制台默认 GBK，打印中文/符号会抛 UnicodeEncodeError 并打断主流程 —— 钉死 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import tempfile
import time
import urllib.request
from datetime import datetime
from urllib.parse import urlsplit

import re
from playwright.sync_api import sync_playwright

DOUYIN_URL = "https://www.douyin.com/"
_DEFAULT_COOKIE_FILE = os.path.join(os.path.expanduser("~"), ".dsh", "cookies", "douyin_cookies.txt")


def _resolve_cookie_file(cli_cookies=None):
    """cookie 文件优先级：--cookies > 环境变量 DOUYIN_COOKIE_FILE > ~/.dsh/cookies/douyin_cookies.txt"""
    if cli_cookies:
        return os.path.expanduser(cli_cookies)
    env = os.environ.get("DOUYIN_COOKIE_FILE")
    if env:
        return os.path.expanduser(env)
    return _DEFAULT_COOKIE_FILE


DOUYIN_COOKIE_FILE = _resolve_cookie_file()


# 抖音视频/CDN 域后缀白名单：只有这些 host 才允许附带登录态 Cookie
# （判据是 urlsplit().hostname 的后缀，绝不用「URL 里出现过 douyinvod.com」这种子串匹配）
_MEDIA_HOST_SUFFIXES = (
    "douyinvod.com", "douyin.com", "amemv.com", "byteimg.com", "douyinpic.com",
    "douyinstatic.com", "bytecdn.cn", "pstatp.com", "snssdk.com",
)


def _host_of(url):
    """URL → 小写 hostname；解析不出来就返回空串（绝不抛）"""
    try:
        return (urlsplit(str(url or "")).hostname or "").lower().rstrip(".")
    except Exception:
        return ""


def _is_douyin_media_host(url):
    """候选直链的 host 是否属于抖音自己的 CDN（后缀白名单）。
    攻击者能让页面出现 https://evil.example/x?u=douyinvod.com 这种 URL，
    所以判据只能是 host 本身，不能是整条 URL 的子串。"""
    host = _host_of(url)
    if not host:
        return False
    return any(host == suf or host.endswith("." + suf) for suf in _MEDIA_HOST_SUFFIXES)


def _load_douyin_cookie():
    """读游客 cookie（netscape 格式）→ Cookie 头；抖音 CDN 无 cookie 会降级返回纯视频流（无音轨）"""
    try:
        ck = []
        with open(DOUYIN_COOKIE_FILE, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if ln.startswith("#HttpOnly_"):
                    # netscape 用 #HttpOnly_ 前缀标记 httpOnly；剥掉前缀继续解析，
                    # 否则 sessionid 这类整条 httpOnly 的 cookie 会被当注释丢掉
                    ln = ln[len("#HttpOnly_"):]
                elif not ln or ln.startswith("#"):
                    continue
                parts = ln.split("\t")
                if len(parts) >= 7:
                    ck.append(f"{parts[5]}={parts[6]}")
        return "; ".join(ck)
    except Exception:
        return ""

# 拦截到的真实视频直链（douyinvod / aweme play），取最近一个为当前视频
_video_urls = []


# 候选 URL 的路径特征（真正的视频流才会命中；先判 host 再判路径）
_MEDIA_URL_HINT = re.compile(r"douyinvod\.com|/aweme/v1/play", re.I)
_STATIC_URL = re.compile(r"\.(?:js|css|png|jpe?g|webp|gif|ico)(?:[?#]|$)", re.I)


def _looks_like_media_url(u):
    """是不是候选视频直链：必须 http(s) + host 在 CDN 白名单 + 路径像视频流"""
    if not u or not re.search(r"^https?://", str(u), re.I):
        return False
    if not _is_douyin_media_host(u):
        return False
    return bool(_MEDIA_URL_HINT.search(u)) and not _STATIC_URL.search(u)


def _on_video_response(resp):
    try:
        u = resp.url
        if not _is_douyin_media_host(u):
            # 外域一律不收集：收集了就会在下载时被附带 Cookie（H2）
            if _MEDIA_URL_HINT.search(str(u or "")):
                print("[跳过] 非抖音 CDN 域的响应不进候选: {}".format(str(u)[:160]))
            return
        if _looks_like_media_url(u):
            _video_urls.append(u)
            if len(_video_urls) > 100:
                del _video_urls[:-50]
    except Exception:
        pass


def _default_work_dir():
    """产物目录：环境变量 DSH_DOUYIN_TMP 优先于默认的 <系统临时目录>/douyin"""
    env = os.environ.get("DSH_DOUYIN_TMP")
    return os.path.expanduser(env) if env else os.path.join(tempfile.gettempdir(), "douyin")


def _apply_work_dir(path):
    """切换截图/视频/manifest 所在的产物目录"""
    global SHOT_DIR, VIDEO_DIR, MANIFEST
    SHOT_DIR = os.path.expanduser(path)
    VIDEO_DIR = os.path.join(SHOT_DIR, "videos")
    MANIFEST = os.path.join(SHOT_DIR, "manifest.txt")


SHOT_DIR = _default_work_dir()
VIDEO_DIR = os.path.join(SHOT_DIR, "videos")
MANIFEST = os.path.join(SHOT_DIR, "manifest.txt")
KEEP_SHOTS = 60  # 截图目录最多保留的张数（推荐页每屏一张，留 60 屏的量）
UA_STRING = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0")

# 浏览器候选链：--browser-channel 选首选，其余按下面的顺序兜底
BROWSER_CHANNELS = ("msedge", "chrome", "chromium", "firefox", "webkit")
# Chromium 家族：只有它们才带 channel 参数、也只有它们之间允许互相回退
CHROMIUM_FAMILY = ("msedge", "chrome", "chromium")


def browser_candidates(preferred):
    """按用户选择把候选链排好。
    Chromium 家族之间互相回退（同一引擎，指纹相近）；firefox / webkit 是不同引擎，
    不装就直接报错，绝不静默退到别的内核（否则你以为在测 firefox，其实跑的是 Edge）"""
    preferred = preferred if preferred in BROWSER_CHANNELS else "msedge"
    if preferred == "chrome":
        return ["chrome", "msedge", "chromium"]
    if preferred == "chromium":
        return ["chromium"]
    if preferred in ("firefox", "webkit"):
        return [preferred]
    return ["msedge", "chrome", "chromium"]


def _brief(exc, limit=200):
    """异常压成一行短句（playwright 的异常常带多行 call log）"""
    try:
        text = " ".join(str(exc).split())
    except Exception:
        text = exc.__class__.__name__
    return text[:limit] or exc.__class__.__name__


def _require_executable(path):
    """--browser-executable 给了就必须真的存在：不存在直接报错，绝不静默改回 msedge"""
    if not path or not str(path).strip():
        return None
    path = os.path.expanduser(os.path.expandvars(str(path).strip()))
    if not os.path.isfile(path):
        raise RuntimeError("指定的浏览器不存在：{}".format(path))
    return path


def _engine(pw, channel):
    """channel → (playwright 的浏览器类型对象, launch 时要多带的参数)
    Chromium 家族用 pw.chromium（msedge/chrome 带 channel）；firefox / webkit 各自的内核"""
    if channel == "firefox":
        return pw.firefox, {}
    if channel == "webkit":
        return pw.webkit, {}
    if channel in CHROMIUM_FAMILY and channel != "chromium":
        return pw.chromium, {"channel": channel}
    return pw.chromium, {}


def _launch_error(chain, errors):
    """全链条都失败时的报错；单内核（firefox/webkit）给一句能直接照抄的安装命令"""
    detail = " | ".join(errors)
    if len(chain) == 1 and chain[0] in ("firefox", "webkit"):
        return "无法启动 {}（Playwright 未安装该浏览器内核）：先运行 npx playwright install {}｜{}".format(
            chain[0], chain[0], detail)
    return "无法启动浏览器（候选链 {}）：{}".format(" / ".join(chain), detail)


def launch_browser(p, preferred, headless, extra_args=None, executable=None):
    """逐个试候选链里的内核，全失败才报错（错误里带每一条的原因）。返回 (browser, channel)
    给了 executable（用户自选浏览器）就直接用它、不走候选链"""
    custom = _require_executable(executable)
    if custom:
        # executable_path 与 channel 互斥；自选浏览器默认按 Chromium 家族处理
        kwargs = {"headless": headless, "executable_path": custom,
                  "args": list(extra_args) if extra_args else extra_args}
        try:
            browser = p.chromium.launch(**kwargs)
        except Exception as exc:
            raise RuntimeError("无法用指定的浏览器启动（{}）：{}".format(custom, _brief(exc)))
        sys.stderr.write("[browser] 使用 custom({})\n".format(os.path.basename(custom)))
        sys.stderr.flush()
        return browser, "custom({})".format(os.path.basename(custom))
    chain = browser_candidates(preferred)
    errors = []
    for channel in chain:
        engine, extra_kwargs = _engine(p, channel)
        kwargs = dict(extra_kwargs)
        kwargs["headless"] = headless
        if channel in CHROMIUM_FAMILY:
            # --autoplay-policy / --window-position 是 Chromium 系开关，firefox/webkit 传了起不来
            kwargs["args"] = list(extra_args) if extra_args else extra_args
        try:
            browser = engine.launch(**kwargs)
        except Exception as exc:
            errors.append("{}: {}".format(channel, _brief(exc)))
            continue
        sys.stderr.write("[browser] 使用 {}\n".format(channel))
        sys.stderr.flush()
        return browser, channel
    raise RuntimeError(_launch_error(chain, errors))


def open_context(browser, headless, channel):
    """实际 channel 决定要不要覆盖 UA：只有 msedge 覆盖（伪装成 Edge）；
    chrome/chromium/firefox/webkit 一律用浏览器自己的真 UA（否则 UA 与实际内核对不上）"""
    return browser.new_context(
        viewport={"width": 1600, "height": 900},
        locale="zh-CN",
        user_agent=(UA_STRING if (headless and channel == "msedge") else None),
    )


# 人机验证关键词（检测到就按验证码处理）
VERIFY_KEYWORDS = ["请完成下列验证", "完成验证", "人机验证", "验证后继续", "安全验证"]
# 登录墙文本信号（抖音未登录访客弹窗）
LOGIN_WALL_KEYWORDS = ["登录后免费畅享", "登录后继续", "扫码登录", "验证码登录", "密码登录", "暂不登录"]

# 滚动无进展判定：连续 N 屏 scrollTop 不动 = 页面卡死/被挡
STALL_LIMIT = 3


def parse_args():
    ap = argparse.ArgumentParser(description="抖音自动刷视频工具")
    ap.add_argument("--count", type=int, default=60,
                    help="下滑次数（屏数），默认 60，范围 1-600")
    ap.add_argument("--delay", type=float, default=2.5,
                    help="每屏停留秒数（视频预览播放时间），默认 2.5，范围 0.5-30")
    ap.add_argument("--minutes", type=float, default=0,
                    help="可选：刷满 N 分钟后自动停止（优先于 --count），范围 0-180")
    ap.add_argument("--tab", choices=["recommend", "feed"], default="recommend",
                    help="刷哪个页：recommend=推荐（默认），feed=精选")
    ap.add_argument("--headless", action="store_true",
                    help="后台运行不显示窗口")
    ap.add_argument("--save-all", action="store_true",
                    help="每个视频都下载 mp4（含音轨）到 %%TEMP%%/douyin/videos/")
    ap.add_argument("--shot-every", type=int, default=10,
                    help="每 N 屏截一张图（默认 10，设 0 关闭截图）")
    ap.add_argument("--download-timeout", type=float, default=300,
                    help="单个视频下载超时秒数，默认 300（慢速大文件给足时间）")
    ap.add_argument("--cookies", default=None, metavar="FILE",
                    help=f"抖音 cookie 文件（默认取环境变量 DOUYIN_COOKIE_FILE，再退回 {_DEFAULT_COOKIE_FILE}）")
    ap.add_argument("--ffmpeg", default=None, metavar="EXE",
                    help="ffmpeg 路径（默认取环境变量 FFMPEG，再探测 PATH 与 ~/.dsh/bin/ffmpeg.exe）")
    ap.add_argument("--work-dir", default=None, metavar="DIR",
                    help="截图/视频/manifest 的产物目录（默认取环境变量 DSH_DOUYIN_TMP，再退回 <系统临时目录>/douyin）")
    ap.add_argument("--browser-channel", dest="browser_channel",
                    choices=list(BROWSER_CHANNELS), default="msedge",
                    help="优先用哪个浏览器内核，默认 msedge（msedge→chrome→内置chromium，"
                         "Chromium 家族之间互相回退；firefox / webkit 是 Playwright 自编译内核，"
                         "需先 npx playwright install firefox|webkit，不装就报错、不回退）")
    ap.add_argument("--browser-executable", dest="browser_executable", default=None, metavar="PATH",
                    help="用指定的浏览器可执行文件启动（覆盖 --browser-channel：按 Chromium 内核处理、"
                         "不回退；路径不存在直接报错）")
    args = ap.parse_args()
    args.count = max(1, min(args.count, 600))
    args.delay = max(0.5, min(args.delay, 30.0))
    args.minutes = max(0.0, min(args.minutes, 180.0))
    global DOUYIN_COOKIE_FILE, _FFMPEG_OVERRIDE
    DOUYIN_COOKIE_FILE = _resolve_cookie_file(args.cookies)
    _FFMPEG_OVERRIDE = args.ffmpeg
    if args.work_dir:
        _apply_work_dir(args.work_dir)
    return args


def is_verify_page(page):
    """检测当前页面是否被人机验证挡住（含 iframe 里的滑块验证）"""
    frames = set([page.main_frame]) | set(page.frames)
    for f in frames:
        try:
            body = f.locator("body").inner_text(timeout=1500)
        except Exception:
            continue
        for kw in VERIFY_KEYWORDS:
            if kw in body:
                return True
    return False


def is_login_wall(page):
    """检测登录墙：文本信号 + 全屏固定覆盖层信号（不依赖类名）"""
    # 信号 1：页面文本含登录墙特征词
    try:
        body = page.locator("body").inner_text(timeout=2000)
        hits = [kw for kw in LOGIN_WALL_KEYWORDS if kw in body]
        if len(hits) >= 2:  # 至少两个特征词才算登录墙（避免误判普通页面）
            return True
        if "登录后免费畅享" in body:
            return True
    except Exception:
        pass
    # 信号 2：存在覆盖全屏的 fixed 层（z-index 高、面积 ≈ 视口）
    # 注意：position:fixed 元素的 offsetParent 恒为 null，不能用 offsetParent 过滤
    try:
        full = page.evaluate(
            "() => {"
            "  const vw = window.innerWidth, vh = window.innerHeight;"
            "  const els = [...document.querySelectorAll('div,section')]"
            "    .filter(e => {"
            "      const st = getComputedStyle(e);"
            "      const r = e.getBoundingClientRect();"
            "      return st.position === 'fixed'"
            "        && parseInt(st.zIndex || '0', 10) >= 900"
            "        && r.width >= vw * 0.8 && r.height >= vh * 0.8"
            "        && st.display !== 'none' && st.visibility !== 'hidden'"
            "        && r.width > 0 && r.height > 0"
            "    });"
            "  return els.length"
            "}"
        )
        if full and full > 0:
            return True
    except Exception:
        pass
    return False


def is_blocked(page):
    """综合判定：验证页 或 登录墙"""
    return is_verify_page(page) or is_login_wall(page)


def remove_login_wall(page):
    """移除登录墙/弹窗：优先文本定位，其次层级定位，再按类名兜底；同时解锁滚动"""
    removed = 0
    try:
        # 1) 文本定位：找含登录墙文案的最近弹窗容器并移除
        removed += page.evaluate(
            "() => {"
            "  const kws = ['登录后免费畅享', '登录后继续', '扫码登录', '验证码登录', '密码登录'];"
            "  const walk = (el, depth) => {"
            "    if (depth > 8 || !el || el === document.body) return null;"
            "    if (el.children && el.children.length === 0) {"
            "      if (kws.some(k => (el.textContent || '').includes(k))) return el.closest('div,section') || el;"
            "      return null"
            "    }"
            "    for (const c of el.children) {"
            "      const r = walk(c, depth + 1);"
            "      if (r) return r"
            "    }"
            "    return null"
            "  };"
            "  let n = 0;"
            "  for (let i = 0; i < 5; i++) {"
            "    const t = walk(document.body, 0);"
            "    if (!t) break;"
            "    const p = t.parentElement;"
            "    if (p) p.remove(); else t.remove();"
            "    n++"
            "  }"
            "  return n"
            "}"
        )
    except Exception:
        pass
    try:
        # 2) 层级定位：移除覆盖全屏的 fixed 层（fixed 元素 offsetParent 恒为 null，勿用它过滤）
        removed += page.evaluate(
            "() => {"
            "  const vw = window.innerWidth, vh = window.innerHeight;"
            "  const els = [...document.querySelectorAll('div,section')]"
            "    .filter(e => {"
            "      const st = getComputedStyle(e);"
            "      const r = e.getBoundingClientRect();"
            "      return st.position === 'fixed' && parseInt(st.zIndex || '0', 10) >= 900"
            "        && r.width >= vw * 0.8 && r.height >= vh * 0.8"
            "        && st.display !== 'none' && st.visibility !== 'hidden'"
            "        && r.width > 0 && r.height > 0"
            "    });"
            "  let n = 0;"
            "  for (const e of els.slice(0, 3)) { e.remove(); n++ }"
            "  return n"
            "}"
        )
    except Exception:
        pass
    try:
        # 3) 类名兜底：兼容 modal/dialog/popup 命名的弹窗
        removed += page.evaluate(
            "() => {"
            "  const els = [...document.querySelectorAll('[class*=modal],[class*=dialog],[class*=popup],[class*=login]')]"
            "    .filter(e => e.offsetHeight > 0 && e.offsetWidth > 0 && e !== document.body);"
            "  els.forEach(e => e.remove());"
            "  return els.length"
            "}"
        )
    except Exception:
        pass
    try:
        # 4) 解锁背景滚动
        page.evaluate(
            "() => {"
            "  document.body.style.overflow = '';"
            "  document.documentElement.style.overflow = '';"
            "  document.body.style.position = '';"
            "}"
        )
    except Exception:
        pass
    return removed


def scroll_state(page):
    """实际滚动位置：优先 scrollingElement，其次取溢出量最大的主滚动容器"""
    try:
        return page.evaluate(
            "() => {"
            "  const sc = document.scrollingElement;"
            "  if (sc && sc.scrollHeight > sc.clientHeight + 100) return sc.scrollTop;"
            "  const els = [...document.querySelectorAll('div,main,section')]"
            "    .filter(e => e.clientHeight > 100 && e.scrollHeight > e.clientHeight + 100)"
            "    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));"
            "  if (els.length) return els[0].scrollTop;"
            "  return window.scrollY || 0"
            "}"
        )
    except Exception:
        return -1


def scroll_down(page):
    """下滑一屏：滚溢出量最大的主滚动容器（modal 弹窗会拦截鼠标滚轮，JS 滚动更稳）"""
    try:
        return page.evaluate(
            "() => {"
            "  const sc = document.scrollingElement;"
            "  if (sc && sc.scrollHeight > sc.clientHeight + 100) { sc.scrollBy(0, 900); return true }"
            "  const els = [...document.querySelectorAll('div,main,section')]"
            "    .filter(e => e.clientHeight > 100 && e.scrollHeight > e.clientHeight + 100)"
            "    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));"
            "  if (els.length) { els[0].scrollBy(0, 900); return true }"
            "  window.scrollBy(0, 900); return false"
            "}"
        )
    except Exception:
        return False


def scroll_at_bottom(page):
    """滚动容器是否已到底（内容加载完，不是卡死）"""
    try:
        return page.evaluate(
            "() => {"
            "  const sc = document.scrollingElement;"
            "  if (sc && sc.scrollHeight > sc.clientHeight + 100) {"
            "    return sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5"
            "  }"
            "  const els = [...document.querySelectorAll('div,main,section')]"
            "    .filter(e => e.clientHeight > 100 && e.scrollHeight > e.clientHeight + 100)"
            "    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));"
            "  if (els.length) {"
            "    const e = els[0];"
            "    return e.scrollTop + e.clientHeight >= e.scrollHeight - 5"
            "  }"
            "  return false"
            "}"
        )
    except Exception:
        return False


def is_recommend_mode(page):
    """是否处于推荐页（单视频全屏流，滚轮切视频而非 scrollTop 滚动）"""
    try:
        if "recommend" in page.url:
            return True
        txt = page.locator("body").inner_text(timeout=2000)
        if "查看更多推荐视频" in txt or "我知道了" in txt:
            return True
    except Exception:
        pass
    return False


def get_video_signature(page):
    """推荐页当前视频标识（作者+标题），用于校验是否真的切到新视频"""
    try:
        return page.evaluate(
            "() => {"
            "  const sels = ['[data-e2e=\"video-player-desc\"]',"
            "    '.video-info-detail', '.dy-title', '.video-info'];"
            "  for (const s of sels) {"
            "    const el = document.querySelector(s);"
            "    if (el && el.textContent.trim().length > 5)"
            "      return el.textContent.trim().slice(0, 60)"
            "  }"
            "  return ''"
            "}"
        )
    except Exception:
        return ""


def _sha256_of(path, limit_bytes=0):
    """算文件内容哈希（用于识别「换屏但下到同一条流」）"""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return ""


# 已下载过的内容哈希：抖音换屏时 <source>/网络历史里常残留上一条流，靠它去重
_seen_hashes = set()


# main() 里由 --ffmpeg 写入；优先级最高
_FFMPEG_OVERRIDE = None


def _ffmpeg_path():
    """定位 ffmpeg（用于下载后校验音轨）
    优先级：--ffmpeg > 环境变量 FFMPEG > PATH > ~/.dsh/bin/ffmpeg.exe"""
    if _FFMPEG_OVERRIDE:
        return _FFMPEG_OVERRIDE
    env = os.environ.get("FFMPEG")
    if env:
        return env
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    bundled = os.path.join(os.path.expanduser("~"), ".dsh", "bin", "ffmpeg.exe")
    return bundled if os.path.exists(bundled) else None


def has_audio_stream(path):
    """ffmpeg -i 探测是否含音轨。抖音 DASH 会下发分离的音/视频两路，只有视频流就无法转写。
    返回 True/False；ffmpeg 不可用时返回 None（未知）"""
    ff = _ffmpeg_path()
    if not ff:
        return None
    try:
        r = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True, text=True, timeout=90)
        return "Audio:" in (r.stderr or "")
    except Exception:
        return None


def _url_group(u):
    """抖音同一条视频的音/视频轨共享 /tos-xxx/<token>/ 段，用它把候选限定在本条视频内"""
    try:
        m = re.search(r"/tos-[^/]+/([^/]+)/", u or "")
        return m.group(1) if m else ""
    except Exception:
        return ""


def grab_media_candidates(page):
    """当前视频的候选直链：先按「与 currentSrc 同属一条视频」过滤，再按更可能带音轨排序"""
    dom = []
    try:
        dom = page.evaluate(
            "() => {"
            "  const v = document.querySelector('video');"
            "  const ok = u => u && /^https?:/.test(u) && !/^blob:/.test(u) && /douyinvod|aweme/i.test(u);"
            "  const res = [];"
            "  if (v) {"
            "    for (const s of Array.from(v.querySelectorAll('source'))) {"
            "      const u = s.src || s.getAttribute('src') || '';"
            "      if (ok(u)) res.push({ url: u, type: (s.type || '').toLowerCase() });"
            "    }"
            "    if (ok(v.currentSrc)) res.push({ url: v.currentSrc, type: 'current' });"
            "    if (ok(v.src)) res.push({ url: v.src, type: 'src' });"
            "  }"
            "  return res;"
            "}"
        ) or []
    except Exception:
        dom = []

    entries = []
    for d in dom:
        if isinstance(d, dict) and d.get("url"):
            entries.append((d["url"], str(d.get("type") or "")))

    current = next((u for u, t in entries if t in ("current", "src")), "")
    group = _url_group(current)

    def same_video(u):
        """是否属于当前这条视频。有 /tos-xxx/<token>/ 段就用它精确分组；
        拿不到分组时退回「同源 host」的弱判据 —— 绝不因为「分组为空」就放行一切 URL
        （否则候选里混进外域，下载时就会把登录态带出去）。"""
        if not u or not isinstance(u, str) or not _is_douyin_media_host(u):
            return False
        if group:
            return _url_group(u) == group
        if not current:
            return True
        return _host_of(u) == _host_of(current)

    def audio_hint(u):
        return ("media-audio" in u) or ("audio_mp4" in u) or ("mime_type=audio" in u)

    audio = [u for u, t in entries if t.startswith("audio") and same_video(u)]
    audio.sort(key=lambda u: 0 if audio_hint(u) else 1)
    cur = [current] if current else []
    rest = [u for u, t in entries if u not in audio and u not in cur and same_video(u)]
    net = [u for u in reversed(_video_urls[-8:]) if same_video(u) and u not in audio and u not in cur and u not in rest]

    seen = set()
    uniq = []
    for u in audio + cur + rest + net:
        if u and u not in seen:
            seen.add(u)
            uniq.append(u)
    return uniq


def grab_media_url(page):
    """取当前视频首个候选直链（保留旧接口）"""
    cands = grab_media_candidates(page)
    return cands[0] if cands else ""
def download_video(url, path, timeout=300):
    """带 Referer 下载视频（含音轨）；Cookie 只发给抖音 CDN 白名单域，成功且非空返回 True"""
    if not url or not url.startswith("http"):
        return False
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        headers = {
            "Referer": DOUYIN_URL,
            "User-Agent": UA_STRING,
            "Accept": "*/*",
            "Range": "bytes=0-",
        }
        if _is_douyin_media_host(url):
            ck = _load_douyin_cookie()
            if ck:
                headers["Cookie"] = ck
        else:
            print("[跳过] 不附带 Cookie：非抖音 CDN 域 {!r}（只下载视频流本身 {}）".format(
                _host_of(url) or "(无法解析)", str(url)[:120]))
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r, open(path, "wb") as f:
            shutil.copyfileobj(r, f, 256 * 1024)
        return os.path.getsize(path) > 10000
    except Exception:
        return False


def trim_shots(keep=KEEP_SHOTS):
    """截图目录只保留最近 keep 张"""
    try:
        os.makedirs(SHOT_DIR, exist_ok=True)
        files = sorted(
            [os.path.join(SHOT_DIR, f) for f in os.listdir(SHOT_DIR) if f.endswith(".png")],
            key=os.path.getmtime,
        )
        for f in files[:-keep]:
            try:
                os.remove(f)
            except Exception:
                pass
    except Exception:
        pass


def main():
    args = parse_args()
    start = time.time()
    scrolled = 0
    stall = 0
    last_y = 0
    stop_by_time = args.minutes > 0
    wall_seen = 0       # 登录墙出现过的屏数计数（用于最终如实标注）
    wall_handled = 0    # 成功移除的次数

    print("=" * 50)
    print("抖音自动刷视频工具 v2.4")
    print("开始时间:", datetime.now().strftime("%H:%M:%S"))
    print("目标:", f"刷满 {args.minutes} 分钟" if stop_by_time else f"下滑 {args.count} 屏")
    print("页面:", "推荐" if args.tab == "recommend" else "精选")
    print("每屏停留:", args.delay, "秒 | 模式:", "后台" if args.headless else "窗口")
    print("=" * 50)

    blocked_reason = None
    try:
        with sync_playwright() as p:
            browser, browser_channel = launch_browser(
                p, args.browser_channel, args.headless,
                extra_args=["--autoplay-policy=no-user-gesture-required"] if args.headless else None,
                executable=getattr(args, "browser_executable", None),
            )
            ctx = open_context(browser, args.headless, browser_channel)
            page = ctx.new_page()
            page.on("response", _on_video_response)

            print("[1/3] 正在打开抖音...")
            page.goto(DOUYIN_URL, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(6000)
            trim_shots()

            # 先移除首屏登录墙（全屏 fixed 层会拦截左侧导航点击，必须先拆）
            if is_login_wall(page):
                n = remove_login_wall(page)
                if n:
                    print(f"[提示] 检测到登录墙并移除 {n} 个覆盖层")
                    page.wait_for_timeout(800)

            # 页面切换：推荐（默认）/ 精选 —— 必须在登录墙移除之后点击，否则被墙拦截
            if args.tab == "recommend":
                clicked = False
                # 方案1：抖音左侧导航推荐 tab 的稳定 class
                try:
                    loc = page.locator(".tab-recommend")
                    if loc.first.is_visible(timeout=1500):
                        loc.first.click(timeout=3000)
                        clicked = True
                except Exception:
                    pass
                # 方案2：精确文本"推荐"（左侧导航 span）
                if not clicked:
                    try:
                        loc = page.get_by_text("推荐", exact=True)
                        if loc.first.is_visible(timeout=1500):
                            loc.first.click(timeout=3000)
                            clicked = True
                    except Exception:
                        pass
                if clicked:
                    page.wait_for_timeout(3500)
                    print("[提示] 已切换到推荐页")
                    # 关闭推荐页新手引导（"我知道了"遮罩）
                    try:
                        if page.get_by_text("我知道了").first.is_visible(timeout=1500):
                            page.get_by_text("我知道了").first.click()
                            page.wait_for_timeout(1200)
                            print("[提示] 已关闭新手引导")
                    except Exception:
                        pass
                else:
                    print("[提示] 左侧推荐入口点击失败，继续刷当前页")
            else:
                print("[提示] 精选页")

            # 关闭可能出现的登录弹窗（Esc 兜底 + 常见按钮选择器）
            try:
                page.keyboard.press("Escape")
                page.wait_for_timeout(800)
            except Exception:
                pass
            for selector in [
                "text=暂不登录", "text=游客模式", "text=随便看看",
                "[aria-label='关闭']", ".dy-account-close",
                "text=稍后再看",
            ]:
                try:
                    if page.locator(selector).first.is_visible(timeout=800):
                        page.locator(selector).first.click()
                        page.wait_for_timeout(800)
                        print("[提示] 已关闭登录弹窗")
                        break
                except Exception:
                    continue

            # 登录墙 / 验证码 首屏处理
            if is_login_wall(page):
                n = remove_login_wall(page)
                wall_seen += 1
                if n:
                    wall_handled += n
                    print(f"[提示] 检测到登录墙并移除 {n} 个覆盖层")
                    page.wait_for_timeout(800)
            if is_verify_page(page):
                if not handle_verify(page):
                    os.makedirs(SHOT_DIR, exist_ok=True)
                    shot = os.path.join(SHOT_DIR, "verify_blocked.png")
                    page.screenshot(path=shot)
                    blocked_reason = f"被验证码挡住，已截图 {shot}"
                    print(f"\n[结束] {blocked_reason}")
                    browser.close()
                    sys.exit(2)

            os.makedirs(SHOT_DIR, exist_ok=True)
            try:
                with open(MANIFEST, "w", encoding="utf-8") as mf:
                    mf.write(f"# 抖音刷视频清单 v2.7 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            except Exception:
                pass
            print("[2/3] 开始自动刷视频（Ctrl+C 可随时停止）...")
            recommend_mode = is_recommend_mode(page)
            if recommend_mode:
                print("[提示] 检测到推荐页模式（滚轮切视频）")
            last_y = scroll_state(page)
            last_sig = get_video_signature(page)

            while True:
                elapsed = time.time() - start
                if stop_by_time and elapsed >= args.minutes * 60:
                    print(f"\n[完成] 已达到 {args.minutes} 分钟")
                    break
                if not stop_by_time and scrolled >= args.count:
                    print(f"\n[完成] 已下滑 {scrolled} 屏")
                    break

                # 每屏先处理登录墙（成本低，移除后继续刷）
                if is_login_wall(page):
                    wall_seen += 1
                    n = remove_login_wall(page)
                    if n:
                        wall_handled += n
                        print(f"\n[提示] 登录墙再现，已移除 {n} 个覆盖层")
                        page.wait_for_timeout(600)
                    else:
                        # 移除没效果：登录墙还在挡着 → 如实失败
                        os.makedirs(SHOT_DIR, exist_ok=True)
                        shot = os.path.join(SHOT_DIR, "login_wall.png")
                        try:
                            page.screenshot(path=shot)
                        except Exception:
                            shot = "(截图失败)"
                        blocked_reason = (
                            f"登录墙无法移除（第 {scrolled + 1} 屏仍被登录弹窗挡住），"
                            f"已截图 {shot}"
                        )
                        print(f"\n[结束] {blocked_reason}")
                        browser.close()
                        sys.exit(2)

                if recommend_mode:
                    # 推荐页：真实滚轮切视频（可能一次不够，最多试 3 次并校验标题变化）
                    sig_before = last_sig
                    moved = False
                    for _ in range(3):
                        try:
                            # 强制关闭各种引导蒙层（点已知按钮）
                            page.evaluate(
                                """() => {
                                    const kws = ['我知道了', '稍后再看', '暂不登录', '知道了', '下一步'];
                                    const els = Array.from(document.querySelectorAll('button, div, span'));
                                    const btn = els.find(e => kws.some(k => e.textContent.trim() === k));
                                    if (btn) btn.click();
                                }"""
                            )
                            # 点击屏幕中心，确保视频获得焦点（防止滚轮被拦截）
                            page.mouse.click(800, 450)
                            page.wait_for_timeout(200)
                            # 双管齐下：滚轮 + 键盘下键
                            page.mouse.wheel(0, 900)
                            page.keyboard.press("ArrowDown")
                        except Exception:
                            try:
                                page.keyboard.press("ArrowDown")
                            except Exception:
                                break
                        time.sleep(0.5)
                        if get_video_signature(page) != sig_before:
                            moved = True
                            break
                    scrolled += 1
                    time.sleep(args.delay)
                    last_sig = get_video_signature(page)
                    # sig_before 为空 = 这次读不到视频签名（推荐页首屏常见），
                    # 此时 stall 判定无据可依：不参与，否则 3 屏后就会误报「切换无进展」
                    if sig_before and not moved and last_sig == sig_before:
                        stall += 1
                        if stall >= STALL_LIMIT:
                            os.makedirs(SHOT_DIR, exist_ok=True)
                            shot = os.path.join(
                                SHOT_DIR,
                                f"stalled_{datetime.now().strftime('%H%M%S')}.png",
                            )
                            try:
                                page.screenshot(path=shot)
                            except Exception:
                                shot = "(截图失败)"
                            blocked_reason = (
                                f"推荐视频切换无进展（已下滑 {scrolled} 屏但视频未变化），"
                                f"疑似被弹窗或验证码挡住，已截图 {shot}"
                            )
                            print(f"\n[结束] {blocked_reason}")
                            browser.close()
                            sys.exit(2)
                    else:
                        stall = 0
                else:
                    # 精选页：JS 滚动实际滚动容器（modal 弹窗会拦截鼠标滚轮，JS 滚动更稳）
                    if not scroll_down(page):
                        try:
                            page.mouse.wheel(0, 900)
                        except Exception:
                            page.keyboard.press("PageDown")
                    scrolled += 1
                    time.sleep(args.delay)

                    # 真实进度校验：滚动位置连续没变 = 页面没在滚（被挡/卡死）
                    y = scroll_state(page)
                    if y == last_y:
                        if scroll_at_bottom(page):
                            # 已到底部 = 内容加载完，正常结束
                            print(f"\n[完成] 已滑到内容底部（{scrolled} 屏），正常结束")
                            break
                        stall += 1
                        if stall >= STALL_LIMIT:
                            os.makedirs(SHOT_DIR, exist_ok=True)
                            shot = os.path.join(
                                SHOT_DIR,
                                f"stalled_{datetime.now().strftime('%H%M%S')}.png",
                            )
                            try:
                                page.screenshot(path=shot)
                            except Exception:
                                shot = "(截图失败)"
                            blocked_reason = (
                                f"页面滚动无进展（已下滑 {scrolled} 屏但滚动位置未变化），"
                                f"疑似被验证码或弹窗挡住，已截图 {shot}"
                            )
                            print(f"\n[结束] {blocked_reason}")
                            browser.close()
                            sys.exit(2)
                    else:
                        stall = 0
                        last_y = y

                # 截图：推荐页每个视频都截；精选页按 shot-every 间隔截
                if recommend_mode:
                    # 推荐页：每个视频一张，便于逐条读图汇报
                    try:
                        shot = os.path.join(
                            SHOT_DIR,
                            f"scroll_{scrolled:03d}_{datetime.now().strftime('%H%M%S')}.png",
                        )
                        page.screenshot(path=shot)
                        trim_shots()
                    except Exception:
                        pass
                    # 抓当前视频直链写入清单
                    try:
                        cands = grab_media_candidates(page)
                        media = cands[0] if cands else ""
                        sig = last_sig or get_video_signature(page)
                        with open(MANIFEST, "a", encoding="utf-8") as mf:
                            mf.write(f"{scrolled}|{sig[:60].replace('|', ' ')}|{media}\n")
                        # 可选：下载 mp4（含音轨）供后续声音转写
                        if args.save_all and cands:
                            vpath = os.path.join(VIDEO_DIR, f"video_{scrolled:03d}.mp4")
                            chosen = None
                            fallback = None
                            for cand in cands[:4]:
                                tmp = vpath + ".part"
                                if not download_video(cand, tmp, timeout=args.download_timeout):
                                    continue
                                digest = _sha256_of(tmp)
                                if digest and digest in _seen_hashes:
                                    print(f"\n[下载] 第 {scrolled} 屏候选是重复内容（与已下载相同），换下一个")
                                    try:
                                        os.remove(tmp)
                                    except OSError:
                                        pass
                                    continue
                                aud = has_audio_stream(tmp)
                                if aud is not False:
                                    os.replace(tmp, vpath)
                                    if digest:
                                        _seen_hashes.add(digest)
                                    chosen = cand
                                    break
                                if fallback is None:
                                    os.replace(tmp, vpath)
                                    fallback = cand
                                else:
                                    try:
                                        os.remove(tmp)
                                    except OSError:
                                        pass
                            if chosen:
                                print(f"\n[下载] 视频已存 {vpath}（含音轨）")
                            elif fallback:
                                with open(MANIFEST, "a", encoding="utf-8") as mf:
                                    mf.write(f"# NO_AUDIO screen={scrolled} url={fallback}\n")
                                print("\n[下载] 视频已存 " + vpath + " 警告: 无音轨/重复，该屏无法转写")
                            else:
                                print(f"\n[下载] 第 {scrolled} 屏视频下载失败或全部重复，已跳过")
                    except Exception:
                        pass
                elif args.shot_every > 0 and scrolled % args.shot_every == 0:
                    try:
                        shot = os.path.join(
                            SHOT_DIR,
                            f"scroll_{scrolled:03d}_{datetime.now().strftime('%H%M%S')}.png",
                        )
                        page.screenshot(path=shot)
                        print(f"\n[截图] 已存 {shot}")
                        trim_shots()
                    except Exception:
                        pass

                # 定期验证码检测（每 5 屏一次）
                if scrolled % 5 == 0 and is_verify_page(page):
                    if not handle_verify(page):
                        os.makedirs(SHOT_DIR, exist_ok=True)
                        shot = os.path.join(SHOT_DIR, "verify_blocked.png")
                        page.screenshot(path=shot)
                        blocked_reason = f"被验证码挡住，已截图 {shot}"
                        print(f"\n[结束] {blocked_reason}")
                        browser.close()
                        sys.exit(2)

                if stop_by_time:
                    remain = args.minutes * 60 - elapsed
                    sys.stdout.write(
                        f"\r[刷视频中] 已刷 {scrolled} 屏 | 已用 {elapsed:.0f}s | "
                        f"剩余 {remain:.0f}s"
                    )
                else:
                    sys.stdout.write(
                        f"\r[刷视频中] 第 {scrolled}/{args.count} 屏 | "
                        f"已用 {elapsed:.0f}s"
                    )
                sys.stdout.flush()

            print()
            print("[3/3] 正在统计...")
            try:
                os.makedirs(SHOT_DIR, exist_ok=True)
                page.screenshot(path=os.path.join(SHOT_DIR, "last.png"))
                trim_shots()
            except Exception:
                pass
            browser.close()

    except KeyboardInterrupt:
        print("\n[停止] 用户手动停止")
        sys.exit(2)
    except Exception as e:
        print(f"\n[出错] {e}")
        sys.exit(2)

    elapsed = time.time() - start
    print("=" * 50)
    print("本次刷视频统计:")
    print("  下滑屏数:", scrolled)
    print("  用时:", f"{elapsed:.0f} 秒 ({elapsed/60:.1f} 分钟)")
    print("  截图目录:", SHOT_DIR)
    if wall_seen:
        print(f"  登录墙: 出现 {wall_seen} 次，成功移除 {wall_handled} 个覆盖层")
    if blocked_reason:
        print("  备注:", blocked_reason)
    print("=" * 50)
    sys.exit(0)


def handle_verify(page, max_retries=3):
    """验证码处理：等待 → 刷新 → 重试"""
    for attempt in range(1, max_retries + 1):
        print(f"\n[验证码] 检测到人机验证（第 {attempt}/{max_retries} 次处理）...")
        time.sleep(5)
        if not is_verify_page(page):
            print("[验证码] 已自动通过，继续刷")
            return True
        try:
            page.reload(wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(6000)
        except Exception:
            pass
        if not is_verify_page(page):
            print("[验证码] 刷新后通过，继续刷")
            return True
    print("[验证码] 多次处理未通过，先停在这（页面已截图，可稍后人工处理）")
    return False


if __name__ == "__main__":
    main()
