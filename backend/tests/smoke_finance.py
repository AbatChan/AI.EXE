"""Smoke test for the local Phase 3 finance foundation."""
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.finance import FinanceStore


def main():
    with tempfile.TemporaryDirectory() as data_dir:
        store = FinanceStore(data_dir)
        assert store.overview()["income_cents"] == 0
        seeded = store.seed_mock_income()
        assert len(seeded) == 3
        overview = store.overview()
        assert overview["income_cents"] == 25500
        assert overview["expense_cents"] == 2200
        assert overview["tax_reserve_cents"] == 5100
        assert overview["mock_transaction_count"] == 3
        updated = store.update_settings({"tax_reserve_bps": 1500, "developer_split_bps": 4000})
        assert updated["tax_reserve_bps"] == 1500
        assert store.overview()["tax_reserve_cents"] == 3825
        store.add_transaction("income", 1250, "USD", "Manual local test", "Entry control smoke test")
        assert store.overview()["income_cents"] == 26750
        assert store.overview()["tax_reserve_cents"] == 4012
        assert store.transactions(limit=1)[0]["source"] == "Manual local test"
        invoice = store.create_invoice(
            "Local test client", "Finance foundation invoice", 37500, "USD", "2026-08-15", "Local draft only"
        )
        assert invoice["status"] == "draft"
        assert store.overview()["open_invoice_cents"] == 37500
        updated_invoice = store.update_invoice_status(invoice["id"], "sent")
        assert updated_invoice["status"] == "sent"
        assert store.invoices(limit=1)[0]["invoice_number"] == invoice["invoice_number"]
        now = datetime.now(timezone.utc)
        report = store.monthly_report(now.year, now.month)
        assert report["income_cents"] == 26750
        assert report["expense_cents"] == 2200
        assert report["transaction_count"] == 4
        assert report["invoice_count"] == 1
        assert report["invoice_totals"]["sent"] == 37500
        assert len(store.audit_log()) >= 7
    print("finance smoke test: ok")


if __name__ == "__main__":
    main()
