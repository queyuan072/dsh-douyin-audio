# -*- coding: utf-8 -*-
"""
抖音只读查询工具 (Douyin Reader) v1.1.0
======================================
用浏览器自动化**只读**查询抖音网页版：热榜 / 搜索 / 视频详情 / 评论，
以及 ② 通知级的「通知摘要 / 私信会话列表」。
全程不点赞、不关注、不评论、不发布、不发私信、不标记已读 —— 只取文本与数字。

用法:
    python douyin_read.py hot --limit 20 --json
    python douyin_read.py search --keyword 关键词 --limit 20 --order totalrank --json
    python douyin_read.py video --url https://www.douyin.com/video/<id> --json
    python douyin_read.py comments --url <同上> --limit 30 --json
    python douyin_read.py note --url https://www.douyin.com/note/<id> --json
    python douyin_read.py notes --limit 20 --json
    python douyin_read.py messages --limit 20 --json

输出统一:
    成功 {"ok": true,  "items": [...], "elapsed": 1.2}
    失败 {"ok": false, "error": "一句话原因", "items": []}
  加 --json 时 stdout 只有这一行 JSON；进度与告警一律走 stderr。

items 结构:
    hot      -> {rank, title, hot, url}
    search   -> {title, author, like, url, duration}
    video    -> {title, author, desc, like, comment, share, url, tags[], music, musicNote}
                music: {name, author} 或 null（拿不到就是 null，并在 musicNote 里说明原因）
    note     -> {title, author, desc, publishTime, like, comment, share, collect,
                 images[], imageCount, url, type, declaration}
                type: note（图文页）/ video（给了视频地址或短链跳到视频页时的自动回退）
                images: note-detail 容器内的大图绝对 URL（最多 20 条，只给地址不下载）
    comments -> {user, text, like, time}
    notes    -> {type, user, text, time, url}
                type: 点赞 / 评论 / @我的 / 关注 / 私信 / 其他（按动作句归类，认不出就是「其他」，不猜）
    messages -> {user, lastText, time, unread}   unread 是整数（"99+" 记 99，读不到记 0）

退出码: 0 = 成功; 2 = 失败（含无法启动浏览器、选择器全部未命中、被验证页拦截）

已知限制（真机实测）:
  * search 子命令在多数环境下会被抖音"验证码中间页"拦死（页面标题=验证码中间页、正文只剩几个字）。
    脚本**不做任何验证码绕过**，只如实返回:
      {"ok": false, "error": "search: 被抖音人机验证拦截（页面标题=验证码中间页），
       当前环境无法搜索；建议手动打开一次抖音并完成验证后重试", "items": []}
    先在浏览器里手动完成一次验证（同一 cookie）后重跑，才可能成功。
  * notes / messages 读的是**登录后**才有的页面：没有 cookie 时脚本在起浏览器之前就返回
      {"ok": false, "error": "notes: 需要登录态：没读到 cookie（<路径>）…"}。
    这两个页面在真机上的 URL 与 DOM 未在本仓库验证过（默认 /notifications 与 /messages），
    路径不对时用 --url 覆盖；页面结构变了同样走「选择器全部未命中」的明确 error。
  * hot 榜单项的 innerText 是多行拼接（时长 / 热度 / 标题 / N人在看 / 作者 / 时间），
    按行切分解析；抖音改版导致行序变化时标题会退化，脚本照实返回而不是编造。
"""

import argparse
import contextlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

# Windows 控制台默认 GBK，打印中文/符号会抛 UnicodeEncodeError —— 钉死 UTF-8（同 douyin_scroller.py）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DOUYIN_HOST = "https://www.douyin.com"
# ② 通知（只读）：通知摘要页 / 私信会话列表页。两个页面都要求登录态；
# 真机路径未在本仓库验证过，路径变了用 --url 覆盖（见 cmd_notes / cmd_messages）。
DOUYIN_NOTES_URL = DOUYIN_HOST + "/notifications"
DOUYIN_MESSAGES_URL = DOUYIN_HOST + "/messages"
_DEFAULT_COOKIE_FILE = os.path.join(os.path.expanduser("~"), ".dsh", "cookies", "douyin_cookies.txt")
UA_STRING = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0")
# 浏览器候选链：--browser-channel 选首选，其余按下面的顺序兜底
BROWSER_CHANNELS = ("msedge", "chrome", "chromium", "firefox", "webkit")
# Chromium 家族：只有它们才带 channel 参数、也只有它们之间允许互相回退
CHROMIUM_FAMILY = ("msedge", "chrome", "chromium")

# 人机验证关键词（命中即判定被拦，不做任何绕过）
VERIFY_KEYWORDS = ["请完成下列验证", "完成验证", "人机验证", "验证后继续", "安全验证", "拖动滑块"]
# 登录墙文本信号（未登录访客弹窗）—— 只作为"结果可能为空"的解释，不阻断
LOGIN_WALL_KEYWORDS = ["登录后免费畅享", "登录后继续", "扫码登录", "验证码登录", "密码登录", "暂不登录"]

# --order -> 抖音搜索页排序参数（值本身未经实测，见报告"未验证清单"）
SEARCH_ORDER = {"totalrank": "0", "click": "1", "pubdate": "2"}

_COUNT_UNITS = {"万": 10000, "w": 10000, "W": 10000, "亿": 100000000,
                "千": 1000, "k": 1000, "K": 1000}


# --------------------------------------------------------------------------
# 错误与日志
# --------------------------------------------------------------------------
class StepError(Exception):
    """某一步失败：step 说明卡在哪一步，reason 一句话原因。绝不让 traceback 漏到 stdout。"""

    def __init__(self, step, reason):
        super().__init__("{}: {}".format(step, reason))
        self.step = step
        self.reason = reason


def _brief(exc, limit=240):
    """异常压成一行短句（playwright 的异常常带多行 call log）"""
    try:
        text = " ".join(str(exc).split())
    except Exception:
        text = exc.__class__.__name__
    return text[:limit] or exc.__class__.__name__


def log(msg):
    """进度/告警走 stderr —— stdout 只留 JSON"""
    try:
        sys.stderr.write("[douyin_read] {}\n".format(msg))
        sys.stderr.flush()
    except Exception:
        pass


# --------------------------------------------------------------------------
# cookie（沿用 douyin_scroller.py 的 _load_douyin_cookie 思路）
# --------------------------------------------------------------------------
def _resolve_cookie_file(cli_cookies=None):
    """优先级：--cookies > 环境变量 DOUYIN_COOKIE_FILE > ~/.dsh/cookies/douyin_cookies.txt"""
    if cli_cookies:
        return os.path.expanduser(cli_cookies)
    env = os.environ.get("DOUYIN_COOKIE_FILE")
    if env:
        return os.path.expanduser(env)
    return _DEFAULT_COOKIE_FILE


def _load_douyin_cookie(cookie_file=None):
    """读游客 cookie（netscape 格式）→ Cookie 头；文件不存在就返回空串（游客态也能读）"""
    path = cookie_file or _resolve_cookie_file()
    try:
        ck = []
        with open(path, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if not ln or ln.startswith("#"):
                    continue
                parts = ln.split("\t")
                if len(parts) >= 7:
                    ck.append("{}={}".format(parts[5], parts[6]))
        return "; ".join(ck)
    except Exception:
        return ""


def _cookie_records(cookie_file=None):
    """netscape 行 → playwright context.add_cookies 的记录列表；坏行逐条跳过"""
    path = cookie_file or _resolve_cookie_file()
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for ln in f:
                ln = ln.rstrip("\n")
                if not ln or ln.startswith("#"):
                    continue
                parts = ln.split("\t")
                if len(parts) < 7:
                    continue
                domain, _flag, cpath, secure, expiry, name, value = parts[:7]
                rec = {
                    "name": name,
                    "value": value,
                    "domain": domain,
                    "path": cpath or "/",
                    "secure": str(secure).upper() == "TRUE",
                }
                # ⚠️ 只给「未过期」的 cookie 带 expires。真机实测：把已过期的 expires 传进来，
                #    Playwright 会丢弃这几条（实测 37 条只剩 35 条），抖音服务端看到残缺会话
                #    直接回「验证码中间页」；同样一组 cookie 不带 expires 则正常打开。
                try:
                    exp = int(float(expiry))
                    if exp > 0 and exp > time.time():
                        rec["expires"] = exp
                except Exception:
                    pass
                out.append(rec)
    except Exception:
        return []
    return out


# --------------------------------------------------------------------------
# 数字解析（"1.2万" -> 12000；解析不出就是 0）
# --------------------------------------------------------------------------
def parse_count(text):
    if text is None:
        return 0
    if isinstance(text, bool):
        return 0
    if isinstance(text, (int, float)):
        return int(text)
    s = str(text).strip().replace(",", "").replace("+", "")
    m = re.search(r"(\d+(?:\.\d+)?)\s*([万亿千wWkK]?)", s)
    if not m:
        return 0
    try:
        val = float(m.group(1))
    except ValueError:
        return 0
    return int(val * _COUNT_UNITS.get(m.group(2), 1))


def _clean(text, limit=300):
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    return s[:limit]


# --------------------------------------------------------------------------
# 页面内提取用的 JS 公共内核（多候选 + 兜底）
# --------------------------------------------------------------------------
_JS_KERNEL = r"""
  const visible = (e) => {
    try { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    catch (err) { return false; }
  };
  const pick = (sels) => {
    for (const s of (sels || [])) {
      try {
        const els = [...document.querySelectorAll(s)].filter((e) => e && visible(e));
        if (els.length) return els;
      } catch (err) {}
    }
    return [];
  };
  const txt = (root, sels) => {
    if (!root) return '';
    for (const s of (sels || [])) {
      try {
        const e = root.querySelector(s);
        if (e) { const t = (e.innerText || e.textContent || '').trim(); if (t) return t; }
      } catch (err) {}
    }
    return '';
  };
  const txtNum = (root, sels) => {
    if (!root) return '';
    for (const s of (sels || [])) {
      try {
        const e = root.querySelector(s);
        if (e) { const t = (e.innerText || e.textContent || '').trim(); if (/\d/.test(t)) return t; }
      } catch (err) {}
    }
    return '';
  };
  const firstText = (sels, dflt) => {
    for (const s of (sels || [])) {
      try {
        const e = document.querySelector(s);
        if (e) { const t = (e.innerText || e.textContent || '').trim(); if (t) return t; }
      } catch (err) {}
    }
    return dflt || '';
  };
  const metaContent = (sel) => {
    try { const e = document.querySelector(sel); return e ? (e.getAttribute('content') || '').trim() : ''; }
    catch (err) { return ''; }
  };
  const abs = (href) => { try { return new URL(href, location.origin).href; } catch (err) { return href || ''; } };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const bodyText = () => (document.body ? (document.body.innerText || '') : '');
  const uniqBy = (arr, keyFn) => {
    const seen = {}; const out = [];
    for (const it of arr) {
      const k = keyFn(it);
      if (!k || seen[k]) continue;
      seen[k] = 1; out.push(it);
    }
    return out;
  };
"""


def _js(body):
    """拼一个 playwright 可直接 evaluate 的函数表达式：(cfg) => { ... }"""
    return "(cfg) => {\n" + _JS_KERNEL + "\n" + body + "\n}"


# 选择器候选（抖音 DOM 会变，按顺序试，最后走锚点兜底）
HOT_ROWS = [
    '[data-e2e="scroll-list"] > li',
    '[data-e2e="scroll-list"] li',
    '[data-e2e="hot-list"] li',
    '[data-e2e="hot-search-list"] li',
    '[data-e2e="hot-list"] > div',
    'ul[class*="hot"] > li',
    'div[class*="hot-list"] div[class*="item"]',
    'div[class*="hotSearch"] div[class*="item"]',
    'main li',
    'a[href*="/hot/"]',
]

SEARCH_ROWS = [
    'ul[data-e2e="scroll-list"] > li',
    '[data-e2e="scroll-list"] > li',
    'div[data-e2e="scroll-list"] > div',
    'li[class*="search-result"]',
    'div[class*="search-result"] li',
    'ul[class*="video"] > li',
    'main ul > li',
]
SEARCH_TITLE = ['[data-e2e="video-title"]', 'h3', '[class*="title"]', 'span']
SEARCH_AUTHOR = ['[data-e2e="video-author"]', '[data-e2e="video-author-name"]',
                 'a[href*="/user/"]', '[class*="author"]', '[class*="nickname"]']
SEARCH_LIKE = ['[data-e2e="video-like"]', '[data-e2e="like-count"]',
               '[class*="like"]', '[class*="digg"]']
SEARCH_DURATION = ['[data-e2e="video-duration"]', '[class*="duration"]', '[class*="time"]']

# 真机核实存在的 data-e2e 键: video-detail / player-container / video-player-digg /
# feed-comment-icon / video-player-collect / video-player-share / video-play-more / danmaku-container
VIDEO_TITLE = ['[data-e2e="video-detail"] h1', 'h1[data-e2e="video-title"]',
               '[data-e2e="video-detail"] [class*="title"]', 'h1',
               'div[class*="video-info"] h1', '[class*="title"]']
VIDEO_DESC = ['[data-e2e="video-desc"]',
              '[data-e2e="video-detail"] [data-e2e="video-desc"]',
              '[data-e2e="video-detail"] [class*="desc"]',
              '[data-e2e="video-desc-text"]',
              'div[class*="video-info"] [class*="desc"]',
              '[class*="desc"]',
              '[data-e2e="video-detail"]']
VIDEO_AUTHOR = ['[data-e2e="video-author-name"]', '[data-e2e="user-name"]',
                'a[href*="/user/"] [class*="name"]', 'a[href*="/user/"]',
                '[class*="author-name"]', '[class*="nickname"]']
VIDEO_LIKE = ['[data-e2e="video-player-digg"]', '[data-e2e="video-like-count"]',
              '[data-e2e="like-count"]', '[class*="like"] [class*="count"]',
              '[class*="like-count"]', '[class*="digg"]']
VIDEO_COMMENT = ['[data-e2e="feed-comment-icon"]', '[data-e2e="video-player-comment"]',
                 '[data-e2e="video-comment-count"]', '[data-e2e="comment-count"]',
                 '[class*="comment"] [class*="count"]', '[class*="comment-count"]']
VIDEO_SHARE = ['[data-e2e="video-player-share"]', '[data-e2e="video-share-count"]',
               '[data-e2e="share-count"]', '[class*="share"] [class*="count"]',
               '[class*="share-count"]']
VIDEO_TAGS = ['a[href*="type=tag"]', 'a[href*="/search/"][href*="tag"]',
              'a[href*="keyword=%23"]', '[class*="tag"] a']

COMMENT_ROWS = [
    '[data-e2e="comment-item"]',
    'div[data-e2e="comment-list"] > div',
    '[class*="comment-item"]',
    'div[class*="comment-list"] > div',
    '[class*="comment"] [class*="item"]',
]
COMMENT_USER = ['[data-e2e="comment-username-1"]', '[data-e2e="comment-username"]',
                'a[href*="/user/"]', '[class*="user-name"]', '[class*="nickname"]']
COMMENT_TEXT = ['[data-e2e="comment-content"]', 'span[class*="content"]',
                '[class*="comment-content"]', 'p']
COMMENT_LIKE = ['[data-e2e="comment-like-count"]', '[class*="like"] [class*="count"]',
                '[class*="like-count"]']
COMMENT_TIME = ['[data-e2e="comment-time"]', '[class*="time"]', '[class*="date"]']

# ② 通知页 / 私信页（真机 DOM 未验证：多候选 + 按行切分兜底，取不到就明确报错）
NOTES_ROWS = [
    '[data-e2e="notice-item"]',
    '[data-e2e="message-item"]',
    '[data-e2e="notification-item"]',
    '[data-e2e="notice-list"] > div',
    '[class*="notice-list"] > div',
    '[class*="notification-list"] > div',
    '[class*="notice"] li',
    '[class*="message-list"] > div',
]
MESSAGES_ROWS = [
    '[data-e2e="conversation-item"]',
    '[data-e2e="session-item"]',
    '[data-e2e="message-list"] > div',
    '[class*="conversation-list"] > div',
    '[class*="session-list"] > div',
    '[class*="chat-list"] li',
    '[class*="conversation"] li',
]
# 未读角标候选（数字角标 / 小红点）
MESSAGES_BADGE = ['[class*="badge"]', '[class*="unread"]', '[class*="count"]', '[class*="dot"]']

HOT_BODY = r"""
  // 真机结构: [data-e2e="scroll-list"] > li*N；li 的 innerText 多行拼接:
  //   "00:21 / 1661 / 标题… / @作者 / · 1周前"
  //   "03:00 / 1.0万 / 娱乐榜：标题 / 147.8万人在看 / 简介…"
  // li 的 class 是哈希串（不可依赖），标题在 a[href*="/video/"] 里
  const cfg0 = cfg;
  const isDuration = (s) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(s);
  const isPureNumber = (s) => /^\d+(?:\.\d+)?\s*[万亿wW]?$/.test(s);
  const isViewers = (s) => /^\d+(?:\.\d+)?\s*[万亿wW]?\s*人在看$/.test(s);
  const isAuthor = (s) => s.charAt(0) === '@';
  const isStamp = (s) => /^[·•]/.test(s)
      || /^\d+\s*(分钟|小时|天|周|个月|月|年)前$/.test(s)
      || /^(昨天|今天|前天)/.test(s)
      || /^\d{1,2}-\d{1,2}$/.test(s);
  const stripBadge = (s) => clean(s)
      .replace(/^(上升热点|热点|独家|置顶|爆)\s*[:：]\s*/, '')
      .replace(/^[^：:\s]{1,6}榜\s*[:：]\s*/, '');

  const parseLi = (li, idx) => {
    let lines = [];
    try { lines = (li.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean); }
    catch (err) { lines = []; }
    if (!lines.length) {
      lines = (li.textContent || '').split('\n').map((s) => s.trim()).filter(Boolean);
    }
    let duration = '';
    const numbers = [];
    const rest = [];
    for (const ln of lines) {
      if (!duration && isDuration(ln)) { duration = ln; continue; }
      if (isViewers(ln)) continue;
      if (isPureNumber(ln)) { numbers.push(ln); continue; }
      if (isAuthor(ln)) continue;
      if (isStamp(ln)) continue;
      rest.push(ln);
    }
    let rank = idx + 1;
    let hot = numbers.length ? numbers[0] : '';
    if (numbers.length >= 2 && /^\d{1,3}$/.test(numbers[0]) && parseInt(numbers[0], 10) <= 100) {
      rank = parseInt(numbers[0], 10);
      hot = numbers[1];
    }
    let title = rest.length ? rest[0] : '';
    if (!title && lines.length) title = lines[lines.length - 1];
    title = stripBadge(title);
    const a = li.querySelector('a[href*="/video/"]') || li.querySelector('a[href]');
    const url = a ? abs(a.getAttribute('href')) : '';
    return { rank: rank, title: clean(title, 160), hot: clean(hot, 24),
             url: url, duration: clean(duration, 12) };
  };

  const out = [];
  const collect = (lis) => {
    lis.forEach((li, i) => {
      const it = parseLi(li, i);
      if (it.title && it.title.length >= 2) out.push(it);
    });
  };
  let lis = [];
  try { lis = [...document.querySelectorAll('[data-e2e="scroll-list"] > li')].filter(visible); }
  catch (err) { lis = []; }
  if (!lis.length) {
    try { lis = [...document.querySelectorAll('[data-e2e="scroll-list"] li')].filter(visible); }
    catch (err) { lis = []; }
  }
  if (lis.length) collect(lis);

  if (!out.length) {
    // 兜底 1：通用候选链
    const rows = pick(cfg0.rows);
    rows.forEach((r, i) => {
      const it = parseLi(r, i);
      if (!it.title) {
        const a = r.querySelector('a[href]');
        it.title = clean(a ? (a.innerText || '') : (r.innerText || '')).slice(0, 160);
      }
      if (it.title && it.title.length >= 2) out.push(it);
    });
  }
  if (!out.length) {
    // 兜底 2：页面上的热点/视频锚点
    const as2 = [...document.querySelectorAll('a[href*="/hot/"], a[href*="/video/"]')]
      .filter((a) => clean(a.innerText || '').length >= 2 && visible(a));
    as2.slice(0, cfg0.limit * 2).forEach((a, i) => {
      out.push({ rank: i + 1, title: clean(stripBadge(clean(a.innerText || '')), 160), hot: '',
                 url: abs(a.getAttribute('href')), duration: '' });
    });
  }
  const items = uniqBy(out, (it) => it.title).slice(0, cfg0.limit);
  return { items: items, pageTitle: document.title || '',
           bodyLen: (document.body ? (document.body.innerText || '').length : 0) };
"""

SEARCH_BODY = r"""
  const cfg0 = cfg;
  const out = [];
  const rows = pick(cfg0.rows);
  rows.forEach((r) => {
    const a = r.querySelector('a[href*="/video/"]') || r.querySelector('a[href]');
    let title = clean(txt(r, cfg0.title));
    if (!title && a) title = clean((a.innerText || a.textContent || ''));
    const author = clean(txt(r, cfg0.author));
    const like = clean(txtNum(r, cfg0.like));
    let duration = clean(txt(r, cfg0.duration));
    if (!duration) {
      const m = clean(r.innerText || '').match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
      if (m) duration = m[1];
    }
    const url = a ? abs(a.getAttribute('href')) : '';
    out.push({ title: title, author: author, like: like, url: url, duration: duration });
  });
  if (!out.length) {
    const as2 = [...document.querySelectorAll('a[href*="/video/"]')]
      .filter((a) => clean(a.innerText || '').length >= 2 && visible(a));
    as2.slice(0, cfg0.limit * 2).forEach((a) => {
      out.push({ title: clean(a.innerText || '').slice(0, 160), author: '',
                 like: '', url: abs(a.getAttribute('href')), duration: '' });
    });
  }
  const items = uniqBy(out.filter((it) => it.url && it.title),
                       (it) => it.url).slice(0, cfg0.limit);
  return { items: items, pageTitle: document.title || '', bodyTail: bodyText().slice(0, 4000) };
"""

VIDEO_BODY = r"""
  const cfg0 = cfg;
  // 候选链里靠后的兜底项可能是"整个详情容器"，取第一个长度合理的，避免 desc 变成整段 innerText
  const pickText = (sels, maxLen) => {
    let fallback = '';
    for (const s of (sels || [])) {
      try {
        const e = document.querySelector(s);
        if (!e) continue;
        const t = clean(e.innerText || '');
        if (!t) continue;
        if (t.length <= maxLen) return t;
        if (!fallback || t.length < fallback.length) fallback = t;
      } catch (err) {}
    }
    return fallback;
  };
  // desc 来源优先级（真机核实）:
  //   1) document.title 去掉结尾 " - 抖音"（最可靠，就是视频描述）
  //   2) [data-e2e="video-detail"] 里包含 '#' 的最长一行
  //   3) meta[name="description"]
  //   4) 原来的 [data-e2e="video-desc"] 候选链
  const docTitle = clean(document.title || '');
  const hasSuffix = /\s[-–—]\s*抖音\s*$/.test(docTitle);
  const titleFromDoc = hasSuffix ? clean(docTitle.replace(/\s[-–—]\s*抖音\s*$/, '')) : '';
  const isGenericTitle = (s) => (!s || s === '抖音' || /^抖音([-—|·]|$)/.test(s)
                                 || s.indexOf('记录美好生活') >= 0 || s.length < 4);
  const descFromDoc = isGenericTitle(titleFromDoc) ? '' : titleFromDoc;

  let hashLine = '';
  try {
    for (const e of document.querySelectorAll('[data-e2e="video-detail"] *')) {
      const t = clean(e.innerText || '');
      if (!t || t.length > 400 || t.indexOf('#') < 0) continue;
      if (t.length > hashLine.length) hashLine = t;
    }
  } catch (err) { hashLine = ''; }

  const desc = clean(descFromDoc
                     || hashLine
                     || metaContent('meta[name="description"]')
                     || pickText(cfg0.desc, 400)
                     || metaContent('meta[property="og:description"]'), 600);
  let title = clean(pickText(cfg0.title, 160));
  if (!title) {
    const og = metaContent('meta[property="og:title"]');
    title = clean(og || descFromDoc || desc.split('\n')[0], 160);
  }
  // author：[data-e2e="video-detail"] 内第一个 textContent 非空的 a[href*="/user/"]
  // （第一个通常是头像链接，textContent 为空；getByText 式的"作者名"才排在后面）
  let author = '';
  try {
    for (const a of document.querySelectorAll('[data-e2e="video-detail"] a[href*="/user/"]')) {
      const t = clean(a.textContent || a.innerText || '');
      if (t && t.length <= 40 && t !== '我的') { author = t; break; }
    }
  } catch (err) { author = ''; }
  if (!author) {
    try {
      const e = document.querySelector('[data-e2e="video-detail"] [class*="author"]');
      if (e) author = clean(e.textContent || '');
    } catch (err) {}
  }
  if (!author) author = clean(firstText(cfg0.author));
  if (!author) {
    const m = desc.match(/@([^\s@]{1,32})/);
    if (m) author = m[1];
  }
  const like = clean(txtNum(document, cfg0.like));
  const comment = clean(txtNum(document, cfg0.comment));
  const share = clean(txtNum(document, cfg0.share));
  const tagSet = {};
  const out2 = [];
  for (const s of (cfg0.tags || [])) {
    try {
      for (const a of document.querySelectorAll(s)) {
        const t = clean(a.innerText || '').replace(/^#/, '');
        if (t && t.length <= 32 && !tagSet[t]) { tagSet[t] = 1; out2.push(t); }
      }
    } catch (err) {}
  }
  const hay = desc + ' ' + (document.body ? clean(document.body.innerText) : '');
  for (const m of (hay.match(/#([^\s#@]{1,24})/g) || [])) {
    const t = m.replace(/^#/, '');
    if (t && !tagSet[t]) { tagSet[t] = 1; out2.push(t); }
    if (out2.length >= 20) break;
  }
  // music：未登录状态下抖音不渲染音乐模块；能抓到就照实抓，抓不到留空由 Python 决定 musicNote
  let musicRaw = '';
  const MUSIC_SELS = ['[data-e2e="video-music"]', '[data-e2e="music-info"]',
                      '[data-e2e="music-name"]', 'a[href*="/music/"]',
                      'a[href*="music_id="]', '[class*="music"] a'];
  for (const s of MUSIC_SELS) {
    try {
      const e = document.querySelector(s);
      if (!e) continue;
      const t = clean(e.innerText || e.textContent || '');
      if (t && t.length < 60) { musicRaw = t; break; }
    } catch (err) {}
  }
  if (!musicRaw) {
    // 兜底：详情区里含"原声"/"音乐"字样的短节点（登录后通常形如「原声 - 用户名」）
    try {
      for (const e of document.querySelectorAll('[data-e2e="video-detail"] *, a[href*="music"]')) {
        const t = clean(e.innerText || e.textContent || '');
        if (!t || t.length >= 40) continue;
        if (t.indexOf('原声') < 0 && t.indexOf('音乐') < 0) continue;
        if (/分享|回复|评论|收藏|举报/.test(t)) continue;
        musicRaw = t;
        break;
      }
    } catch (err) {}
  }
  const item = { title: title, author: author, desc: desc, like: like,
                 comment: comment, share: share, url: location.href, tags: out2.slice(0, 20),
                 musicRaw: musicRaw };
  return { item: item, pageTitle: document.title || '', bodyTail: bodyText().slice(0, 4000) };
"""

# 图文（note）详情容器：真机实测图文页是 note-detail，视频页没有这个标记
NOTE_DETAIL_SEL = '[data-e2e="note-detail"]'
# 图片只在容器内取、且要够大：全页按 naturalWidth 取会先抓到站点 logo 和「相关推荐」封面
NOTE_IMG_MIN_WIDTH = 300
NOTE_MAX_IMAGES = 20

NOTE_BODY = r"""
  const cfg0 = cfg;
  const detailSel = cfg0.detail;
  let root = null;
  try { root = document.querySelector(detailSel); } catch (err) { root = null; }
  const hasNote = !!root;
  const stripSuffix = (s) => clean(s.replace(/\s[-–—]\s*抖音\s*$/, ''));
  const docTitle = clean(document.title || '');
  const title = stripSuffix(docTitle);
  const linesOf = (el) => {
    try {
      return (el.innerText || '').split('\n').map((s) => s.trim()).filter((s) => !!s);
    } catch (err) { return []; }
  };
  // 文本行优先取图文容器内的 innerText（全页 innerText 会混进推荐位和页脚，数字行就没法映射了）
  let lines = root ? linesOf(root) : [];
  let linesSource = 'note-detail';
  if (!lines.length) {
    lines = linesOf(document.body || document.documentElement);
    linesSource = 'body';
  }
  const srcOf = (im) => { try { return im.currentSrc || im.src || ''; } catch (err) { return ''; } };
  const bigEnough = (im) => { try { return (im.naturalWidth || 0) >= cfg0.minW; } catch (err) { return false; } };
  const seen = {};
  const images = [];
  const collect = (needWorkTos) => {
    let all = [];
    try { all = [...root.querySelectorAll('img')]; } catch (err) { all = []; }
    for (const im of all) {
      const src = srcOf(im);
      if (!src || seen[src] || !bigEnough(im)) continue;
      if (src.indexOf('image-cut-tos') >= 0) continue;        // 推荐位封面
      // 真机实测：作品图是 biz_tag=aweme_images，另有一条 biz_tag=pcweb_cover（封面，混进来会多算一张）
      if (src.indexOf('pcweb_cover') >= 0) continue;
      if (src.indexOf('noop.jpeg') >= 0) continue;
      // 真机实测：评论区里别人发的图是 biz_tag=aweme_comment，混进来会多算
      if (src.indexOf('aweme_comment') >= 0) continue;
      if (needWorkTos && src.indexOf('tos-cn-i') < 0) continue; // 作品图特征（真机实测）
      seen[src] = 1;
      images.push(src);
    }
  };
  if (root) {
    collect(true);
    if (!images.length) collect(false);  // CDN 命名变了也得有图：只排除已知垃圾
  }
  // 作者兜底：容器内第一个有文字的 a[href*="/user/"]（行切分认不出时才用）
  let authorLink = '';
  if (root) {
    try {
      for (const a of root.querySelectorAll('a[href*="/user/"]')) {
        const t = clean(a.textContent || a.innerText || '');
        if (t && t.length <= 60 && t !== '我的') { authorLink = t; break; }
      }
    } catch (err) { authorLink = ''; }
  }
  const item = { hasNote: hasNote, title: title, docTitle: docTitle,
                 lines: lines, linesSource: linesSource, authorLink: authorLink,
                 images: images.slice(0, cfg0.maxImages), imageCount: images.length,
                 url: location.href };
  return { item: item, pageTitle: document.title || '', bodyTail: bodyText().slice(0, 2000) };
"""


COMMENTS_BODY = r"""
  const cfg0 = cfg;
  const rows = pick(cfg0.rows);
  const out = [];
  // 真机结构（[data-e2e="comment-item"].innerText）:
  //   用户名 / "..."占位 / 正文 / 时间+地点(如 "1周前·江苏") / 点赞数 / "分享" / "回复"
  // 结构化选择器经常把点赞数当成正文，所以以按行切分为主，选择器只做兜底。
  const FIXED_WORDS = ['...', '…', '…', '分享', '回复', '举报', '展开', '收起',
                       '作者赞过', '互相关注', '置顶'];
  const isCountLine = (s) => /^\d+(?:\.\d+)?\s*[万亿wW]?$/.test(s);
  const isTimeLine = (s) => /(\d+\s*(?:秒|分钟|小时|天|周|个月|月|年)前)/.test(s)
      || /^(刚刚|刚才)/.test(s)
      || /^[·•]/.test(s)
      || /^\d{1,2}-\d{1,2}$/.test(s)
      || /^\d{4}-\d{2}-\d{2}/.test(s);

  rows.forEach((r) => {
    let lines = [];
    try { lines = (r.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean); }
    catch (err) { lines = []; }
    let like = '';
    let time = '';
    const cand = [];
    for (const ln of lines) {
      if (FIXED_WORDS.indexOf(ln) >= 0) continue;
      if (isTimeLine(ln)) { if (!time) time = ln; continue; }
      if (isCountLine(ln)) { if (!like) like = ln; continue; }
      cand.push(ln);
    }
    let user = cand.length ? clean(cand[0]) : '';
    // text = 剩余行里最长的一行（长度 >= 2，且不是纯数字行）
    let text = '';
    for (const ln of cand.slice(1)) {
      const t = clean(ln);
      if (t.length >= 2 && !isCountLine(t) && t.length > text.length) text = t;
    }
    if (!text) {
      for (const ln of cand) {
        const t = clean(ln);
        if (t.length >= 2 && !isCountLine(t) && t.length > text.length) text = t;
      }
    }
    // 兜底：用户链接 / 结构化选择器（真实 DOM 若补上 data-e2e 也能用）
    if (!user) {
      const a = r.querySelector('a[href*="/user/"]');
      if (a) user = clean(a.textContent || a.innerText || '');
    }
    if (!user) user = clean(txt(r, cfg0.user));
    if (!text) text = clean(txt(r, cfg0.text), 600);
    if (!like) like = clean(txtNum(r, cfg0.like));
    if (!time) time = clean(txt(r, cfg0.time));
    out.push({ user: user, text: clean(text, 600), like: like, time: time });
  });
  const items = uniqBy(out.filter((it) => it.text),
                       (it) => (it.user || '') + '|' + it.text).slice(0, cfg0.limit);
  return { items: items, total: out.length, rowCount: rows.length,
           bodyLen: (document.body ? (document.body.innerText || '').length : 0) };
"""

NOTES_BODY = r"""
  const cfg0 = cfg;
  const rows = pick(cfg0.rows);
  const out = [];
  // 通知卡 innerText 大概是「昵称 / 动作句 / 时间」或「昵称 / 动作句 / 评论摘录 / 时间」。
  // 抖音改版后行序会变，所以按"行"归类，不按固定下标取。
  const isTimeLine = (s) => /(\d+\s*(?:秒|分钟|小时|天|周|个月|月|年)前)/.test(s)
      || /^(刚刚|刚才|昨天|今天|前天)/.test(s)
      || /^[·•]/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || /^\d{1,2}-\d{1,2}$/.test(s)
      || /^\d{4}-\d{2}-\d{2}/.test(s);
  // 类型只看"动作句"：逐行扫，先命中的行决定类型（评论正文里出现"赞"不会被抢先判成点赞）
  const TYPE_RULES = [
    [/@了我|@了你|提到了你|在评论中@/, '@我的'],
    [/关注了你|开始关注|新增关注/, '关注'],
    [/赞了|点赞了你|喜欢了你的/, '点赞'],
    [/评论了|回复了你|给你留言/, '评论'],
    [/私信|发来一条消息|给你发了/, '私信'],
    [/收藏了|分享了|转发了你的/, '其他'],
  ];
  const isAction = (s) => TYPE_RULES.some((r) => r[0].test(s));
  const typeOf = (lines) => {
    for (const ln of lines) {
      const t = clean(ln);
      if (!t) continue;
      for (const rule of TYPE_RULES) { if (rule[0].test(t)) return rule[1]; }
    }
    return '其他';
  };
  rows.forEach((r) => {
    let lines = [];
    try { lines = (r.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean); }
    catch (err) { lines = []; }
    let time = '';
    const rest = [];
    for (const ln of lines) {
      if (!time && isTimeLine(ln)) { time = ln; continue; }
      rest.push(ln);
    }
    // user：优先 a[href*="/user/"]（昵称/头像通常带链接）；没有就挑"不像动作句、不是时间"的短行
    let user = '';
    try {
      const a = r.querySelector('a[href*="/user/"]');
      if (a) user = clean(a.textContent || a.innerText || '');
    } catch (err) {}
    if (!user) {
      for (const ln of rest) {
        const t = clean(ln);
        if (!t || t.length > 24 || isAction(t)) continue;
        user = t;
        break;
      }
    }
    // text：最长的那一行（动作句或评论摘录），排掉与 user 相同的那行
    let text = '';
    for (const ln of rest) {
      const t = clean(ln);
      if (!t || t === user) continue;
      if (t.length > text.length) text = t;
    }
    let url = '';
    try {
      const a3 = r.querySelector('a[href*="/video/"]') || r.querySelector('a[href*="/user/"]')
                 || r.querySelector('a[href]');
      if (a3) url = abs(a3.getAttribute('href'));
    } catch (err) {}
    out.push({ type: typeOf(lines), user: clean(user, 60), text: clean(text, 300),
               time: clean(time, 40), url: url });
  });
  const items = uniqBy(out.filter((it) => it.text || it.user),
                       (it) => it.user + '|' + it.text + '|' + it.time).slice(0, cfg0.limit);
  return { items: items, rowCount: rows.length,
           bodyLen: (document.body ? (document.body.innerText || '').length : 0) };
"""

MESSAGES_BODY = r"""
  const cfg0 = cfg;
  const rows = pick(cfg0.rows);
  const out = [];
  const isTimeLine = (s) => /(\d+\s*(?:秒|分钟|小时|天|周|个月|月|年)前)/.test(s)
      || /^(刚刚|刚才|昨天|今天|前天)/.test(s)
      || /^(星期|周)[一二三四五六日天]$/.test(s)
      || /^[·•]/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || /^\d{1,2}-\d{1,2}$/.test(s)
      || /^\d{4}-\d{2}-\d{2}/.test(s);
  const isCountLine = (s) => /^\d{1,3}$/.test(s);
  rows.forEach((r) => {
    let lines = [];
    try { lines = (r.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean); }
    catch (err) { lines = []; }
    let time = '';
    let unread = 0;
    const rest = [];
    for (const ln of lines) {
      if (!time && isTimeLine(ln)) { time = ln; continue; }
      if (!unread && isCountLine(ln)) { unread = parseInt(ln, 10) || 0; continue; }
      rest.push(ln);
    }
    // 未读角标：结构化节点优先（带数字就取数字；纯红点没有数字按 1 计）
    if (!unread) {
      for (const sel of (cfg0.badge || [])) {
        try {
          const e = r.querySelector(sel);
          if (!e) continue;
          const t = clean(e.innerText || e.textContent || '');
          const m = t.match(/\d{1,3}/);
          unread = m ? (parseInt(m[0], 10) || 1) : 1;
          break;
        } catch (err) {}
      }
    }
    let user = '';
    try {
      const a = r.querySelector('a[href*="/user/"]');
      if (a) user = clean(a.textContent || a.innerText || '');
    } catch (err) {}
    if (!user && rest.length) user = clean(rest[0], 60);
    let lastText = '';
    for (const ln of rest) {
      const t = clean(ln);
      if (!t || t === user) continue;
      if (t.length > lastText.length) lastText = t;
    }
    out.push({ user: clean(user, 60), lastText: clean(lastText, 300),
               time: clean(time, 40), unread: unread });
  });
  const items = uniqBy(out.filter((it) => it.user), (it) => it.user).slice(0, cfg0.limit);
  return { items: items, rowCount: rows.length,
           bodyLen: (document.body ? (document.body.innerText || '').length : 0) };
"""

COUNT_BODY = r"""
  const rows = pick(cfg.rows);
  return { count: rows.length };
"""

_COMMENT_SCROLL_JS = r"""() => {
  const sels = ['[data-e2e="comment-list"]', 'div[class*="comment-list"]',
                'div[class*="comment"] [class*="list"]', '[class*="comment-container"]'];
  for (const s of sels) {
    try {
      const el = document.querySelector(s);
      if (el && el.scrollHeight > el.clientHeight + 20) {
        el.scrollTop = el.scrollHeight;
        return 'container';
      }
    } catch (err) {}
  }
  try { window.scrollBy(0, Math.max(window.innerHeight, 800)); return 'window'; }
  catch (err) { return 'none'; }
}"""


# --------------------------------------------------------------------------
# 浏览器（惰性导入 playwright：没装也走优雅失败，不是 traceback）
# --------------------------------------------------------------------------
_LOOP_FILTER_INSTALLED = False


def _install_loop_noise_filter():
    """playwright 传输层初始化失败时，asyncio 会在清理期打印
    'Future exception was never retrieved' 的未捕获异常回溯（playwright 自己的 loop）。
    装一次静音 handler，让失败只留下我们那一行 error —— 不改变任何行为。"""
    global _LOOP_FILTER_INSTALLED
    if _LOOP_FILTER_INSTALLED:
        return
    _LOOP_FILTER_INSTALLED = True
    try:
        import asyncio

        original = asyncio.new_event_loop

        def _quiet_loop(*a, **kw):
            loop = original(*a, **kw)

            def _handler(loop_, context):
                msg = str(context.get("message") or "")
                if "never retrieved" in msg or context.get("future") is not None:
                    return
                loop_.default_exception_handler(context)

            try:
                loop.set_exception_handler(_handler)
            except Exception:
                pass
            return loop

        asyncio.new_event_loop = _quiet_loop
    except Exception:
        pass


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
    return "无法启动浏览器（候选链 {}）: {}".format(" / ".join(chain), detail)


def launch_browser(pw, preferred, launch_kwargs, executable=None):
    """把候选链逐个试 launch，全失败才报错（错误里带每一条的原因）。返回 (browser, channel)
    给了 executable（用户自选浏览器）就直接用它、不走候选链"""
    custom = _require_executable(executable)
    if custom:
        # executable_path 与 channel 互斥；自选浏览器默认按 Chromium 家族处理
        kwargs = dict(launch_kwargs)
        kwargs.pop("channel", None)
        kwargs["executable_path"] = custom
        try:
            browser = pw.chromium.launch(**kwargs)
        except Exception as exc:
            raise RuntimeError("无法用指定的浏览器启动（{}）: {}".format(custom, _brief(exc, 160)))
        try:
            sys.stderr.write("[browser] 使用 custom({})\n".format(os.path.basename(custom)))
            sys.stderr.flush()
        except Exception:
            pass
        return browser, "custom({})".format(os.path.basename(custom))
    chain = browser_candidates(preferred)
    errors = []
    for channel in chain:
        engine, extra_kwargs = _engine(pw, channel)
        kwargs = dict(launch_kwargs)
        kwargs.pop("channel", None)
        if channel not in CHROMIUM_FAMILY:
            # --autoplay-policy=... / --window-position=... 是 Chromium 系开关，firefox/webkit 传了起不来
            kwargs.pop("args", None)
        kwargs.update(extra_kwargs)
        try:
            browser = engine.launch(**kwargs)
        except Exception as exc:
            errors.append("{}: {}".format(channel, _brief(exc, 160)))
            continue
        try:
            sys.stderr.write("[browser] 使用 {}\n".format(channel))
            sys.stderr.flush()
        except Exception:
            pass
        return browser, channel
    raise RuntimeError(_launch_error(chain, errors))


def _context_kwargs(channel):
    """实际 channel 决定要不要覆盖 UA：只有 msedge 覆盖（伪装成 Edge）；
    chrome/chromium/firefox/webkit 一律用浏览器自己的真 UA（否则 UA 与实际内核对不上）"""
    kwargs = {"viewport": {"width": 1600, "height": 900}, "locale": "zh-CN"}
    if channel == "msedge":
        kwargs["user_agent"] = UA_STRING
    return kwargs


@contextlib.contextmanager
def _browser_page(args):
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        raise StepError("browser", "未安装 playwright（{}）".format(_brief(exc)))

    _install_loop_noise_filter()
    pw = None
    browser = None
    try:
        try:
            pw = sync_playwright().start()
        except Exception as exc:
            raise StepError("browser", "playwright 启动失败: {}".format(_brief(exc)))
        launch_kwargs = {"headless": bool(args.headless)}
        if args.headless:
            launch_kwargs["args"] = ["--autoplay-policy=no-user-gesture-required"]
        elif getattr(args, "window_offscreen", False):
            # 真机实测：headless 打开抖音必吃验证码；可见窗口（且移出屏幕）能过风控。
            # 只在显式给了 --window-offscreen 时生效，不动任何默认行为。
            launch_kwargs["args"] = ["--window-position=-3000,-3000", "--window-size=1200,900"]
        try:
            browser, channel = launch_browser(pw, args.browser_channel, launch_kwargs,
                                              executable=getattr(args, "browser_executable", None))
        except Exception as exc:
            raise StepError("browser", str(exc))
        args.browser_used = channel
        try:
            ctx = browser.new_context(**_context_kwargs(channel))
        except Exception as exc:
            raise StepError("browser", "无法创建浏览器上下文: {}".format(_brief(exc)))
        records = _cookie_records(args.cookies)
        if records:
            try:
                ctx.add_cookies(records)
                log("已注入 {} 条 cookie".format(len(records)))
            except Exception as exc:
                log("注入 cookie 失败（继续游客态）: {}".format(_brief(exc)))
        else:
            log("没有可用 cookie 文件（游客态继续）")
        page = ctx.new_page()
        try:
            page.set_default_timeout(int(args.timeout * 1000))
        except Exception:
            pass
        try:
            yield page
        finally:
            with contextlib.suppress(Exception):
                page.close()
            with contextlib.suppress(Exception):
                ctx.close()
    finally:
        if browser is not None:
            with contextlib.suppress(Exception):
                browser.close()
        if pw is not None:
            with contextlib.suppress(Exception):
                pw.stop()


def _page_title(page):
    try:
        return " ".join((page.title() or "").split())
    except Exception:
        return ""


def _body_len(page):
    try:
        return int(page.evaluate(
            "() => (document.body ? (document.body.innerText || '').length : 0)") or 0)
    except Exception:
        return 0


def _verify_state(page):
    """(是否验证页, 页面标题, 正文长度)。真机实测的验证页特征：标题=验证码中间页、正文只剩几个字。"""
    title = _page_title(page)
    body_len = _body_len(page)
    try:
        url = page.url or ""
    except Exception:
        url = ""
    if "/verify" in url or "验证码" in title or "验证" in title:
        return True, title, body_len
    if body_len < 50:
        return True, title, body_len
    try:
        body = page.evaluate("() => (document.body ? document.body.innerText : '').slice(0, 20000)")
    except Exception:
        body = ""
    if [kw for kw in VERIFY_KEYWORDS if kw in (body or "")]:
        return True, title, body_len
    return False, title, body_len


def _verify_message(page):
    """验证页的一句话原因（含页面标题），不是验证页就返回 None"""
    is_verify, title, body_len = _verify_state(page)
    if not is_verify:
        return None
    return "被抖音人机验证拦截（页面标题={}，正文 {} 字）".format(title or "空", body_len)


def _search_verify_message(page):
    """search 专用：真机环境下搜索页会被"验证码中间页"挡死，这里给出可执行的建议"""
    is_verify, title, body_len = _verify_state(page)
    if not is_verify:
        return None
    return ("被抖音人机验证拦截（页面标题={}），当前环境无法搜索；"
            "建议手动打开一次抖音并完成验证后重试").format(title or "空")


def _login_wall_hint(page):
    try:
        body = page.evaluate("() => (document.body ? document.body.innerText : '').slice(0, 20000)")
    except Exception:
        return None
    hits = [kw for kw in LOGIN_WALL_KEYWORDS if kw in (body or "")]
    if len(hits) >= 2:
        return "页面疑似弹出了登录墙（命中: {}），列表可能未加载".format("、".join(hits[:3]))
    return None


def _seconds_label(value):
    """4.0 -> "4"，4.5 -> "4.5"（错误文案里要能一眼看出等了几秒）"""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return str(value)
    if abs(num - round(num)) < 1e-6:
        return str(int(round(num)))
    return "{:.1f}".format(num).rstrip("0").rstrip(".")


def _await_verify(page, args, step, verify_hint=None):
    """命中验证页后的处理。
    --verify-wait 0（默认）：与旧版完全一致 —— 立刻抛 StepError；
    --verify-wait N>0：提示一行后每 2 秒复检 _verify_state，
    通过就返回让调用方继续抓，等满 N 秒仍未通过才抛 StepError。
    不点滑块、不绕过：只是给用户手动处理的时间。
    """
    verify_msg = _verify_message(page)
    if not verify_msg:
        return
    wait = float(getattr(args, "verify_wait", 0) or 0)
    if wait <= 0:
        custom = verify_hint(page) if verify_hint else None
        raise StepError(step, custom or verify_msg)
    secs = _seconds_label(wait)
    log("命中人机验证，等你手动处理，最多 {} 秒（{}）".format(secs, verify_msg))
    if getattr(args, "window_offscreen", False):
        log("提示：窗口被移到了屏幕外（--window-offscreen），要手动点滑块得先把窗口拖回来")
    remaining = wait
    while remaining > 0:
        pause = min(2.0, remaining)
        with contextlib.suppress(Exception):
            page.wait_for_timeout(int(round(pause * 1000)))
        remaining -= pause
        is_verify, title, body_len = _verify_state(page)
        if not is_verify:
            log("验证已通过（页面标题={}，正文 {} 字），继续抓取".format(title or "空", body_len))
            return
        if remaining > 0:
            log("仍在验证页，剩余 {} 秒".format(_seconds_label(remaining)))
    custom = verify_hint(page) if verify_hint else None
    raise StepError(step, "命中人机验证，等满 {} 秒仍未通过（{}）".format(secs, custom or verify_msg))


def _goto(page, url, args, step, verify_hint=None):
    """打开页面；被验证页挡住就抛 StepError（verify_hint 用来给某个子命令定制话术）"""
    url = _resolve_short_url(url)
    log("打开 {}".format(url))
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=int(args.timeout * 1000))
    except Exception as exc:
        raise StepError(step, "打开页面失败: {}".format(_brief(exc)))
    try:
        page.wait_for_timeout(2500)
    except Exception:
        pass
    _await_verify(page, args, step, verify_hint)


def _extract(page, body, cfg, step, retries=2, pause_ms=1500):
    """提取一次；为空就等一下重试（抖音列表是异步渲染）"""
    data = {}
    last_exc = None
    for attempt in range(retries + 1):
        try:
            data = page.evaluate(_js(body), cfg) or {}
            last_exc = None
        except Exception as exc:
            last_exc = exc
            data = {}
        if data.get("items") or data.get("item"):
            return data
        if attempt < retries:
            with contextlib.suppress(Exception):
                page.wait_for_timeout(pause_ms)
    if last_exc is not None:
        raise StepError(step, "页面内提取脚本执行失败: {}".format(_brief(last_exc)))
    return data


def _items_or_fail(data, step, what, page):
    items = data.get("items") or []
    if items:
        return items
    hint = _login_wall_hint(page)
    base = "{} 选择器全部未命中（抖音 DOM 可能已变）".format(what)
    raise StepError(step, base + ("；" + hint if hint else ""))


# --------------------------------------------------------------------------
# 四个子命令
# --------------------------------------------------------------------------
def cmd_hot(page, args):
    _goto(page, DOUYIN_HOST + "/hot", args, "hot")
    cfg = {"limit": args.limit, "rows": HOT_ROWS}
    data = _extract(page, HOT_BODY, cfg, "hot")
    rows = _items_or_fail(data, "hot", "热榜列表", page)
    items = []
    for i, it in enumerate(rows[: args.limit]):
        title = _clean(it.get("title"), 160)
        if not title:
            continue
        try:
            rank = int(it.get("rank"))
        except (TypeError, ValueError):
            rank = i + 1
        items.append({
            "rank": rank,
            "title": title,
            "hot": _clean(it.get("hot"), 24),
            "url": it.get("url") or "",
        })
    if not items:
        raise StepError("hot", "热榜解析后标题全为空（页面结构可能已变）")
    return items


def cmd_search(page, args):
    keyword = (args.keyword or "").strip()
    if not keyword:
        raise StepError("search", "关键词为空")
    sort_type = SEARCH_ORDER.get(args.order, "0")
    url = "{}/search/{}?type=video&sort_type={}".format(
        DOUYIN_HOST, urllib.parse.quote(keyword), sort_type)
    # 真机实测：搜索页大概率被"验证码中间页"挡死 —— 不绕过，只如实报错
    _goto(page, url, args, "search", verify_hint=_search_verify_message)
    cfg = {"limit": args.limit, "rows": SEARCH_ROWS, "title": SEARCH_TITLE,
           "author": SEARCH_AUTHOR, "like": SEARCH_LIKE, "duration": SEARCH_DURATION}
    data = _extract(page, SEARCH_BODY, cfg, "search")
    verify_msg = _search_verify_message(page)
    if verify_msg:
        raise StepError("search", verify_msg)
    rows = _items_or_fail(data, "search", "搜索结果列表", page)
    items = []
    for it in rows[: args.limit]:
        if not it.get("url"):
            continue
        items.append({
            "title": _clean(it.get("title"), 160),
            "author": _clean(it.get("author"), 60),
            "like": parse_count(it.get("like")),
            "url": it.get("url") or "",
            "duration": _clean(it.get("duration"), 20),
        })
    if not items:
        raise StepError("search", "搜索结果解析后没有可用条目（可能被登录墙挡住）")
    return items


_VIDEO_ID_RE = re.compile(r"/video/(\d{6,})")

# 分享页（真机实测目前是 JS 壳、不含音乐字段；保留正则，抖音改回来就能用）
_SHARE_URL = "https://www.iesdouyin.com/share/video/{}/"
_MUSIC_NAME_RES = [
    r'"music"\s*:\s*\{[^{}]{0,400}?"title"\s*:\s*"([^"]{1,120})"',
    r'"music_title"\s*:\s*"([^"]{1,120})"',
    r'"musicName"\s*:\s*"([^"]{1,120})"',
    r'"title"\s*:\s*"([^"]{1,120})"\s*,\s*"author"\s*:',
]
_MUSIC_AUTHOR_RES = [
    r'"music"\s*:\s*\{[^{}]{0,400}?"author"\s*:\s*"([^"]{1,120})"',
    r'"music_author"\s*:\s*"([^"]{1,120})"',
    r'"musicAuthor"\s*:\s*"([^"]{1,120})"',
]


def _json_unescape(raw):
    """把 JSON 字符串里的 \\uXXXX 还原成中文；还原失败就原样返回"""
    if not raw:
        return ""
    try:
        return json.loads('"' + raw.replace('"', '\\"') + '"')
    except Exception:
        return raw


def _split_music_text(text):
    """「原声 - 用户名」「歌名 - 歌手」→ (name, author)；没有分隔符就整体当 name"""
    t = _clean(text, 120)
    if not t:
        return "", ""
    for sep in (" - ", " – ", " — ", "-"):
        if sep in t:
            name, author = t.split(sep, 1)
            name, author = _clean(name, 60), _clean(author, 60)
            if name:
                return name, author
    return t, ""


def _music_from_html(html):
    """从 HTML 里正则抓音乐；命中返回 (music, None)，未命中返回 (None, None)"""
    if not html:
        return None, None
    name = ""
    for pattern in _MUSIC_NAME_RES:
        m = re.search(pattern, html)
        if m:
            name = _json_unescape(m.group(1))
            break
    if not name:
        return None, None
    author = ""
    for pattern in _MUSIC_AUTHOR_RES:
        m = re.search(pattern, html)
        if m:
            author = _json_unescape(m.group(1))
            break
    return {"name": _clean(name, 120), "author": _clean(author, 60)}, None


def _fetch_music_from_share(video_id, args):
    """分享页 HTML 正则抓音乐；返回 (music|None, 原因|None)。任何异常都转成一句话原因。"""
    url = _SHARE_URL.format(video_id)
    log("尝试分享页取音乐: {}".format(url))
    headers = {"User-Agent": UA_STRING, "Accept-Language": "zh-CN,zh;q=0.9"}
    cookie = _load_douyin_cookie(args.cookies)
    if cookie:
        headers["Cookie"] = cookie
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=min(float(args.timeout), 15.0)) as resp:
            status = getattr(resp, "status", 200)
            html = resp.read(2 * 1024 * 1024).decode("utf-8", "replace")
    except Exception as exc:
        brief = _brief(exc, 120)
        if any(code in brief for code in ("403", "Blocked", "Argus")):
            return None, "分享页被风控拦截（{}）".format(brief)
        return None, "分享页请求失败（{}）".format(brief)
    if status == 403:
        return None, "分享页被风控拦截（HTTP 403）"
    if not html:
        return None, "分享页返回空内容（HTTP {}）".format(status)
    music, _ = _music_from_html(html)
    if music:
        return music, None
    return None, "分享页未返回音乐字段（HTML {} 字节，只有路由表）".format(len(html))


def _page_html(page, limit=3 * 1024 * 1024):
    """拿当前页 HTML（可能含服务端渲染的音乐字段）；失败返回空串"""
    if page is None:
        return ""
    try:
        return (page.content() or "")[:limit]
    except Exception:
        return ""


def _resolve_music(dom_text, video_url, args, page=None):
    """music 只从页面 DOM / 页面 HTML / 分享页 HTML 里照实取；都拿不到就 null + musicNote（绝不编造）"""
    if dom_text:
        name, author = _split_music_text(dom_text)
        if name:
            return {"name": name, "author": author}, None
    reasons = ["页面未提供音乐信息（未登录状态下抖音不渲染音乐模块）"]
    page_html = _page_html(page)
    if page_html:
        music, _ = _music_from_html(page_html)
        if music:
            log("音乐来自视频页 HTML（{} 字节）".format(len(page_html)))
            return music, None
        reasons.append("视频页 HTML 里也没有音乐字段")
    m = _VIDEO_ID_RE.search(video_url or "")
    if not m:
        reasons.append("地址里解析不出视频 id，未尝试分享页")
        return None, "；".join(reasons)
    music, note = _fetch_music_from_share(m.group(1), args)
    if music:
        return music, None
    if note:
        reasons.append(note)
    return None, "；".join(reasons)


_SHORT_HOSTS = ("v.douyin.com",)
_SHORT_URL_TIMEOUT = 15.0


def _resolve_short_url(url, timeout=_SHORT_URL_TIMEOUT):
    """v.douyin.com 短链 -> 最终落地 URL（urllib 跟随跳转，超时 15 秒）。

    只做一次 GET 拿最终 URL：不保存 cookie（默认 opener 不落盘）、不读页面正文，
    失败就把原地址原样返回并在 stderr 提示 —— 短链解析永远不能让命令失败。
    """
    raw = (url or "").strip()
    if not raw:
        return raw
    candidate = raw
    if re.match(r"^v\.douyin\.com/", candidate):
        candidate = "https://" + candidate
    try:
        parts = urllib.parse.urlsplit(candidate)
    except Exception:
        return raw
    if (parts.hostname or "").lower() not in _SHORT_HOSTS:
        return raw
    req = urllib.request.Request(candidate, method="GET",
                                 headers={"User-Agent": UA_STRING,
                                          "Referer": DOUYIN_HOST + "/"})
    opener = urllib.request.build_opener()  # 默认 opener：不装 cookie jar，不留任何凭证
    try:
        with opener.open(req, timeout=timeout) as resp:
            final = (resp.geturl() or "").strip()
            with contextlib.suppress(Exception):
                resp.read(2048)  # 读一点点就断开，不把落地页整个拉下来
    except Exception as exc:
        log("短链解析失败（{}），沿用原地址: {}".format(_brief(exc, 120), candidate))
        return raw
    if not final.startswith("http"):
        log("短链解析没拿到有效地址（{}），沿用原地址".format(_brief(final, 120) or "空"))
        return raw
    if final.rstrip("/") == candidate.rstrip("/"):
        log("短链没有跳转（可能已失效），沿用原地址: {}".format(candidate))
        return raw
    log("短链已解析: {} -> {}".format(candidate, final))
    return final


_NOTE_ID_RE = re.compile(r"/note/(\d{6,})")


def _note_url(raw):
    """接受完整 URL、/note/<id>、裸 id 或短链，统一成可打开的地址"""
    if not raw:
        raise StepError("note", "缺少 --url")
    raw = raw.strip()
    if re.fullmatch(r"\d{6,}", raw):
        return "{}/note/{}".format(DOUYIN_HOST, raw)
    m = _NOTE_ID_RE.search(raw)
    if m:
        return "{}/note/{}".format(DOUYIN_HOST, m.group(1))
    if raw.startswith("http") or re.match(r"^v\.douyin\.com/", raw):
        return raw  # 短链交给 _goto 里的 _resolve_short_url
    raise StepError("note", "无法识别的图文地址: {}".format(raw[:120]))


def _video_url(raw):
    """接受完整 URL 或裸 video id，统一成 https://www.douyin.com/video/<id>"""
    if not raw:
        raise StepError("video", "缺少 --url")
    raw = raw.strip()
    if re.fullmatch(r"\d{6,}", raw):
        return "{}/video/{}".format(DOUYIN_HOST, raw)
    m = _VIDEO_ID_RE.search(raw)
    if m:
        return "{}/video/{}".format(DOUYIN_HOST, m.group(1))
    if raw.startswith("http"):
        return raw  # 短链/分享链接交给抖音自己跳转
    raise StepError("video", "无法识别的视频地址: {}".format(raw[:120]))


def _video_item(page, args, url, step="video"):
    """视频页解析（video 子命令与 note 的回退共用；调用前页面必须已经打开，不做任何验证码绕过）"""
    if _VIDEO_ID_RE.search(page.url or "") is None and "/video/" not in (page.url or ""):
        log("注意：落地页不是视频页（{}），继续尝试提取".format((page.url or "")[:120]))
    with contextlib.suppress(Exception):
        page.wait_for_timeout(1500)
    cfg = {"title": VIDEO_TITLE, "desc": VIDEO_DESC, "author": VIDEO_AUTHOR,
           "like": VIDEO_LIKE, "comment": VIDEO_COMMENT, "share": VIDEO_SHARE,
           "tags": VIDEO_TAGS}
    data = _extract(page, VIDEO_BODY, cfg, step, retries=2, pause_ms=2000)
    it = data.get("item") or {}
    if not it.get("title") and not it.get("desc"):
        hint = _login_wall_hint(page)
        raise StepError(step, "标题/描述选择器全部未命中（抖音 DOM 可能已变）"
                              + ("；" + hint if hint else ""))
    final_url = it.get("url") or url
    try:
        music, music_note = _resolve_music(it.get("musicRaw"), final_url, args, page)
    except Exception as exc:  # 音乐拿不到绝不能拖垮 video 主结果
        music, music_note = None, "音乐信息解析失败（{}）".format(_brief(exc, 120))
    return {
        "title": _clean(it.get("title"), 200),
        "author": _clean(it.get("author"), 60),
        "desc": _clean(it.get("desc"), 600),
        "like": parse_count(it.get("like")),
        "comment": parse_count(it.get("comment")),
        "share": parse_count(it.get("share")),
        "url": final_url,
        "tags": [_clean(t, 32) for t in (it.get("tags") or []) if _clean(t)][:20],
        "music": music,
        "musicNote": music_note,
    }


def cmd_video(page, args):
    url = _video_url(args.url)
    _goto(page, url, args, "video")  # 被验证页挡住时抛 StepError，不做任何绕过
    return [_video_item(page, args, url, "video")]


def cmd_comments(page, args):
    url = _video_url(args.url)
    _goto(page, url, args, "comments")
    cfg = {"limit": args.limit, "rows": COMMENT_ROWS, "user": COMMENT_USER,
           "text": COMMENT_TEXT, "like": COMMENT_LIKE, "time": COMMENT_TIME}
    # 逐轮滚动让评论加载，直到条数够或连续两轮没涨
    last_count = -1
    stale = 0
    deadline = time.time() + min(float(args.timeout), 20.0)
    for _round in range(12):
        with contextlib.suppress(Exception):
            page.evaluate(_COMMENT_SCROLL_JS)
        with contextlib.suppress(Exception):
            page.wait_for_timeout(1100)
        try:
            count = int((page.evaluate(_js(COUNT_BODY), {"rows": COMMENT_ROWS}) or {}).get("count") or 0)
        except Exception:
            count = 0
        if count >= args.limit:
            break
        stale = stale + 1 if count <= last_count else 0
        last_count = count
        if stale >= 2 or time.time() > deadline:
            break
    data = _extract(page, COMMENTS_BODY, cfg, "comments", retries=1, pause_ms=1500)
    try:
        row_count = int(data.get("rowCount") or 0)
    except (TypeError, ValueError):
        row_count = 0
    rows = data.get("items") or []
    if not rows:
        hint = _login_wall_hint(page)
        verify_msg = _verify_message(page)
        if row_count > 0:
            raise StepError("comments", "该视频暂无评论或评论未加载（命中 {} 个评论节点但正文为空）{}"
                            .format(row_count, "；" + hint if hint else ""))
        if verify_msg:
            raise StepError("comments", verify_msg)
        raise StepError("comments", "评论列表选择器全部未命中（抖音 DOM 可能已变）{}"
                        .format("；" + hint if hint else ""))
    items = []
    for it in rows[: args.limit]:
        text = _clean(it.get("text"), 600)
        if not text:
            continue
        items.append({
            "user": _clean(it.get("user"), 60),
            "text": text,
            "like": parse_count(it.get("like")),
            "time": _clean(it.get("time"), 40),
        })
    if not items:
        raise StepError("comments", "评论解析后正文全为空（可能需滚动加载或需登录）")
    return items


# 图文页文本行的解析规则（真机实测的行结构，见 _parse_note_fields）
_NOTE_COUNT_KEYS = ("like", "comment", "share", "collect")
_NOTE_NUM_RE = re.compile(r"^[\d.,]+\s*[万wW亿千kK]?\+?$")
_NOTE_FANS_RE = re.compile(r"粉丝\s*[\d.,]|获赞\s*[\d.,]")
_NOTE_PUBLISH_RE = re.compile(r"^发布时间\s*[：:]\s*(.*)$")
_NOTE_DECL_RE = re.compile(r"^作者声明\s*[：:]\s*(.*)$")


def _parse_note_fields(lines, author_hint=None):
    """纯函数：note-detail 的 innerText 行 -> 结构化字段（不碰浏览器，可直接单测）。

    规则（真机实测的行序）:
      * 作者   = 「粉丝111获赞6699」那行的前一行
      * 正文   = 含 # 话题 的最长一行
      * 发布时间 = 「发布时间：2026-10-13 22:26:08」那行（去掉前缀）
      * 作者声明 = 「作者声明：…」那行（可选）
      * 纯数字行按页面出现顺序映射 赞 / 评 / 分享 / 收藏
        （顺序是从页面顺序推定的，未实证；所以字段名照实叫 like/comment/share/collect）
    抓不到的字段一律 None —— 不猜、不编造。
    """
    rows = [_clean(ln, 400) for ln in (lines or [])]
    rows = [r for r in rows if r]
    author = None
    desc = None
    publish_time = None
    publish_idx = None
    declaration = None
    numbers = []
    for idx, row in enumerate(rows):
        m = _NOTE_PUBLISH_RE.match(row)
        if m:
            if not publish_time:
                publish_time = _clean(m.group(1), 40) or None
                publish_idx = idx
            continue
        m = _NOTE_DECL_RE.match(row)
        if m:
            if not declaration:
                declaration = _clean(m.group(1), 120) or None
            continue
        if _NOTE_FANS_RE.search(row):
            if not author and idx > 0:
                author = rows[idx - 1]
            continue
        if "#" in row:
            if not desc or len(row) > len(desc):
                desc = row
            continue
        compact = row.replace(" ", "")
        if _NOTE_NUM_RE.match(compact):
            numbers.append(compact)
    # 正文更可靠的判据：**发布时间行的上一行**就是作品正文（真机实测的页面行序）。
    # 只按「含 # 的最长行」取会把「相关推荐」里别的视频文案抓进来（实测踩过这个坑）。
    if publish_idx is not None:
        for row in reversed(rows[:publish_idx]):
            if "#" in row:
                desc = row
                break
    if not author and author_hint:
        author = _clean(author_hint, 60) or None
    counts = {}
    for pos, key in enumerate(_NOTE_COUNT_KEYS):
        counts[key] = parse_count(numbers[pos]) if pos < len(numbers) else None
    return {
        "author": _clean(author, 60) or None,
        "desc": _clean(desc, 600) or None,
        "publishTime": publish_time,
        "declaration": declaration,
        "like": counts["like"],
        "comment": counts["comment"],
        "share": counts["share"],
        "collect": counts["collect"],
        "numberLines": numbers[:len(_NOTE_COUNT_KEYS)],
    }


def _note_item(raw, url):
    """纯函数：把 NOTE_BODY 抓到的原始数据（标题/文本行/图片）拼成 note item，可脱离浏览器单测"""
    raw = raw or {}
    fields = _parse_note_fields(raw.get("lines"), raw.get("authorLink"))
    title = _clean(raw.get("title"), 200)
    if title in ("抖音", "抖音精选", "抖音-记录美好生活") or "记录美好生活" in title:
        title = None
    images = []
    seen = {}
    for src in (raw.get("images") or []):
        if not isinstance(src, str):
            continue
        src = src.strip()
        if not src.startswith("http") or seen.get(src):
            continue
        seen[src] = 1
        images.append(src)
    images = images[:NOTE_MAX_IMAGES]
    try:
        image_count = int(raw.get("imageCount") or 0)
    except (TypeError, ValueError):
        image_count = 0
    return {
        "title": title or None,
        "author": fields["author"],
        "desc": fields["desc"],
        "publishTime": fields["publishTime"],
        "like": fields["like"],
        "comment": fields["comment"],
        "share": fields["share"],
        "collect": fields["collect"],
        "images": images,
        "imageCount": max(image_count, len(images)),
        "url": url,
        "type": "note",
        "declaration": fields["declaration"],
    }


def cmd_note(page, args):
    url = _note_url(args.url)
    _goto(page, url, args, "note")  # 验证页处理与其它子命令一致（--verify-wait）
    with contextlib.suppress(Exception):
        page.wait_for_timeout(1200)
    cfg = {"detail": NOTE_DETAIL_SEL, "minW": NOTE_IMG_MIN_WIDTH,
           "maxImages": NOTE_MAX_IMAGES}
    data = _extract(page, NOTE_BODY, cfg, "note", retries=2, pause_ms=1500)
    it = data.get("item") or {}
    final_url = it.get("url") or (getattr(page, "url", None) or url)
    if not it.get("hasNote"):
        # 落地页其实是视频页（给了 /video/<id>，或短链跳去了视频）：回退视频解析，不报错
        log("没找到图文容器 {}（落地页可能是视频页），回退用视频解析".format(NOTE_DETAIL_SEL))
        item = _video_item(page, args, final_url, "note")
        item["type"] = "video"
        return [item]
    if it.get("linesSource") == "body":
        log("图文容器内没有文本，改用整页 innerText（数字行映射可能不准）")
    item = _note_item(it, final_url)
    if not (item["title"] or item["author"] or item["desc"] or item["images"]):
        hint = _login_wall_hint(page)
        raise StepError("note", "命中图文容器但内容全空（可能需登录或页面结构已变）"
                                + ("；" + hint if hint else ""))
    return [item]


def _require_login(args, step):
    """通知/私信页面只有登录态才渲染：没读到 cookie 就在起浏览器之前失败（一句话原因，不漏 traceback）"""
    if _cookie_records(args.cookies):
        return
    raise StepError(step, "需要登录态：没读到 cookie（{}）；先跑 scripts/douyin_login.py 或用 --cookies 指定"
                    .format(_resolve_cookie_file(args.cookies)))


def cmd_notes(page, args):
    url = (getattr(args, "url", None) or DOUYIN_NOTES_URL).strip()
    _goto(page, url, args, "notes")
    cfg = {"limit": args.limit, "rows": NOTES_ROWS}
    data = _extract(page, NOTES_BODY, cfg, "notes")
    rows = data.get("items") or []
    try:
        row_count = int(data.get("rowCount") or 0)
    except (TypeError, ValueError):
        row_count = 0
    if not rows:
        verify_msg = _verify_message(page)
        if verify_msg:
            raise StepError("notes", verify_msg)
        hint = _login_wall_hint(page)
        if row_count > 0:
            raise StepError("notes", "命中 {} 个通知节点但内容为空（可能未登录或列表未渲染）{}"
                            .format(row_count, "；" + hint if hint else ""))
        raise StepError("notes", "通知列表选择器全部未命中（抖音 DOM 可能已变；通知页需要登录态）{}"
                        .format("；" + hint if hint else ""))
    items = []
    for it in rows[: args.limit]:
        items.append({
            "type": _clean(it.get("type"), 12) or "其他",
            "user": _clean(it.get("user"), 60),
            "text": _clean(it.get("text"), 300),
            "time": _clean(it.get("time"), 40),
            "url": it.get("url") or "",
        })
    if not items:
        raise StepError("notes", "通知解析后没有可用条目（可能需登录或页面结构已变）")
    return items


def cmd_messages(page, args):
    url = (getattr(args, "url", None) or DOUYIN_MESSAGES_URL).strip()
    _goto(page, url, args, "messages")
    cfg = {"limit": args.limit, "rows": MESSAGES_ROWS, "badge": MESSAGES_BADGE}
    data = _extract(page, MESSAGES_BODY, cfg, "messages")
    rows = data.get("items") or []
    try:
        row_count = int(data.get("rowCount") or 0)
    except (TypeError, ValueError):
        row_count = 0
    if not rows:
        verify_msg = _verify_message(page)
        if verify_msg:
            raise StepError("messages", verify_msg)
        hint = _login_wall_hint(page)
        if row_count > 0:
            raise StepError("messages", "命中 {} 个会话节点但内容为空（可能未登录或列表未渲染）{}"
                            .format(row_count, "；" + hint if hint else ""))
        raise StepError("messages", "私信会话列表选择器全部未命中（抖音 DOM 可能已变；私信页需要登录态）{}"
                        .format("；" + hint if hint else ""))
    items = []
    for it in rows[: args.limit]:
        user = _clean(it.get("user"), 60)
        if not user:
            continue
        items.append({
            "user": user,
            "lastText": _clean(it.get("lastText"), 300),
            "time": _clean(it.get("time"), 40),
            "unread": parse_count(it.get("unread")),
        })
    if not items:
        raise StepError("messages", "私信会话解析后用户名为空（可能需登录或页面结构已变）")
    return items


HANDLERS = {
    "hot": cmd_hot,
    "search": cmd_search,
    "video": cmd_video,
    "comments": cmd_comments,
    "note": cmd_note,
    "notes": cmd_notes,
    "messages": cmd_messages,
}


def run(args):
    handler = HANDLERS[args.command]
    if args.command in ("notes", "messages"):
        _require_login(args, args.command)  # 先查登录态，别白起一个浏览器
    with _browser_page(args) as page:
        return handler(page, args)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def _common_parser():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--cookies", default=None, metavar="FILE",
                    help="抖音 cookie 文件（默认取环境变量 DOUYIN_COOKIE_FILE，"
                         "再退回 ~/.dsh/cookies/douyin_cookies.txt）")
    ap.add_argument("--headless", dest="headless", action="store_true", default=True,
                    help="后台运行不显示窗口（默认开）")
    ap.add_argument("--no-headless", dest="headless", action="store_false",
                    help="显示浏览器窗口（调试用）")
    ap.add_argument("--verify-wait", dest="verify_wait", type=float, default=0.0, metavar="SEC",
                    help="命中人机验证后最多等多少秒让你手动处理；默认 0 = 立刻报错退出（老行为）")
    ap.add_argument("--window-offscreen", dest="window_offscreen", action="store_true",
                    help="配合 --no-headless：把浏览器窗口移到屏幕外（真机实测可过风控且不打扰桌面）")
    ap.add_argument("--browser-channel", dest="browser_channel",
                    choices=list(BROWSER_CHANNELS), default="msedge",
                    help="优先用哪个浏览器内核，默认 msedge（msedge→chrome→内置chromium，"
                         "Chromium 家族之间互相回退；firefox / webkit 是 Playwright 自编译内核，"
                         "需先 npx playwright install firefox|webkit，不装就报错、不回退）")
    ap.add_argument("--browser-executable", dest="browser_executable", default=None, metavar="PATH",
                    help="用指定的浏览器可执行文件启动（覆盖 --browser-channel：按 Chromium 内核处理、"
                         "不回退；路径不存在直接报错）")
    ap.add_argument("--timeout", type=float, default=30.0, metavar="SEC",
                    help="单步超时秒数，默认 30")
    ap.add_argument("--json", action="store_true",
                    help="stdout 只输出一行 JSON（进度信息走 stderr）")
    return ap


def parse_args(argv=None):
    common = _common_parser()
    ap = argparse.ArgumentParser(
        prog="douyin_read.py",
        description="抖音只读查询工具：热榜 / 搜索 / 视频详情 / 图文详情 / 评论 / 通知摘要 / 私信会话列表"
                    "（不点赞、不关注、不评论、不发布、不发私信、不标记已读）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=("示例:\n"
                "  python douyin_read.py hot --limit 20 --json\n"
                "  python douyin_read.py search --keyword 关键词 --limit 20 --order totalrank --json\n"
                "  python douyin_read.py video --url https://www.douyin.com/video/<id> --json\n"
                "  python douyin_read.py comments --url https://www.douyin.com/video/<id> --limit 30 --json\n"
                "  python douyin_read.py note --url https://www.douyin.com/note/<id> --json\n"
                "  python douyin_read.py notes --limit 20 --json\n"
                "  python douyin_read.py messages --limit 20 --json\n"
                "\n"
                "公共选项（写在各子命令后面，例如 hot --browser-channel chrome --json）:\n"
                "  --cookies FILE / --headless / --no-headless / --verify-wait SEC /\n"
                "  --window-offscreen / --browser-channel {msedge,chrome,chromium,firefox,webkit} /\n"
                "  --browser-executable PATH / --timeout SEC / --json\n"),
    )
    sub = ap.add_subparsers(dest="command",
                            metavar="{hot,search,video,comments,note,notes,messages}")
    sub.required = True

    p_hot = sub.add_parser("hot", parents=[common], help="抖音热榜")
    p_hot.add_argument("--limit", type=int, default=20, help="取几条，默认 20，范围 1-100")

    p_search = sub.add_parser("search", parents=[common], help="搜索视频")
    p_search.add_argument("--keyword", required=True, help="搜索关键词")
    p_search.add_argument("--limit", type=int, default=20, help="取几条，默认 20，范围 1-100")
    p_search.add_argument("--order", choices=sorted(SEARCH_ORDER), default="totalrank",
                          help="排序：totalrank=综合（默认）/ click=最多播放 / pubdate=最新")

    for name, helptext in (("video", "视频详情"), ("comments", "视频评论")):
        p = sub.add_parser(name, parents=[common], help=helptext)
        p.add_argument("--url", required=True,
                       help="视频地址 https://www.douyin.com/video/<id>（也接受裸 id）")
        if name == "comments":
            p.add_argument("--limit", type=int, default=30, help="取几条评论，默认 30，范围 1-100")

    # 图文（note）：与 video 同级，共用 common；短链与 /note/<id> 都吃，落地是视频页会自动回退
    p_note = sub.add_parser("note", parents=[common], help="图文（note）详情，含图片 URL")
    p_note.add_argument("--url", required=True,
                        help="图文地址 https://www.douyin.com/note/<id>（也接受短链与裸 id）")

    # ② 通知（只读）：登录后才有的两个页面。--url 可覆盖默认路径（真机路径变了就不用改代码）
    for name, helptext, default_url in (
            ("notes", "通知摘要（点赞/评论/@我的/关注，需要登录态）", DOUYIN_NOTES_URL),
            ("messages", "私信会话列表摘要（需要登录态）", DOUYIN_MESSAGES_URL)):
        p = sub.add_parser(name, parents=[common], help=helptext)
        p.add_argument("--limit", type=int, default=20, help="取几条，默认 20，范围 1-100")
        p.add_argument("--url", default=None,
                       help="页面地址，默认 {}".format(default_url))

    args = ap.parse_args(argv)
    if getattr(args, "limit", None) is not None:
        args.limit = max(1, min(int(args.limit), 100))
    args.timeout = max(3.0, min(float(args.timeout), 300.0))
    args.verify_wait = max(0.0, min(float(getattr(args, "verify_wait", 0) or 0), 300.0))
    return args


def browser_used(args):
    """实际用上的 channel；还没启动成功（早失败）就回报请求的那个"""
    if args is None:
        return "msedge"
    return getattr(args, "browser_used", None) or getattr(args, "browser_channel", "msedge")


def _emit(payload, as_json):
    if as_json:
        print(json.dumps(payload, ensure_ascii=False))
        return
    if not payload.get("ok"):
        print("失败: {}".format(payload.get("error")))
        return
    items = payload.get("items") or []
    if not items:
        print("（无数据）")
    for it in items:
        print(" | ".join("{}={}".format(k, v) for k, v in it.items()))


def main(argv=None):
    start = time.time()
    args = None
    try:
        args = parse_args(argv)
        items = run(args)
        payload = {"ok": True, "items": items, "elapsed": round(time.time() - start, 2)}
    except StepError as exc:
        payload = {"ok": False, "error": "{}: {}".format(exc.step, exc.reason),
                   "items": [], "elapsed": round(time.time() - start, 2)}
    except KeyboardInterrupt:
        payload = {"ok": False, "error": "已中断", "items": [],
                   "elapsed": round(time.time() - start, 2)}
    except Exception as exc:
        payload = {"ok": False, "error": "未预期错误: {}".format(_brief(exc)),
                   "items": [], "elapsed": round(time.time() - start, 2)}
    payload["browser"] = browser_used(args)
    as_json = bool(getattr(args, "json", False)) if args is not None else False
    _emit(payload, as_json)
    return 0 if payload.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
