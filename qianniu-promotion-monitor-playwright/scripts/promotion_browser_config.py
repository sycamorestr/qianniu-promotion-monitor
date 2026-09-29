"""Normalize a workbench browser config to one Alimama page role."""
from __future__ import annotations

from copy import deepcopy
from typing import Any

PROMOTION_URL = "https://one.alimama.com/index.html#!/manage/onesite"


def with_promotion_page(config: dict[str, Any]) -> dict[str, Any]:
    """Derive only the promotion role without rewriting a saved environment."""
    if not isinstance(config, dict):
        raise ValueError("浏览器配置必须是对象")
    result = deepcopy(config)
    sessions = result.get("browser_sessions")
    if not isinstance(sessions, dict) or not sessions:
        raise ValueError("browser_sessions 必须是非空对象")
    allowed = {"home", "invoice", "orders", "goods", "promotion", "all_site", "keyword"}
    unknown = set(sessions) - allowed
    if unknown:
        raise ValueError(f"browser_sessions 包含未知角色: {', '.join(sorted(unknown))}")
    # A workbench homepage is not a promotion page. Preserve promotion-role
    # options only; a known route replaces any stale saved business URL.
    current = sessions.get("promotion") or sessions.get("all_site")
    effective = deepcopy(current) if isinstance(current, dict) else {}
    effective.pop("href", None)
    effective.pop("urls", None)
    effective["url"] = PROMOTION_URL
    result["browser_sessions"] = {"promotion": effective}
    return result
