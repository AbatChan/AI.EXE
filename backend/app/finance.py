"""Local-only finance foundation for AI.EXE Phase 3.

This is deliberately a recordkeeping layer.  It does not connect to banks,
payment processors, exchanges, mining software, or trading services.
"""
import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional


DEFAULT_SETTINGS = {
    "base_currency": "USD",
    "tax_reserve_bps": 2000,
    "developer_split_bps": 5000,
    "income_target_cents": 100000,
}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class FinanceStore:
    """Small SQLite-backed ledger with append-only audit records."""

    def __init__(self, data_dir: str):
        os.makedirs(data_dir, exist_ok=True)
        self._path = os.path.join(data_dir, "finance.sqlite3")
        self._lock = threading.RLock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._lock, self._connect() as conn:
            conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS finance_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS finance_transactions (
                    id TEXT PRIMARY KEY,
                    occurred_at TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
                    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
                    currency TEXT NOT NULL,
                    source TEXT NOT NULL,
                    memo TEXT NOT NULL,
                    is_mock INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS finance_audit_log (
                    id TEXT PRIMARY KEY,
                    occurred_at TEXT NOT NULL,
                    action TEXT NOT NULL,
                    detail TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS finance_invoices (
                    id TEXT PRIMARY KEY,
                    invoice_number TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    due_date TEXT NOT NULL,
                    client_name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
                    currency TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('draft', 'sent', 'paid', 'void')),
                    note TEXT NOT NULL
                );
                """
            )
            for key, value in DEFAULT_SETTINGS.items():
                conn.execute(
                    "INSERT OR IGNORE INTO finance_settings (key, value, updated_at) VALUES (?, ?, ?)",
                    (key, json.dumps(value), _now()),
                )

    def _audit(self, conn: sqlite3.Connection, action: str, detail: Dict) -> None:
        conn.execute(
            "INSERT INTO finance_audit_log (id, occurred_at, action, detail) VALUES (?, ?, ?, ?)",
            (uuid.uuid4().hex, _now(), action, json.dumps(detail, sort_keys=True)),
        )

    def settings(self) -> Dict:
        with self._lock, self._connect() as conn:
            rows = conn.execute("SELECT key, value FROM finance_settings").fetchall()
        values = dict(DEFAULT_SETTINGS)
        for row in rows:
            try:
                values[row["key"]] = json.loads(row["value"])
            except (TypeError, ValueError):
                continue
        return values

    def update_settings(self, updates: Dict) -> Dict:
        allowed = {"base_currency", "tax_reserve_bps", "developer_split_bps", "income_target_cents"}
        clean = {key: value for key, value in updates.items() if key in allowed and value is not None}
        if not clean:
            return self.settings()
        if "base_currency" in clean:
            clean["base_currency"] = str(clean["base_currency"]).upper().strip()
            if len(clean["base_currency"]) != 3:
                raise ValueError("base_currency must be a three-letter currency code")
        for key in ("tax_reserve_bps", "developer_split_bps"):
            if key in clean and not 0 <= int(clean[key]) <= 10000:
                raise ValueError(f"{key} must be between 0 and 10000")
        if "income_target_cents" in clean and int(clean["income_target_cents"]) < 0:
            raise ValueError("income_target_cents cannot be negative")

        with self._lock, self._connect() as conn:
            for key, value in clean.items():
                conn.execute(
                    "INSERT INTO finance_settings (key, value, updated_at) VALUES (?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                    (key, json.dumps(value), _now()),
                )
            self._audit(conn, "settings_updated", clean)
        return self.settings()

    def add_transaction(self, kind: str, amount_cents: int, currency: str, source: str,
                        memo: str = "", is_mock: bool = False) -> Dict:
        kind = str(kind).lower().strip()
        if kind not in ("income", "expense"):
            raise ValueError("kind must be income or expense")
        amount_cents = int(amount_cents)
        if amount_cents <= 0:
            raise ValueError("amount_cents must be greater than zero")
        currency = str(currency).upper().strip()
        if len(currency) != 3:
            raise ValueError("currency must be a three-letter currency code")
        source = str(source).strip()
        if not source:
            raise ValueError("source is required")
        tx = {
            "id": uuid.uuid4().hex,
            "occurred_at": _now(),
            "kind": kind,
            "amount_cents": amount_cents,
            "currency": currency,
            "source": source[:120],
            "memo": str(memo or "")[:500],
            "is_mock": bool(is_mock),
        }
        with self._lock, self._connect() as conn:
            conn.execute(
                """INSERT INTO finance_transactions
                   (id, occurred_at, kind, amount_cents, currency, source, memo, is_mock)
                   VALUES (:id, :occurred_at, :kind, :amount_cents, :currency, :source, :memo, :is_mock)""",
                tx,
            )
            self._audit(conn, "transaction_recorded", {key: tx[key] for key in ("id", "kind", "amount_cents", "currency", "source", "is_mock")})
        return tx

    def seed_mock_income(self) -> List[Dict]:
        with self._lock, self._connect() as conn:
            count = conn.execute("SELECT COUNT(*) FROM finance_transactions WHERE is_mock = 1").fetchone()[0]
        if count:
            return self.transactions(limit=20, mock_only=True)
        samples = [
            ("income", 18000, "USD", "AI.EXE demo service", "Mock income for local finance testing"),
            ("income", 7500, "USD", "AI.EXE demo service", "Mock income for local finance testing"),
            ("expense", 2200, "USD", "Mock infrastructure", "Mock operating cost for local finance testing"),
        ]
        return [self.add_transaction(*sample, is_mock=True) for sample in samples]

    def transactions(self, limit: int = 50, mock_only: bool = False) -> List[Dict]:
        limit = max(1, min(int(limit), 200))
        query = "SELECT * FROM finance_transactions"
        params: tuple = ()
        if mock_only:
            query += " WHERE is_mock = 1"
        query += " ORDER BY occurred_at DESC, rowid DESC LIMIT ?"
        params = (limit,)
        with self._lock, self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [dict(row) | {"is_mock": bool(row["is_mock"])} for row in rows]

    def audit_log(self, limit: int = 50) -> List[Dict]:
        limit = max(1, min(int(limit), 200))
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT id, occurred_at, action, detail FROM finance_audit_log ORDER BY occurred_at DESC, rowid DESC LIMIT ?",
                (limit,),
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            try:
                item["detail"] = json.loads(item["detail"])
            except (TypeError, ValueError):
                pass
            result.append(item)
        return result

    def create_invoice(self, client_name: str, description: str, amount_cents: int,
                       currency: str, due_date: str, note: str = "") -> Dict:
        client_name = str(client_name).strip()
        description = str(description).strip()
        currency = str(currency).upper().strip()
        due_date = str(due_date).strip()
        amount_cents = int(amount_cents)
        if not client_name:
            raise ValueError("client_name is required")
        if not description:
            raise ValueError("description is required")
        if amount_cents <= 0:
            raise ValueError("amount_cents must be greater than zero")
        if len(currency) != 3:
            raise ValueError("currency must be a three-letter currency code")
        try:
            datetime.strptime(due_date, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError("due_date must use YYYY-MM-DD") from exc

        created_at = _now()
        invoice = {
            "id": uuid.uuid4().hex,
            "invoice_number": f"AIEXE-{datetime.now(timezone.utc):%Y%m%d}-{uuid.uuid4().hex[:6].upper()}",
            "created_at": created_at,
            "due_date": due_date,
            "client_name": client_name[:160],
            "description": description[:500],
            "amount_cents": amount_cents,
            "currency": currency,
            "status": "draft",
            "note": str(note or "")[:500],
        }
        with self._lock, self._connect() as conn:
            conn.execute(
                """INSERT INTO finance_invoices
                   (id, invoice_number, created_at, due_date, client_name, description,
                    amount_cents, currency, status, note)
                   VALUES (:id, :invoice_number, :created_at, :due_date, :client_name, :description,
                           :amount_cents, :currency, :status, :note)""",
                invoice,
            )
            self._audit(conn, "invoice_created", {
                key: invoice[key] for key in ("id", "invoice_number", "client_name", "amount_cents", "currency", "due_date")
            })
        return invoice

    def invoices(self, limit: int = 50) -> List[Dict]:
        limit = max(1, min(int(limit), 200))
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM finance_invoices ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(row) for row in rows]

    def update_invoice_status(self, invoice_id: str, status: str) -> Dict:
        status = str(status).lower().strip()
        if status not in ("draft", "sent", "paid", "void"):
            raise ValueError("status must be draft, sent, paid, or void")
        with self._lock, self._connect() as conn:
            cursor = conn.execute("UPDATE finance_invoices SET status = ? WHERE id = ?", (status, invoice_id))
            if cursor.rowcount != 1:
                raise ValueError("invoice not found")
            row = conn.execute("SELECT * FROM finance_invoices WHERE id = ?", (invoice_id,)).fetchone()
            invoice = dict(row)
            self._audit(conn, "invoice_status_updated", {"id": invoice_id, "invoice_number": invoice["invoice_number"], "status": status})
        return invoice

    def monthly_report(self, year: int, month: int) -> Dict:
        if not 1 <= int(month) <= 12:
            raise ValueError("month must be between 1 and 12")
        year = int(year)
        month = int(month)
        if not 2000 <= year <= 2100:
            raise ValueError("year must be between 2000 and 2100")
        start = f"{year:04d}-{month:02d}-01T00:00:00Z"
        next_year, next_month = (year + 1, 1) if month == 12 else (year, month + 1)
        end = f"{next_year:04d}-{next_month:02d}-01T00:00:00Z"
        settings = self.settings()
        currency = settings["base_currency"]
        with self._lock, self._connect() as conn:
            transactions = conn.execute(
                """SELECT * FROM finance_transactions
                   WHERE occurred_at >= ? AND occurred_at < ? AND currency = ?
                   ORDER BY occurred_at DESC, rowid DESC""",
                (start, end, currency),
            ).fetchall()
            invoices = conn.execute(
                """SELECT * FROM finance_invoices
                   WHERE created_at >= ? AND created_at < ? AND currency = ?
                   ORDER BY created_at DESC, rowid DESC""",
                (start, end, currency),
            ).fetchall()
        transaction_rows = [dict(row) | {"is_mock": bool(row["is_mock"])} for row in transactions]
        invoice_rows = [dict(row) for row in invoices]
        income_cents = sum(row["amount_cents"] for row in transaction_rows if row["kind"] == "income")
        expense_cents = sum(row["amount_cents"] for row in transaction_rows if row["kind"] == "expense")
        tax_reserve_cents = max(0, income_cents * int(settings["tax_reserve_bps"]) // 10000)
        net_cents = income_cents - expense_cents
        distributable_cents = max(0, net_cents - tax_reserve_cents)
        source_totals: Dict[str, int] = {}
        for row in transaction_rows:
            direction = 1 if row["kind"] == "income" else -1
            source_totals[row["source"]] = source_totals.get(row["source"], 0) + direction * row["amount_cents"]
        invoice_totals = {status: 0 for status in ("draft", "sent", "paid", "void")}
        for row in invoice_rows:
            invoice_totals[row["status"]] += row["amount_cents"]
        return {
            "period": f"{year:04d}-{month:02d}",
            "currency": currency,
            "income_cents": income_cents,
            "expense_cents": expense_cents,
            "net_cents": net_cents,
            "tax_reserve_cents": tax_reserve_cents,
            "distributable_cents": distributable_cents,
            "developer_share_cents": distributable_cents * int(settings["developer_split_bps"]) // 10000,
            "client_share_cents": distributable_cents - (distributable_cents * int(settings["developer_split_bps"]) // 10000),
            "transaction_count": len(transaction_rows),
            "invoice_count": len(invoice_rows),
            "invoice_totals": invoice_totals,
            "source_totals": [
                {"source": source, "amount_cents": amount}
                for source, amount in sorted(source_totals.items(), key=lambda item: (-abs(item[1]), item[0].lower()))
            ],
            "transactions": transaction_rows,
            "invoices": invoice_rows,
            "settings": settings,
            "disclaimer": "Local recordkeeping only. Confirm tax, invoice, and compliance requirements with a qualified professional.",
        }

    def overview(self) -> Dict:
        settings = self.settings()
        currency = settings["base_currency"]
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT kind, amount_cents, is_mock FROM finance_transactions WHERE currency = ?",
                (currency,),
            ).fetchall()
            invoice_rows = conn.execute(
                "SELECT amount_cents, status FROM finance_invoices WHERE currency = ?", (currency,)
            ).fetchall()
        income_cents = sum(row["amount_cents"] for row in rows if row["kind"] == "income")
        expense_cents = sum(row["amount_cents"] for row in rows if row["kind"] == "expense")
        net_cents = income_cents - expense_cents
        tax_reserve_cents = max(0, income_cents * int(settings["tax_reserve_bps"]) // 10000)
        distributable_cents = max(0, net_cents - tax_reserve_cents)
        developer_share_cents = distributable_cents * int(settings["developer_split_bps"]) // 10000
        return {
            "currency": currency,
            "income_cents": income_cents,
            "expense_cents": expense_cents,
            "net_cents": net_cents,
            "tax_reserve_cents": tax_reserve_cents,
            "distributable_cents": distributable_cents,
            "developer_share_cents": developer_share_cents,
            "client_share_cents": distributable_cents - developer_share_cents,
            "income_target_cents": int(settings["income_target_cents"]),
            "transaction_count": len(rows),
            "mock_transaction_count": sum(1 for row in rows if row["is_mock"]),
            "open_invoice_cents": sum(row["amount_cents"] for row in invoice_rows if row["status"] in ("draft", "sent")),
            "open_invoice_count": sum(1 for row in invoice_rows if row["status"] in ("draft", "sent")),
            "settings": settings,
        }
