import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from playwright_controller import BrowserControllerError, PlaywrightBrowserController, _same_role_page, _same_site_family
from promotion_browser_config import PROMOTION_URL, with_promotion_page
from shop_registry import RegistryError, load_registry, selected_identity

KEYWORD_URL = "https://one.alimama.com/index.html#!/manage/search"


class Page:
    def __init__(self, url):
        self.url = url

    def is_closed(self):
        return False


class Context:
    def __init__(self, pages):
        self.pages = pages
        self.created = 0

    async def new_page(self):
        self.created += 1
        raise AssertionError("Unexpected new page")


class PromotionControllerTests(unittest.TestCase):
    def test_spa_routes_are_distinct(self):
        self.assertTrue(_same_role_page(PROMOTION_URL, PROMOTION_URL))
        self.assertFalse(_same_role_page(KEYWORD_URL, PROMOTION_URL))
        self.assertFalse(_same_role_page(PROMOTION_URL, KEYWORD_URL, "keyword"))
        self.assertTrue(_same_role_page(KEYWORD_URL + "?tab=report", KEYWORD_URL, "keyword"))
        self.assertTrue(_same_role_page(KEYWORD_URL, PROMOTION_URL, "promotion"))
        self.assertFalse(_same_role_page("https://one.alimama.com/index.html#!/manage/other", PROMOTION_URL, "promotion"))

    def test_single_role_reuses_keyword_tab_after_prior_scan(self):
        controller = PlaywrightBrowserController({"user_data_dir": "unused-profile", "browser_sessions": {"promotion": PROMOTION_URL}})
        home = Page("https://myseller.taobao.com/")
        campaign = Page(KEYWORD_URL)
        controller.context = Context([home, campaign])
        asyncio.run(controller.register_roles(open_missing=True))
        self.assertIs(controller.page("promotion"), campaign)
        self.assertEqual(controller.context.created, 0)
        self.assertEqual(controller.context.pages, [home, campaign])

    def test_taobao_sso_is_reported_without_new_tab(self):
        login = "https://login.taobao.com/member/login.jhtml"
        self.assertTrue(_same_site_family(login, PROMOTION_URL))
        controller = PlaywrightBrowserController({"user_data_dir": "unused-profile", "browser_sessions": {"promotion": PROMOTION_URL}})
        controller.context = Context([Page(login)])
        with self.assertRaises(BrowserControllerError) as raised:
            asyncio.run(controller.register_roles(open_missing=True))
        self.assertEqual(raised.exception.code, "login_required")
        self.assertEqual(controller.context.created, 0)

    def test_existing_business_config_is_not_mutated(self):
        original = {"user_data_dir": "unchanged", "browser_sessions": {
            "home": {"url": "https://myseller.taobao.com/"},
            "invoice": {"url": "https://myseller.taobao.com/home.htm/merchant-invoice/"},
            "orders": {"url": "https://myseller.taobao.com/home.htm/trade-platform/tp/sold"},
            "goods": {"url": "https://fp.erp321.com/setting/goodsManage"},
        }}
        before = json.dumps(original, sort_keys=True)
        effective = with_promotion_page(original)
        self.assertEqual(effective["browser_sessions"], {"promotion": {"url": PROMOTION_URL}})
        self.assertEqual(effective["user_data_dir"], "unchanged")
        self.assertEqual(json.dumps(original, sort_keys=True), before)


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.registry = self.root / "shops.json"
        (self.root / "config").mkdir()
        self.shop1 = self.make_shop("shop01", 9401)
        self.write(self.registry, {"schema_version": 1, "shops": [self.shop1]})

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, path, value):
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def make_shop(self, sid, port, **config):
        value = {"schema_version": 1, "browser": "Edge", "user_data_dir": f"../profiles/{sid}",
                 "download_dir": f"../downloads/{sid}", "remote_debugging_port": port,
                 "browser_sessions": {"home": "https://myseller.taobao.com/"}, **config}
        self.write(self.root / "config" / f"{sid}.json", value)
        return {"id": sid, "store": "店铺" + sid, "browser_config": f"config/{sid}.json",
                "login_username": "主账号:子账号" + sid, "arbitrary_private_field": "must not be copied"}

    def test_paths_are_relative_to_config_and_roles_derived(self):
        shop = load_registry(self.registry)["shops"][0]
        effective = shop["browser_config_value"]
        self.assertEqual(effective["user_data_dir"], str(self.root / "profiles" / "shop01"))
        self.assertEqual(effective["download_dir"], str(self.root / "downloads" / "shop01"))
        self.assertEqual(effective["browser_sessions"], {"promotion": {"url": PROMOTION_URL}})
        self.assertNotIn("arbitrary_private_field", shop)

    def test_confirmed_account_allows_alias_without_derived_expected_shop(self):
        shop = load_registry(self.registry)["shops"][0]
        self.assertEqual(shop["expected_shop_mode"], "account")
        self.assertEqual(shop["expected_alimama_shop"], self.shop1["store"])
        original = selected_identity(load_registry(self.registry), ["shop01"])
        self.shop1["expected_alimama_shop"] = self.shop1["store"]
        self.write(self.registry, {"schema_version": 1, "shops": [self.shop1]})
        explicit = load_registry(self.registry)
        self.assertEqual(explicit["shops"][0]["expected_shop_mode"], "shop")
        self.assertNotEqual(original["sha256"], selected_identity(explicit, ["shop01"])["sha256"])

    def test_missing_account_keeps_strict_store_and_empty_explicit_shop_is_invalid(self):
        self.shop1.pop("login_username")
        self.write(self.registry, {"schema_version": 1, "shops": [self.shop1]})
        shop = load_registry(self.registry)["shops"][0]
        self.assertEqual(shop["expected_shop_mode"], "shop")
        self.assertEqual(shop["expected_alimama_shop"], self.shop1["store"])
        self.shop1["expected_alimama_shop"] = ""
        self.write(self.registry, {"schema_version": 1, "shops": [self.shop1]})
        with self.assertRaises(RegistryError):
            load_registry(self.registry)

    def test_selected_identity_ignores_added_shop_but_binds_account_config_and_source(self):
        original = selected_identity(load_registry(self.registry), ["shop01"])
        extra = self.make_shop("shop02", 9402)
        self.write(self.root / ".browser-workbench-shops.json", {"schema_version": 1, "shops": [extra]})
        updated = load_registry(self.registry)
        self.assertEqual(original, selected_identity(updated, ["shop01"]))
        self.assertNotIn("browser_config_value", original["shops"][0])
        updated["shops"][0]["login_username"] = "another:account"
        self.assertNotEqual(original["sha256"], selected_identity(updated, ["shop01"])["sha256"])
        updated = load_registry(self.registry)
        updated["source"] = str(self.root / "other-shops.json")
        self.assertNotEqual(original["sha256"], selected_identity(updated, ["shop01"])["sha256"])

    def test_bad_sidecar_is_not_silently_ignored(self):
        sidecar = self.root / ".browser-workbench-shops.json"
        for bad in ({"shops": []}, {"schema_version": 1, "shops": [None]},
                    {"schema_version": 1, "shops": [self.shop1]}):
            with self.subTest(bad=bad):
                self.write(sidecar, bad)
                with self.assertRaises(RegistryError):
                    load_registry(self.registry)
        sidecar.write_text("not json", encoding="utf-8")
        with self.assertRaises(RegistryError):
            load_registry(self.registry)

    def test_independent_browser_directories_and_ports(self):
        cases = [
            {"user_data_dir": "../profiles/shop01"},
            {"user_data_dir": "../profiles/shop01/nested"},
            {"download_dir": "../downloads/shop01"},
            {"download_dir": "../downloads/shop01/nested"},
            {"download_dir": "../profiles/shop01/foreign-downloads"},
            {"remote_debugging_port": 9401},
            {"remote_debugging_port": 0},
        ]
        for config in cases:
            with self.subTest(config=config):
                other = self.make_shop("shop02", 9402, **config)
                self.write(self.registry, {"schema_version": 1, "shops": [self.shop1, other]})
                with self.assertRaises(RegistryError):
                    load_registry(self.registry)

    def test_omitted_ports_still_conflict(self):
        first = self.make_shop("shop01", None)
        second = self.make_shop("shop02", None)
        self.write(self.registry, {"schema_version": 1, "shops": [first, second]})
        with self.assertRaises(RegistryError):
            load_registry(self.registry)


if __name__ == "__main__":
    unittest.main()
