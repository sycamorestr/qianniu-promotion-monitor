"""Playwright/CDP transport. Business requests execute only in the authenticated page."""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from browser_lock import FileMutexBusy
from playwright_controller import PlaywrightBrowserController, BrowserControllerError, configured_lock_wait_ms
from promotion_browser_lifecycle import save_and_close

URLS = {"全站推": "https://one.alimama.com/index.html#!/manage/onesite",
        "关键词推广": "https://one.alimama.com/index.html#!/manage/search"}
ADAPTERS = Path(__file__).resolve().parent.parent / "adapters"

# Reads only the current route's Magix user object. No network, cookie,
# credentials, or business API access is needed to establish this identity.
IDENTITY_PROBE = r"""(() => {
  const input = __INPUT__;
  const href = String(location.href || '');
  if (/(?:\/login|\/signin|passport)/i.test(href))
    throw new Error('Authentication required: Alimama login page is active');
  let pageUrl, route;
  try {
    pageUrl = new URL(href);
    if (pageUrl.protocol !== 'https:' || pageUrl.hostname !== 'one.alimama.com'
        || !pageUrl.hash.startsWith('#!')) throw new Error();
    route = new URL(pageUrl.hash.slice(2), pageUrl.origin).pathname.replace(/\/$/, '');
  } catch { throw new Error('Not on requested Alimama page'); }
  const expectedRoute = input.type === 'keyword' ? '/manage/search' : '/manage/onesite';
  if (route !== expectedRoute) throw new Error('Not on requested Alimama page');
  if (!input.expectedShop && !input.expectedAccount)
    throw new Error('An exact expected identity is required');
  let Magix;
  for (const entry of Object.values(window.seajs?.cache || {})) {
    const exported = entry?.exports;
    const candidate = exported?.default?.Vframe ? exported.default : exported;
    if (candidate?.Vframe && candidate?.Router && candidate?.State) { Magix = candidate; break; }
  }
  const pattern = input.type === 'keyword' ? /search\/campaign-list/ : /onesite\/campaign-list/;
  const frames = Magix ? Object.values(Magix.Vframe.all()).filter(item => pattern.test(item.path || '')).reverse() : [];
  const frame = frames.find(item => typeof item?.$v?.updater?.get === 'function');
  if (!frame) throw new Error('Identity probe is not ready');
  const nickName = String(frame.$v.updater.get('user')?.meta?.nickName || '');
  const shopName = nickName.split(/[:：]/)[0].trim();
  if (!shopName || !nickName) throw new Error('Logged-in shop identity is unavailable');
  if (input.expectedAccount !== undefined && nickName !== input.expectedAccount)
    throw new Error('Account identity does not match expected-account');
  if (input.expectedShop !== undefined && shopName !== input.expectedShop)
    throw new Error('Shop identity does not match expected-shop');
  return {shopName, nickName};
})()"""


class PromotionError(RuntimeError):
    def __init__(self, code: str, message: str, *, write_attempted: bool | None = None):
        super().__init__(message)
        self.code = code
        self.write_attempted = write_attempted


def classify_error(error: Exception) -> PromotionError:
    if isinstance(error, PromotionError):
        return error
    text = str(error)
    if isinstance(error, BrowserControllerError):
        return PromotionError(error.code, "浏览器环境不可用，请检查本店登录、页面或目录占用")
    if "Pause outcome uncertain" in text:
        uncertain = PromotionError("write_uncertain", "暂停请求结果未知，必须定向回查", write_attempted=True)
        uncertain.auth_required = bool(re.search(r"Authentication required|not logged|session.*(?:expired|invalid)|未登录|登录.*(?:过期|失效)", text, re.I))
        return uncertain
    if re.search(r"Authentication required|Logged-in shop identity is unavailable|not logged|session.*(?:expired|invalid)|未登录|登录.*(?:过期|失效)|(?:passport|login)\.", text, re.I):
        return PromotionError("login_required", "本店登录已失效，需要人工登录")
    if re.search(r"identity|expected-shop|expected-account|name does not match", text, re.I):
        return PromotionError("identity_mismatch", "页面店铺、账号或计划身份与本次配置不符")
    marker = re.search(r"\[PAUSE_PRECHECK:([A-Z_]+)\]", text)
    if marker and "Pause outcome uncertain" not in text:
        return PromotionError("precheck_rejected", "暂停前复核未通过: " + marker.group(1), write_attempted=False)
    return PromotionError("page_request_failed", "页面接口未完成；保留检查点供核验")


class PromotionAdapter:
    def __init__(self, shop: dict, config: dict, *, connect_only: bool = False, close_after_shop: bool = False):
        self.shop, self.config, self.connect_only = shop, config, connect_only
        self.close_after_shop = close_after_shop
        self.controller = PlaywrightBrowserController(shop["browser_config_value"], timeout_ms=30_000,
            lock_wait_ms=configured_lock_wait_ms(shop["browser_config_value"], default_seconds=5),
            retain_on_page_error=close_after_shop)
        self.page = None
        self.owned_pages = []
        self.lifecycle_result = {"status": "not_connected"}
        self.cleanup_errors = []
        self.observed_identity = None
        saved_identity = shop.get("observed_identity")
        if saved_identity is not None:
            self.observed_identity = self._validate_identity(saved_identity)

    async def __aenter__(self):
        try:
            if self.connect_only:
                await self.controller.connect(open_missing=True)
            else:
                await self.controller.start(open_missing=True)
            self.lifecycle_result = {"status": "open"}
            self.page = self.controller.page("promotion")
            return self
        except BaseException as exc:
            error = classify_error(exc) if isinstance(exc, Exception) else exc
            if (isinstance(exc, BrowserControllerError) and exc.code == "profile_locked"
                    and isinstance(exc.__cause__, FileMutexBusy)):
                # This mutex is acquired before starting Playwright or touching
                # a browser. Other profile/port errors do not prove that.
                self.lifecycle_result = {"status": "not_connected", "reason": "profile_lock_busy"}
                error = PromotionError("profile_locked", "浏览器目录被其他任务占用，等待后仍未释放")
            callback = getattr(self, "on_entry_error", None)
            if callback is not None:
                try:
                    callback(error)
                except BaseException:
                    self.lifecycle_result = {"status": "open", "error": {
                        "code": "audit_save_failed", "message": "启动失败记录未能落盘，浏览器保留"}}
                    await self.controller.close()
                    raise
            await self._cleanup()
            if not isinstance(exc, Exception):
                raise
            raise error from exc

    async def __aexit__(self, *_):
        await self._cleanup()

    async def _cleanup(self):
        # Only pages explicitly created for writes belong to this operation.
        try:
            for page in self.owned_pages:
                try:
                    await asyncio.wait_for(page.close(), 5)
                except Exception:
                    pass
            if self.close_after_shop and getattr(self.controller, "browser", None) is not None:
                try:
                    self.lifecycle_result = await save_and_close(self.controller)
                except BaseException as exc:
                    code = exc.code if isinstance(exc, BrowserControllerError) else "browser_close_failed"
                    messages = {"cookie_sync_failed": "会话保存失败，浏览器保留，后续店铺未启动",
                                "browser_ownership_mismatch": "浏览器归属或退出状态无法确认，后续店铺未启动"}
                    error = {"code": code, "message": messages.get(code, "浏览器未确认正常关闭，后续店铺未启动")}
                    self.cleanup_errors.append(error)
                    self.lifecycle_result = {"status": "open", "error": error}
                    if isinstance(exc, BrowserControllerError) and isinstance(exc.details.get("cookie_sync"), dict):
                        self.lifecycle_result["cookie_sync"] = exc.details["cookie_sync"]
                        self.lifecycle_result["reason"] = exc.details.get("reason")
                    if not isinstance(exc, Exception):
                        raise
            elif not self.close_after_shop and self.lifecycle_result.get("reason") != "profile_lock_busy":
                self.lifecycle_result = {"status": "kept"}
        finally:
            try:
                await self.controller.close()
            except Exception:
                error = {"code": "browser_close_failed", "message": "浏览器控制连接未正常释放，后续店铺未启动"}
                self.cleanup_errors.append(error)
                self.lifecycle_result["error"] = error

    def _args(self, promotion_type: str, date: str, is_rt: bool) -> dict:
        args = {"type": "keyword" if promotion_type == "关键词推广" else "all-site",
                "pageSize": self.config["limits"]["pageSize"], "maxPages": self.config["limits"]["maxPages"],
                "reportDate": date, "isRt": is_rt, **self._identity_constraints()}
        if "expectedShop" not in args:
            raise PromotionError("identity_mismatch", "账号绑定模式尚未核验实际店铺，禁止采集")
        return args

    def _identity_constraints(self) -> dict:
        observed = getattr(self, "observed_identity", None)
        mode = self.shop.get("expected_shop_mode", "shop")
        if mode not in {"shop", "account"}:
            raise PromotionError("identity_mismatch", "未知店铺身份约束模式")
        expected_account = self.shop.get("login_username")
        if mode == "account" and not expected_account:
            raise PromotionError("identity_mismatch", "账号绑定模式缺少已确认完整账号")
        result = {}
        if observed is not None:
            result = {"expectedShop": observed["shopName"], "expectedAccount": observed["nickName"]}
        elif mode == "shop":
            result["expectedShop"] = self.shop["expected_alimama_shop"]
        if expected_account:
            result["expectedAccount"] = expected_account
        return result

    def _validate_identity(self, value: dict) -> dict:
        if (not isinstance(value, dict) or any(not isinstance(value.get(field), str) or not value[field].strip()
                                               for field in ("shopName", "nickName"))):
            raise PromotionError("identity_mismatch", "页面未返回完整店铺与账号身份")
        expected = self._identity_constraints()
        if ((expected.get("expectedShop") is not None and value["shopName"] != expected["expectedShop"])
                or (expected.get("expectedAccount") is not None and value["nickName"] != expected["expectedAccount"])):
            raise PromotionError("identity_mismatch", "页面店铺或完整账号与本次绑定身份不符")
        return {"shopName": value["shopName"], "nickName": value["nickName"]}

    async def _probe_identity(self, page, promotion_type: str):
        args = {"type": "keyword" if promotion_type == "关键词推广" else "all-site", **self._identity_constraints()}
        value = await self._evaluate_source(page, IDENTITY_PROBE, args)
        self.observed_identity = self._validate_identity(value)
        return self.observed_identity

    async def _navigate(self, page, promotion_type: str):
        await page.goto(URLS[promotion_type], wait_until="domcontentloaded", timeout=30_000)
        # Preserve the upstream adapter's settling interval for the SPA report runtime.
        # Identity and list readiness checks still run after this bounded wait.
        await asyncio.sleep(4)

    async def _evaluate(self, page, filename: str, args: dict):
        source = (ADAPTERS / filename).read_text(encoding="utf-8-sig")
        return await self._evaluate_source(page, source, args)

    async def _evaluate_source(self, page, source: str, args: dict):
        expression = source.replace("__INPUT__", json.dumps(args, ensure_ascii=False, separators=(",", ":")))
        # Only a definitive failure before the first request may repeat.
        ready_attempts = self.config["limits"]["retries"] * 10
        for attempt in range(ready_attempts + 1):
            try:
                return await asyncio.wait_for(page.evaluate(expression), self.config["limits"]["requestTimeoutSeconds"])
            except Exception as exc:
                first_line = str(exc).splitlines()[0] if str(exc) else ""
                ready_error = re.fullmatch(r"(?:Page\.evaluate: )?(?:Error: )?(?:(?:Campaign|all-site campaign|keyword campaign) list is not ready|Identity probe is not ready)", first_line)
                if attempt < ready_attempts and ready_error:
                    await asyncio.sleep(.5)
                    continue
                raise classify_error(exc) from exc

    async def scan(self, date: str, is_rt: bool, targets: list[dict] | None = None) -> list[dict]:
        rows = []
        for promotion_type in URLS:
            selected = [row for row in targets if row["promotionType"] == promotion_type] if targets is not None else None
            if selected == []:
                continue
            try:
                await self._navigate(self.page, promotion_type)
                await self._probe_identity(self.page, promotion_type)
                args = self._args(promotion_type, date, is_rt)
                if selected is not None:
                    args["targets"] = selected
                result = await self._evaluate(self.page, "scan_campaigns.js", args)
            except Exception as exc:
                raise classify_error(exc) from exc
            if not isinstance(result, dict) or not isinstance(result.get("rows"), list):
                raise PromotionError("invalid_data", "扫描结果缺少完整列表")
            self._validate_identity(result)
            for row in result.get("rows", []):
                rows.append({**row, "shopId": self.shop["id"], "store": self.shop["store"], "accountNick": result.get("nickName")})
        return rows

    async def pause(self, row: dict) -> dict:
        # A fresh owned page isolates an uncertain write from subsequent targets.
        page = await self.controller.context.new_page()
        self.owned_pages.append(page)
        try:
            await self._navigate(page, row["promotionType"])
            await self._probe_identity(page, row["promotionType"])
            args = {"type": "keyword" if row["promotionType"] == "关键词推广" else "all-site",
                    "id": row["campaignId"], "execute": True,
                    **self._identity_constraints(),
                    "expectedName": row["campaignName"], "maxRoi": self.config["thresholds"]["closeRoiBelow"],
                    "minCharge": self.config["thresholds"]["closeChargeAbove"], "reportContext": row["reportContext"]}
            return await self._evaluate(page, "pause_campaign.js", args)
        except Exception as exc:
            raise classify_error(exc) from exc
        finally:
            try:
                await asyncio.wait_for(page.close(), 5)
                self.owned_pages.remove(page)
            except Exception:
                pass
