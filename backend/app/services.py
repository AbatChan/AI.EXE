"""Shared singletons (usage manager + API-key store + project store)."""
import os

from .adapter import AdapterManager
from .config import settings
from .finance import FinanceStore
from .modules import ModuleStore
from .projects import ProjectStore
from .provider import ProviderStore
from .usage import ApiKeyStore, UsageManager

usage_manager = UsageManager(
    data_dir=settings.data_dir,
    rate_max=settings.rate_limit_max,
    rate_window=settings.rate_limit_window_seconds,
    credit_limit=settings.credit_limit_monthly,
    cost=settings.credit_cost_per_request,
    warn_ratio=settings.credit_warn_ratio,
)

api_key_store = ApiKeyStore(data_dir=settings.data_dir)

provider_store = ProviderStore(settings.data_dir, settings.llm_base_url, settings.llm_model)

project_store = ProjectStore(base_dir=os.path.join(settings.data_dir, "projects"))

module_store = ModuleStore(base_dir=os.path.join(settings.workshop_dir, "modules"))

finance_store = FinanceStore(data_dir=settings.data_dir)

adapter_manager = AdapterManager(settings.data_dir)
