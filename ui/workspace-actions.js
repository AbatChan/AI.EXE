(function initAIExeWorkspaceActions(global) {
  function createWorkspaceActions(deps) {
    function getWorkspaceCreateParentPath() {
      return deps.getWorkspaceCurrentKind() === 'folder'
        ? deps.normalizeWorkspacePath(deps.getWorkspaceCurrentPath())
        : deps.parentWorkspacePath(deps.getWorkspaceCurrentPath());
    }

    function startWorkspaceDraft(kind = 'file') {
      const draftKind = kind === 'folder' ? 'folder' : 'file';
      const parentPath = getWorkspaceCreateParentPath();
      const parentNode = deps.getWorkspaceNodeState(parentPath);
      parentNode.expanded = true;
      deps.setWorkspaceDraft({
        id: `draft_${deps.nowTs()}_${Math.random().toString(36).slice(2, 7)}`,
        kind: draftKind,
        parentPath,
        name: draftKind === 'folder' ? 'new-folder' : 'new-file.txt',
      });
      deps.setWorkspaceRenameDraft(null);
      deps.setWorkspaceRenameFocusId(0);
      deps.setWorkspaceDraftFocusId(deps.getWorkspaceDraft().id);
      deps.setWorkspaceSelection(parentPath, 'folder', false, false);
      void deps.renderArtifacts();
    }

    function cancelWorkspaceDraft() {
      if (!deps.getWorkspaceDraft()) return;
      deps.setWorkspaceDraft(null);
      deps.setWorkspaceDraftFocusId(0);
      void deps.renderArtifacts();
    }

    function cancelWorkspaceRenameDraft(shouldRender = true) {
      if (!deps.getWorkspaceRenameDraft()) return;
      deps.setWorkspaceRenameDraft(null);
      deps.setWorkspaceRenameFocusId(0);
      if (shouldRender) {
        void deps.renderArtifacts();
      }
    }

    async function commitWorkspaceDraft(rawName) {
      const draft = deps.getWorkspaceDraft();
      if (!draft) return false;
      const parentPath = deps.normalizeWorkspacePath(draft.parentPath);
      const name = deps.normalizeWorkspaceName(rawName);
      if (!name) return false;

      const parentNode = await deps.loadWorkspaceChildren(parentPath, false);
      const exists = (parentNode.children || []).some((entry) => String(entry.name || '').toLowerCase() === name.toLowerCase());
      if (exists) {
        window.alert('An item with this name already exists in the folder.');
        return false;
      }

      const path = deps.joinWorkspacePath(parentPath, name);
      const response = draft.kind === 'folder'
        ? await deps.invokeWorkspaceAction('workspaceMkdir', { path })
        : await deps.invokeWorkspaceAction('workspaceWriteFile', { path, content: '' });
      if (!response || !response.ok) {
        window.alert((response && response.message) || `Failed to create ${draft.kind}.`);
        return false;
      }

      deps.setWorkspaceDraft(null);
      deps.setWorkspaceDraftFocusId(0);
      const node = deps.getWorkspaceNodeState(parentPath);
      node.expanded = true;
      node.loaded = false;
      deps.setWorkspaceSelection(path, draft.kind);
      await deps.renderArtifacts();
      return true;
    }

    async function startWorkspaceRenamePath(path) {
      const targetPath = deps.normalizeWorkspacePath(path);
      if (!targetPath || targetPath === '/') return false;

      const parentPath = deps.parentWorkspacePath(targetPath);
      const parentNode = await deps.loadWorkspaceChildren(parentPath, false);
      const entry = (parentNode.children || []).find((item) => deps.normalizeWorkspacePath(item.path) === targetPath);
      if (!entry) return false;

      deps.setWorkspaceDraft(null);
      deps.setWorkspaceDraftFocusId(0);
      deps.setWorkspaceRenameDraft({
        id: `rename_${deps.nowTs()}_${Math.random().toString(36).slice(2, 7)}`,
        path: targetPath,
        parentPath,
        kind: entry.kind === 'folder' ? 'folder' : 'file',
        name: entry.name || deps.workspaceBaseName(targetPath),
      });
      deps.setWorkspaceRenameFocusId(deps.getWorkspaceRenameDraft().id);
      deps.setWorkspaceSelection(targetPath, deps.getWorkspaceRenameDraft().kind);
      void deps.renderArtifacts();
      return true;
    }

    async function startWorkspaceRenameSelected() {
      const paths = deps.getSelectedWorkspacePathsForAction();
      if (paths.length !== 1) {
        window.alert('Select exactly one file or folder to rename.');
        return;
      }
      const started = await startWorkspaceRenamePath(paths[0]);
      if (!started) {
        window.alert('Unable to rename selected item.');
      }
    }

    async function commitWorkspaceRenameDraft(rawName) {
      const draft = deps.getWorkspaceRenameDraft();
      if (!draft) return false;
      const sourcePath = deps.normalizeWorkspacePath(draft.path);
      const parentPath = deps.normalizeWorkspacePath(draft.parentPath);
      const newName = deps.normalizeWorkspaceName(rawName);
      if (!newName) return false;

      const currentName = deps.workspaceBaseName(sourcePath);
      if (newName === currentName) {
        cancelWorkspaceRenameDraft();
        return true;
      }

      const parentNode = await deps.loadWorkspaceChildren(parentPath, false);
      const exists = (parentNode.children || []).some((entry) => deps.normalizeWorkspacePath(entry.path) !== sourcePath && String(entry.name || '').toLowerCase() === newName.toLowerCase());
      if (exists) {
        window.alert('An item with this name already exists in the folder.');
        return false;
      }

      const targetPath = deps.joinWorkspacePath(parentPath, newName);
      const response = await deps.invokeWorkspaceAction('workspaceMove', {
        srcPath: sourcePath,
        dstPath: targetPath,
      });
      if (!response || !response.ok) {
        window.alert((response && response.message) || 'Failed to rename item.');
        return false;
      }

      deps.setWorkspaceRenameDraft(null);
      deps.setWorkspaceRenameFocusId(0);
      const selectedPaths = deps.getWorkspaceSelectedPaths();
      selectedPaths.clear();
      selectedPaths.add(targetPath);
      deps.setWorkspaceSelection(targetPath, draft.kind);
      deps.getWorkspaceTreeState().clear();
      deps.getWorkspaceNodeState('/').expanded = true;
      await deps.renderArtifacts();
      return true;
    }

    function readFileAsText(file) {
      return new Promise((resolve, reject) => {
        try {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('Failed to read dropped file.'));
          reader.readAsText(file);
        } catch (err) {
          reject(err);
        }
      });
    }

    function readDroppedEntryFile(entry) {
      return new Promise((resolve, reject) => {
        try {
          entry.file((file) => resolve(file), (err) => reject(err || new Error('Failed to read dropped file.')));
        } catch (err) {
          reject(err);
        }
      });
    }

    function readDroppedDirectoryBatch(reader) {
      return new Promise((resolve, reject) => {
        try {
          reader.readEntries((entries) => resolve(Array.from(entries || [])), (err) => reject(err));
        } catch (err) {
          reject(err);
        }
      });
    }

    async function collectDroppedEntries(entries, prefix = '', out = { folders: [], files: [] }) {
      const list = Array.from(entries || []);
      for (const entry of list) {
        if (!entry) continue;
        if (entry.isFile) {
          let file = null;
          try {
            file = await readDroppedEntryFile(entry);
          } catch (_) {
            continue;
          }
          const fileName = deps.normalizeWorkspaceName((file && file.name) || entry.name || '');
          if (!fileName) continue;
          const relPath = prefix ? `${prefix}/${fileName}` : fileName;
          out.files.push({ relPath, file });
          continue;
        }
        if (entry.isDirectory) {
          const dirName = deps.normalizeWorkspaceName(entry.name || 'folder');
          if (!dirName) continue;
          const dirRelPath = prefix ? `${prefix}/${dirName}` : dirName;
          out.folders.push(dirRelPath);
          const reader = entry.createReader();
          while (true) {
            let batch = [];
            try {
              batch = await readDroppedDirectoryBatch(reader);
            } catch (_) {
              batch = [];
            }
            if (!batch.length) break;
            await collectDroppedEntries(batch, dirRelPath, out);
          }
        }
      }
      return out;
    }

    function getDroppedFileSystemEntries(dataTransfer) {
      const items = Array.from((dataTransfer && dataTransfer.items) || []);
      const entries = [];
      items.forEach((item) => {
        if (item && typeof item.webkitGetAsEntry === 'function') {
          const entry = item.webkitGetAsEntry();
          if (entry) entries.push(entry);
        }
      });
      return entries;
    }

    async function uploadDroppedFiles(fileList, targetFolderPath) {
      const files = Array.from(fileList || []);
      if (!files.length) return;

      const rootNode = deps.getWorkspaceNodeState('/');
      if (!deps.getWorkspaceRootName() && (!rootNode.loaded || rootNode.children.length === 0)) {
        window.alert('To open a project, please click the "Open Project" button in the toolbar.\n\nDragging and dropping folders into the window attempts to copy them into the workspace, which is not supported when no project is open.');
        return;
      }

      const targetFolder = deps.normalizeWorkspacePath(targetFolderPath);
      let createdCount = 0;
      for (const file of files) {
        const rawName = deps.normalizeWorkspaceName(file && file.name ? file.name : '');
        if (!rawName) continue;
        if (Number(file && file.size) > 2 * 1024 * 1024) {
          window.alert(`Skipped "${rawName}" (max 2 MB per dropped file).`);
          continue;
        }
        try {
          const content = await readFileAsText(file);
          const path = deps.joinWorkspaceRelativePath(targetFolder, rawName);
          const response = await deps.invokeWorkspaceAction('workspaceWriteFile', { path, content });
          if (!response || !response.ok) {
            window.alert((response && response.message) || `Failed to add "${rawName}".`);
            continue;
          }
          createdCount += 1;
        } catch (_) {
          window.alert(`Failed to read "${rawName}" as text.`);
        }
      }

      if (createdCount > 0) {
        const node = deps.getWorkspaceNodeState(targetFolder);
        node.expanded = true;
        node.loaded = false;
        deps.setWorkspaceSelection(targetFolder, 'folder');
        await deps.renderArtifacts();
      }
    }

    async function uploadDroppedDataTransfer(dataTransfer, targetFolderPath) {
      const rootNode = deps.getWorkspaceNodeState('/');
      if (!deps.getWorkspaceRootName() && (!rootNode.loaded || rootNode.children.length === 0)) {
        window.alert('To open a project, please click the "Open Project" button in the toolbar.\n\nDragging and dropping folders into the window attempts to copy them into the workspace, which is not supported when no project is open.');
        return;
      }

      const entries = getDroppedFileSystemEntries(dataTransfer);
      if (!entries.length) {
        await uploadDroppedFiles(dataTransfer ? dataTransfer.files : [], targetFolderPath);
        return;
      }

      const targetFolder = deps.normalizeWorkspacePath(targetFolderPath);
      const collected = await collectDroppedEntries(entries);
      const folderPaths = Array.from(new Set((collected.folders || []).filter(Boolean)))
        .sort((a, b) => a.split('/').length - b.split('/').length);
      let createdCount = 0;

      for (const rel of folderPaths) {
        const path = deps.joinWorkspaceRelativePath(targetFolder, rel);
        const response = await deps.invokeWorkspaceAction('workspaceMkdir', { path });
        if (!response || !response.ok) {
          window.alert((response && response.message) || `Failed to add folder "${rel}".`);
          continue;
        }
        createdCount += 1;
      }

      for (const item of (collected.files || [])) {
        const relPath = item && item.relPath ? String(item.relPath) : '';
        const file = item && item.file;
        if (!relPath || !file) continue;
        const displayName = deps.normalizeWorkspaceName(relPath.split('/').pop() || relPath);
        if (Number(file.size || 0) > 2 * 1024 * 1024) {
          window.alert(`Skipped "${displayName}" (max 2 MB per dropped file).`);
          continue;
        }
        try {
          const content = await readFileAsText(file);
          const path = deps.joinWorkspaceRelativePath(targetFolder, relPath);
          const response = await deps.invokeWorkspaceAction('workspaceWriteFile', { path, content });
          if (!response || !response.ok) {
            window.alert((response && response.message) || `Failed to add "${relPath}".`);
            continue;
          }
          createdCount += 1;
        } catch (_) {
          window.alert(`Failed to read "${displayName}" as text.`);
        }
      }

      if (createdCount > 0) {
        const node = deps.getWorkspaceNodeState(targetFolder);
        node.expanded = true;
        node.loaded = false;
        deps.setWorkspaceSelection(targetFolder, 'folder');
        await deps.renderArtifacts();
      }
    }

    async function importWorkspacePickedFiles(fileList) {
      deps.closeExplorerMenus();
      const targetFolder = getWorkspaceCreateParentPath();
      await uploadDroppedFiles(fileList, targetFolder);
    }

    function importWorkspaceFiles() {
      if (!deps.ensureSignedIn()) return;
      if (!deps.nativeBridge.available()) {
        window.alert('Native runtime bridge unavailable.');
        return;
      }
      if (!deps.workspaceImportInput) {
        window.alert('Workspace import is unavailable in this build.');
        return;
      }
      deps.closeExplorerMenus();
      deps.workspaceImportInput.click();
    }

    async function importWorkspacePickedFolderFiles(fileList) {
      deps.closeExplorerMenus();
      const files = Array.from(fileList || []);
      if (!files.length) return;
      const targetFolder = getWorkspaceCreateParentPath();
      const folderSet = new Set();
      let createdCount = 0;

      for (const file of files) {
        const relRaw = String(file && file.webkitRelativePath ? file.webkitRelativePath : file && file.name ? file.name : '').replace(/\\/g, '/');
        const relPath = relRaw.split('/').filter(Boolean).map((part) => deps.normalizeWorkspaceName(part)).filter(Boolean).join('/');
        if (!relPath) continue;
        const parts = relPath.split('/');
        for (let i = 1; i < parts.length; i += 1) {
          const dirRel = parts.slice(0, i).join('/');
          if (dirRel) folderSet.add(dirRel);
        }
      }

      const folderPaths = Array.from(folderSet).sort((a, b) => a.split('/').length - b.split('/').length);
      for (const rel of folderPaths) {
        const path = deps.joinWorkspaceRelativePath(targetFolder, rel);
        const response = await deps.invokeWorkspaceAction('workspaceMkdir', { path });
        if (response && response.ok) createdCount += 1;
      }

      for (const file of files) {
        const relRaw = String(file && file.webkitRelativePath ? file.webkitRelativePath : file && file.name ? file.name : '').replace(/\\/g, '/');
        const relPath = relRaw.split('/').filter(Boolean).map((part) => deps.normalizeWorkspaceName(part)).filter(Boolean).join('/');
        if (!relPath) continue;
        const displayName = relPath.split('/').pop() || relPath;
        if (Number(file && file.size) > 2 * 1024 * 1024) {
          window.alert(`Skipped "${displayName}" (max 2 MB per file).`);
          continue;
        }
        try {
          const content = await readFileAsText(file);
          const path = deps.joinWorkspaceRelativePath(targetFolder, relPath);
          const response = await deps.invokeWorkspaceAction('workspaceWriteFile', { path, content });
          if (!response || !response.ok) {
            window.alert((response && response.message) || `Failed to add "${relPath}".`);
            continue;
          }
          createdCount += 1;
        } catch (_) {
          window.alert(`Failed to read "${displayName}" as text.`);
        }
      }

      if (createdCount > 0) {
        const node = deps.getWorkspaceNodeState(targetFolder);
        node.expanded = true;
        node.loaded = false;
        deps.setWorkspaceSelection(targetFolder, 'folder');
        await deps.renderArtifacts();
      }
    }

    function importWorkspaceFolder() {
      if (!deps.ensureSignedIn()) return;
      if (!deps.nativeBridge.available()) {
        window.alert('Native runtime bridge unavailable.');
        return;
      }
      if (!deps.workspaceImportFolderInput) {
        window.alert('Folder import is unavailable in this build.');
        return;
      }
      deps.closeExplorerMenus();
      deps.workspaceImportFolderInput.click();
    }

    async function revealWorkspaceInSystem() {
      if (!deps.ensureSignedIn()) return;
      if (!deps.nativeBridge.available()) {
        window.alert('Native runtime bridge unavailable.');
        return;
      }
      const targetPath = deps.getWorkspaceCurrentPath() || '/';
      const response = await deps.invokeWorkspaceAction('workspaceReveal', { path: targetPath });
      if (!response || !response.ok) {
        window.alert((response && response.message) || 'Failed to open workspace in system file manager.');
      }
      deps.closeExplorerMenus();
    }

    function parseDraggedWorkspacePaths(dataTransfer) {
      if (!dataTransfer) return [];
      const rawList = dataTransfer.getData('application/x-aiexe-paths');
      if (rawList) {
        try {
          const parsed = JSON.parse(rawList);
          if (Array.isArray(parsed)) {
            return deps.normalizeWorkspacePathList(parsed);
          }
        } catch (_) { }
      }
      const single = dataTransfer.getData('text/plain');
      // text/plain now carries an external file:// URL on drag-out; that is not a
      // workspace path, so don't try to move it as one.
      if (/^file:\/\//i.test(String(single || '').trim())) return [];
      return deps.normalizeWorkspacePathList([single]);
    }

    async function moveWorkspaceEntries(sourcePaths, targetFolderPath) {
      const dstFolder = deps.normalizeWorkspacePath(targetFolderPath);
      if (!dstFolder) return;

      const sources = deps.normalizeWorkspacePathList(sourcePaths);
      if (!sources.length) return;

      const moved = [];
      const failures = [];
      for (const src of sources) {
        if (src === dstFolder || dstFolder.startsWith(`${src}/`)) continue;
        const name = deps.workspaceBaseName(src);
        if (!name) continue;
        const dst = deps.joinWorkspacePath(dstFolder, name);
        if (dst === src) continue;

        const response = await deps.invokeWorkspaceAction('workspaceMove', { srcPath: src, dstPath: dst });
        if (!response || !response.ok) {
          failures.push((response && response.message) || `Failed to move "${name}".`);
          continue;
        }
        moved.push({ src, dst });
      }

      if (moved.length > 0) {
        const selectedPaths = deps.getWorkspaceSelectedPaths();
        selectedPaths.clear();
        moved.forEach((item) => {
          selectedPaths.add(item.dst);
        });
        deps.setWorkspaceSelection(moved[0].dst, deps.getWorkspaceCurrentKind(), true);
        deps.getWorkspaceTreeState().clear();
        deps.getWorkspaceNodeState('/').expanded = true;
        await deps.renderArtifacts();
      }
      if (failures.length > 0) {
        const preview = failures.slice(0, 2).join('\n');
        const suffix = failures.length > 2 ? `\n...and ${failures.length - 2} more.` : '';
        window.alert(`${preview}${suffix}`);
      }
    }

    async function downloadWorkspaceFile(entry) {
      const path = deps.normalizeWorkspacePath(entry && entry.path);
      if (!path || path === '/') return;
      const response = await deps.invokeWorkspaceAction('workspaceReadFile', { path });
      if (!response || !response.ok) {
        window.alert((response && response.message) || 'Failed to read file.');
        return;
      }
      const content = String(response.output || '');
      const name = (entry && entry.name) || 'file.txt';
      const a = document.createElement('a');
      a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;
      a.download = name;
      a.click();
    }

    function collapseAllFolders() {
      deps.closeExplorerMenus();
      deps.clearWorkspaceDragExpandTimers();
      deps.setWorkspaceDraft(null);
      deps.setWorkspaceDraftFocusId(0);
      deps.setWorkspaceRenameDraft(null);
      deps.setWorkspaceRenameFocusId(0);
      deps.getWorkspaceTreeState().forEach((node, key) => {
        node.expanded = key === '/';
      });
      void deps.renderArtifacts();
    }

    async function openWorkspaceProject() {
      deps.closeExplorerMenus();
      if (!deps.ensureSignedIn()) return;
      if (!deps.nativeBridge.available()) {
        window.alert('Native runtime bridge unavailable.');
        return;
      }
      const response = await deps.invokeWorkspaceAction('workspaceOpenRoot', {});
      if (!response || !response.ok) {
        const msg = (response && response.message) || 'Failed to open project folder.';
        if (msg !== 'Folder selection cancelled.') {
          window.alert(msg);
        }
        return;
      }

      if (typeof deps.applyWorkspaceStatusSnapshot === 'function') {
        const statusRes = await deps.invokeWorkspaceAction('status', {});
        deps.applyWorkspaceStatusSnapshot(statusRes && statusRes.status ? statusRes.status : {});
      }
      deps.clearWorkspaceDragExpandTimers();
      deps.setWorkspaceDraft(null);
      deps.setWorkspaceDraftFocusId(0);
      deps.setWorkspaceRenameDraft(null);
      deps.setWorkspaceRenameFocusId(0);
      deps.getWorkspaceSelectedPaths().clear();
      deps.setWorkspaceSelection('/', 'folder');
      deps.getWorkspaceTreeState().clear();
      if (typeof deps.closeAllWorkspaceTabs === 'function') deps.closeAllWorkspaceTabs();
      const freshRoot = deps.getWorkspaceNodeState('/');
      freshRoot.expanded = true;
      freshRoot.loaded = false;
      await deps.renderArtifacts();
    }

    async function closeWorkspaceProject() {
      deps.closeExplorerMenus();
      if (!deps.ensureSignedIn()) return;
      if (!deps.nativeBridge.available()) {
        window.alert('Native runtime bridge unavailable.');
        return;
      }
      if (!deps.getWorkspaceRootName || !deps.getWorkspaceRootName()) {
        window.alert('No project is currently open.');
        return;
      }
      const response = await deps.invokeWorkspaceAction('workspaceCloseRoot', {});
      if (!response || !response.ok) {
        window.alert((response && response.message) || 'Failed to close project.');
        return;
      }
      deps.clearWorkspaceDragExpandTimers();
      deps.setWorkspaceDraft(null);
      deps.setWorkspaceDraftFocusId(0);
      deps.setWorkspaceRenameDraft(null);
      deps.setWorkspaceRenameFocusId(0);
      deps.getWorkspaceSelectedPaths().clear();
      if (typeof deps.applyWorkspaceStatusSnapshot === 'function') {
        deps.applyWorkspaceStatusSnapshot({ rootPath: '', rootName: '', currentPath: '/', currentKind: 'folder' });
      } else {
        if (typeof deps.setWorkspaceItems === 'function') deps.setWorkspaceItems([]);
        if (typeof deps.setWorkspaceCurrentPath === 'function') deps.setWorkspaceCurrentPath('/');
        if (typeof deps.setWorkspaceCurrentKind === 'function') deps.setWorkspaceCurrentKind('folder');
        deps.setWorkspaceRootName('');
        deps.saveWorkspaceRootPath('');
      }
      deps.setWorkspaceSelection('/', 'folder');
      deps.getWorkspaceTreeState().clear();
      if (typeof deps.closeAllWorkspaceTabs === 'function') deps.closeAllWorkspaceTabs();
      const freshRoot = deps.getWorkspaceNodeState('/');
      freshRoot.expanded = true;
      freshRoot.loaded = false;
      if (typeof deps.recordDebugTrace === 'function') {
        deps.recordDebugTrace('workspace_closed', {
          workspaceRootName: '',
          workspaceCurrentPath: '/',
          workspaceRootLoaded: 'false',
          workspaceRootEntryCount: '0',
        }, {
          workspace: typeof deps.getWorkspaceDebugSnapshot === 'function' ? deps.getWorkspaceDebugSnapshot() : null,
        });
      }
      await deps.renderArtifacts();
    }

    async function deleteSelectedWorkspaceItems() {
      deps.closeExplorerMenus();
      if (!deps.ensureSignedIn()) return;
      if (!deps.nativeBridge.available()) {
        window.alert('Native runtime bridge unavailable.');
        return;
      }
      const paths = deps.getSelectedWorkspacePathsForAction()
        .filter((path) => deps.normalizeWorkspacePath(path) !== '/');
      if (!paths.length) {
        window.alert('Select file(s) or folder(s) inside the current project to delete.');
        return;
      }
      const label = paths.length === 1 ? paths[0] : `${paths.length} items`;
      const okDelete = window.confirm(`Move ${label} to Trash?`);
      if (!okDelete) return;

      const failures = [];
      let deletedCount = 0;
      for (const path of paths) {
        const response = await deps.invokeWorkspaceAction('workspaceTrash', { path });
        if (!response || !response.ok) {
          failures.push((response && response.message) || `Failed to delete "${path}".`);
          continue;
        }
        if (typeof deps.removeWorkspaceTab === 'function') deps.removeWorkspaceTab(path);
        deletedCount += 1;
      }

      if (deletedCount > 0) {
        const fallbackPath = deps.parentWorkspacePath(paths[0]);
        deps.getWorkspaceSelectedPaths().clear();
        deps.setWorkspaceSelection(fallbackPath, 'folder');
        // Remove only the deleted entries from the tree. Clearing the whole tree
        // state forced a full root re-list whose result could briefly come back
        // empty right after the trash op — blanking the rest of the project
        // (the "empty, use +" state) until the app was reloaded.
        const treeState = deps.getWorkspaceTreeState();
        paths.forEach((path) => {
          const normalized = deps.normalizeWorkspacePath(path);
          if (typeof deps.removeWorkspaceTreeEntry === 'function') {
            deps.removeWorkspaceTreeEntry(normalized);
          }
          // Drop the deleted node and any descendant nodes so a stale path is
          // never re-listed by the background refresh.
          Array.from(treeState.keys()).forEach((key) => {
            if (key === normalized || key.startsWith(`${normalized}/`)) treeState.delete(key);
          });
        });
        deps.getWorkspaceNodeState('/').expanded = true;
        await deps.renderArtifacts();
      }
      if (failures.length > 0) {
        const preview = failures.slice(0, 2).join('\n');
        const suffix = failures.length > 2 ? `\n...and ${failures.length - 2} more.` : '';
        window.alert(`${preview}${suffix}`);
      }
    }

    // Busy state for the Run button: launching can take seconds (server boot,
    // browser open) — without it users click repeatedly and fire extra runs.
    // window flag so the renderer keeps the state across tree re-renders.
    function setRunAppBusy(busy) {
      window.aiexeRunAppBusy = Boolean(busy);
      document.querySelectorAll('.ws-root-run').forEach((btn) => {
        btn.classList.toggle('running', Boolean(busy));
        btn.setAttribute('data-tooltip', busy ? 'Starting the project...' : 'Run the project');
        if (busy) btn.setAttribute('aria-busy', 'true');
        else btn.removeAttribute('aria-busy');
      });
    }

    async function runWorkspaceApp() {
      deps.closeExplorerMenus();
      if (window.aiexeRunAppBusy) return; // a launch is already in flight
      if (!deps.ensureSignedIn()) return;
      if (!deps.nativeBridge.available()) {
        window.alert('Native runtime bridge unavailable.');
        return;
      }
      if (!deps.getWorkspaceRootName || !deps.getWorkspaceRootName()) {
        window.alert('Open a project first, then click Run to launch it.');
        return;
      }
      setRunAppBusy(true);
      try {
        // Serves the open project over http://127.0.0.1 and opens it in the browser.
        // file:// breaks ES modules, fetch(), and many APIs ("only the UI shows");
        // a real http origin makes the generated app actually work.
        const response = await deps.invokeWorkspaceAction('runWorkspaceApp', {});
        if (!response || !response.ok) {
          window.alert((response && response.message) || 'Failed to run the project.');
          return;
        }
        // Native run opens the app externally (Chrome/default browser for web
        // projects, terminal/cmd for servers). Keep the embedded artifact browser
        // out of the way so it remains reserved for adapter/account flows.
        if (typeof deps.setMiddleViewMode === 'function') deps.setMiddleViewMode('chat');
        if (typeof deps.renderMiddleView === 'function') deps.renderMiddleView();
        if (typeof deps.renderSidebarCounts === 'function') deps.renderSidebarCounts();
      } finally {
        setRunAppBusy(false);
      }
    }

    return {
      getWorkspaceCreateParentPath,
      startWorkspaceDraft,
      cancelWorkspaceDraft,
      cancelWorkspaceRenameDraft,
      commitWorkspaceDraft,
      startWorkspaceRenamePath,
      startWorkspaceRenameSelected,
      commitWorkspaceRenameDraft,
      getDroppedFileSystemEntries,
      uploadDroppedDataTransfer,
      parseDraggedWorkspacePaths,
      moveWorkspaceEntries,
      downloadWorkspaceFile,
      importWorkspacePickedFiles,
      importWorkspaceFiles,
      importWorkspacePickedFolderFiles,
      importWorkspaceFolder,
      revealWorkspaceInSystem,
      collapseAllFolders,
      openWorkspaceProject,
      closeWorkspaceProject,
      runWorkspaceApp,
      deleteSelectedWorkspaceItems,
    };
  }

  global.AIExeWorkspaceActions = {
    createWorkspaceActions,
  };
})(window);
