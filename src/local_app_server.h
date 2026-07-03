#pragma once

#include <filesystem>
#include <string>

// Starts (or reuses) a tiny static HTTP server bound to 127.0.0.1 on an
// ephemeral port, serving the files under `root`. Returns the base URL
// (e.g. "http://127.0.0.1:54321/") or an empty string on failure (err set).
//
// Why: generated web projects opened from disk (file://) silently break — ES
// modules, fetch()/XHR of sibling files, and many APIs are blocked by the
// browser's file:// origin rules, so "only the UI shows but nothing works".
// Serving the same folder over http://127.0.0.1 gives a real origin where the
// app actually runs. Safe to call repeatedly: one server is kept per resolved
// root for the process lifetime and reused.
std::string StartLocalAppServer(const std::filesystem::path& root,
                                std::string* err);

// True when something is already accepting TCP connections on 127.0.0.1:port.
// Used by external dev-server launchers (Vite) to make Run idempotent.
bool IsLoopbackTcpPortOpen(int port);
