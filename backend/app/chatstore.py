"""Durable chat storage.

Chats used to live only in the WebView's localStorage, which WebKit caps at 5 MB per
origin. One heavy agent project fills that, every later write fails, and `saveChats`
starts dropping whole conversations to fit. A user lost 10 chats that way.

Storage and prompt budget are different problems: the prompt must be trimmed to control
tokens, storage has no reason to delete anything. This module is the durable side —
nothing here ever deletes a chat to save space. Agent activity is stored per-chat so a
heavy run can be shed on its own without touching the conversation.

Lives in the backend data dir (%LOCALAPPDATA%\\AI_EXE\\backend on Windows, the app's
Application Support dir on macOS), so it survives an app update.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from typing import Dict, List, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    id           TEXT PRIMARY KEY,
    user_scope   TEXT NOT NULL,
    name         TEXT,
    payload      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_scope_updated ON chats (user_scope, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_activity (
    chat_id      TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    payload      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (chat_id, seq)
);

CREATE TABLE IF NOT EXISTS chat_backups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_scope   TEXT NOT NULL,
    reason       TEXT NOT NULL,
    payload      TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);
"""


# A deleted chat leaves the sidebar at once but stays recoverable for a month — a
# misclick should not be as final as a bug was. Nothing else prunes this table.
DELETED_RETENTION_DAYS = 30
DELETED_RETENTION_MS = DELETED_RETENTION_DAYS * 24 * 60 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


class ChatStore:
    def __init__(self, data_dir: str) -> None:
        os.makedirs(data_dir, exist_ok=True)
        self._path = os.path.join(data_dir, "chats.sqlite3")
        self._lock = threading.Lock()
        with self._connect() as conn:
            conn.executescript(SCHEMA)
        try:
            os.chmod(self._path, 0o600)
        except OSError:
            pass

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    # ---- reads -------------------------------------------------------------
    def list_chats(self, scope: str) -> List[Dict]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT payload FROM chats WHERE user_scope = ? ORDER BY updated_at DESC",
                (scope,),
            ).fetchall()
        out: List[Dict] = []
        for row in rows:
            try:
                out.append(json.loads(row["payload"]))
            except (ValueError, TypeError):
                continue
        return out

    def get_chat(self, scope: str, chat_id: str) -> Optional[Dict]:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM chats WHERE user_scope = ? AND id = ?",
                (scope, str(chat_id)),
            ).fetchone()
        if not row:
            return None
        try:
            return json.loads(row["payload"])
        except (ValueError, TypeError):
            return None

    def count(self, scope: str) -> int:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM chats WHERE user_scope = ?", (scope,)
            ).fetchone()
        return int(row["n"] if row else 0)

    # ---- writes ------------------------------------------------------------
    @staticmethod
    def _message_total(chat: Optional[Dict]) -> int:
        """Every stored message, top-level plus per-thread."""
        if not isinstance(chat, dict):
            return 0
        total = len(chat.get("messages") or [])
        for thread in chat.get("threads") or []:
            if isinstance(thread, dict):
                total += len(thread.get("messages") or [])
        return total

    def upsert_many(self, scope: str, chats: List[Dict]) -> Dict[str, int]:
        """Insert or update chats. Never deletes anything that is not in the payload —
        a partial save from a client that trimmed its own list must not erase history.

        Also refuses to blank a stored conversation: a payload with NO messages over a row
        that has them is a cache placeholder, not an edit. That exact write destroyed the
        history of 14 chats once the client started stubbing over-budget chats."""
        written = 0
        protected = 0
        with self._lock, self._connect() as conn:
            for chat in chats or []:
                chat_id = str((chat or {}).get("id") or "").strip()
                if not chat_id:
                    continue
                row = conn.execute(
                    "SELECT payload FROM chats WHERE id = ?", (chat_id,)
                ).fetchone()
                if row:
                    try:
                        stored = json.loads(row["payload"])
                    except (ValueError, TypeError):
                        stored = None
                    incoming_msgs = self._message_total(chat)
                    stored_msgs = self._message_total(stored)
                    if incoming_msgs == 0 and stored_msgs > 0:
                        protected += 1
                        continue
                    if incoming_msgs < stored_msgs:
                        # A legitimate shrink (e.g. dropping a synthetic resume line) still
                        # goes through, but the previous version stays recoverable.
                        conn.execute(
                            "INSERT INTO chat_backups (user_scope, reason, payload, created_at)"
                            " VALUES (?, ?, ?, ?)",
                            (scope, f"shrink-{chat_id}", row["payload"], _now_ms()),
                        )
                blob = json.dumps(chat, ensure_ascii=False)
                created = int(chat.get("createdAt") or _now_ms())
                updated = int(chat.get("updatedAt") or chat.get("createdAt") or _now_ms())
                conn.execute(
                    """INSERT INTO chats (id, user_scope, name, payload, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                         user_scope = excluded.user_scope,
                         name       = excluded.name,
                         payload    = excluded.payload,
                         updated_at = excluded.updated_at""",
                    (chat_id, scope, str(chat.get("name") or ""), blob, created, updated),
                )
                written += 1
            conn.commit()
        return {"written": written, "protected": protected}

    def delete_chat(self, scope: str, chat_id: str) -> bool:
        """Explicit user deletion only. Nothing in this module deletes to reclaim space.

        The conversation is snapshotted first and kept for DELETED_RETENTION_DAYS, so a
        misclick is recoverable for a month. It leaves the sidebar immediately either way."""
        cid = str(chat_id)
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM chats WHERE user_scope = ? AND id = ?", (scope, cid)
            ).fetchone()
            if row:
                conn.execute(
                    "INSERT INTO chat_backups (user_scope, reason, payload, created_at)"
                    " VALUES (?, ?, ?, ?)",
                    (scope, f"deleted-{cid}", row["payload"], _now_ms()),
                )
            cur = conn.execute(
                "DELETE FROM chats WHERE user_scope = ? AND id = ?", (scope, cid)
            )
            conn.execute("DELETE FROM chat_activity WHERE chat_id = ?", (cid,))
            # Retention is enforced here rather than on a timer: deletes are the only
            # thing that grows this table on a normal day.
            conn.execute(
                "DELETE FROM chat_backups WHERE created_at < ?",
                (_now_ms() - DELETED_RETENTION_MS,),
            )
            conn.commit()
            return cur.rowcount > 0

    def list_deleted(self, scope: str) -> List[Dict]:
        """Recoverable deletions, newest first. A backup nobody can find is not a backup."""
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT reason, payload, created_at FROM chat_backups"
                " WHERE user_scope = ? AND reason LIKE 'deleted-%' ORDER BY created_at DESC",
                (scope,),
            ).fetchall()
            live = {r["id"] for r in conn.execute("SELECT id FROM chats WHERE user_scope = ?", (scope,))}
        out: List[Dict] = []
        seen = set()
        for row in rows:
            chat_id = str(row["reason"])[len("deleted-"):]
            if not chat_id or chat_id in live or chat_id in seen:
                continue
            try:
                chat = json.loads(row["payload"])
            except (ValueError, TypeError):
                continue
            seen.add(chat_id)
            out.append({
                "id": chat_id,
                "name": str((chat or {}).get("name") or ""),
                "deletedAt": int(row["created_at"]),
                "messageCount": self._message_total(chat),
                "expiresAt": int(row["created_at"]) + DELETED_RETENTION_MS,
            })
        return out

    def restore_deleted(self, scope: str, chat_id: str) -> Optional[Dict]:
        """Put a deleted conversation back. Returns the restored chat, or None if it is
        past retention (or was never deleted through this store)."""
        cid = str(chat_id)
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM chat_backups WHERE user_scope = ? AND reason = ?"
                " ORDER BY created_at DESC LIMIT 1",
                (scope, f"deleted-{cid}"),
            ).fetchone()
        if not row:
            return None
        try:
            chat = json.loads(row["payload"])
        except (ValueError, TypeError):
            return None
        if not isinstance(chat, dict) or not chat.get("id"):
            return None
        self.upsert_many(scope, [chat])
        return chat

    def snapshot(self, scope: str, reason: str) -> int:
        """Keep a restorable copy before a risky operation (import, migration)."""
        chats = self.list_chats(scope)
        if not chats:
            return 0
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO chat_backups (user_scope, reason, payload, created_at) VALUES (?, ?, ?, ?)",
                (scope, str(reason or "manual"), json.dumps(chats, ensure_ascii=False), _now_ms()),
            )
            conn.commit()
        return len(chats)

    def import_chats(self, scope: str, chats: List[Dict], reason: str = "import") -> Dict:
        """Additive restore: existing chats win, missing ones are added back."""
        self.snapshot(scope, reason)
        existing = {str(c.get("id")) for c in self.list_chats(scope)}
        fresh = [c for c in (chats or []) if str((c or {}).get("id") or "") not in existing]
        added = int(self.upsert_many(scope, fresh).get("written") or 0)
        return {"added": added, "skipped": len(chats or []) - added, "total": self.count(scope)}

    def stats(self) -> Dict:
        with self._lock, self._connect() as conn:
            scopes = conn.execute(
                "SELECT user_scope, COUNT(*) AS n FROM chats GROUP BY user_scope"
            ).fetchall()
        size = os.path.getsize(self._path) if os.path.exists(self._path) else 0
        return {
            "path": self._path,
            "sizeBytes": size,
            "scopes": {row["user_scope"]: int(row["n"]) for row in scopes},
        }
