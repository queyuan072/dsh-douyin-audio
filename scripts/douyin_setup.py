#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""douyin_setup.py —— 给抖音插件装运行环境：先扫描，能复用就不装

CLI（host 侧 index.js 的 douyin_setup 工具按这个调用，签名别改）:
    python douyin_setup.py --mode auto|scan|minimal|full|minimal-force
                           [--force-venv] [--scan] [--json] [--log <log路径>]
                           [--base-python <python.exe>] [--state-dir <目录>] [--venv-dir <目录>]

五种模式:
    scan           只体检：**不写配置、不建 venv、不下载**，stdout 输出 inventory JSON
    auto           扫描 → 有可用 Python（playwright + sherpa_onnx 都能 import）就复用并把路径写进
                   <状态目录>/config.json 的 pythonPath → 没有就在 <插件根>/venv 建 venv 装依赖
                   → 写配置 → 写 <状态目录>/setup-result.json
    minimal        确保 venv + pip 装 playwright / sherpa-onnx（不下 ffmpeg / 模型，缺了只报告）
    full           minimal + 下 ffmpeg 到 <状态目录>/bin + 下 SenseVoice 模型到 <状态目录>/models
    minimal-force  同 minimal，但**不复用**现成环境（跳过「已经就绪就不动」的短路，
                   重新解析基础解释器并重装一遍；venv 已存在则就地复用，绝不删）

输出契约（host 解析 stdout）：--json 时 stdout **只有一个 JSON 对象**，前面不含其它字符；
进度一律走 stderr 与 --log 文件。解析不出 JSON 时 host 会认为脚本没跑起来。

状态目录 = %USERPROFILE%\\.dsh\\douyin-duty（DSH_HOME 可覆盖），与 lib/state.mjs 的 stateDir() 一致；
结论写 <状态目录>/setup-result.json，原子写（先写 .tmp 再 os.replace）。

基础解释器优先级: --base-python → DSH 自带 runtime（优先 dsh-primary-runtime）→ 配置里的 pythonPath
                 → 豆包 sandbox → PATH → 常见安装目录。显式给了 --base-python 就必须能用，
                 验不过直接判失败（不静默换成别的解释器，免得掩盖用户的真实意图）。

安全立场（硬规矩，别改）:
  * 这个脚本**不做任何递归删除**：整个文件里没有一处递归删除调用（shutil 只用到 which 与
    copyfileobj，删除动作只有清理自己临时目录时的那两个非递归调用）。
  * 临时文件只放在 tempfile.mkdtemp() 自己建的那个目录里；清理由 _drop_own_tmp() 完成，
    删之前断言「目标在系统临时目录下、且目录名带自己的前缀」，断言不过就一个字节都不删。
    宁可不删（留下的只是垃圾文件），删错一次就是灾难。
  * 对插件根与状态目录的写入一律逐文件、明确路径（venv 由 python -m venv 自己建，那是解释器的活）。
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

VERSION = "1.0.0"
MODES = ("auto", "scan", "minimal", "full", "minimal-force")
PY_EXE = "python.exe" if os.name == "nt" else "python"
RESULT_NAME = "setup-result.json"
CFG_NAME = "config.json"
TMP_PREFIX = "dsh-douyin-setup-"
PROBE_TIMEOUT = 8          # 每个 python 的 import 探测上限（秒）
DOWNLOAD_TIMEOUT = 300     # 单个文件下载的整体 deadline（秒）；也当单次 socket 超时用
DOWNLOAD_MAX_BYTES = 3 * 1024 * 1024 * 1024  # 单个文件大小上限（3GB）：防对端不限量地把盘写满
DOWNLOAD_LOG_STEP = 5 * 1024 * 1024   # 下载中每 5MB 打一行日志
PIP_PACKAGES = ("playwright", "sherpa-onnx")
PIP_INDEXES = (
    ("PyPI", None),
    ("清华镜像", "https://pypi.tuna.tsinghua.edu.cn/simple"),
)
FFMPEG_SOURCES = (
    ("gyan.dev", "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"),
    ("BtbN/FFmpeg-Builds", "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"),
)
MODEL_DIR_NAME = "sherpa-sense-voice"
MODEL_ARCHIVE = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
MODEL_SOURCES = (
    ("GitHub release（tar.bz2）",
     "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/" + MODEL_ARCHIVE + ".tar.bz2",
     "archive"),
    ("hf-mirror.com（逐文件）",
     "https://hf-mirror.com/csukuangfj/" + MODEL_ARCHIVE + "/resolve/main",
     "files"),
    ("modelscope.cn（逐文件）",
     "https://modelscope.cn/models/k2-fsa/" + MODEL_ARCHIVE + "/resolve/master",
     "files"),
)
MODEL_FILES = ("model.onnx", "model.int8.onnx", "tokens.txt", "am.mvn")
MODEL_GG_RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models"
FFMPEG_GYAN = "https://www.gyan.dev/ffmpeg/builds/"

ARGS = None          # argparse 结果（全局，省得每层传参）
LOG = None           # Log 实例


# ── 小工具 ──────────────────────────────────────────────────────────────────
def now_ms():
    return int(time.time() * 1000)


def _brief(value, limit=200):
    """异常/输出压成一行可读文本"""
    text = " ".join(str(value or "").split())
    return text[:limit]


def _decode(raw):
    if raw is None:
        return ""
    if isinstance(raw, bytes):
        try:
            return raw.decode("utf-8", "replace")
        except Exception:
            return raw.decode("latin-1", "replace")
    return str(raw)


def run(cmd, timeout=60, cwd=None):
    """跑一个子进程，永不抛。返回 {code, out, err}（code=None 表示没跑起来/超时）"""
    res = {"code": None, "out": "", "err": ""}
    try:
        cp = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            stdin=subprocess.DEVNULL, timeout=timeout, cwd=cwd)
        res["code"] = cp.returncode
        res["out"] = _decode(cp.stdout)[-8000:]
        res["err"] = _decode(cp.stderr)[-8000:]
    except subprocess.TimeoutExpired:
        res["err"] = "超时(>{}s)".format(timeout)
    except FileNotFoundError as exc:
        res["err"] = "找不到命令: " + _brief(exc)
    except Exception as exc:
        res["err"] = "{}: {}".format(type(exc).__name__, _brief(exc))
    return res


def _parse_version(text):
    """从 'Python 3.12.14' 里抠出版本号"""
    for token in str(text or "").replace("\n", " ").split():
        core = token.strip().strip(",")
        if core[:1].isdigit() and "." in core:
            return core
    return ""


def log(msg):
    if LOG is not None:
        LOG(msg)
    else:
        try:
            sys.stderr.write(str(msg) + "\n")
        except Exception:
            pass


class Log:
    """逐行追加日志（带时间戳）；也往 stderr 打一份。写不了就只 stderr，绝不抛。"""

    def __init__(self, path):
        self.path = os.path.abspath(path) if path else ""
        self._fh = None
        if not self.path:
            return
        try:
            parent = os.path.dirname(self.path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            self._fh = open(self.path, "a", encoding="utf-8", newline="\n")
        except Exception:
            self._fh = None

    def __call__(self, msg):
        line = "[{}] {}".format(time.strftime("%Y-%m-%d %H:%M:%S"), msg)
        try:
            sys.stderr.write(line + "\n")
            sys.stderr.flush()
        except Exception:
            pass
        if self._fh is not None:
            try:
                self._fh.write(line + "\n")
                self._fh.flush()
            except Exception:
                pass

    def close(self):
        if self._fh is not None:
            try:
                self._fh.close()
            except Exception:
                pass
            self._fh = None


# ── 路径 ────────────────────────────────────────────────────────────────────
def dsh_home():
    home = os.environ.get("DSH_HOME")
    if home and home.strip():
        return os.path.abspath(os.path.expanduser(home.strip()))
    try:
        return os.path.join(os.path.expanduser("~"), ".dsh")
    except Exception:
        return ".dsh"


def state_dir():
    if ARGS is not None and getattr(ARGS, "state_dir", None):
        return os.path.abspath(os.path.expanduser(ARGS.state_dir))
    return os.path.join(dsh_home(), "douyin-duty")


def cfg_path():
    return os.path.join(state_dir(), CFG_NAME)


def result_path():
    return os.path.join(state_dir(), RESULT_NAME)


def plugin_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def venv_dir():
    if ARGS is not None and getattr(ARGS, "venv_dir", None):
        return os.path.abspath(os.path.expanduser(ARGS.venv_dir))
    return os.path.join(plugin_root(), "venv")


def venv_python():
    sub = "Scripts" if os.name == "nt" else "bin"
    return os.path.join(venv_dir(), sub, PY_EXE)


# ── JSON / 配置读写（逐文件、原子写）─────────────────────────────────────────
def write_json_atomic(path, data):
    """先写一个 mkstemp 出来的唯一临时名再 os.replace；失败返回 False（绝不抛）。
    用 mkstemp 而不是 <path>.tmp：并发写时固定名字会互相覆盖，还可能写进别人留下的符号链接。"""
    tmp = ""
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=os.path.basename(path) + ".", suffix=".tmp",
                                   dir=parent or ".")
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        tmp = ""
        return True
    except Exception as exc:
        log("写 {} 失败: {}".format(path, _brief(exc)))
        return False
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except Exception:
                pass


def read_cfg():
    """读配置：没有 = {}；坏了 = None（调用方据此拒绝改写，别把人家的配置覆盖掉）"""
    path = cfg_path()
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return data
        log("config.json 不是对象，按「坏了」处理")
        return None
    except Exception as exc:
        log("config.json 读不了: {}".format(_brief(exc)))
        return None


def write_cfg_python(python_path):
    """把 pythonPath 写进配置（其余字段原样保留）。返回 (ok, 说明)"""
    cfg = read_cfg()
    if cfg is None:
        return False, "config.json 读不了/坏了，没敢改写（请先修好它）"
    cfg["pythonPath"] = python_path
    if write_json_atomic(cfg_path(), cfg):
        log("已写入配置 pythonPath = " + python_path)
        return True, ""
    return False, "写 config.json 失败（路径: " + cfg_path() + "）"


def write_result(result):
    ok = write_json_atomic(result_path(), result)
    if ok:
        log("setup-result.json 已写: action={} elapsed={}s".format(result.get("action"), result.get("elapsed")))
    return ok


# ── Python 探测 ─────────────────────────────────────────────────────────────
_PROBE_CODE = (
    "import sys\n"
    "ok = []\n"
    "for m in ('playwright', 'sherpa_onnx'):\n"
    "    try:\n"
    "        __import__(m)\n"
    "        ok.append(m)\n"
    "    except Exception:\n"
    "        pass\n"
    "print('PYVER=' + sys.version.split()[0])\n"
    "print('MODS=' + ' '.join(ok))\n"
)


def is_store_stub(path):
    """WindowsApps 下的 python.exe 是 Microsoft Store 的转发空壳"""
    return "windowsapps" in str(path or "").replace("/", "\\").lower()


def probe_python(path, source, timeout=PROBE_TIMEOUT):
    """真 import 两个模块（8 秒超时）。两个都成功才算 usable。绝不抛。"""
    rec = {"path": path, "source": source, "version": "", "hasPlaywright": False,
           "hasSherpa": False, "usable": False, "ok": False, "note": ""}
    if not path:
        rec["note"] = "空路径"
        return rec
    if is_store_stub(path):
        rec["note"] = "WindowsApps 下的 Microsoft Store 空壳，跳过"
        return rec
    res = run([path, "-c", _PROBE_CODE], timeout=timeout)
    text = res["out"] + "\n" + res["err"]
    if "microsoft" in text.lower():
        rec["note"] = "输出含 Microsoft（Microsoft Store 空壳），跳过"
        return rec
    if res["code"] != 0:
        vres = run([path, "-V"], timeout=timeout)
        rec["version"] = _parse_version(vres["out"] + vres["err"])
        rec["note"] = "-c 探测失败: " + _brief(vres["err"] or res["err"] or res["out"], 120)
        return rec
    rec["ok"] = True
    version = ""
    mods = []
    for line in res["out"].splitlines():
        line = line.strip()
        if line.startswith("PYVER="):
            version = line[len("PYVER="):].strip()
        elif line.startswith("MODS="):
            mods = line[len("MODS="):].split()
    rec["version"] = version
    rec["hasPlaywright"] = "playwright" in mods
    rec["hasSherpa"] = "sherpa_onnx" in mods
    rec["usable"] = rec["hasPlaywright"] and rec["hasSherpa"]
    if not rec["usable"]:
        gaps = [n for n, hit in (("playwright", rec["hasPlaywright"]),
                                 ("sherpa-onnx", rec["hasSherpa"])) if not hit]
        rec["note"] = "缺依赖: " + ", ".join(gaps)
    return rec


def _push(acc, seen, path, source):
    raw = str(path or "").strip()
    if not raw:
        return
    if ("/" in raw) or ("\\" in raw):
        full = os.path.abspath(os.path.expanduser(raw))
        if not os.path.isfile(full):
            return
        raw = full
    key = raw.replace("/", "\\").lower()
    if key in seen:
        return
    seen.add(key)
    acc.append({"path": raw, "source": source})


def _doubao_pythons():
    out = []
    local = os.environ.get("LOCALAPPDATA") or ""
    if not local:
        return out
    root = os.path.join(local, "Doubao", "User Data", "sandbox_runtime", "bases")
    try:
        for item in sorted(glob.glob(os.path.join(root, "*"))):
            cand = os.path.join(item, "python", PY_EXE)
            if os.path.isfile(cand):
                out.append(cand)
    except Exception:
        pass
    return out


def _common_pythons():
    out = []
    local = os.environ.get("LOCALAPPDATA") or ""
    pf = os.environ.get("ProgramFiles") or ""
    pf86 = os.environ.get("ProgramFiles(x86)") or ""
    pats = []
    if local:
        pats.append(os.path.join(local, "Programs", "Python", "Python3*", PY_EXE))
    if pf:
        pats.append(os.path.join(pf, "Python3*", PY_EXE))
    if pf86:
        pats.append(os.path.join(pf86, "Python3*", PY_EXE))
    pats.append("C:\\Python3*\\" + PY_EXE)
    pats.append(os.path.join(os.path.expanduser("~"), "anaconda3", PY_EXE))
    pats.append(os.path.join(os.path.expanduser("~"), "miniconda3", PY_EXE))
    for pat in pats:
        try:
            for hit in sorted(glob.glob(pat), reverse=True):
                out.append(hit)
        except Exception:
            pass
    return out


def discover_pythons(cfg, base_python=None):
    """按优先级收集候选解释器（顺序 = 基础解释器优先级，也是扫描顺序）"""
    acc, seen = [], set()
    if os.path.isfile(venv_python()):
        _push(acc, seen, venv_python(), "venv")
    _push(acc, seen, base_python, "base-python")
    runtimes = os.path.join(dsh_home(), "dsh-runtimes")
    names = []
    try:
        names = sorted(os.listdir(runtimes))
    except Exception:
        names = []
    names.sort(key=lambda n: (0 if "primary" in n.lower() else 1, n))
    for name in names:
        _push(acc, seen, os.path.join(runtimes, name, "dependencies", "python", PY_EXE), "dsh-runtime")
    if isinstance(cfg, dict):
        _push(acc, seen, cfg.get("pythonPath"), "config")
    for cand in _doubao_pythons():
        _push(acc, seen, cand, "doubao")
    _push(acc, seen, shutil.which("python"), "path")
    _push(acc, seen, shutil.which("python3"), "path")
    for cand in _common_pythons():
        _push(acc, seen, cand, "common")
    return acc


def validate_base_python(raw):
    """显式 --base-python：必须存在、必须能跑，否则报错（不静默换解释器）"""
    path = os.path.abspath(os.path.expanduser(str(raw).strip()))
    if not os.path.isfile(path):
        raise RuntimeError("--base-python 指向的文件不存在: " + path)
    if is_store_stub(path):
        raise RuntimeError("--base-python 指向的是 Microsoft Store 空壳（WindowsApps 下）: " + path)
    res = run([path, "-V"], timeout=20)
    version = _parse_version(res["out"] + res["err"])
    if res["code"] != 0 or not version:
        raise RuntimeError("--base-python 跑不起来（-V 失败）: {} → {}".format(
            path, _brief(res["err"] or res["out"], 160)))
    return path


def resolve_base_python():
    """挑一个能跑的基础解释器：--base-python → DSH runtime → 配置 → 豆包 → PATH → 常见目录"""
    if ARGS is not None and getattr(ARGS, "base_python", None):
        return validate_base_python(ARGS.base_python)
    cfg = read_cfg()
    for cand in discover_pythons(cfg if isinstance(cfg, dict) else {}):
        path = cand["path"]
        if is_store_stub(path):
            continue
        res = run([path, "-V"], timeout=20)
        version = _parse_version(res["out"] + res["err"])
        if res["code"] == 0 and version:
            log("基础解释器候选通过: {} [{}] {}".format(path, cand["source"], version))
            return path
        log("基础解释器候选不可用: {} [{}] {}".format(path, cand["source"], _brief(res["err"] or res["out"], 120)))
    raise RuntimeError("找不到可用的 Python：装一个 Python 3.9+，或在配置里填 pythonPath，"
                       "或重跑一次 --mode auto 让脚本自己建 venv")


# ── ffmpeg / 模型 / cookie 探测 ─────────────────────────────────────────────
def _verify_ffmpeg(path):
    res = run([path, "-version"], timeout=8)
    return res["code"] == 0 and "ffmpeg version" in (res["out"] + res["err"]).lower()


def _ffmpeg_candidates(cfg):
    out = []
    if isinstance(cfg, dict):
        out.append((str(cfg.get("ffmpegPath") or "").strip(), "config"))
    out.append((os.path.join(state_dir(), "bin", "ffmpeg.exe"), "state-bin"))
    out.append((os.path.join(dsh_home(), "bin", "ffmpeg.exe"), "dsh-bin"))
    which = shutil.which("ffmpeg")
    if which:
        out.append((which, "path"))
    local = os.environ.get("LOCALAPPDATA") or ""
    if local:
        bases = os.path.join(local, "Doubao", "User Data", "sandbox_runtime", "bases")
        for pat in ("*/ffmpeg.exe", "*/bin/ffmpeg.exe", "*/*/ffmpeg.exe", "*/*/bin/ffmpeg.exe"):
            try:
                for hit in sorted(glob.glob(os.path.join(bases, pat.replace("/", os.sep)))):
                    out.append((hit, "doubao"))
            except Exception:
                pass
    return [(p, s) for p, s in out if p]


def find_ffmpeg(cfg):
    """返回 {path, ok, source, note}；找到但跑不起来时 ok=False 并继续往下试"""
    first_existing = {"path": "", "ok": False, "source": "", "note": ""}
    for path, source in _ffmpeg_candidates(cfg):
        full = os.path.abspath(os.path.expanduser(path))
        if not os.path.isfile(full):
            continue
        if _verify_ffmpeg(full):
            return {"path": full, "ok": True, "source": source, "note": ""}
        if not first_existing["path"]:
            first_existing = {"path": full, "ok": False, "source": source,
                              "note": "文件在但 -version 跑不起来"}
    if not first_existing["path"]:
        first_existing["note"] = "没找到 ffmpeg.exe"
    return first_existing


def _model_ok(folder, files):
    names = {os.path.basename(f).lower() for f in files}
    has_onnx = any(n.startswith("model") and n.endswith(".onnx") for n in names)
    return has_onnx and ("tokens.txt" in names)


def _model_roots():
    roots = [os.path.join(dsh_home(), "models"), os.path.join(state_dir(), "models")]
    return [r for i, r in enumerate(roots) if r and r not in roots[:i]]


def find_model():
    """~/.dsh/models（与 <状态目录>/models）下含 sense-voice 且 model*.onnx + tokens.txt 都在的目录"""
    best = None
    for root in _model_roots():
        if not os.path.isdir(root):
            continue
        base_depth = os.path.abspath(root).rstrip("\\/").count(os.sep)
        try:
            walker = os.walk(root)
            for cur, dirs, files in walker:
                depth = os.path.abspath(cur).rstrip("\\/").count(os.sep) - base_depth
                if depth >= 3:
                    dirs[:] = []
                if not _model_ok(cur, files):
                    continue
                name = os.path.basename(cur).lower()
                score = 0
                if "sense-voice" in name or "sense_voice" in name:
                    score += 4
                if MODEL_ARCHIVE in name:
                    score += 2
                if os.path.abspath(cur).lower().startswith(os.path.abspath(root).lower()):
                    score += 1
                if best is None or score > best[0]:
                    best = (score, cur)
        except Exception as exc:
            log("扫模型目录出错 {}: {}".format(root, _brief(exc)))
    if best is None:
        return {"path": "", "ok": False, "note": "没找到含 model*.onnx + tokens.txt 的 SenseVoice 模型目录"}
    return {"path": best[1], "ok": True, "note": ""}


def cookie_info():
    path = os.path.join(dsh_home(), "cookies", "douyin_cookies.txt")
    info = {"path": path, "exists": False, "count": 0}
    if not os.path.isfile(path):
        return info
    info["exists"] = True
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            info["count"] = len([ln for ln in fh.read().splitlines() if ln.strip()])
    except Exception as exc:
        info["note"] = "读不了: " + _brief(exc)
    return info


# ── 下载 ────────────────────────────────────────────────────────────────────
def download(url, dest, timeout=DOWNLOAD_TIMEOUT, min_bytes=0, max_bytes=DOWNLOAD_MAX_BYTES):
    """流式下载到 dest（先 .part 再 os.replace）。每 5MB 打一行日志。失败抛异常。

    三重护栏缺一不可：整体 deadline（timeout 本身只是单次 socket 超时，慢速对端能一直拖）、
    max_bytes 上限（对端不给 Content-Length 也能兜住）、Content-Length 与实际字节数核对。"""
    log("下载: " + url)
    parent = os.path.dirname(dest)
    if parent:
        os.makedirs(parent, exist_ok=True)
    part = dest + ".part"
    got = 0
    next_mark = DOWNLOAD_LOG_STEP
    total = 0
    deadline = time.monotonic() + float(timeout or 0 or DOWNLOAD_TIMEOUT)
    req = urllib.request.Request(url, headers={"User-Agent": "dsh-douyin-setup/" + VERSION})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(part, "wb") as fh:
            try:
                raw_len = resp.headers.get("Content-Length")
                total = int(raw_len) if raw_len and str(raw_len).isdigit() else 0
            except Exception:
                total = 0
            if total and max_bytes and total > max_bytes:
                raise RuntimeError("文件太大: Content-Length {} 字节 > 上限 {} 字节".format(total, max_bytes))
            if total:
                log("  大小约 {:.1f}MB".format(total / 1048576.0))
            while True:
                if time.monotonic() > deadline:
                    raise RuntimeError("下载超时: 超过 {} 秒仍未完成（已收 {:.1f}MB）".format(
                        timeout, got / 1048576.0))
                chunk = resp.read(262144)
                if not chunk:
                    break
                fh.write(chunk)
                got += len(chunk)
                if max_bytes and got > max_bytes:
                    raise RuntimeError("下载超限: 已收 {} 字节 > 上限 {} 字节".format(got, max_bytes))
                if got >= next_mark:
                    log("  下载中… {:.1f}MB{}".format(
                        got / 1048576.0,
                        "/{:.1f}MB".format(total / 1048576.0) if total else ""))
                    next_mark += DOWNLOAD_LOG_STEP
        if total and got != total:
            raise RuntimeError("下载不完整: 收到 {} 字节，Content-Length 声明 {} 字节".format(got, total))
        if min_bytes and got < min_bytes:
            raise RuntimeError("下载不完整: {} 字节 < 预期 {} 字节".format(got, min_bytes))
        os.replace(part, dest)
    except BaseException:
        # 失败/超限一律不留 .part：被拒绝的超大文件更不该留在盘上
        try:
            os.remove(part)
        except Exception:
            pass
        raise
    log("  下载完成 {:.1f}MB → {}".format(got / 1048576.0, dest))
    return got


def _own_tmp_dir():
    """自己建一个临时目录（后面只允许删它）"""
    path = tempfile.mkdtemp(prefix=TMP_PREFIX)
    log("临时目录: " + path)
    return path


def _drop_own_tmp(tmp_root):
    """只清理自己刚建的临时目录：断言前缀 + 只删里面第一层的普通文件，不做递归。
    断言不过就一个字节都不删（留下的只是垃圾，删错一次就是灾难）。"""
    try:
        sysroot = os.path.abspath(tempfile.gettempdir()).lower()
        target = os.path.abspath(tmp_root)
        low = target.lower()
        if not low.startswith(sysroot + os.sep):
            log("拒绝清理（不在系统临时目录下）: " + target)
            return
        if not os.path.basename(target).startswith(TMP_PREFIX):
            log("拒绝清理（名字不是自己建的）: " + target)
            return
        try:
            entries = os.listdir(target)
        except Exception:
            return
        for name in entries:
            path = os.path.join(target, name)
            if os.path.isfile(path) or os.path.islink(path):
                try:
                    os.remove(path)
                except Exception:
                    pass
            # 目录一律不碰：宁可留垃圾
        try:
            os.rmdir(target)   # 只有空了才会成功；非空就留着
            log("已清理临时目录: " + target)
        except Exception:
            log("临时目录非空，留着: " + target)
    except Exception as exc:
        log("清理临时目录时出错（忽略）: " + _brief(exc))


def _zip_member(zip_path, wanted):
    try:
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
    except Exception as exc:
        raise RuntimeError("压缩包打不开: " + _brief(exc))
    exact = [n for n in names if os.path.basename(n).lower() == wanted]
    if not exact:
        raise RuntimeError("压缩包里没有 " + wanted)
    exact.sort(key=lambda n: (0 if os.path.basename(os.path.dirname(n)).lower() == "bin" else 1, len(n)))
    return exact[0]


def install_ffmpeg():
    """多源回退下 ffmpeg.exe 到 <状态目录>/bin。成功返回路径，失败 None。"""
    dest = os.path.join(state_dir(), "bin", "ffmpeg.exe")
    if os.path.isfile(dest) and _verify_ffmpeg(dest):
        log("ffmpeg 已在位，跳过下载: " + dest)
        return dest
    tmp_root = _own_tmp_dir()
    try:
        for name, url in FFMPEG_SOURCES:
            zip_path = os.path.join(tmp_root, "ffmpeg.zip")
            try:
                download(url, zip_path, min_bytes=1024 * 1024)
                member = _zip_member(zip_path, "ffmpeg.exe")
                log("  从压缩包取 {} → {}".format(member, dest))
                parent = os.path.dirname(dest)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                part = dest + ".part"
                with zipfile.ZipFile(zip_path) as zf, zf.open(member) as src, open(part, "wb") as out:
                    shutil.copyfileobj(src, out, 262144)
                os.replace(part, dest)
                if not _verify_ffmpeg(dest):
                    raise RuntimeError("解出来的 ffmpeg.exe 跑不起来")
                log("ffmpeg 就位（来源 {}）: {}".format(name, dest))
                return dest
            except Exception as exc:
                log("ffmpeg 下载失败（{}）: {}".format(name, _brief(exc, 300)))
    finally:
        _drop_own_tmp(tmp_root)
    return None


def _model_target():
    return os.path.join(state_dir(), "models", MODEL_DIR_NAME)


def _model_ready(folder):
    try:
        names = {n.lower() for n in os.listdir(folder)}
    except Exception:
        return False
    has_onnx = any(n.startswith("model") and n.endswith(".onnx") for n in names)
    return has_onnx and ("tokens.txt" in names)


def _extract_model_from_tar(tar_path, folder):
    """只从 tar.bz2 里取出模型需要的几个文件（不解整个包）"""
    wanted = {n.lower() for n in MODEL_FILES}
    got = []
    with tarfile.open(tar_path, "r:bz2") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            base = os.path.basename(member.name).lower()
            if base not in wanted:
                continue
            src = tf.extractfile(member)
            if src is None:
                continue
            dest = os.path.join(folder, os.path.basename(member.name))
            with src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out, 262144)
            got.append(os.path.basename(member.name))
    return got


def _download_model_files(base_url, folder):
    """逐文件下（hf-mirror / modelscope 那种 resolve 路径）"""
    got = []
    errors = []
    for name in MODEL_FILES:
        url = base_url.rstrip("/") + "/" + name
        dest = os.path.join(folder, name)
        try:
            download(url, dest, min_bytes=1024)
            got.append(name)
        except Exception as exc:
            errors.append("{}: {}".format(name, _brief(exc, 120)))
            if name in ("model.onnx", "model.int8.onnx"):
                continue        # 另一个 onnx 还能试
    if errors:
        log("  逐文件下载有失败: " + "; ".join(errors))
    return got


def install_model():
    """多源回退下 SenseVoice 模型到 <状态目录>/models/sherpa-sense-voice"""
    folder = _model_target()
    if _model_ready(folder):
        log("模型已就位，跳过下载: " + folder)
        return folder
    tmp_root = None
    try:
        for name, url, kind in MODEL_SOURCES:
            try:
                os.makedirs(folder, exist_ok=True)
                if kind == "archive":
                    if tmp_root is None:
                        tmp_root = _own_tmp_dir()
                    archive = os.path.join(tmp_root, "model.tar.bz2")
                    download(url, archive, min_bytes=1024 * 1024)
                    files = _extract_model_from_tar(archive, folder)
                    log("  解出: " + (", ".join(files) or "(无)"))
                else:
                    files = _download_model_files(url, folder)
                if _model_ready(folder):
                    log("模型就位（来源 {}）: {}".format(name, folder))
                    return folder
                raise RuntimeError("校验没过（缺 model*.onnx 或 tokens.txt）")
            except Exception as exc:
                log("模型下载失败（{}）: {}".format(name, _brief(exc, 300)))
    finally:
        if tmp_root:
            _drop_own_tmp(tmp_root)
    return None


# ── venv 与 pip ─────────────────────────────────────────────────────────────
def ensure_venv(base_python):
    """venv 已存在就复用（绝不删）；不存在就用 base python 建一个。返回 venv python 路径。"""
    py = venv_python()
    if os.path.isfile(py):
        log("venv 已存在，复用: " + venv_dir())
        return py
    log("建 venv（base python: {}）→ {}".format(base_python, venv_dir()))
    res = run([base_python, "-m", "venv", venv_dir()], timeout=900)
    if res["code"] != 0 or not os.path.isfile(py):
        raise RuntimeError("建 venv 失败: rc={} {}".format(res["code"], _brief(res["err"] or res["out"], 300)))
    log("venv 建好: " + py)
    _ensure_pip(py)
    return py


def _ensure_pip(py):
    chk = run([py, "-m", "pip", "--version"], timeout=120)
    if chk["code"] == 0:
        return True
    log("venv 里没有 pip，试 ensurepip: " + _brief(chk["err"] or chk["out"], 120))
    res = run([py, "-m", "ensurepip", "--default-pip"], timeout=600)
    if res["code"] != 0:
        log("ensurepip 失败: " + _brief(res["err"] or res["out"], 200))
        return False
    return True


def pip_install(py):
    """PyPI → 清华源 逐个试；包也逐个装，一个失败不连累另一个。返回缺失的包列表"""
    failed = []
    for pkg in PIP_PACKAGES:
        ok = False
        for label, index in PIP_INDEXES:
            cmd = [py, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", pkg]
            if index:
                # 只换 index-url，不加 --trusted-host：那等于关掉 TLS 证书校验
                cmd += ["-i", index]
            log("pip install {}（源: {}）…".format(pkg, label))
            res = run(cmd, timeout=1800)
            if res["code"] == 0:
                log("pip install {} 成功（{}）".format(pkg, label))
                ok = True
                break
            log("pip install {} 失败（{}）rc={}: {}".format(pkg, label, res["code"], _brief(res["err"] or res["out"], 300)))
        if not ok:
            failed.append(pkg)
    return failed


def probe_venv():
    py = venv_python()
    if not os.path.isfile(py):
        return {"path": py, "exists": False, "version": "", "hasPlaywright": False,
                "hasSherpa": False, "usable": False, "note": "venv 里没有 python"}
    rec = probe_python(py, "venv")
    rec["exists"] = True
    return rec


# ── inventory ───────────────────────────────────────────────────────────────
def _next_steps_for(missing, ffmpeg, model, cookie):
    steps = []
    if "python" in missing:
        steps.append("没有同时带 playwright 与 sherpa-onnx 的 Python：重跑一次 --mode auto 让脚本在 "
                     + venv_dir() + " 建 venv，或在配置里把 pythonPath 指向一个现成的解释器。")
    if "ffmpeg" in missing:
        steps.append("下载 ffmpeg（约 90MB）：python scripts/douyin_setup.py --mode full；"
                     "或手动从 " + FFMPEG_GYAN + " 取 ffmpeg.exe 放到 "
                     + os.path.join(dsh_home(), "bin", "ffmpeg.exe"))
    if "model" in missing:
        steps.append("SenseVoice 模型缺失：--mode full 会自动下到 " + _model_target() + "；"
                     "手动的话从 " + MODEL_GG_RELEASE + " 取 " + MODEL_ARCHIVE + ".tar.bz2，"
                     "解到 " + os.path.join(dsh_home(), "models", MODEL_DIR_NAME))
    if not cookie.get("exists"):
        steps.append("还没登录抖音：调用 douyin_login（mode=window）扫一次码，cookie 会写到 " + cookie.get("path", ""))
    return steps


def build_inventory(cfg, do_probe=True):
    """体检：Python 候选 / ffmpeg / 模型 / cookie + verdict。只读，不写任何东西。"""
    pythons = []
    if do_probe:
        for cand in discover_pythons(cfg if isinstance(cfg, dict) else {},
                                     ARGS.base_python if ARGS else None):
            rec = probe_python(cand["path"], cand["source"])
            log("python [{}] {} → version={} playwright={} sherpa={} usable={}{}".format(
                rec["source"], rec["path"], rec["version"] or "?",
                rec["hasPlaywright"], rec["hasSherpa"], rec["usable"],
                "（" + rec["note"] + "）" if rec["note"] else ""))
            pythons.append(rec)
    ffmpeg = find_ffmpeg(cfg if isinstance(cfg, dict) else {})
    log("ffmpeg: {} ok={} [{}]{}".format(ffmpeg["path"] or "(未找到)", ffmpeg["ok"],
                                        ffmpeg["source"] or "-",
                                        "（" + ffmpeg["note"] + "）" if ffmpeg.get("note") else ""))
    model = find_model()
    log("模型: {} ok={}{}".format(model["path"] or "(未找到)", model["ok"],
                                 "（" + model["note"] + "）" if model.get("note") else ""))
    cookie = cookie_info()
    log("cookie: {} exists={} 行数={}".format(cookie["path"], cookie["exists"], cookie["count"]))

    usable = [p for p in pythons if p["usable"]]
    missing = []
    if not usable:
        missing.append("python")
    if not ffmpeg["ok"]:
        missing.append("ffmpeg")
    if not model["ok"]:
        missing.append("model")
    if usable:
        top = usable[0]
        verdict = {"canReusePython": True, "reusePath": top["path"],
                   "reuseReason": "复用现成 Python（{}，playwright + sherpa_onnx 都在）".format(top["source"]),
                   "missing": missing}
        log("reuse-python: " + top["path"])
    else:
        seen_sources = ", ".join(sorted({p["source"] for p in pythons})) or "(无候选)"
        verdict = {"canReusePython": False, "reusePath": "",
                   "reuseReason": "没有同时带 playwright 与 sherpa_onnx 的解释器（看过: {}）".format(seen_sources),
                   "missing": missing}
    return {
        "pythons": pythons,
        "ffmpeg": {"path": ffmpeg["path"], "ok": ffmpeg["ok"], "source": ffmpeg["source"]},
        "model": {"path": model["path"], "ok": model["ok"]},
        "cookie": cookie,
        "verdict": verdict,
        "missing": missing,
        "nextSteps": _next_steps_for(missing, ffmpeg, model, cookie),
    }


# ── 结论信封 ────────────────────────────────────────────────────────────────
def make_result(action, py_path="", version="", has_playwright=False, has_sherpa=False,
                ffmpeg=None, model=None, missing=None, next_steps=None, elapsed=0.0, error=None):
    result = {
        "action": action,
        "ok": action != "failed" and not error,
        "pythonPath": py_path or "",
        "version": version or "",
        "hasPlaywright": bool(has_playwright),
        "hasSherpa": bool(has_sherpa),
        "ffmpeg": {"path": (ffmpeg or {}).get("path", ""), "ok": bool((ffmpeg or {}).get("ok"))},
        "model": {"path": (model or {}).get("path", ""), "ok": bool((model or {}).get("ok"))},
        "missing": list(missing or []),
        "nextSteps": list(next_steps or []),
        "at": now_ms(),
        "elapsed": round(float(elapsed), 1),
    }
    if error:
        result["error"] = _brief(error, 600)
    return result


def envelope(result, mode, extra=None):
    """给 host 的 stdout 信封：install 形状（host 的 normalizeScan 两种形状都吃）"""
    env = dict(result)
    env.update({
        "mode": mode,
        "python": result.get("pythonPath", ""),
        "playwright": bool(result.get("hasPlaywright")),
        "sherpa": bool(result.get("hasSherpa")),
        "venv": venv_dir(),
        "log": LOG.path if LOG is not None else (ARGS.log if ARGS else ""),
        "basePython": (extra or {}).get("basePython", ""),
        "configWritten": bool((extra or {}).get("configWritten", False)),
        "ffmpegPath": (result.get("ffmpeg") or {}).get("path", ""),
        "modelDir": (result.get("model") or {}).get("path", ""),
    })
    if extra and "pythonFound" in extra:
        env["pythonFound"] = extra["pythonFound"]
    return env


def emit(obj):
    """--json 就只往 stdout 打一个 JSON 对象；否则打人看的几行"""
    if ARGS is not None and ARGS.json:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return
    print("douyin_setup v{} —— mode={} action={} ok={}".format(
        VERSION, obj.get("mode", ""), obj.get("action", "-"), obj.get("ok")))
    py = obj.get("python") or obj.get("reusePythonPath") or ""
    if py:
        print("  python    : {}{}".format(py, " v" + obj["version"] if obj.get("version") else ""))
    if obj.get("pythons"):
        for item in obj["pythons"]:
            print("  候选      : [{}] {} playwright={} sherpa={} usable={}".format(
                item.get("source", ""), item.get("path", ""),
                item.get("hasPlaywright"), item.get("hasSherpa"), item.get("usable")))
    ff = obj.get("ffmpeg") or {}
    print("  ffmpeg    : {} ({})".format(ff.get("path") or "未找到", "ok" if ff.get("ok") else "缺失"))
    md = obj.get("model") or {}
    print("  model     : {} ({})".format(md.get("path") or "未找到", "ok" if md.get("ok") else "缺失"))
    if obj.get("missing"):
        print("  missing   : " + ", ".join(map(str, obj["missing"])))
    for step in obj.get("nextSteps") or []:
        print("  下一步    : " + str(step))
    if obj.get("error"):
        print("  错误      : " + str(obj["error"]))


# ── 五个模式 ────────────────────────────────────────────────────────────────
def do_scan():
    """只体检：绝不写配置、绝不建 venv、绝不下载"""
    started = time.monotonic()
    inv = build_inventory(read_cfg())
    env = {
        "ok": True,
        "mode": "scan",
        "pythons": inv["pythons"],
        "ffmpeg": inv["ffmpeg"],
        "model": inv["model"],
        "cookie": inv["cookie"],
        "verdict": inv["verdict"],
        "missing": inv["missing"],
        "nextSteps": inv["nextSteps"],
        "canReusePython": inv["verdict"]["canReusePython"],
        "reusePythonPath": inv["verdict"]["reusePath"],
        "pythonPath": inv["verdict"]["reusePath"],
        "venv": venv_dir(),
        "log": LOG.path if LOG is not None else "",
        "elapsed": round(time.monotonic() - started, 1),
    }
    emit(env)
    return 0


def _fail(mode, reason, started, missing=None, steps=None):
    """失败也要把结论落盘（host 读 setup-result.json 显示原因）"""
    cfg = read_cfg()
    ffmpeg = find_ffmpeg(cfg if isinstance(cfg, dict) else {})
    model = find_model()
    cookie = cookie_info()
    missing = list(missing or [])
    if not ffmpeg["ok"] and "ffmpeg" not in missing:
        missing.append("ffmpeg")
    if not model["ok"] and "model" not in missing:
        missing.append("model")
    steps = list(steps or [])
    if not steps:
        steps = _next_steps_for(missing, ffmpeg, model, cookie)
    res = make_result("failed", ffmpeg=ffmpeg, model=model, missing=missing,
                      next_steps=steps, elapsed=time.monotonic() - started, error=reason)
    write_result(res)
    env = envelope(res, mode)
    emit(env)
    return 2


def _install_steps(log_hint="", force=False):
    """装 venv + 依赖（auto / minimal / minimal-force 共用）。返回 (ok, venv_record, err)"""
    try:
        base = resolve_base_python()
    except Exception as exc:
        return False, None, str(exc)
    log("base python: " + base)
    try:
        py = ensure_venv(base)
    except Exception as exc:
        return False, None, str(exc)
    _ensure_pip(py)
    record = probe_python(py, "venv")
    if record["usable"] and not force:
        log("venv 里两个模块都齐，跳过 pip: " + py)
        return True, record, ""
    failed = pip_install(py)
    record = probe_python(py, "venv")
    if failed:
        return False, record, "pip 装不上: " + ", ".join(failed)
    if not record["usable"]:
        return False, record, "依赖装完但 import 还是失败（playwright={} sherpa={}）: {}".format(
            record["hasPlaywright"], record["hasSherpa"], record["note"])
    return True, record, ""


def do_install(mode, started):
    """auto / minimal / full / minimal-force"""
    cfg = read_cfg()
    if cfg is None:
        return _fail(mode, "config.json 读不了/坏了，为了不覆盖掉你的配置，这次什么都不改", started)
    if not isinstance(cfg, dict):
        cfg = {}
    force = bool(ARGS.force_venv or mode == "minimal-force")

    # 显式 --base-python 先验一遍：说好用的解释器必须真能用，不静默换成别的
    forced_base = ""
    if getattr(ARGS, "base_python", ""):
        try:
            forced_base = validate_base_python(ARGS.base_python)
            log("--base-python 校验通过: " + forced_base)
        except Exception as exc:
            return _fail(mode, "{}（换一个路径，或去掉 --base-python 让脚本自己挑）".format(exc),
                         started, missing=["python"])

    # auto：先扫描，有能用的就复用（--force-venv 时跳过复用，直接装）
    reused = None
    if mode == "auto" and not force:
        inv = build_inventory(cfg)
        usable = [p for p in inv["pythons"] if p["usable"]]
        if forced_base:
            hit = [p for p in usable
                   if os.path.normcase(p["path"]) == os.path.normcase(forced_base)]
            if hit:
                reused = hit[0]
            else:
                log("--base-python 指定的解释器没带全依赖，改为在 venv 里装")
        elif usable:
            reused = usable[0]
        else:
            log("扫描没找到可复用的 Python，改为安装")
    elif mode == "auto" and force:
        log("--force-venv：跳过复用，直接建 venv 装依赖")

    if reused is not None:
        ok_cfg, why_cfg = write_cfg_python(reused["path"])
        steps = list(inv["nextSteps"])
        if not ok_cfg:
            steps.insert(0, why_cfg)
        res = make_result("reused", reused["path"], reused["version"], reused["hasPlaywright"],
                          reused["hasSherpa"], inv["ffmpeg"], inv["model"], inv["missing"], steps,
                          elapsed=time.monotonic() - started)
        write_result(res)
        emit(envelope(res, mode, {"configWritten": ok_cfg}))
        return 0

    # 装：venv + 依赖
    ok_py, record, err = _install_steps(force=force)
    ffmpeg = find_ffmpeg(cfg)
    model = find_model()
    cookie = cookie_info()

    # full：再补 ffmpeg 与模型（python 装挂了也照做，能补一个是一个）
    if mode == "full":
        if not ffmpeg["ok"]:
            got = install_ffmpeg()
            ffmpeg = find_ffmpeg(cfg) if got else ffmpeg
        if not model["ok"]:
            got_dir = install_model()
            model = find_model() if got_dir else model

    missing = []
    if not ok_py:
        missing.append("python")
    if not ffmpeg["ok"]:
        missing.append("ffmpeg")
    if not model["ok"]:
        missing.append("model")
    steps = _next_steps_for(missing, ffmpeg, model, cookie)

    if not ok_py:
        res = make_result("failed", (record or {}).get("path", ""), (record or {}).get("version", ""),
                          (record or {}).get("hasPlaywright", False), (record or {}).get("hasSherpa", False),
                          ffmpeg, model, missing, steps, time.monotonic() - started, error=err or "装依赖失败")
        write_result(res)
        emit(envelope(res, mode))
        return 2

    py = record["path"]
    ok_cfg, why_cfg = write_cfg_python(py)
    if not ok_cfg:
        steps.insert(0, why_cfg)
    res = make_result("installed", py, record["version"], record["hasPlaywright"], record["hasSherpa"],
                      ffmpeg, model, missing, steps, time.monotonic() - started)
    write_result(res)
    emit(envelope(res, mode, {"configWritten": ok_cfg}))
    return 0


# ── CLI ─────────────────────────────────────────────────────────────────────
def build_parser():
    ap = argparse.ArgumentParser(
        prog="douyin_setup.py",
        description="给抖音插件装运行环境：先扫描，能复用就不装（Python/playwright/sherpa-onnx、ffmpeg、SenseVoice 模型）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例:\n"
               "  python douyin_setup.py --mode scan --json --log %USERPROFILE%\\.dsh\\douyin-duty\\setup.log\n"
               "  python douyin_setup.py --mode auto --json --log setup.log\n"
               "  python douyin_setup.py --mode full --json --log setup.log\n"
               "  python douyin_setup.py --mode minimal-force --force-venv --json --log setup.log\n")
    ap.add_argument("--mode", choices=list(MODES), default="auto",
                    help="auto（默认：扫描→复用或安装）/ scan（只体检，不改任何东西）/ "
                         "minimal（venv + playwright + sherpa-onnx）/ full（minimal + ffmpeg + 模型）/ "
                         "minimal-force（同 minimal，但不复用现成环境）")
    ap.add_argument("--scan", action="store_true",
                    help="等价于 --mode scan：只体检，不改配置、不建 venv、不下载")
    ap.add_argument("--force-venv", dest="force_venv", action="store_true",
                    help="强制新建 venv：不复用现成 Python / 现成环境（venv 已存在则就地重装，绝不删）")
    ap.add_argument("--json", action="store_true",
                    help="stdout 只输出一个 JSON 信封（host 用这个；进度走 stderr 与 --log）")
    ap.add_argument("--log", default="", metavar="PATH",
                    help="日志文件（逐行追加，带时间戳）")
    ap.add_argument("--base-python", dest="base_python", default="", metavar="PATH",
                    help="基础解释器（优先于其它所有候选；给了就必须能用，跑不起来直接判失败）")
    ap.add_argument("--state-dir", dest="state_dir", default="", metavar="DIR",
                    help="状态目录（默认 DSH_HOME/douyin-duty；调试/测试用）")
    ap.add_argument("--venv-dir", dest="venv_dir", default="", metavar="DIR",
                    help="venv 目录（默认 <插件根>/venv；调试/测试用）")
    return ap


def main(argv=None):
    global ARGS, LOG
    parser = build_parser()
    ARGS = parser.parse_args(argv)
    mode = "scan" if ARGS.scan else ARGS.mode
    if ARGS.scan and ARGS.mode not in ("auto", "scan"):
        parser.error("--scan 与 --mode {} 冲突（--scan 就是 --mode scan）".format(ARGS.mode))
    started = time.monotonic()
    LOG = Log(ARGS.log)
    log("==== douyin_setup.py v{} mode={} force_venv={} py={} ====".format(
        VERSION, mode, bool(ARGS.force_venv), sys.version.split()[0]))
    log("状态目录: " + state_dir())
    log("venv: " + venv_dir())
    try:
        if mode == "scan":
            return do_scan()
        return do_install(mode, started)
    except Exception as exc:
        reason = "{}: {}".format(type(exc).__name__, _brief(exc, 400))
        log("未预料的错误（已兜住，不抛裸 traceback）: " + reason)
        try:
            return _fail(mode, reason, started)
        except Exception as exc2:
            log("连失败结论都没写成: " + _brief(exc2))
            emit({"ok": False, "mode": mode, "action": "failed", "error": reason,
                  "missing": ["python"], "nextSteps": ["看日志: " + (LOG.path or "(未指定 --log)")]})
            return 2
    finally:
        if LOG is not None:
            LOG.close()


if __name__ == "__main__":
    sys.exit(main())
