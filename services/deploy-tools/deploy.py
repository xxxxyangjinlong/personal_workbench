#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一句话发布 / 运维工具

命令:
  deploy list                            列出已登记项目
  deploy envs  <项目>                    列出项目的环境
  deploy add   <项目|目录>               自动探测并生成配置骨架
  deploy <项目> [环境] [选项]             构建 → 上传 → 重启 → 健康检查
  deploy upload <本地文件> <服务器[:路径]>  往某服务器传文件
  deploy run    <服务器> "<命令>"         在服务器上执行命令

选项:
  --no-build / --no-restart / --dry-run

配置:
  hosts.conf               全局服务器登记（host/user/pass_env）
  conf/<项目>.conf         项目构建方式 + [env:<服务器>] 环境映射
  .env                     密码：PASS_<别名>=xxx（已被 git 忽略）
"""
import configparser
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
DEPLOY_HOME = Path(__file__).resolve().parent
CONF_DIR = DEPLOY_HOME / "conf"
HOSTS_FILE = DEPLOY_HOME / "hosts.conf"
ENV_FILE = DEPLOY_HOME / ".env"

_C = {"r": "\033[0m", "b": "\033[1m", "g": "\033[32m", "y": "\033[33m", "c": "\033[36m"}
if not sys.stdout.isatty():
    _C = {k: "" for k in _C}


def die(msg):
    print(f"{_C['y']}❌ {msg}{_C['r']}", file=sys.stderr)
    sys.exit(1)


def info(msg):
    print(f"{_C['c']}▶ {msg}{_C['r']}")


def ok(msg):
    print(f"{_C['g']}✅ {msg}{_C['r']}")


def expand(v):
    return os.path.expandvars(os.path.expanduser(v.strip())) if v else v


def load_env_file():
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, val = line.split("=", 1)
        os.environ.setdefault(k.strip(), val.strip().strip('"').strip("'"))


def read_conf(path):
    cp = configparser.ConfigParser(inline_comment_prefixes=("#",))
    cp.optionxform = str
    if path.exists():
        cp.read(path)
    return cp


SSH_COMPAT_OPTS = ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15",
                   "-o", "HostKeyAlgorithms=+ssh-rsa", "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa"]

HOSTS = None


def _hosts():
    global HOSTS
    if HOSTS is None:
        HOSTS = read_conf(HOSTS_FILE)
    return HOSTS


class Server:
    """一台服务器：解析别名 → host/user/pass，并提供 ssh/scp。"""

    def __init__(self, ref, override_user=None, override_pass=None, dry_run=False):
        hp = _hosts()
        self.alias = ref
        if hp.has_section(ref):
            h = hp[ref]
            self.host = h.get("host", ref).strip()
            self.user = (override_user or h.get("user", "root")).strip()
            penv = h.get("pass_env", "").strip()
            base = os.environ.get(penv, "") if penv else ""
            if not base:
                base = os.environ.get(f"PASS_{ref}", "") or h.get("pass", "")
        else:
            self.host = ref
            self.user = (override_user or "root").strip()
            base = os.environ.get(f"PASS_{ref}", "") or os.environ.get("DEPLOY_PASSWD", "")
        self.passwd = (override_pass or base or "").strip()
        self.dry = dry_run

    def desc(self):
        return f"{self.user}@{self.host}"

    def _run(self, cmd):
        pretty = " ".join(shlex.quote(c) for c in cmd)
        if self.dry:
            print(f"   {_C['y']}[dry-run]{_C['r']} {pretty}")
            return 0
        # 去掉本地 LC_*/LANG，避免 ssh 把 locale 传到远端触发 setlocale 警告
        env = {k: v for k, v in os.environ.items()
               if not k.startswith("LC_") and k != "LANG"}
        return subprocess.call(cmd, env=env)

    def ssh_argv(self, tty=False):
        """构造 ssh 参数（可选交互式 PTY），供持久会话使用。

        交互式会话不用 sshpass：sshpass 会自建一个 pty，导致键入的命令在本地被
        额外回显一遍。改用 SSH_ASKPASS（见 tty_env）由 ssh 自己取密码，回显干净。
        """
        opts = list(SSH_COMPAT_OPTS)
        if tty:
            opts = ["-tt", *opts,
                    "-o", "PreferredAuthentications=password",
                    "-o", "PubkeyAuthentication=no",
                    "-o", "NumberOfPasswordPrompts=1"]
        base = ["ssh", *opts, f"{self.user}@{self.host}"]
        if self.passwd and not tty:
            base = ["sshpass", "-p", self.passwd] + base
        return base

    def tty_env(self, env=None):
        """交互式会话所需的环境（SSH_ASKPASS 喂密码）。"""
        env = dict(env or os.environ)
        if self.passwd:
            env["SSHPASS"] = self.passwd
            env["SSH_ASKPASS"] = str(DEPLOY_HOME / "askpass.sh")
            env["SSH_ASKPASS_REQUIRE"] = "force"
        return env

    def ssh(self, script):
        base = ["ssh", *SSH_COMPAT_OPTS, f"{self.user}@{self.host}", script]
        if self.passwd:
            base = ["sshpass", "-p", self.passwd] + base
        return self._run(base)

    def scp(self, local, remote):
        base = ["scp", "-q", *SSH_COMPAT_OPTS, str(local), f"{self.user}@{self.host}:{remote}"]
        if self.passwd:
            base = ["sshpass", "-p", self.passwd] + base
        return self._run(base)


class Deployer:
    def __init__(self, project, env=None, do_build=True, do_restart=True, dry_run=False):
        self.project = project
        self.conf_path = CONF_DIR / f"{project}.conf"
        if not self.conf_path.exists():
            die(f"找不到项目配置: {self.conf_path}（可用 deploy add {project} 生成）")
        self.cfg = read_conf(self.conf_path)
        if "project" not in self.cfg:
            die(f"{self.conf_path} 缺少 [project] 段")
        self.p = self.cfg["project"]
        self.do_build = do_build
        self.do_restart = do_restart
        self.dry = dry_run

        self.kind = self.p.get("kind", "jar").strip()
        self.proj_dir = Path(expand(self.p.get("dir", "")))
        if not self.proj_dir.exists():
            die(f"项目目录不存在: {self.proj_dir}")

        env = env or self.p.get("default_env", "").strip() or self._first_env()
        self.env = env
        sec = self._env_sec(env)
        self.sec = sec
        self.srv = Server(sec.get("host", env).strip(),
                          override_user=sec.get("user"),
                          dry_run=dry_run)
        self.path = expand(sec.get("path", self.p.get("remote_dir", "")))
        if not self.path:
            die(f"环境 '{env}' 缺少部署目录（path=）")
        self.profile = sec.get("profile", self.p.get("profile", "")).strip()
        self.port = sec.get("port", self.p.get("port", "")).strip()
        self.java = expand(sec.get("java", self.p.get("java", "java"))).strip()
        self.start_cmd = self.p.get("start_cmd", "").strip()

    def _first_env(self):
        for s in self.cfg.sections():
            if s.startswith("env:"):
                return s[4:]
        die(f"{self.conf_path.name} 没有登记任何 [env:xxx]")

    def _env_sec(self, env):
        for name in (f"env:{env}", env):
            if self.cfg.has_section(name):
                return self.cfg[name]
        die(f"环境 '{env}' 未在 {self.conf_path.name} 登记")

    # -- steps ---------------------------------------------------------
    def build(self):
        if not self.do_build:
            info("跳过构建（--no-build）")
            return
        build_cmd = self.p.get("build", "").strip()
        if not build_cmd:
            info("未配置 build，跳过")
            return
        cmd = (expand(build_cmd)
               .replace("{mvn}", self.p.get("mvn", "mvn"))
               .replace("{dir}", str(self.proj_dir)))
        home = expand(self.p.get("build_java_home", ""))
        info(f"构建：{cmd}" + (f"  [JAVA_HOME={home}]" if home else ""))
        env = dict(os.environ)
        if home:
            env["JAVA_HOME"] = home
        if self.dry:
            print(f"   {_C['y']}[dry-run]{_C['r']} (cd {self.proj_dir} && {cmd})")
            return
        if subprocess.call(cmd, shell=True, cwd=str(self.proj_dir), env=env) != 0:
            die("构建失败")

    def artifact_path(self):
        rel = self.p.get("artifact", "")
        if not rel:
            die("配置缺少 artifact（产物相对路径）")
        ap = Path(expand(str(self.proj_dir / rel)))
        if not ap.exists():
            die(f"产物不存在: {ap}")
        return ap

    def deploy(self):
        print(_C["b"] + "=" * 60 + _C["r"])
        print(f" 项目: {self.project}   环境: {self.env}   类型: {self.kind}")
        print(f" 目标: {self.srv.desc()}:{self.path}"
              + (f"  port={self.port}" if self.port else "")
              + (f"  profile={self.profile}" if self.profile else ""))
        print(_C["b"] + "=" * 60 + _C["r"])
        self.build()
        fn = getattr(self, f"deploy_{self.kind}", None)
        if not fn:
            die(f"未知 kind={self.kind}（支持 jar/war/static/docker）")
        fn()
        ok(f"完成：{self.project} → {self.env} ({self.srv.host})")

    def deploy_jar(self):
        ap = self.artifact_path()
        name = ap.name
        info(f"产物: {name} ({ap.stat().st_size // 1024} KB)")
        info("停止旧进程并备份")
        pat = shlex.quote(name)
        self.srv.ssh(
            f"mkdir -p {shlex.quote(self.path)}; cd {shlex.quote(self.path)}; "
            f"if [ -f {pat} ]; then cp -f {pat} {pat}.bak; echo '  已备份'; fi; "
            # 用 ps + [j]ava 技巧避免 pgrep -f 匹配到执行脚本的 shell 自身
            f"PIDS=$(ps -eo pid,args | grep '[j]ava' | grep -F {pat} | awk '{{print $1}}'); "
            f"if [ -n \"$PIDS\" ]; then echo \"  停止进程: $PIDS\"; kill $PIDS 2>/dev/null || true; "
            f"for i in $(seq 1 15); do sleep 1; ps -p $PIDS >/dev/null 2>&1 || break; done; "
            f"LEFT=$(ps -eo pid,args | grep '[j]ava' | grep -F {pat} | awk '{{print $1}}'); "
            f"[ -n \"$LEFT\" ] && kill -9 $LEFT 2>/dev/null || true; echo '  已停止'; "
            f"else echo '  无运行中的旧进程'; fi")
        info(f"上传 → {self.srv.desc()}:{self.path}")
        self.srv.scp(ap, f"{self.path}/{name}")
        if not self.do_restart:
            ok("已上传（--no-restart，未重启）")
            return
        info(f"启动服务{' (profile=' + self.profile + ')' if self.profile else ''}")
        if self.start_cmd:
            body = (self.start_cmd
                    .replace("{java}", self.java).replace("{jar}", name)
                    .replace("{profile}", self.profile).replace("{port}", self.port)
                    .rstrip().rstrip("&").rstrip())
        else:
            prof = f"--spring.profiles.active={self.profile}" if self.profile else ""
            body = f"nohup {shlex.quote(self.java)} -jar {shlex.quote(name)} {prof}".strip()
        health = ""
        url = self.sec.get("health_url", "").strip()
        if url:
            health = f"curl -s -m 3 {shlex.quote(url)} && echo '' || true; "
        wait = ""
        if self.port:
            wait = (f"ok=0; for i in $(seq 1 180); do "
                    f"if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':{self.port} '; then ok=1; break; fi; "
                    f"grep -q 'Started .*Application in' app.log 2>/dev/null && {{ ok=1; break; }}; sleep 1; done; ")
            check = (f"if [ \"$ok\" = 1 ]; then echo '  ✅ 启动成功（端口 {self.port} / 日志就绪）'; {health}"
                     f"else echo '  ❌ 等待启动超时（180s）'; tail -n 40 app.log; exit 1; fi")
        else:
            check = "sleep 5; echo '  已启动（未配端口，跳过探测）'; " + health
        rc = self.srv.ssh(f"cd {shlex.quote(self.path)}; "
                          f"{body} > app.log 2>&1 & echo \"  新进程 PID: $!\"; {wait}{check}")
        if not self.dry and rc != 0:
            die(f"服务启动失败（{self.project}/{self.env}），请查看上面的 app.log")

    def deploy_war(self):
        ap = self.artifact_path()
        info(f"上传 war → {self.path}")
        self.srv.scp(ap, f"{self.path}/{ap.name}")
        rc = self.p.get("restart_cmd", "").strip()
        if rc and self.do_restart:
            info(f"重启容器：{rc}")
            self.srv.ssh(expand(rc))
        ok("war 发布完成")

    def deploy_static(self):
        src = self.proj_dir / self.p.get("src_dir", "dist")
        if not src.exists():
            die(f"静态产物目录不存在: {src}")
        tgz = "/tmp/_deploy_static.tgz"
        info("打包静态产物")
        if not self.dry:
            subprocess.call(["tar", "-czf", tgz, "-C", str(src), "."])
        else:
            print(f"   [dry-run] tar -czf {tgz} -C {src} .")
        self.srv.scp(tgz, f"{self.path}/.deploy.tgz")
        self.srv.ssh(f"mkdir -p {shlex.quote(self.path)}; cd {shlex.quote(self.path)}; "
                     f"tar -xzf .deploy.tgz; rm -f .deploy.tgz; echo '  已解包'")
        rc = self.p.get("reload_cmd", "").strip()
        if rc:
            self.srv.ssh(expand(rc))
        ok("静态发布完成")

    def deploy_docker(self):
        b = self.p.get("docker_build", "").strip()
        if b:
            info(f"构建镜像：{b}")
            if not self.dry:
                subprocess.call(b, shell=True, cwd=str(self.proj_dir))
        cmd = self.p.get("deploy_cmd", "").strip()
        if not cmd:
            die("docker 类型需要配置 deploy_cmd")
        info("在服务器部署")
        self.srv.ssh(expand(cmd))
        ok("docker 发布完成")


# ---------------------------------------------------------------------
#  add / list / envs / upload / run
# ---------------------------------------------------------------------
def detect_and_write(name_or_dir):
    d = Path(expand(name_or_dir))
    if not d.exists():
        d = HOME / "IdeaProjects" / name_or_dir
    if not d.exists():
        die(f"找不到项目目录: {name_or_dir}")
    proj = d.name
    out = CONF_DIR / f"{proj}.conf"
    if out.exists():
        die(f"配置已存在: {out}")
    lines = [f"# 由 deploy add 生成于 {__import__('datetime').datetime.now():%F %T}，请核对 TODO", "", "[project]"]
    if (d / "pom.xml").exists() or list(d.glob("*/pom.xml")):
        lines.append("kind = jar")
        jdk = detect_jdk(d)
        if jdk and str(jdk).startswith(("1.", "6", "7", "8")):
            lines.append(f"build_java_home = {HOME}/Library/Java/JavaVirtualMachines/corretto-1.8.0_472/Contents/Home  # TODO")
        lines.append(f"mvn = {HOME}/maven/apache-maven-3.6.2/bin/mvn")
        lines.append("build = {mvn} -f pom.xml clean package -DskipTests")
        art = detect_springboot_jar(d)
        lines.append(f"artifact = {art}  # TODO 核对" if art else "artifact = target/xxx.jar  # TODO")
        lines.append("port =   # TODO 端口")
    elif (d / "package.json").exists():
        lines += ["kind = static", "build = npm install && npm run build", "src_dir = dist  # TODO"]
    elif (d / "docker-compose.yml").exists():
        lines += ["kind = docker", f"docker_build = docker build -t {proj}:latest .  # TODO",
                  "deploy_cmd = echo '服务器执行'  # TODO"]
    else:
        lines.append("kind = jar  # TODO")
    lines += ["", "# [env:207]", "# host = 207", f"# path = /usr/local/src/{proj}",
              "# profile = fat", "# port = 8085", "# java = java", f"", f"# 用法: deploy {proj}"]
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n")
    ok(f"已生成: {out}")
    print(f"   核对 TODO、补 [env:xxx] 段，然后:  deploy {proj}")


def detect_jdk(d):
    txt = ""
    for pom in [d / "pom.xml"] + list(d.glob("*/pom.xml")):
        txt += pom.read_text(errors="ignore")
    m = re.search(r"<(?:java\.version|maven\.compiler\.(?:source|target))>([^<]+)", txt)
    return m.group(1).strip() if m else None


def detect_springboot_jar(d):
    for pom in list(d.glob("*/pom.xml")) + [d / "pom.xml"]:
        try:
            t = pom.read_text(errors="ignore")
        except Exception:
            continue
        if "spring-boot-maven-plugin" not in t:
            continue
        module = pom.parent
        body = re.sub(r"<parent>.*?</parent>", "", t, flags=re.S)
        am = re.search(r"<artifactId>([^<]+)</artifactId>", body)
        vm = re.search(r"<version>([^<]+)</version>", body)
        art = am.group(1).strip() if am else module.name
        ver = vm.group(1).strip() if vm else "0.0.1-SNAPSHOT"
        tdir = module / "target"
        real = None
        if tdir.is_dir():
            jars = [x for x in tdir.glob("*.jar") if not x.name.endswith(("sources.jar", "javadoc.jar"))]
            real = ([x for x in jars if x.name.startswith(art)] or jars or [None])[0]
        rel = module.relative_to(d)
        rel = "" if str(rel) == "." else f"{rel}/"
        return f"{rel}target/{real.name}" if real else f"{rel}target/{art}-{ver}.jar"
    return None


def cmd_list():
    print("已登记项目:")
    for f in sorted(CONF_DIR.glob("*.conf")):
        cfg = read_conf(f)
        kind = cfg["project"].get("kind", "?") if cfg.has_section("project") else "?"
        envs = [s[4:] for s in cfg.sections() if s.startswith("env:")]
        print(f"  - {f.stem:24s} [{kind}]  {'/'.join(envs)}")


def cmd_envs(project):
    f = CONF_DIR / f"{project}.conf"
    if not f.exists():
        die(f"无此项目: {project}")
    cfg = read_conf(f)
    print(f"{project} 的环境:")
    for s in cfg.sections():
        if s.startswith("env:"):
            print(f"  - {s[4:]} → {cfg[s].get('host', '')}  {cfg[s].get('path','')}")


def cmd_upload(local, ref, remote_path=None, dry=False):
    p = Path(expand(local))
    if not p.exists():
        die(f"本地文件不存在: {p}")
    if ":" in ref:
        alias, rp = ref.split(":", 1)
    else:
        alias, rp = ref, None
    if not rp:
        rp = "~"
    if rp.endswith("/") or rp in ("~", "."):
        rp = rp.rstrip("/").rstrip() + "/" + p.name if rp not in ("~",) else rp
        if rp == "~":
            rp = "~/" + p.name
    srv = Server(alias, dry_run=dry)
    info(f"上传 {p.name} → {srv.desc()}:{rp}")
    rc = srv.scp(p, rp)
    if not dry and rc == 0:
        ok(f"已上传到 {srv.desc()}:{rp}")
    return rc


def cmd_run(alias, remote_cmd, dry=False):
    srv = Server(alias, dry_run=dry)
    info(f"在 {srv.desc()} 执行：{remote_cmd}")
    return srv.ssh(remote_cmd)


def usage():
    print(__doc__)
    print("可用项目:")
    for f in sorted(CONF_DIR.glob("*.conf")):
        print(f"  - {f.stem}")


def main():
    load_env_file()
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        usage()
        return
    cmd = args[0]
    if cmd == "list":
        return cmd_list()
    if cmd == "envs":
        return cmd_envs(args[1] if len(args) > 1 else die("用法: deploy envs <项目>"))
    if cmd == "add":
        return detect_and_write(args[1] if len(args) > 1 else die("用法: deploy add <项目>"))
    if cmd == "upload":
        if len(args) < 3:
            die("用法: deploy upload <本地文件> <服务器[:路径]>")
        return cmd_upload(args[1], args[2], dry="--dry-run" in args)
    if cmd == "run":
        if len(args) < 3:
            die("用法: deploy run <服务器> \"<命令>\"")
        return cmd_run(args[1], args[2], dry="--dry-run" in args)

    project = cmd
    rest = args[1:]
    env = next((a for a in rest if not a.startswith("-")), None)
    flags = set(a for a in rest if a.startswith("-"))
    Deployer(project, env,
             do_build="--no-build" not in flags,
             do_restart="--no-restart" not in flags,
             dry_run="--dry-run" in flags).deploy()


if __name__ == "__main__":
    main()
