"""Sequential Alimama promotion inspection with per-shop checkpoints."""
from __future__ import annotations

import argparse
import asyncio
import csv
import copy
import hashlib
import json
import math
import os
import sys
import urllib.request
from urllib.parse import parse_qs, urlsplit
import uuid
from datetime import datetime, timedelta, timezone
from contextlib import nullcontext
from pathlib import Path

from browser_lock import FileMutex
from promotion_adapter import PromotionAdapter, PromotionError, classify_error
from shop_registry import load_registry, selected_identity

SHANGHAI = timezone(timedelta(hours=8))
LOCAL_CONFIG = Path(__file__).resolve().parents[1] / "config.json"
DEFAULTS = {"thresholds": {"notifyRoiBelow": 2, "closeChargeAbove": 30, "closeRoiBelow": 1.5},
            "limits": {"pageSize": 500, "maxPages": 50, "retries": 2, "requestTimeoutSeconds": 90}}
LOCAL_ERRORS = {"login_required", "identity_mismatch", "profile_locked", "page_missing", "page_navigation_failed",
                "browser_not_running", "browser_connection_failed", "cdp_unavailable", "browser_failed", "page_request_failed",
                "browser_disconnected", "context_changed", "browser_identity_unverified"}
LOCAL_ERRORS.update({"browser_launch_failed", "browser_ownership_mismatch", "cookie_sync_failed", "browser_close_failed"})


def now():
    return datetime.now(SHANGHAI).isoformat(timespec="seconds")


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def load_webhook():
    """Read local notification credentials without adding them to batch state."""
    try:
        config = read_json(LOCAL_CONFIG)
    except OSError:
        raise ValueError("无法读取 Skill 根目录 config.json；请配置 wechat_webhook_url") from None
    except (ValueError, UnicodeError):
        raise ValueError("Skill 根目录 config.json 格式无效") from None
    webhook = config.get("wechat_webhook_url") if isinstance(config, dict) else None
    if not isinstance(webhook, str) or not webhook.strip():
        raise ValueError("Skill 根目录 config.json 缺少 wechat_webhook_url")
    webhook = webhook.strip()
    try:
        url = urlsplit(webhook)
        valid = (url.scheme == "https" and url.netloc == "qyapi.weixin.qq.com"
                 and url.path == "/cgi-bin/webhook/send" and not url.fragment
                 and bool(parse_qs(url.query).get("key", [""])[0].strip()))
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("config.json 中 wechat_webhook_url 不是有效的企业微信机器人地址")
    return webhook


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_bytes(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8"))
    os.replace(temporary, path)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def key(row):
    return (row["shopId"], row["promotionType"], row["campaignId"])


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def metric_value(value):
    if value is None or (isinstance(value, str) and not value.strip()):
        return 0
    if not finite(value):
        raise PromotionError("invalid_data", "指标不是有限数值")
    return value


def active(row):
    return row.get("displayStatus") == "start" and row.get("onlineStatus") == 1


def select(rows, thresholds):
    low = [row for row in rows if active(row) and metric_value(row.get("roi")) < thresholds["notifyRoiBelow"]]
    candidates = [row for row in rows if active(row)
                  and metric_value(row.get("roi")) < thresholds["closeRoiBelow"]
                  and metric_value(row.get("charge")) > thresholds["closeChargeAbove"]]
    return low, candidates


def load_config(path):
    raw = read_json(path) if path else {}
    if not isinstance(raw, dict) or set(raw) - set(DEFAULTS):
        raise ValueError("推广配置只支持 thresholds 与 limits")
    result = {section: {**default, **raw.get(section, {})} for section, default in DEFAULTS.items()}
    for name, value in result["thresholds"].items():
        if name not in DEFAULTS["thresholds"] or not finite(value) or value < 0:
            raise ValueError("推广阈值无效")
    limits = result["limits"]
    for name, maximum in [("pageSize", 500), ("maxPages", 200), ("retries", 3), ("requestTimeoutSeconds", 300)]:
        if isinstance(limits[name], bool) or not isinstance(limits[name], int) or not 1 <= limits[name] <= maximum:
            raise ValueError("推广读取限制无效: " + name)
    if set(limits) != set(DEFAULTS["limits"]):
        raise ValueError("未知读取限制")
    return result


def validate_rows(rows, shop, *, targets=None, date=None):
    if not isinstance(rows, list):
        raise PromotionError("invalid_data", "扫描返回不是列表")
    seen = set()
    normalized = []
    for row in rows:
        if (not isinstance(row, dict) or row.get("shopId") != shop["id"] or row.get("shopName") != shop["expected_alimama_shop"]
                or row.get("promotionType") not in {"全站推", "关键词推广"} or not isinstance(row.get("campaignId"), str)
                or not row["campaignId"].strip() or not isinstance(row.get("campaignName"), str) or not row["campaignName"].strip()):
            raise PromotionError("identity_mismatch", "计划身份与本次店铺不符")
        if key(row) in seen:
            raise PromotionError("invalid_data", "计划重复")
        seen.add(key(row))
        metrics = {field: metric_value(row.get(field)) for field in ("roi", "charge")}
        context = row.get("reportContext", {})
        if not isinstance(context, dict) or (date and (context.get("startTime") != date or context.get("endTime") != date)):
            raise PromotionError("invalid_data", "报表日期与本轮不符")
        expected_type = "verification" if targets is not None else "campaign"
        if row.get("recordType") != expected_type:
            raise PromotionError("invalid_data", "返回记录类型不符")
        normalized.append({**row, **metrics})
    if targets is not None and seen != {key(row) for row in targets}:
        raise PromotionError("invalid_data", "定向核验缺少目标或包含额外计划")
    return normalized


def reconcile(record, observations):
    by_key = {key(row): row for row in observations}
    for target in record["candidates"]:
        row = by_key.get(key(target))
        match = row and row.get("campaignName") == target["campaignName"] and row.get("verified") is True
        if match and row.get("outcome") == "inactive" and row.get("displayStatus") == "pause" and row.get("onlineStatus") == 0:
            outcome = "paused"
        elif match and row.get("outcome") == "active" and active(row):
            outcome = "active"
        else:
            outcome = "unverified"
        target["outcome"] = outcome
        target["latest"] = row
        target["verifiedAt"] = now()


def unresolved(record, mode, config):
    if not record.get("scan_complete"):
        return True
    if mode != "execute":
        return False
    for row in record.get("candidates", []):
        if row.get("outcome") == "paused":
            continue
        latest = row.get("latest") or {}
        if (row.get("outcome") == "active" and active(latest)
                and not select([latest], config["thresholds"])[1]):
            continue
        return True
    return False


def save_shop(run_dir, state, record):
    content = json.dumps(record, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    revision_hash = hashlib.sha256(content).hexdigest()
    shop_dir = run_dir / "shops" / record["id"]
    file = shop_dir / "checkpoints" / (revision_hash + ".json")
    if not file.exists():
        atomic_json(file, record)
    if digest(file) != revision_hash:
        raise ValueError("不可变店铺检查点哈希不符")
    state["shops"][record["id"]] = {"status": record["status"], "file": str(file.relative_to(run_dir)), "sha256": revision_hash}
    atomic_json(run_dir / "batch-state.json", state)
    # The state points at an immutable revision before refreshing this public
    # convenience copy. A crash between writes leaves a valid old/new pointer.
    atomic_json(shop_dir / "audit.json", record)


def load_shop(run_dir, receipt):
    file = (run_dir / receipt["file"]).resolve()
    if run_dir.resolve() not in file.parents or not file.is_file() or digest(file) != receipt["sha256"]:
        raise ValueError("店铺审计文件丢失或哈希不符，停止恢复")
    return read_json(file)


def retry_requests(path, state):
    if not path:
        return {}
    if state["mode"] != "execute":
        raise ValueError("只有原 execute 批次可以恢复写入")
    raw = read_json(path)
    if not isinstance(raw, list) or not raw:
        raise ValueError("retry-targets 必须为非空目标数组")
    result = {}
    for row in raw:
        if (not isinstance(row, dict) or row.get("operation_settled") is not True or not isinstance(row.get("reason"), str)
                or not row["reason"].strip() or any(not isinstance(row.get(field), str) or not row[field].strip()
                                                  for field in ("shopId", "promotionType", "campaignId"))):
            raise ValueError("每个重试目标必须包含精确身份及 operation_settled=true 和已核验的 reason")
        if key(row) in result:
            raise ValueError("重复重试目标")
        result[key(row)] = row
    return result


async def inspect_shop(run_dir, state, shop, record, retries, adapter_factory, connect_only, *, recovering=False):
    config = state["config"]
    is_resume = recovering or record is not None
    record = record or {"id": shop["id"], "store": shop["store"], "status": "pending", "scan_complete": False,
                        "rows": [], "low_roi": [], "candidates": [], "attempts": [], "errors": []}
    shop = dict(shop)
    if record.get("scan_identity"):
        shop["observed_identity"] = record["scan_identity"]
        shop["expected_alimama_shop"] = record["scan_identity"]["shopName"]
    record.pop("business_status", None)
    record["last_run_errors"] = []
    record["status"] = "running"
    save = lambda: save_shop(run_dir, state, record)
    save()
    is_rt = state["date"] == datetime.now(SHANGHAI).date().isoformat()
    adapter = None
    business_error = None

    def note_error(exc):
        error = classify_error(exc)
        record["errors"].append({"at": now(), "code": error.code, "message": str(error)})
        record["last_run_errors"].append(record["errors"][-1])
        record["status"] = "failed" if not record["scan_complete"] else "needs_review"

    def entry_error(exc):
        nonlocal business_error
        business_error = exc
        if isinstance(exc, Exception):
            note_error(exc)
        else:
            record["status"] = "needs_review"
            error = {"at": now(), "code": "interrupted", "message": "浏览器启动被中断，需要恢复处理"}
            record["errors"].append(error)
            record["last_run_errors"].append(error)
        if state.get("close_after_shop", False):
            record["business_status"] = record["status"]
            record["status"] = "closing"
            record["browser_cleanup"] = {"status": "pending"}
        save()

    try:
        adapter = adapter_factory(shop, config, connect_only=connect_only,
                                  close_after_shop=state.get("close_after_shop", False))
        adapter.on_entry_error = entry_error
        async with adapter:
            try:
                def accept_identity():
                    observed = getattr(adapter, "observed_identity", None)
                    if observed is None:
                        if shop.get("expected_shop_mode") == "account":
                            raise PromotionError("identity_mismatch", "完整账号模式缺少平台身份核验结果")
                        return
                    if (not isinstance(observed, dict) or not isinstance(observed.get("shopName"), str) or not observed["shopName"].strip()
                            or not isinstance(observed.get("nickName"), str) or not observed["nickName"].strip()
                            or (shop.get("login_username") and observed["nickName"] != shop["login_username"])
                            or (record.get("scan_identity") and observed != record["scan_identity"])
                            or (shop.get("expected_shop_mode") != "account" and observed["shopName"] != shop["expected_alimama_shop"])):
                        raise PromotionError("identity_mismatch", "当前平台店铺或账号与本轮核验身份不符")
                    record["scan_identity"] = dict(observed)
                    shop["expected_alimama_shop"] = observed["shopName"]

                if not record["scan_complete"]:
                    scanned = await adapter.scan(state["date"], is_rt)
                    accept_identity()
                    rows = validate_rows(scanned, shop, date=state["date"])
                    record["rows"] = rows
                    low, candidates = select(rows, config["thresholds"])
                    record["low_roi"] = low
                    record["candidates"] = [{**row, "outcome": "pending", "recovery_writes": 0} for row in candidates]
                    record["scan_complete"] = True
                    record["scannedAt"] = now()
                    save()
                targets = record["candidates"]
                # Resume starts with a fresh exact-ID read. No automatic write replay.
                if is_resume and state["mode"] == "execute" and targets:
                    observations = await adapter.scan(state["date"], is_rt, targets)
                    accept_identity()
                    reconcile(record, validate_rows(observations, shop, targets=targets, date=state["date"]))
                    save()
                if state["mode"] == "execute":
                    for row in targets:
                        retry = retries.get(key(row)) if is_resume else None
                        if is_resume:
                            if not retry or row.get("outcome") != "active" or not row.get("latest"):
                                continue
                            if row.get("recovery_writes", 0) >= 1:
                                record["errors"].append({"at": now(), "code": "retry_budget_exhausted", "promotionType": row["promotionType"],
                                                         "campaignId": row["campaignId"], "message": "本轮该计划的恢复写入次数已用完"})
                                save()
                                continue
                            if not select([row["latest"]], config["thresholds"])[1]:
                                continue
                            row["recovery_writes"] = row.get("recovery_writes", 0) + 1
                        attempt = {"promotionType": row["promotionType"], "campaignId": row["campaignId"], "status": "pending",
                                   "startedAt": now(), "recovery": bool(retry)}
                        if retry:
                            attempt["settlementEvidence"] = retry["reason"]
                        record["attempts"].append(attempt)
                        save()  # Durable pending record precedes every possible write.
                        try:
                            await adapter.pause(row["latest"] if retry else row)
                            attempt["status"] = "requested"
                        except Exception as exc:
                            error = classify_error(exc)
                            attempt["status"] = "not-written" if error.write_attempted is False else "uncertain"
                            attempt["error"] = {"code": error.code, "message": str(error)}
                            if error.code in {"login_required", "identity_mismatch"}:
                                raise error
                            if getattr(error, "auth_required", False):
                                raise PromotionError("login_required", "暂停结果未知且登录已失效；本店停止后续动作", write_attempted=True)
                        save()
                    if targets:
                        await asyncio.sleep(.3)
                        observations = await adapter.scan(state["date"], is_rt, targets)
                        accept_identity()
                        reconcile(record, validate_rows(observations, shop, targets=targets, date=state["date"]))
                        save()
                record["status"] = "needs_review" if unresolved(record, state["mode"], config) else "complete"
            except asyncio.CancelledError:
                record["status"] = "needs_review"
                error = {"at": now(), "code": "interrupted", "message": "本店处理被中断，需要只读恢复核验"}
                record["errors"].append(error)
                record["last_run_errors"].append(error)
                raise
            except Exception as exc:
                business_error = exc
                note_error(exc)
                raise
            finally:
                # Finish the durable business record before session save/close.
                if state.get("close_after_shop", False):
                    record["business_status"] = record["status"]
                    record["status"] = "closing"
                    record["browser_cleanup"] = {"status": "pending"}
                save()
    except Exception as exc:
        error = classify_error(exc)
        if exc is not business_error:
            note_error(exc)
        if not isinstance(exc, PromotionError) or error.code not in LOCAL_ERRORS:
            raise
    finally:
        had_business_record = "business_status" in record
        previous_status = record.pop("business_status", None)
        if record["status"] == "closing":
            record["status"] = previous_status or "needs_review"
        cleanup = getattr(adapter, "lifecycle_result", None)
        if state.get("close_after_shop", False) and had_business_record and (not cleanup or cleanup.get("status") != "closed"):
            cleanup = copy.deepcopy(cleanup or {"status": "open"})
            cleanup.setdefault("error", {"code": "browser_close_failed", "message": "浏览器关闭未确认完成，需要恢复处理"})
        if cleanup is not None:
            record["browser_cleanup"] = copy.deepcopy(cleanup)
            cleanup_errors = list(getattr(adapter, "cleanup_errors", []))
            if cleanup.get("error") and cleanup["error"] not in cleanup_errors:
                cleanup_errors.append(cleanup["error"])
            for error in cleanup_errors:
                record["errors"].append({"at": now(), **error})
                record["last_run_errors"].append(record["errors"][-1])
            if cleanup_errors:
                record["status"] = "needs_review"
        record["updatedAt"] = now()
        save()
    return record


def summaries(run_dir, state):
    rows = []
    for shop in state["identity"]["shops"]:
        sid = shop["id"]
        receipt = state["shops"].get(sid)
        record = load_shop(run_dir, receipt) if receipt else None
        rows.append({"id": sid, "store": shop["store"], "status": record["status"] if record else "not_run",
                     "scanned": len(record["rows"]) if record else 0, "low_roi": len(record["low_roi"]) if record else 0,
                     "to_pause": len(record["candidates"]) if record else 0,
                     "paused": sum(row.get("outcome") == "paused" for row in record["candidates"]) if record else 0,
                     "browser": record.get("browser_cleanup", {}).get("status", "unknown") if record else "not_run"})
    atomic_json(run_dir / "batch-summary.json", {"run_id": state["run_id"], "status": state["status"], "date": state["date"], "shops": rows})
    with (run_dir / "batch-summary.csv").open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=["id", "store", "status", "scanned", "low_roi", "to_pause", "paused", "browser"])
        writer.writeheader()
        writer.writerows(rows)
    return rows


def messages(run_dir, state):
    lines = ["# 千牛推广巡检", f"> 报表日期：{state['date']}"]
    if state.get("notification_policy") == "after_batch":
        round_number = state["notification"].get("round", 1)
        if round_number > 1:
            lines.append(f"> 第 {round_number} 次汇总（恢复核验）")
        counts = {status: sum(receipt["status"] == status for receipt in state["shops"].values())
                  for status in ("complete", "needs_review", "failed")}
        lines.append(f"> 已完成 {counts['complete']} 店｜待复核 {counts['needs_review'] + counts['failed']} 店｜未执行 {len(state['identity']['shops']) - len(state['shops'])} 店")
    if state["mode"] != "execute":
        lines.append("> 本次仅巡检，未执行暂停")
    candidates = []
    def clean(value):
        return str(value).replace("\n", " ").replace("<", "〈").replace(">", "〉")[:100]
    def metric(row):
        display = lambda value: f"{metric_value(value):.2f}"
        return f"<font color=\"comment\">ROI {display(row.get('roi'))}｜花费 {display(row.get('charge'))}</font>"
    for shop in state["identity"]["shops"]:
        receipt = state["shops"].get(shop["id"])
        record = load_shop(run_dir, receipt) if receipt else None
        lines.append("## " + clean(shop["store"]))
        if not record:
            lines.append("- 本店未执行，批次已提前停止")
            continue
        if record.get("browser_cleanup", {}).get("error"):
            lines.append("- 会话保存或浏览器关闭未完成，已停止继续打开后续店铺")
        if record["status"] != "complete" and record.get("errors"):
            codes = {item["code"] for item in record.get("last_run_errors", record["errors"])}
            if "login_required" in codes:
                lines.append("- 登录已失效，需要人工登录后恢复")
            elif "identity_mismatch" in codes:
                lines.append("- 店铺身份核验未通过，需要复核账号")
        if not record["scan_complete"]:
            lines.append("- 本店巡检未完成，请检查登录及页面状态")
            if not record["rows"]:
                continue
        lines.extend(f"- {clean(row['promotionType'])} / {clean(row['campaignName'])}｜{metric(row)}" for row in record["low_roi"])
        if not record["low_roi"]:
            lines.append("- 暂无低 ROI 推广")
        candidates.append(record)
    yield from split_message(lines)
    if not any(record["candidates"] for record in candidates):
        incomplete = len(candidates) < len(state["identity"]["shops"]) or any(
            not record["scan_complete"]
            for record in candidates)
        note = "；尚未完成的部分仍需复核" if incomplete else ""
        yield "# 暂停操作汇总\n已巡检计划中，暂无符合暂停条件的推广" + note + "。"
        return
    lines = ["# 暂停操作汇总", "> 待暂停为本轮符合规则的候选清单；已暂停以最终核验为准"]
    for record in candidates:
        if not record["candidates"]:
            continue
        lines.extend(["## " + clean(record["store"]), "### 待暂停"])
        for row in record["candidates"]:
            outcome = row.get("outcome")
            note = "已核验暂停" if outcome == "paused" else "仍在推广" if outcome == "active" else "待核验" if state["mode"] == "execute" else "本次未执行"
            latest = row.get("latest") or {}
            if (outcome == "active" and active(latest)
                    and not select([latest], state["config"]["thresholds"])[1]):
                note = "最新指标不符合暂停条件，无需暂停"
            lines.append(f"- <font color=\"warning\">{clean(row['promotionType'])} / {clean(row['campaignName'])}</font>｜{note}｜{metric(row.get('latest') or row)}")
        paused = [row for row in record["candidates"] if row.get("outcome") == "paused"]
        if paused:
            lines.append("### 已暂停")
            lines.extend(f"- <font color=\"info\">{clean(row['promotionType'])} / {clean(row['campaignName'])}</font>" for row in paused)
    yield from split_message(lines)


def split_message(lines):
    current = []
    for line in lines:
        if len(("\n".join(current + [line])).encode("utf-8")) > 3800:
            yield "\n".join(current)
            current = ["# 千牛推广（续）"]
        current.append(line)
    if current:
        yield "\n".join(current)


def send_wechat(webhook, message):
    body = json.dumps({"msgtype": "markdown", "markdown": {"content": message}}, ensure_ascii=False).encode()
    request = urllib.request.Request(webhook, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
        if result.get("errcode") != 0:
            raise ValueError("rejected")
    except Exception as exc:
        raise RuntimeError("企业微信发送结果未知，先核对群内记录，不自动重发") from exc


def finalize(run_dir, state, sender=send_wechat):
    if state["mode"] == "report" or state["notification"]["status"] in {"sent", "disabled"}:
        return
    if state["notification"]["status"] in {"sending", "delivery_unknown"}:
        raise ValueError("之前的通知送达状态未知；核对后再处理，不能自动重发")
    webhook = load_webhook()
    notification = state["notification"]
    if "messages" not in notification:
        notification.setdefault("round", 1)
        notification["snapshot"] = {"status": state["status"], "shops": copy.deepcopy(state["shops"])}
        notification["messages"] = list(messages(run_dir, state))
        atomic_json(run_dir / "batch-state.json", state)
    notices = notification["messages"]
    for index in range(state["notification"].get("sent", 0), len(notices)):
        state["notification"].update(status="sending", current=index)
        atomic_json(run_dir / "batch-state.json", state)
        try:
            sender(webhook, notices[index])
        except Exception:
            state["notification"]["status"] = "delivery_unknown"
            atomic_json(run_dir / "batch-state.json", state)
            raise
        state["notification"].update(sent=index + 1, status="pending")
        atomic_json(run_dir / "batch-state.json", state)
    state["notification"]["status"] = "sent"
    atomic_json(run_dir / "batch-state.json", state)


async def run(args, *, adapter_factory=PromotionAdapter, sender=send_wechat):
    if args.retry_targets and not args.resume:
        raise ValueError("--retry-targets 必须与 --resume 一起使用")
    if getattr(args, "no_notify", False) and args.mode == "dry-run":
        raise ValueError("dry-run 用于通知；仅本地巡检请用 report")
    previous = args.resume or args.finalize
    if previous:
        run_dir = Path(previous).resolve()
        if not (run_dir / "batch-state.json").is_file():
            raise ValueError("恢复目录缺少 batch-state.json")
    else:
        if not args.registry:
            raise ValueError("新批次需要 --registry")
        run_dir = Path(args.output_root).resolve() / ("promotion-" + datetime.now(SHANGHAI).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8])
        run_dir.mkdir(parents=True)
    registry_path = args.registry or (read_json(run_dir / "batch-state.json").get("registry") if previous else None)
    # A second scheduled batch must not open another shop in parallel.
    registry_lock = (FileMutex(Path(registry_path).resolve().with_name(".promotion-monitor.lock"),
                               {"operation": "promotion-batch"}) if registry_path and not args.finalize else nullcontext())
    with registry_lock, FileMutex(run_dir / ".batch.lock", {"operation": "promotion"}):
        if previous:
            state = read_json(run_dir / "batch-state.json")
            if state.get("schema_version") != 1 or state.get("backend") != "playwright-cdp":
                raise ValueError("不是新版 Playwright 批次，不导入旧版写入状态")
            # Hash checks precede any browser or notification side effect.
            for receipt in state["shops"].values():
                load_shop(run_dir, receipt)
            if args.finalize:
                if getattr(args, "no_notify", False) and state["notification"]["status"] not in {"sent", "sending", "delivery_unknown"}:
                    state["notification"]["status"] = "disabled"
                    atomic_json(run_dir / "batch-state.json", state)
                finalize(run_dir, state, sender)
                return run_dir, state
            notice = state["notification"]
            if notice["status"] in {"sending", "delivery_unknown"} or (notice["status"] == "pending" and notice.get("sent", 0)):
                raise ValueError("通知发送未完成或送达状态未知，先核对送达情况，不恢复或重发")
            if notice["status"] == "sent" and state.get("notification_policy") != "after_batch":
                raise ValueError("旧版批次通知已发送，不再修改该批次")
            if args.mode and args.mode != state["mode"]:
                raise ValueError("恢复不能切换模式")
            if args.date and args.date != state["date"]:
                raise ValueError("恢复不能切换报表日期")
            if args.config and load_config(args.config) != state["config"]:
                raise ValueError("恢复不能切换阈值或读取配置")
            if getattr(args, "keep_browser", False) and state.get("close_after_shop", False):
                raise ValueError("恢复不能更改本轮浏览器关闭策略")
            registry = load_registry(args.registry or state["registry"])
            selected = args.shops or state["identity"]["shop_ids"]
            if selected_identity(registry, selected) != state["identity"]:
                raise ValueError("选中店铺、顺序、账号或浏览器配置已改变")
        else:
            registry = load_registry(args.registry)
            date = args.date or datetime.now(SHANGHAI).date().isoformat()
            if datetime.strptime(date, "%Y-%m-%d").date().isoformat() != date:
                raise ValueError("日期必须为 YYYY-MM-DD")
            state = {"schema_version": 1, "backend": "playwright-cdp", "run_id": run_dir.name, "createdAt": now(),
                     "date": date, "mode": args.mode or "report", "config": load_config(args.config),
                     "registry": str(Path(args.registry).resolve()), "identity": selected_identity(registry, args.shops or []),
                     "status": "running", "shops": {}, "close_after_shop": not bool(getattr(args, "keep_browser", False)),
                     "notification_policy": "after_batch", "notification_history": [],
                     "notification": {"round": 1, "status": "disabled" if (args.mode or "report") == "report" or getattr(args, "no_notify", False) else "pending", "sent": 0}}
        retries = retry_requests(args.retry_targets, state)
        existing_targets = set()
        for receipt in state["shops"].values():
            existing_targets.update(key(row) for row in load_shop(run_dir, receipt)["candidates"])
        if set(retries) - existing_targets:
            raise ValueError("重试目标不在原批次待暂停清单中；先执行只读恢复")
        if args.resume and state["notification"]["status"] == "sent" and state["status"] != "complete":
            # A new summary revision keeps the delivered evidence immutable.
            previous_notice = copy.deepcopy(state["notification"])
            state.setdefault("notification_history", []).append(previous_notice)
            state["notification"] = {"round": previous_notice.get("round", 1) + 1, "status": "pending", "sent": 0}
        if args.resume and state["notification"]["status"] == "pending" and not state["notification"].get("sent", 0):
            # Nothing was sent: a resume must describe the newly read data.
            state["notification"].pop("messages", None)
            state["notification"].pop("snapshot", None)
        if getattr(args, "no_notify", False) and state["notification"]["status"] != "sent":
            state["notification"]["status"] = "disabled"
        if state["notification"]["status"] not in {"disabled", "sent"}:
            load_webhook()
        atomic_json(run_dir / "batch-state.json", state)
        by_id = {shop["id"]: shop for shop in registry["shops"]}
        cancelled = False
        try:
            for sid in state["identity"]["shop_ids"]:
                receipt = state["shops"].get(sid)
                record = load_shop(run_dir, receipt) if receipt else None
                if record and record["status"] == "complete":
                    continue
                print(f"[{sid}] {by_id[sid]['store']}: 巡检", flush=True)
                record = await inspect_shop(run_dir, state, by_id[sid], record, retries, adapter_factory, args.connect_only, recovering=bool(args.resume))
                if record.get("browser_cleanup", {}).get("error"):
                    state["status"] = "stopped"
                    break
            else:
                state["status"] = "complete" if all(value["status"] == "complete" for value in state["shops"].values()) else "needs_review"
        except asyncio.CancelledError:
            cancelled = True
            state["status"] = "stopped"
            raise
        except Exception:
            state["status"] = "stopped"
            raise
        finally:
            state["updatedAt"] = now()
            atomic_json(run_dir / "batch-state.json", state)
            summaries(run_dir, state)
            (run_dir / "report.md").write_text("\n\n---\n\n".join(messages(run_dir, state)), encoding="utf-8")
            if not cancelled and state["mode"] != "report" and (state.get("notification_policy") == "after_batch" or state["status"] == "complete"):
                finalize(run_dir, state, sender)
        return run_dir, state


def parser():
    p = argparse.ArgumentParser(description="千牛推广巡检：原生 Edge + Playwright CDP，多店串行")
    p.add_argument("--registry")
    p.add_argument("--config")
    p.add_argument("--mode", choices=("report", "dry-run", "execute"))
    p.add_argument("--date")
    p.add_argument("--shops", nargs="+")
    p.add_argument("--output-root", default="outputs")
    p.add_argument("--connect-only", action="store_true")
    p.add_argument("--keep-browser", action="store_true", default=None, help="单店结束仅断开连接，保留浏览器供人工检查")
    p.add_argument("--no-notify", action="store_true", help="execute 仅保存本地结果，不发企业微信")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--resume")
    group.add_argument("--finalize")
    p.add_argument("--retry-targets")
    return p


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = parser().parse_args()
    try:
        output, state = asyncio.run(run(args))
        print(json.dumps({"output": str(output), "status": state["status"], "notification": state["notification"]["status"]}, ensure_ascii=False))
        return 0 if state["status"] == "complete" else 2
    except Exception as exc:
        # No raw page/network exception or webhook address is printed.
        message = str(exc) if isinstance(exc, (ValueError, PromotionError)) else "运行中止，检查本地配置、锁和检查点"
        print(json.dumps({"status": "failed", "message": message}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
