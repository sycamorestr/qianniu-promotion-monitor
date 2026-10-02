import asyncio
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from playwright_controller import BrowserControllerError, PlaywrightBrowserController, _same_role_page, _same_site_family
from promotion_browser_config import PROMOTION_URL, with_promotion_page
from shop_registry import RegistryError, load_registry, selected_identity
import check as local_check

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

    def test_selection_skips_unselected_browser_config_and_preserves_identity(self):
        original = selected_identity(load_registry(self.registry), ["shop01"])
        other = self.make_shop("shop02", 9402)
        self.write(self.root / ".browser-workbench-shops.json", {"schema_version": 1, "shops": [other]})
        config_path = self.root / "config" / "shop02.json"
        config_path.unlink()
        for content in (None, "not json"):
            with self.subTest(content=content):
                if content is not None:
                    config_path.write_text(content, encoding="utf-8")
                selected = load_registry(self.registry, shop_ids=["shop01"])
                self.assertEqual([shop["id"] for shop in selected["shops"]], ["shop01"])
                self.assertEqual(selected_identity(selected, ["shop01"]), original)
                with self.assertRaises(RegistryError):
                    load_registry(self.registry)

    def test_selected_invalid_browser_config_still_fails(self):
        (self.root / "config" / "shop01.json").write_text("not json", encoding="utf-8")
        with self.assertRaises(RegistryError):
            load_registry(self.registry, shop_ids=["shop01"])

    def test_unknown_and_duplicate_selection_rejected_before_config_load(self):
        for selection in (["unknown"], ["shop01", "unknown"], ["shop01", "shop01"]):
            with self.subTest(selection=selection), patch("shop_registry.load_browser_config") as load_config:
                with self.assertRaisesRegex(RegistryError, "--shops"):
                    load_registry(self.registry, shop_ids=selection)
                load_config.assert_not_called()

    def test_check_counts_only_selected_shops_and_rejects_invalid_selection(self):
        other = self.make_shop("shop02", 9402)
        self.write(self.root / ".browser-workbench-shops.json", {"schema_version": 1, "shops": [other]})
        (self.root / "config" / "shop02.json").unlink()
        for selection, expected_exit in ((["shop01"], 0), (["shop02"], 1),
                                         (["unknown"], 1), (["shop01", "shop01"], 1)):
            with self.subTest(selection=selection):
                output = io.StringIO()
                with patch.object(sys, "argv", ["check.py", "--registry", str(self.registry), "--shops", *selection]), \
                        patch.object(local_check.platform, "system", return_value="Windows"), \
                        patch.object(local_check, "_resolve_browser_executable", return_value=self.root / "msedge.exe"), \
                        patch.object(local_check.importlib.util, "find_spec", return_value=object()), redirect_stdout(output):
                    self.assertEqual(local_check.main(), expected_exit)
                result = json.loads(output.getvalue())
                self.assertEqual(result["authentication"], "not_checked")
                if expected_exit == 0:
                    self.assertEqual(next(item for item in result["checks"] if item["name"] == "registry")["shops"], 1)

    def test_empty_primary_uses_workbench_shops_without_rewriting_registry(self):
        self.write(self.registry, {"schema_version": 1, "shops": []})
        extra = self.make_shop("shop02", 9402)
        sidecar = self.root / ".browser-workbench-shops.json"
        self.write(sidecar, {"schema_version": 1, "shops": [self.shop1, extra]})
        original_files = {path: path.read_bytes() for path in (self.registry, sidecar)}
        loaded = load_registry(self.registry)
        self.assertEqual([shop["id"] for shop in loaded["shops"]], ["shop01", "shop02"])
        self.assertEqual(loaded["source"], str(self.registry))
        self.assertEqual(loaded["shops"][0]["browser_config"], str(self.root / "config" / "shop01.json"))
        for path, content in original_files.items():
            self.assertEqual(path.read_bytes(), content)
        with self.assertRaises(RegistryError):
            load_registry(self.registry, include_workbench=False)

    def test_empty_merged_registry_is_rejected(self):
        self.write(self.registry, {"schema_version": 1, "shops": []})
        with self.assertRaises(RegistryError):
            load_registry(self.registry)
        self.write(self.root / ".browser-workbench-shops.json", {"schema_version": 1, "shops": []})
        with self.assertRaises(RegistryError):
            load_registry(self.registry)

    def test_valid_sidecar_does_not_hide_invalid_primary(self):
        self.write(self.root / ".browser-workbench-shops.json", {"schema_version": 1, "shops": [self.shop1]})
        for bad in ({"shops": []}, {"schema_version": 1, "shops": None},
                    {"schema_version": 1, "shops": [None]}):
            with self.subTest(bad=bad):
                self.write(self.registry, bad)
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
                for selection in (None, ["shop01", "shop02"]):
                    with self.subTest(selection=selection), self.assertRaises(RegistryError):
                        load_registry(self.registry, shop_ids=selection)

    def test_omitted_ports_still_conflict(self):
        first = self.make_shop("shop01", None)
        second = self.make_shop("shop02", None)
        self.write(self.registry, {"schema_version": 1, "shops": [first, second]})
        with self.assertRaises(RegistryError):
            load_registry(self.registry)


if __name__ == "__main__":
    unittest.main()
