"""Local finance-foundation endpoints for Phase 3."""
import csv
import io
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from ..services import finance_store


router = APIRouter(tags=["finance"])


class FinanceSettingsUpdate(BaseModel):
    base_currency: Optional[str] = None
    tax_reserve_bps: Optional[int] = Field(default=None, ge=0, le=10000)
    developer_split_bps: Optional[int] = Field(default=None, ge=0, le=10000)
    income_target_cents: Optional[int] = Field(default=None, ge=0)


class FinanceTransactionCreate(BaseModel):
    kind: str
    amount_cents: int = Field(gt=0)
    currency: str = Field(min_length=3, max_length=3)
    source: str = Field(min_length=1, max_length=120)
    memo: str = Field(default="", max_length=500)
    is_mock: bool = False


class FinanceInvoiceCreate(BaseModel):
    client_name: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=500)
    amount_cents: int = Field(gt=0)
    currency: str = Field(min_length=3, max_length=3)
    due_date: str = Field(min_length=10, max_length=10)
    note: str = Field(default="", max_length=500)


class FinanceInvoiceStatusUpdate(BaseModel):
    status: str


@router.get("/finance/overview")
def finance_overview():
    return finance_store.overview()


@router.get("/finance/transactions")
def finance_transactions(limit: int = Query(default=50, ge=1, le=200)):
    return {"transactions": finance_store.transactions(limit=limit)}


@router.get("/finance/audit")
def finance_audit(limit: int = Query(default=50, ge=1, le=200)):
    return {"events": finance_store.audit_log(limit=limit)}


@router.get("/finance/invoices")
def finance_invoices(limit: int = Query(default=50, ge=1, le=200)):
    return {"invoices": finance_store.invoices(limit=limit)}


@router.get("/finance/reports/monthly")
def monthly_finance_report(year: Optional[int] = None, month: Optional[int] = None):
    now = datetime.now(timezone.utc)
    try:
        return finance_store.monthly_report(year or now.year, month or now.month)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/finance/reports/monthly.csv")
def monthly_finance_report_csv(year: Optional[int] = None, month: Optional[int] = None):
    now = datetime.now(timezone.utc)
    try:
        report = finance_store.monthly_report(year or now.year, month or now.month)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["AI.EXE local monthly finance report", report["period"], report["currency"]])
    writer.writerow([])
    writer.writerow(["Summary", "Amount (cents)"])
    for key in ("income_cents", "expense_cents", "net_cents", "tax_reserve_cents", "distributable_cents", "developer_share_cents", "client_share_cents"):
        writer.writerow([key.replace("_cents", "").replace("_", " ").title(), report[key]])
    writer.writerow([])
    writer.writerow(["Transactions"])
    writer.writerow(["Occurred at", "Type", "Source", "Memo", "Amount (cents)", "Currency", "Mock"])
    for row in report["transactions"]:
        writer.writerow([row["occurred_at"], row["kind"], row["source"], row["memo"], row["amount_cents"], row["currency"], row["is_mock"]])
    writer.writerow([])
    writer.writerow(["Invoices"])
    writer.writerow(["Invoice", "Client", "Description", "Due date", "Status", "Amount (cents)", "Currency"])
    for row in report["invoices"]:
        writer.writerow([row["invoice_number"], row["client_name"], row["description"], row["due_date"], row["status"], row["amount_cents"], row["currency"]])
    filename = f"ai-exe-finance-report-{report['period']}.csv"
    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/finance/settings")
def update_finance_settings(payload: FinanceSettingsUpdate):
    try:
        return finance_store.update_settings(payload.model_dump(exclude_none=True))
    except AttributeError:  # Pydantic v1 support for the shipped backend environment.
        try:
            return finance_store.update_settings(payload.dict(exclude_none=True))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/finance/transactions")
def create_finance_transaction(payload: FinanceTransactionCreate):
    try:
        return finance_store.add_transaction(**payload.model_dump())
    except AttributeError:
        try:
            return finance_store.add_transaction(**payload.dict())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/finance/invoices")
def create_finance_invoice(payload: FinanceInvoiceCreate):
    try:
        return finance_store.create_invoice(**payload.model_dump())
    except AttributeError:
        try:
            return finance_store.create_invoice(**payload.dict())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/finance/invoices/{invoice_id}/status")
def update_finance_invoice_status(invoice_id: str, payload: FinanceInvoiceStatusUpdate):
    try:
        return finance_store.update_invoice_status(invoice_id, payload.status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/finance/mock-income")
def seed_finance_mock_income():
    return {"transactions": finance_store.seed_mock_income(), "overview": finance_store.overview()}
