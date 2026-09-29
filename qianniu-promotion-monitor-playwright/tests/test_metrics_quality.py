import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from promotion_adapter import PromotionError
from run_batch import DEFAULTS, select, validate_rows

DATE = "2026-09-28"
SHOP = {"id": "shop01", "expected_alimama_shop": "测试店"}

def campaign(cid, **changes):
    row = {"shopId": "shop01", "shopName": "测试店", "promotionType": "全站推",
           "recordType": "campaign", "campaignId": cid, "campaignName": "计划" + cid,
           "roi": None, "charge": None, "displayStatus": "start", "onlineStatus": 1,
           "reportContext": {"startTime": DATE, "endTime": DATE}}
    return {**row, **changes}

class MetricsQualityTests(unittest.TestCase):
    def test_entire_type_without_reports_is_zero_and_does_not_block_other_type(self):
        rows = [campaign("1"), campaign("2", promotionType="关键词推广", roi=2.1, charge=10)]
        result = validate_rows(rows, SHOP, date=DATE)
        self.assertEqual((result[0]["roi"], result[0]["charge"]), (0, 0))
        self.assertEqual((result[1]["roi"], result[1]["charge"]), (2.1, 10))

    def test_empty_roi_qualifies_with_sufficient_charge_and_empty_charge_does_not(self):
        rows = [campaign("empty-roi", charge=30.1), campaign("empty-charge", roi=1),
                campaign("both-empty"), campaign("boundary", roi=None, charge=30),
                campaign("roi-boundary", roi=1.5, charge=31), campaign("blank", roi=" ", charge=31)]
        result = validate_rows(rows, SHOP, date=DATE)
        low, candidates = select(result, DEFAULTS["thresholds"])
        self.assertEqual([row["campaignId"] for row in candidates], ["empty-roi", "blank"])
        self.assertEqual(len(low), len(result))
        self.assertEqual(result[0]["roi"], 0)
        self.assertEqual(result[1]["charge"], 0)

    def test_nonempty_invalid_values_are_not_treated_as_zero(self):
        for value in ("invalid", True, [], {}, float("nan"), float("inf")):
            with self.subTest(value=value):
                with self.assertRaises(PromotionError) as caught:
                    validate_rows([campaign("1", roi=value, charge=40)], SHOP, date=DATE)
                self.assertEqual(caught.exception.code, "invalid_data")

    def test_empty_shop_and_paused_target_readback_are_valid_without_metrics(self):
        self.assertEqual(validate_rows([], SHOP, date=DATE), [])
        target = campaign("1")
        row = campaign("1", recordType="verification", displayStatus="pause", onlineStatus=0,
                       outcome="inactive", verified=True)
        result = validate_rows([row], SHOP, targets=[target], date=DATE)
        self.assertEqual(result, [{**row, "roi": 0, "charge": 0}])

if __name__ == "__main__":
    unittest.main()
