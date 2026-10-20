#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 Web 界面：
  /            发布面板（选项目环境，一键发布）
  /shell       服务器终端（持久会话，可连续执行命令 / tail -f 看日志）
启动： ./start.sh [端口]     默认 http://127.0.0.1:8778
"""
import base64
import fcntl
import getpass
import json
import mimetypes
import os
import pty
import queue
import select
import struct
import subprocess
import sys
import termios
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

import deploy as D

D.load_env_file()  # 载入 .env 里的服务器密码（PASS_<别名>），供持久终端使用

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
LOGS_FILE = ROOT / "logs.conf"

JOBS = {}
TERMS = {}
LOCK = threading.Lock()

# ------------------------------------------------------------------ 一次性任务
def _reader(job_id, proc):
    job = JOBS[job_id]
    for raw in iter(proc.stdout.readline, b""):
        line = raw.decode("utf-8", "replace").rstrip("\n")
        with LOCK:
            job["lines"].append(line)
    proc.wait()
    job["rc"] = proc.returncode
    job["done"] = True


def _start_job(cmd):
    job_id = uuid.uuid4().hex[:12]
    proc = subprocess.Popen(cmd, cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    with LOCK:
        JOBS[job_id] = {"lines": [], "proc": proc, "rc": None, "done": False,
                        "cmd": " ".join(cmd), "started": time.time()}
    threading.Thread(target=_reader, args=(job_id, proc), daemon=True).start()
    return job_id, " ".join(cmd)


# ------------------------------------------------------------------ 持久终端
class Term:
    """一个真实 pty 会话（本机 shell 或远端 ssh）。

    字节原样透传（不剥 ANSI、不改回显），交给前端 xterm.js 渲染，
    因此 vim / top / codex 等全屏 TUI 都能正常用。
    """

    def __init__(self, alias, cols=80, rows=24):
        self.sid = uuid.uuid4().hex[:10]
        self.alias = alias
        self.alive = True
        self.lock = threading.Lock()
        self.listeners = []          # 每个 SSE 连接一个 queue.Queue
        self.backlog = bytearray()   # 最近输出，供新订阅者先补齐屏幕内容
        if alias == "local":
            self.srv = None
            self.desc = f"本机（{getpass.getuser()}@{os.uname().nodename}）"
            argv = [os.environ.get("SHELL") or "/bin/zsh", "-l"]
            env = dict(os.environ)
        else:
            self.srv = D.Server(alias)
            self.desc = self.srv.desc()
            argv = self.srv.ssh_argv(tty=True)
            env = self.srv.tty_env({k: v for k, v in os.environ.items()
                                    if not k.startswith("LC_") and k != "LANG"})
        # 前端是 xterm.js，告诉远端/本地一个足够强的 TERM，全屏程序才会走彩色/备用屏渲染
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        self.proc, self.master = self._spawn(argv, env, str(Path.home()))
        self.resize(cols, rows)
        threading.Thread(target=self._reader, daemon=True).start()

    @staticmethod
    def _spawn(argv, env, cwd):
        """在本机 pty 里起进程；pty 作为其控制终端，Ctrl-C/作业控制都正常。"""
        master, slave = pty.openpty()

        def _child():
            os.setsid()
            try:
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            except OSError:
                pass

        proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave,
                                preexec_fn=_child, env=env, cwd=cwd, close_fds=True)
        os.close(slave)
        return proc, master

    def _reader(self):
        while True:
            try:
                ready, _, _ = select.select([self.master], [], [], 1.0)
                if not ready:
                    if self.proc.poll() is not None:
                        try:
                            data = os.read(self.master, 65536)
                        except OSError:
                            break
                        if data:
                            self._publish(data)
                            continue
                        break
                    continue
                data = os.read(self.master, 65536)
            except (OSError, ValueError):
                break
            if not data:
                break
            self._publish(data)
        self._publish(None)          # 通知所有订阅者：会话结束
        self.alive = False

    def _publish(self, data):
        with self.lock:
            if data is not None:
                self.backlog += data
                if len(self.backlog) > 1_000_000:   # 只留最近 1MB，防内存无限涨
                    del self.backlog[:-500_000]
            listeners = list(self.listeners)
        for q in listeners:
            try:
                q.put_nowait(data)
            except Exception:  # noqa: BLE001
                pass

    def subscribe(self):
        q = queue.Queue()
        with self.lock:
            self.listeners.append(q)
            backlog = bytes(self.backlog)
        if backlog:
            q.put_nowait(backlog)     # 先把已有内容补上，终端能立刻还原当前屏幕
        return q

    def unsubscribe(self, q):
        with self.lock:
            try:
                self.listeners.remove(q)
            except ValueError:
                pass

    def write(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        try:
            os.write(self.master, data)
        except (OSError, ValueError):
            self.alive = False

    def resize(self, cols, rows):
        try:
            cols, rows = max(2, int(cols)), max(1, int(rows))
            fcntl.ioctl(self.master, termios.TIOCSWINSZ,
                        struct.pack("HHHH", rows, cols, 0, 0))
        except (OSError, ValueError):
            pass

    def close(self):
        try:
            self.proc.terminate()
        except Exception:  # noqa: BLE001
            pass
        try:
            os.close(self.master)
        except OSError:
            pass
        self.alive = False


# ------------------------------------------------------------------ api 公共
def _q(query, key, default=""):
    v = query.get(key, default)
    return v[0] if isinstance(v, list) and v else (v or default)


def resolve(project, env):
    try:
        dep = D.Deployer(project, env, dry_run=True)
    except SystemExit:
        return {"error": f"环境 '{env}' 配置有误"}
    return {"project": project, "env": dep.env, "kind": dep.kind,
            "host": dep.srv.host, "user": dep.srv.user, "path": dep.path,
            "profile": dep.profile, "port": dep.port,
            "artifact": D.expand(dep.cfg["project"].get("artifact", "")),
            "has_pass": bool(dep.srv.passwd)}


def api_projects():
    out = []
    for f in sorted(D.CONF_DIR.glob("*.conf")):
        name = f.stem
        try:
            cfg = D.read_conf(f)
            if "project" not in cfg:
                continue
            proj = cfg["project"]
            envs = []
            for sec in cfg.sections():
                if sec.startswith("env:"):
                    e = sec[4:]
                    info = resolve(name, e)
                    envs.append({"name": e, "host": info.get("host"), "path": info.get("path"),
                                 "profile": info.get("profile"), "port": info.get("port"),
                                 "error": info.get("error")})
            out.append({"name": name, "kind": proj.get("kind", "jar"),
                        "dir": D.expand(proj.get("dir", "")), "envs": envs})
        except Exception as exc:  # noqa: BLE001
            out.append({"name": name, "kind": "?", "envs": [], "error": str(exc)})
    return {"projects": out}


def api_servers():
    hp = D.read_conf(D.HOSTS_FILE)
    lc = D.read_conf(LOGS_FILE) if LOGS_FILE.exists() else None
    out = [{"alias": "local", "host": "本机", "user": getpass.getuser(),
            "local": True, "logs": []}]
    for s in hp.sections():
        logs = [{"label": k, "path": v.strip()} for k, v in lc[s].items()] if (lc and lc.has_section(s)) else []
        out.append({"alias": s, "host": hp[s].get("host", "").strip(),
                    "user": hp[s].get("user", "root").strip(), "local": False, "logs": logs})
    return {"servers": out}


def api_detail(body):
    return resolve(body.get("project"), body.get("env"))


def api_deploy(body):
    project, env = body.get("project"), body.get("env")
    if not project or not env:
        return {"error": "缺少项目或环境"}
    cmd = [sys.executable, "-u", str(ROOT / "deploy.py"), project, env]
    for flag, key in (("--no-build", "noBuild"), ("--no-restart", "noRestart"), ("--dry-run", "dryRun")):
        if body.get(key):
            cmd.append(flag)
    job, c = _start_job(cmd)
    return {"job": job, "cmd": c}


def api_log(body, query):
    job = JOBS.get(_q(query, "job"))
    if not job:
        return {"error": "无此任务"}
    start = int(_q(query, "from", "0") or 0)
    with LOCK:
        return {"lines": job["lines"][start:], "next": len(job["lines"]),
                "done": job["done"], "rc": job["rc"]}


def api_cancel(body):
    job = JOBS.get(body.get("job"))
    if job and not job["done"]:
        job["proc"].terminate()
        return {"ok": True}
    return {"error": "任务不存在或已结束"}


# ------------------------------------------------------------------ api 终端
def api_term_open(body):
    alias = body.get("server")
    if not alias:
        return {"error": "缺少服务器"}
    if alias != "local" and not D.read_conf(D.HOSTS_FILE).has_section(alias):
        return {"error": f"未登记的服务器: {alias}"}
    cols = body.get("cols") or 80
    rows = body.get("rows") or 24
    t = Term(alias, cols=cols, rows=rows)
    with LOCK:
        TERMS[t.sid] = t
    return {"sid": t.sid, "server": alias, "desc": t.desc}


def api_term_input(body):
    t = TERMS.get(body.get("sid"))
    if not t:
        return {"error": "会话不存在"}
    data = body.get("data")
    if data:
        t.write(data)
    return {"ok": True}


def api_term_resize(body):
    t = TERMS.get(body.get("sid"))
    if not t:
        return {"error": "会话不存在"}
    t.resize(body.get("cols", 80), body.get("rows", 24))
    return {"ok": True}


def api_term_close(body):
    t = TERMS.get(body.get("sid"))
    if t:
        t.close()
        with LOCK:
            TERMS.pop(t.sid, None)
    return {"ok": True}


ROUTES = {
    "/api/projects": lambda b, q: api_projects(),
    "/api/servers": lambda b, q: api_servers(),
    "/api/detail": lambda b, q: api_detail(b),
    "/api/deploy": lambda b, q: api_deploy(b),
    "/api/log": lambda b, q: api_log(b, q),
    "/api/cancel": lambda b, q: api_cancel(b),
    "/api/term/open": lambda b, q: api_term_open(b),
    "/api/term/input": lambda b, q: api_term_input(b),
    "/api/term/resize": lambda b, q: api_term_resize(b),
    "/api/term/close": lambda b, q: api_term_close(b),
}

PAGES = {"/": "index.html", "/index.html": "index.html",
         "/shell": "shell.html", "/shell.html": "shell.html"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _static(self, name):
        html = (WEB / name).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def _file(self, rel):
        p = (WEB / rel).resolve()
        if not str(p).startswith(str(WEB.resolve())) or not p.is_file():
            self.send_response(404); self.end_headers(); return
        data = p.read_bytes()
        ctype = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _term_stream(self, query):
        """SSE：把 pty 的原始字节 base64 后持续推给前端。"""
        t = TERMS.get(_q(query, "sid"))
        if not t:
            return self._json({"error": "会话不存在"}, 404)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = t.subscribe()
        try:
            self.wfile.write(b": connected\n\n"); self.wfile.flush()
            while True:
                try:
                    data = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n"); self.wfile.flush()
                    continue
                if data is None:
                    self.wfile.write(b"event: close\ndata: {}\n\n"); self.wfile.flush()
                    break
                self.wfile.write(b"data: " + base64.b64encode(data) + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            t.unsubscribe(q)

    def do_GET(self):
        path, _, qs = self.path.partition("?")
        query = parse_qs(qs)
        if path in PAGES:
            return self._static(PAGES[path])
        if path.startswith("/vendor/") or path.startswith("/assets/"):
            return self._file(path.lstrip("/"))
        if path == "/api/term/stream":
            return self._term_stream(query)
        fn = ROUTES.get(path)
        if not fn:
            self.send_response(404); self.end_headers(); return
        try:
            self._json(fn({}, query))
        except Exception as exc:  # noqa: BLE001
            self._json({"error": str(exc), "trace": traceback.format_exc()}, 500)

    def do_POST(self):
        path, _, _ = self.path.partition("?")
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:  # noqa: BLE001
            body = {}
        fn = ROUTES.get(path)
        if not fn:
            self.send_response(404); self.end_headers(); return
        try:
            self._json(fn(body, {}))
        except Exception as exc:  # noqa: BLE001
            self._json({"error": str(exc), "trace": traceback.format_exc()}, 500)

    def log_message(self, *args):
        pass


def main(port=8778):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("面板已启动：")
    print(f"  发布面板     http://127.0.0.1:{port}/")
    print(f"  服务器终端   http://127.0.0.1:{port}/shell")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 8778)
