(function initAIExeWorkspaceCore(global) {
  function createWorkspaceCore(deps) {
    function normalizeWorkspaceName(raw) {
      return String(raw || '')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function normalizeWorkspaceComparableName(raw) {
      return normalizeWorkspaceName(raw)
        .toLowerCase()
        .replace(/\s*\(\d+\)\s*$/g, '')
        .replace(/[^a-z0-9]+/g, '');
    }

    function normalizeWorkspacePath(raw) {
      const value = String(raw || '/').replace(/\\/g, '/').trim();
      let parts = value.split('/').filter((part) => part && part !== '.');
      const currentRootName = String(deps.getWorkspaceRootName ? deps.getWorkspaceRootName() : '');
      if (parts.length > 0 && currentRootName) {
        const currentRoot = normalizeWorkspaceComparableName(currentRootName);
        const firstPart = normalizeWorkspaceComparableName(parts[0]);
        if (currentRoot && firstPart === currentRoot) {
          parts = parts.slice(1);
        }
      }
      const clean = [];
      parts.forEach((part) => {
        if (part === '..') return;
        clean.push(part);
      });
      return clean.length > 0 ? `/${clean.join('/')}` : '/';
    }

    function joinWorkspacePath(parentPath, childName) {
      const parent = normalizeWorkspacePath(parentPath);
      const child = normalizeWorkspaceName(childName);
      if (!child) return parent;
      return normalizeWorkspacePath(parent === '/' ? `/${child}` : `${parent}/${child}`);
    }

    function joinWorkspaceRelativePath(parentPath, relativePath) {
      const parent = normalizeWorkspacePath(parentPath);
      const rel = String(relativePath || '')
        .replace(/\\/g, '/')
        .split('/')
        .map((part) => normalizeWorkspaceName(part))
        .filter(Boolean)
        .join('/');
      if (!rel) return parent;
      return normalizeWorkspacePath(parent === '/' ? `/${rel}` : `${parent}/${rel}`);
    }

    function parentWorkspacePath(path) {
      const full = normalizeWorkspacePath(path);
      if (full === '/' || !full.includes('/')) return '/';
      const idx = full.lastIndexOf('/');
      return idx <= 0 ? '/' : full.slice(0, idx);
    }

    function workspaceBaseName(path) {
      const value = normalizeWorkspacePath(path);
      if (value === '/') return '';
      const parts = value.split('/').filter(Boolean);
      return parts[parts.length - 1] || '';
    }

    function normalizeWorkspacePathList(paths) {
      const seen = new Set();
      const normalized = [];
      (paths || []).forEach((value) => {
        const p = normalizeWorkspacePath(value);
        if (!p || p === '/' || seen.has(p)) return;
        seen.add(p);
        normalized.push(p);
      });
      normalized.sort((a, b) => a.length - b.length);
      return normalized.filter((path, idx) => {
        for (let i = 0; i < idx; i += 1) {
          const parent = normalized[i];
          if (path.startsWith(`${parent}/`)) return false;
        }
        return true;
      });
    }

    function getSelectedWorkspacePathsForAction() {
      const selectedPaths = deps.getWorkspaceSelectedPaths();
      if (selectedPaths.size > 0) {
        return normalizeWorkspacePathList(Array.from(selectedPaths));
      }
      return normalizeWorkspacePathList([deps.getWorkspaceCurrentPath()]);
    }

    function clearWorkspaceDragExpandTimers() {
      const timers = deps.getWorkspaceDragExpandTimers();
      timers.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      timers.clear();
    }

    async function invokeWorkspaceAction(action, data = {}) {
      if (!deps.nativeBridge.available()) {
        return { ok: false, message: 'Native runtime bridge unavailable.' };
      }
      const response = await deps.nativeBridge.invoke(action, data);
      if (response && response.status) {
        deps.applyRuntimeStatus(response.status);
      }
      return response || { ok: false, message: 'No response from workspace bridge.' };
    }

    function mapWorkspaceEntry(raw) {
      const item = raw && typeof raw === 'object' ? raw : {};
      const kind = item.kind === 'folder' ? 'folder' : 'file';
      const path = normalizeWorkspacePath(item.path || '/');
      const name = normalizeWorkspaceName(item.name || '') || (kind === 'folder' ? 'Folder' : 'file.txt');
      const sizeBytes = Number(item.sizeBytes) || 0;
      const updatedAt = Number(item.updatedAt) || deps.nowTs();
      const childCount = Number(item.childCount) || 0;
      return {
        kind,
        path,
        name,
        sizeBytes,
        size: kind === 'file' ? deps.formatBytes(sizeBytes) : '',
        updatedAt,
        childCount,
        optimisticUntil: Number(item.optimisticUntil) || 0,
      };
    }

    function getWorkspaceNodeState(path) {
      const key = normalizeWorkspacePath(path);
      const treeState = deps.getWorkspaceTreeState();
      let node = treeState.get(key);
      if (!node) {
        node = {
          path: key,
          expanded: key === '/',
          loaded: false,
          loading: false,
          loadPromise: null,
          error: '',
          children: [],
        };
        treeState.set(key, node);
      }
      return node;
    }

    function sortWorkspaceEntries(entries) {
      return Array.from(entries || []).sort((left, right) => {
        const kindDiff = String(left && left.kind || '') === String(right && right.kind || '')
          ? 0
          : (String(left && left.kind || '') === 'folder' ? -1 : 1);
        if (kindDiff !== 0) return kindDiff;
        return String(left && left.name || '').localeCompare(String(right && right.name || ''), undefined, { sensitivity: 'base' });
      });
    }

    function ensureWorkspaceParentChain(path) {
      let current = parentWorkspacePath(path);
      while (current && current !== '/' && current !== '.') {
        const parent = parentWorkspacePath(current);
        const parentNode = getWorkspaceNodeState(parent || '/');
        const currentName = workspaceBaseName(current);
        const existing = (parentNode.children || []).find((entry) => normalizeWorkspacePath(entry.path) === current);
        if (!existing) {
          parentNode.children = sortWorkspaceEntries([...(parentNode.children || []), {
            kind: 'folder',
            path: current,
            name: currentName,
            sizeBytes: 0,
            size: '',
            updatedAt: deps.nowTs(),
            childCount: 0,
          }]);
        }
        parentNode.loaded = true;
        parentNode.expanded = true;
        current = parent;
      }
    }

    function upsertWorkspaceTreeEntry(entry) {
      const mapped = mapWorkspaceEntry(entry);
      if (!mapped.path || mapped.path === '/') return;
      ensureWorkspaceParentChain(mapped.path);
      const parentPath = parentWorkspacePath(mapped.path);
      const parentNode = getWorkspaceNodeState(parentPath || '/');
      const nextChildren = (parentNode.children || []).filter((item) => normalizeWorkspacePath(item.path) !== mapped.path);
      nextChildren.push(mapped);
      parentNode.children = sortWorkspaceEntries(nextChildren);
      parentNode.loaded = true;
      parentNode.expanded = true;
    }

    function removeWorkspaceTreeEntry(path) {
      const normalized = normalizeWorkspacePath(path);
      if (!normalized || normalized === '/') return;
      const parentPath = parentWorkspacePath(normalized);
      const parentNode = getWorkspaceNodeState(parentPath || '/');
      parentNode.children = (parentNode.children || []).filter((item) => normalizeWorkspacePath(item.path) !== normalized);
      parentNode.loaded = true;
    }

    function scheduleWorkspaceExplorerBackgroundRefresh(delayMs = 280) {
      const currentTimer = deps.getWorkspaceRefreshTimer();
      if (currentTimer) {
        clearTimeout(currentTimer);
      }
      const timerId = window.setTimeout(() => {
        deps.setWorkspaceRefreshTimer(0);
        void deps.refreshWorkspaceTree(true);
      }, Math.max(0, Number(delayMs) || 0));
      deps.setWorkspaceRefreshTimer(timerId);
    }

    async function loadWorkspaceChildren(path, force = false) {
      const key = normalizeWorkspacePath(path);
      const node = getWorkspaceNodeState(key);
      // Concurrent renders must share the same native list request. Returning the node
      // immediately while it was still loading allowed the newer render token to paint an
      // empty tree, then discard the older render that actually received the files.
      if (node.loading && node.loadPromise) return node.loadPromise;
      if (node.loaded && !force) return node;

      node.loading = true;
      node.error = '';
      node.loadPromise = (async () => {
        let response = null;
        // Shared/network folders can fail a directory read for a moment. Retry without
        // clearing the last good tree; Run uses the real folder and should never disagree
        // with Explorer merely because one refresh raced the filesystem.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          response = await invokeWorkspaceAction('workspaceList', { path: key });
          if (response && response.ok) break;
          if (attempt < 2) {
            await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 100 : 250));
          }
        }
        if (!response || !response.ok) {
          // Preserve the last successful snapshot. A transient refresh failure is not proof
          // that the directory became empty.
          node.error = (response && response.message) || 'Failed to load folder.';
          return node;
        }

        let parsed = {};
        try {
          parsed = JSON.parse(String(response.output || '{}'));
        } catch (_) {
          parsed = {};
        }
        if (!Array.isArray(parsed.entries)) {
          node.error = 'Workspace returned an invalid folder listing.';
          return node;
        }
        // .aiexe/ holds the agent's phased-build plan (source of truth) — hidden from the user.
        const hiddenSystemFiles = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.Spotlight-V100', '.Trashes', '.fseventsd', '.aiexe']);
        const fetchedChildren = parsed.entries
          .map(mapWorkspaceEntry)
          .filter((e) => !hiddenSystemFiles.has(e.name) && !e.name.startsWith('._'));
        const optimisticCarry = (node.children || []).filter((entry) => {
          const optimisticUntil = Number(entry && entry.optimisticUntil) || 0;
          if (!optimisticUntil || optimisticUntil < deps.nowTs()) return false;
          return !fetchedChildren.some((fetched) => normalizeWorkspacePath(fetched.path) === normalizeWorkspacePath(entry.path));
        });
        node.children = sortWorkspaceEntries([...fetchedChildren, ...optimisticCarry]);
        node.loaded = true;
        node.error = '';
        node.children.forEach((entry) => {
          if (entry.kind === 'folder') getWorkspaceNodeState(entry.path);
        });
        return node;
      })();
      try {
        return await node.loadPromise;
      } finally {
        node.loading = false;
        node.loadPromise = null;
      }
    }

    function setWorkspaceSelection(path, kind = 'folder', keepMulti = false, includePath = true) {
      deps.setWorkspaceCurrentPath(normalizeWorkspacePath(path));
      deps.setWorkspaceCurrentKind(kind === 'file' ? 'file' : 'folder');
      const selectedPaths = deps.getWorkspaceSelectedPaths();
      if (!keepMulti) {
        selectedPaths.clear();
      }
      if (includePath) {
        selectedPaths.add(deps.getWorkspaceCurrentPath());
      }
      deps.saveWorkspaceState();
      deps.updateWorkspaceHeaderUi();
    }

    async function refreshWorkspaceTree(forceReload = true) {
      deps.closeExplorerMenus();
      clearWorkspaceDragExpandTimers();
      deps.clearWorkspaceDrafts();
      if (forceReload) {
        const selectedFolderPath = deps.getWorkspaceCurrentKind() === 'folder'
          ? normalizeWorkspacePath(deps.getWorkspaceCurrentPath())
          : parentWorkspacePath(deps.getWorkspaceCurrentPath());
        const treeState = deps.getWorkspaceTreeState();
        treeState.clear();
        const rootNode = getWorkspaceNodeState('/');
        rootNode.expanded = true;
        if (selectedFolderPath && selectedFolderPath !== '/') {
          getWorkspaceNodeState(selectedFolderPath).expanded = true;
        }
      }
      await deps.renderArtifacts();
      if (typeof deps.refreshOpenFileTabsFromWorkspace === 'function') {
        await deps.refreshOpenFileTabsFromWorkspace();
      }
    }

    function guessWorkspaceTargetKind(path) {
      const normalized = normalizeWorkspacePath(path || '');
      if (!normalized || normalized === '/') return 'folder';
      return /\.[^./\\]+$/.test(normalized) ? 'file' : 'folder';
    }

    return {
      normalizeWorkspaceName,
      normalizeWorkspaceComparableName,
      normalizeWorkspacePath,
      joinWorkspacePath,
      joinWorkspaceRelativePath,
      parentWorkspacePath,
      workspaceBaseName,
      normalizeWorkspacePathList,
      getSelectedWorkspacePathsForAction,
      clearWorkspaceDragExpandTimers,
      invokeWorkspaceAction,
      mapWorkspaceEntry,
      getWorkspaceNodeState,
      sortWorkspaceEntries,
      ensureWorkspaceParentChain,
      upsertWorkspaceTreeEntry,
      removeWorkspaceTreeEntry,
      scheduleWorkspaceExplorerBackgroundRefresh,
      loadWorkspaceChildren,
      setWorkspaceSelection,
      refreshWorkspaceTree,
      guessWorkspaceTargetKind,
    };
  }

  global.AIExeWorkspaceCore = {
    createWorkspaceCore,
  };
})(window);
