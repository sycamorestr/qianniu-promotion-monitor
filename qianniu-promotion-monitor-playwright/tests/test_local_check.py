"""Machine readiness diagnostics must stay offline and respect shop selection."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import check as local_check


class LocalCheckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.registry = self.root / "shops.json"
        self.shops = []
        for index, browser in enumerate(("Edge", "Chrome"), 1):
            sid = f"shop{index}"
            executable = self.root / ("msedge.exe" if browser == "Edge" else "chrome.exe")
            executable.touch()
            config = {"schema_version": 1, "browser": browser,
                      "executable_path": str(executable),
                      "user_data_dir": f"profiles/{sid}",
                      "download_dir": f"downloads/{sid}",
                      "remote_debugging_port": 9500 + index,
                      "browser_sessions": {"home": "https://myseller.taobao.com/"}}
            (self.root / f"{sid}.json").write_text(json.dumps(config), encoding="utf-8")
            self.shops.append({"id": sid, "store": f"Example {index}",
                               "browser_config": f"{sid}.json"})
        self.registry.write_text(json.dumps({"schema_version": 1, "shops": self.shops}), encoding="utf-8")

    def run_check(self, *args, system="Windows"):
        output = io.StringIO()
        with patch.object(sys, "argv", ["check.py", "--registry", str(self.registry), *args]), \
                patch.object(local_check.platform, "system", return_value=system), \
                patch.object(local_check.importlib.util, "find_spec", return_value=object()), \
                patch("playwright_controller.subprocess.Popen", side_effect=AssertionError("browser launch")), \
                patch("playwright_controller._cdp_version_sync", side_effect=AssertionError("CDP probe")), \
                patch("browser_lock.FileMutex.acquire", side_effect=AssertionError("lock probe")), \
                redirect_stdout(output):
            result = local_check.main()
        self.assertFalse((self.root / "profiles").exists())
        self.assertFalse((self.root / "downloads").exists())
        return result, json.loads(output.getvalue())

    def test_edge_and_chrome_paths_pass_without_touching_browsers(self):
        code, result = self.run_check()
        self.assertEqual(code, 0)
        self.assertEqual(result["authentication"], "not_checked")
        browsers = [row for row in result["checks"] if row["name"] == "browser_executable"]
        self.assertEqual([row["browser"] for row in browsers], ["edge", "chrome"])
        self.assertTrue(all(row["ok"] for row in browsers))

    def test_missing_browser_fails_only_when_selected(self):
        (self.root / "chrome.exe").unlink()
        code, result = self.run_check()
        self.assertEqual(code, 1)
        failed = [row for row in result["checks"] if not row["ok"]]
        self.assertEqual([row["shop_id"] for row in failed], ["shop2"])
        code, result = self.run_check("--shops", "shop1")
        self.assertEqual(code, 0)
        self.assertEqual([row["shop_id"] for row in result["checks"]
                          if row["name"] == "browser_executable"], ["shop1"])

    def test_unsupported_system_is_reported_locally(self):
        code, result = self.run_check(system="Linux")
        self.assertEqual(code, 1)
        self.assertEqual([row["name"] for row in result["checks"] if not row["ok"]], ["platform"])

    def test_wrong_browser_executable_and_missing_config_are_actionable(self):
        path = self.root / "shop1.json"
        config = json.loads(path.read_text(encoding="utf-8"))
        config["executable_path"] = str(self.root / "chrome.exe")
        path.write_text(json.dumps(config), encoding="utf-8")
        code, result = self.run_check("--shops", "shop1")
        self.assertEqual(code, 1)
        failed = next(row for row in result["checks"] if not row["ok"])
        self.assertIn("msedge.exe", failed["message"])
        code, result = self.run_check("--config", str(self.root / "missing.json"))
        self.assertEqual(code, 1)
        self.assertEqual(next(row for row in result["checks"] if not row["ok"])["name"], "config")


if __name__ == "__main__":
    unittest.main()
