"""Shared singletons (usage manager + API-key store + project store)."""
import os

from .adapter import AdapterManager
from .broker import PaperBroker
from .prices import QuoteFeed
from .paper_test import PaperTestRunner
from .autopilot import Autopilot
from .autopilot_ai import make_reviewer
from .config import settings
from .chatstore import ChatStore
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

# Paper-mode only; see broker.py. No live venue, no network.
paper_broker = PaperBroker(data_dir=settings.data_dir)

# The only networked part of the trading stack; the broker is handed prices.
quote_feed = QuoteFeed()

# Daily forward test. It records and proposes; the broker gate still confirms.
paper_test_runner = PaperTestRunner(settings.data_dir, paper_broker, quote_feed)

# 24/7 crypto autopilot on its own paper account. Feed + AI are injected.
autopilot = Autopilot(settings.data_dir, quote_feed.crypto_hourly_candles,
                      reviewer=make_reviewer(provider_store, api_key_store, usage_manager))

# Durable chat storage — see chatstore.py. Never trimmed to reclaim space.
chat_store = ChatStore(data_dir=settings.data_dir)

adapter_manager = AdapterManager(settings.data_dir)
