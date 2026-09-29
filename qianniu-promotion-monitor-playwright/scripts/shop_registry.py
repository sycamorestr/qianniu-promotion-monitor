"""Registry validation and deterministic identity for multi-shop runs."""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from playwright_controller import BrowserControllerError, _configured_debug_port, load_browser_config
from promotion_browser_config import with_promotion_page

ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


class RegistryError(ValueError):
    pass


def _path(base: Path, value: str) -> Path:
    candidate = Path(value).expanduser()
    return (base / candidate if not candidate.is_absolute() else candidate).resolve()


def _sha(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RegistryError(f"无法读取配置: {path}") from exc
    if not isinstance(value, dict):
        raise RegistryError(f"配置必须是 JSON 对象: {path}")
    return value


def _catalog(path: Path, *, allow_empty: bool = False) -> list[dict[str, Any]]:
    value = _load_json(path)
    if value.get("schema_version") != 1:
        raise RegistryError(f"店铺清单 schema_version 必须为 1: {path}")
    shops = value.get("shops")
    if not isinstance(shops, list) or (not shops and not allow_empty):
        raise RegistryError(f"shops 必须是{'非空' if not allow_empty else ''}数组: {path}")
    if any(not isinstance(item, dict) for item in shops):
        raise RegistryError(f"shops 中每个店铺必须是对象: {path}")
    return [dict(item) for item in shops]


def _nested(first: Path, second: Path) -> bool:
    first = Path(os.path.normcase(str(first.resolve())))
    second = Path(os.path.normcase(str(second.resolve())))
    return first == second or first in second.parents or second in first.parents


def _required_text(value: Any, message: str) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise RegistryError(message)
    return value


def load_registry(path: str | os.PathLike[str], *, include_workbench: bool = True) -> dict[str, Any]:
    source = Path(path).expanduser().resolve()
    shops = [(item, source.parent) for item in _catalog(source)]
    sidecar = source.with_name(".browser-workbench-shops.json")
    if include_workbench and sidecar.exists():
        shops.extend((item, sidecar.parent) for item in _catalog(sidecar, allow_empty=True))
    result: list[dict[str, Any]] = []
    ids: set[str] = set()
    environments: list[tuple[Path, Path, int]] = []
    for item, base in shops:
        sid = item.get("id")
        if not isinstance(sid, str) or not ID_RE.fullmatch(sid) or sid in {"shared", "piaoju"}:
            raise RegistryError("店铺 id 必须以小写字母开头，仅含字母、数字、下划线和连字符")
        if sid in ids:
            raise RegistryError(f"重复店铺 id: {sid}")
        store = _required_text(item.get("store"), f"店铺 {sid} 的 store 无效")
        config_value = _required_text(item.get("browser_config") or item.get("config"), f"店铺 {sid} 缺少 browser_config")
        config_path = _path(base, config_value)
        try:
            normalized, _ = load_browser_config(config_path)
            effective = with_promotion_page(normalized)
            port = _configured_debug_port(effective)
        except (BrowserControllerError, ValueError) as exc:
            raise RegistryError(f"店铺 {sid} 浏览器配置无效: {exc}") from exc
        data_root = Path(effective["user_data_dir"])
        download_root = Path(effective["download_dir"])
        for other_root, other_download, other_port in environments:
            if _nested(data_root, other_root):
                raise RegistryError("多个店铺不能共享或嵌套 user_data_dir")
            if _nested(download_root, other_download):
                raise RegistryError("多个店铺不能共享或嵌套 download_dir")
            if _nested(download_root, other_root) or _nested(data_root, other_download):
                raise RegistryError("一个店铺的下载目录不能占用另一店铺的浏览器目录")
            if port == other_port:
                raise RegistryError(f"店铺 {sid} 的 CDP 端口与其他店铺冲突")
        # Include the actual default too: two omitted ports still conflict.
        effective["remote_debugging_port"] = port
        login_username = item.get("login_username")
        if login_username in (None, ""):
            login_username = None
        else:
            login_username = _required_text(login_username, f"店铺 {sid} 的 login_username 无效")
        explicit_shop = item.get("expected_alimama_shop")
        expected_shop = _required_text(explicit_shop if explicit_shop is not None else store,
                                       f"店铺 {sid} 的 expected_alimama_shop 无效")
        expected_shop_mode = "account" if explicit_shop is None and login_username else "shop"
        identity = {
            "id": sid,
            "store": store,
            "browser_config": str(config_path),
            "config_sha256": _sha(effective),
            "login_username": login_username,
            "expected_alimama_shop": expected_shop,
            "expected_shop_mode": expected_shop_mode,
        }
        # Arbitrary source fields are not carried into job state or audit.
        result.append({**identity, "browser_config_value": effective})
        ids.add(sid)
        environments.append((data_root, download_root, port))
    return {"schema_version": 1, "source": str(source), "shops": result}


def selected_identity(registry: dict[str, Any], shop_ids: list[str]) -> dict[str, Any]:
    by_id = {shop["id"]: shop for shop in registry["shops"]}
    if not shop_ids:
        shop_ids = [shop["id"] for shop in registry["shops"]]
    if len(set(shop_ids)) != len(shop_ids) or any(sid not in by_id for sid in shop_ids):
        raise RegistryError("--shops 含有未知或重复店铺")
    fields = ("id", "store", "browser_config", "config_sha256", "login_username", "expected_alimama_shop", "expected_shop_mode")
    selected = [{key: by_id[sid][key] for key in fields} for sid in shop_ids]
    identity = {"source": registry["source"], "shop_ids": list(shop_ids), "shops": selected}
    return {**identity, "sha256": _sha(identity)}
