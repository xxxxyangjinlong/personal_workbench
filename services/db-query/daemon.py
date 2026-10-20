#!/usr/bin/env python3
"""把 server.py 以守护进程方式启动（双 fork 脱离会话），PID 写入 server.pid。"""
import os, sys, time

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = sys.argv[1] if len(sys.argv) > 1 else "8777"
PIDFILE = os.path.join(ROOT, "server.pid")
LOGFILE = os.path.join(ROOT, "server.log")

def daemonize():
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    sys.stdout.flush(); sys.stderr.flush()
    with open(LOGFILE, "ab", 0) as log:
        os.dup2(log.fileno(), 1)
        os.dup2(log.fileno(), 2)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)

daemonize()
os.chdir(ROOT)
with open(PIDFILE, "w") as f:
    f.write(str(os.getpid()))
with open(LOGFILE, "ab", 0) as log:
    log.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} start pid={os.getpid()} port={PORT} ===\n".encode())

import runpy
sys.argv = ["server.py", PORT]
runpy.run_path(os.path.join(ROOT, "server.py"), run_name="__main__")
