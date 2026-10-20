"""自然语言 -> SQL：调用 OpenAI 兼容的 chat/completions 接口。"""
import json
import re

import requests

DIALECT_NOTES = {
    "mysql": "MySQL：使用反引号包裹标识符；分页用 LIMIT n OFFSET m；日期函数如 DATE()、NOW()。",
    "dm": "达梦 DM（高度兼容 Oracle 语法）：标识符用双引号；ROWNUM 分页或 LIMIT 均可用；别用 MySQL 专属函数。",
    "oracle": "Oracle：标识符用双引号；分页用 ROWNUM 或 OFFSET/FETCH；字符串拼接用 ||。",
    "postgresql": "PostgreSQL：标识符用双引号；分页用 LIMIT/OFFSET；schema 需显式限定。",
    "hive2": "Hive：类 SQL，注意分区字段；分页用 LIMIT；避免事务类语法。",
    "sqlserver": "SQL Server：标识符用方括号；分页用 TOP 或 OFFSET/FETCH。",
}


class LLMError(Exception):
    pass


def _endpoint(base_url):
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return base + "/chat/completions"


def chat(cfg, messages, temperature=0.0, max_tokens=2000):
    llm = cfg.get("llm") or {}
    base_url = llm.get("base_url")
    api_key = llm.get("api_key")
    model = llm.get("model")
    if not base_url or not api_key:
        raise LLMError("未配置 LLM。请在 config.json 的 llm 字段或 OPENAI_BASE_URL/OPENAI_API_KEY 环境变量中提供。")
    resp = requests.post(
        _endpoint(base_url),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"model": model, "messages": messages,
              "temperature": temperature, "max_tokens": max_tokens},
        timeout=90,
    )
    if resp.status_code != 200:
        raise LLMError(f"LLM 接口返回 {resp.status_code}: {resp.text[:400]}")
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def _extract_json(text):
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    return json.loads(text)


def generate_sql(cfg, question, meta, history=None):
    """把自然语言问题编译成一条 SQL。返回 {sql, explanation}。"""
    lines = [f"数据库类型：{meta['typeLabel']}（{meta['type']}）",
             f"数据库：{meta.get('database') or '(默认)'}"]
    if meta.get("schema"):
        lines.append(f"schema：{meta['schema']}")
    lines.append("")
    lines.append("可用的表和字段（可能不完整）：")
    for table, cols in meta.get("tables", {}).items():
        lines.append(f"- {table}({', '.join(cols)})")
    schema_text = "\n".join(lines)

    dialect = DIALECT_NOTES.get(meta["type"], "")
    system = (
        "你是一个资深的 SQL 专家。请根据给定的数据库结构，把用户的自然语言需求转换为一条"
        "可直接执行的 SELECT/查询 SQL。\n"
        "要求：\n"
        "1. 只生成一条 SQL 语句，务必是安全的只读查询；除非用户明确要求，否则不要写数据。\n"
        "2. 只使用给定结构中存在的表和字段；若不确定，选择最合理的表。\n"
        f"3. 遵循目标数据库方言：{dialect}\n"
        "4. 如果用户描述不完整，合理补全（例如默认加 LIMIT 50）。\n"
        '5. 只返回 JSON，格式为 {"sql": "...", "explanation": "用中文简述这条SQL在做什么"}，不要有多余文字。'
    )
    messages = [{"role": "system", "content": system}]
    if history:
        messages.extend(history[-6:])
    messages.append({"role": "user", "content": f"数据库结构：\n{schema_text}\n\n用户需求：{question}"})
    raw = chat(cfg, messages)
    try:
        parsed = _extract_json(raw)
    except Exception as exc:  # noqa: BLE001
        raise LLMError(f"无法解析模型输出为 SQL：{exc}\n原始输出：{raw[:400]}")
    sql = (parsed.get("sql") or "").strip().rstrip(";").strip()
    if not sql:
        raise LLMError(f"模型没有返回 SQL：{raw[:300]}")
    return {"sql": sql, "explanation": parsed.get("explanation", "")}


def summarize(cfg, question, columns, rows):
    preview = [dict(zip(columns, r)) for r in rows[:50]]
    system = "你是一个数据分析助手，请用简洁的中文回答用户的问题，基于给出的查询结果。"
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content":
            f"用户问题：{question}\n\n查询结果（最多50行）：\n{json.dumps(preview, ensure_ascii=False, default=str)}"},
    ]
    return chat(cfg, messages, temperature=0.2, max_tokens=800)
