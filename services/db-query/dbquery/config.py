"""配置加载：优先 config.json，其次环境变量，再次 Codex 的 config.toml。"""
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
CODEX_CONFIG = Path.home() / ".codex" / "config.toml"

DEFAULTS = {
    "projects_root": str(Path.home() / "IdeaProjects"),
    "max_rows": 200,
    "extra_classpath": [],
    "exclude_dirs": ["target", "node_modules", "dist", ".git", "build", "logs", ".idea"],
    "llm": None,
}


def _load_codex_llm():
    """从 ~/.codex/config.toml 里抠出 OpenAI 兼容端点信息。"""
    if not CODEX_CONFIG.exists():
        return None
    text = CODEX_CONFIG.read_text(encoding="utf-8", errors="ignore")
    block = re.search(r"\[model_providers\.\w+\](.*?)(?:\n\[|\Z)", text, re.S)
    if not block:
        return None
    body = block.group(1)
    base = re.search(r'base_url\s*=\s*"([^"]+)"', body)
    token = re.search(r'(?:experimental_bearer_token|bearer_token|api_key)\s*=\s*"([^"]+)"', body)
    model = re.search(r'^model\s*=\s*"([^"]+)"', text, re.M)
    if not base:
        return None
    return {
        "base_url": base.group(1),
        "api_key": token.group(1) if token else None,
        "model": model.group(1) if model else "gpt-4o-mini",
    }


def load():
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] 读取 config.json 失败: {exc}")

    env_root = os.environ.get("DBQUERY_PROJECTS_ROOT")
    if env_root:
        cfg["projects_root"] = env_root

    if not cfg.get("llm"):
        env_llm = {
            "base_url": os.environ.get("OPENAI_BASE_URL") or os.environ.get("DBQUERY_LLM_BASE_URL"),
            "api_key": os.environ.get("OPENAI_API_KEY") or os.environ.get("DBQUERY_LLM_API_KEY"),
            "model": os.environ.get("DBQUERY_LLM_MODEL") or os.environ.get("OPENAI_MODEL"),
        }
        if env_llm["base_url"] and env_llm["api_key"]:
            cfg["llm"] = env_llm
        else:
            codex = _load_codex_llm()
            if codex:
                cfg["llm"] = codex
    return cfg
