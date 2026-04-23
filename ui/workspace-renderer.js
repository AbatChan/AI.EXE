(function initAIExeWorkspaceRenderer(global) {
  function createWorkspaceRenderer(deps) {
    function updateWorkspaceHeaderUi() {
      const selectedPath = deps.getWorkspaceCurrentPath() === '/' ? '/' : deps.getWorkspaceCurrentPath();
      const hasOpenProject = Boolean(deps.getWorkspaceRootName && deps.getWorkspaceRootName());
      const selectedActionPaths = typeof deps.getSelectedWorkspacePathsForAction === 'function'
        ? deps.getSelectedWorkspacePathsForAction()
        : [];
      const deletablePaths = selectedActionPaths.filter((path) => deps.normalizeWorkspacePath(path) !== '/');

      if (deps.workspacePathLabel) {
        deps.workspacePathLabel.textContent = `Selected: ${selectedPath}`;
      }
      if (deps.workspaceBackBtn) {
        deps.workspaceBackBtn.style.display = deps.getWorkspaceCurrentPath() === '/' ? 'none' : 'inline-flex';
      }
      if (deps.expCloseProjectBtn) {
        deps.expCloseProjectBtn.disabled = !hasOpenProject;
        deps.expCloseProjectBtn.title = hasOpenProject
          ? 'Close the current open project'
          : 'No project is currently open';
      }
      if (deps.expDeleteSelectedBtn) {
        deps.expDeleteSelectedBtn.disabled = deletablePaths.length === 0;
        deps.expDeleteSelectedBtn.title = deletablePaths.length > 0
          ? 'Move the selected file(s) or folder(s) to Trash'
          : 'Select a file or folder inside the project to delete it';
      }
    }

    function updateFolderEmptyState(mode = 'default') {
      if (!deps.emptyFolder) return;
      deps.emptyFolder.classList.toggle('loading-skeleton', mode === 'loading');
      const buildBaseContent = (iconSvg, titleText, subText) => `
        <div class="ef-icon">
          <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            ${iconSvg}
          </svg>
        </div>
        <div class="ef-title">${titleText}</div>
        <div class="ef-sub">${subText}</div>
      `;

      if (!deps.currentAuthUser()) {
        deps.emptyFolder.innerHTML = buildBaseContent(
          '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>',
          'Sign In Required',
          'Log in to view your workspace files.<br>Each account has isolated storage.'
        );
        return;
      }
      if (!deps.nativeBridge.available()) {
        deps.emptyFolder.innerHTML = buildBaseContent(
          '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>',
          'Desktop Runtime Required',
          'Open AI.EXE desktop runtime to manage local files.'
        );
        return;
      }
      if (mode === 'loading') {
        deps.emptyFolder.innerHTML = `
          <div class="workspace-skeleton" aria-label="Loading workspace files">
            <div class="workspace-skeleton-row root">
              <span class="workspace-skeleton-chip"></span>
              <span class="workspace-skeleton-icon"></span>
              <span class="workspace-skeleton-line long"></span>
              <span class="workspace-skeleton-line meta"></span>
            </div>
            <div class="workspace-skeleton-row indent-1">
              <span class="workspace-skeleton-chip"></span>
              <span class="workspace-skeleton-icon"></span>
              <span class="workspace-skeleton-line medium"></span>
              <span class="workspace-skeleton-line meta short"></span>
            </div>
            <div class="workspace-skeleton-row indent-1">
              <span class="workspace-skeleton-chip"></span>
              <span class="workspace-skeleton-icon"></span>
              <span class="workspace-skeleton-line long"></span>
              <span class="workspace-skeleton-line meta"></span>
            </div>
            <div class="workspace-skeleton-row indent-2">
              <span class="workspace-skeleton-chip"></span>
              <span class="workspace-skeleton-icon"></span>
              <span class="workspace-skeleton-line medium"></span>
              <span class="workspace-skeleton-line meta short"></span>
            </div>
            <div class="workspace-skeleton-row indent-1">
              <span class="workspace-skeleton-chip"></span>
              <span class="workspace-skeleton-icon"></span>
              <span class="workspace-skeleton-line short"></span>
              <span class="workspace-skeleton-line meta"></span>
            </div>
          </div>
        `;
        return;
      }
      if (mode === 'error') {
        deps.emptyFolder.innerHTML = buildBaseContent(
          '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>',
          'Workspace Error',
          'Failed to load this folder. Try root or create a new folder.'
        );
        return;
      }
      if (mode === 'no-project') {
        deps.emptyFolder.innerHTML = `
          <div class="dash-grid">
            <div class="dash-card" onclick="openWorkspaceProject()">
              <div class="dash-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path></svg></div>
              <div class="dash-card-label">Open project</div>
              <div class="dash-card-desc">Browse and select a folder to get started</div>
            </div>
          </div>
        `;
        return;
      }

      if (deps.getWorkspaceCurrentPath() !== '/') {
        deps.emptyFolder.innerHTML = buildBaseContent(
          '<path d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H3z"></path><path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2"></path>',
          'Empty Folder',
          'Use the <b>+</b> buttons above to create a file or folder here.'
        );
        return;
      }

      deps.emptyFolder.innerHTML = buildBaseContent(
        '<path d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H3z"></path><path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2"></path>',
        'Empty Project',
        'Use the <b>+</b> buttons above to create your first file or folder.'
      );
    }

    function workspaceFileIconSvg(fileName = '') {
      const lower = String(fileName || '').toLowerCase();
      if (/\.(js|jsx|ts|tsx)$/.test(lower)) {
        return '<path d="M8 4h8l4 4v12H8z"></path><path d="M16 4v4h4"></path><path d="M10 16c.7 1 2.3 1 3 0"></path>';
      }
      if (/\.(json|ya?ml|toml|xml|ini)$/.test(lower)) {
        return '<path d="M8 4h8l4 4v12H8z"></path><path d="M16 4v4h4"></path><path d="M11 13h6"></path><path d="M11 16h6"></path>';
      }
      if (/\.(md|txt|rtf|docx?|pdf)$/.test(lower)) {
        return '<path d="M8 4h8l4 4v12H8z"></path><path d="M16 4v4h4"></path><path d="M11 13h6"></path>';
      }
      return '<path d="M8 4h8l4 4v12H8z"></path><path d="M16 4v4h4"></path>';
    }

    function buildWorkspaceDraftRow(parentPath, depth = 0) {
      const workspaceDraft = deps.getWorkspaceDraft();
      if (!workspaceDraft) return null;
      const parent = deps.normalizeWorkspacePath(parentPath);
      if (deps.normalizeWorkspacePath(workspaceDraft.parentPath) !== parent) return null;

      const row = document.createElement('div');
      row.className = `ws-row ws-draft ${workspaceDraft.kind}`;
      row.classList.add('selected');
      row.style.paddingLeft = `${6 + (depth * 6)}px`;
      row.title = parent === '/' ? '/' : parent;

      const spacer = document.createElement('span');
      spacer.className = 'ws-spacer';
      row.appendChild(spacer);

      const icon = document.createElement('span');
      icon.className = 'ws-icon';
      icon.innerHTML = workspaceDraft.kind === 'folder'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H3z"></path><path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2"></path></svg>'
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${workspaceFileIconSvg(workspaceDraft.name)}</svg>`;
      row.appendChild(icon);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ws-draft-input';
      input.value = workspaceDraft.name;
      input.spellcheck = false;
      row.appendChild(input);

      const draftId = workspaceDraft.id;
      let didAutoSelect = false;
      const autoSelectDraftName = () => {
        if (didAutoSelect) return;
        const latestDraft = deps.getWorkspaceDraft();
        if (!latestDraft || latestDraft.id !== draftId) return;
        if (!input.isConnected) return;
        didAutoSelect = true;
        input.focus();
        input.setSelectionRange(0, input.value.length);
      };
      const scheduleDraftAutoSelect = () => {
        const attempts = [0, 16, 48, 96];
        attempts.forEach((delay) => {
          window.setTimeout(() => {
            autoSelectDraftName();
          }, delay);
        });
      };
      if (deps.getWorkspaceDraftFocusId() === draftId) {
        scheduleDraftAutoSelect();
        deps.setWorkspaceDraftFocusId(0);
      }

      input.addEventListener('focus', () => {
        if (!didAutoSelect) {
          scheduleDraftAutoSelect();
        }
      });
      input.addEventListener('mouseup', (evt) => {
        if (!didAutoSelect) {
          evt.preventDefault();
          autoSelectDraftName();
        }
      });

      input.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter') {
          evt.preventDefault();
          void deps.commitWorkspaceDraft(input.value);
        } else if (evt.key === 'Escape') {
          evt.preventDefault();
          deps.cancelWorkspaceDraft();
        }
      });
      input.addEventListener('blur', () => {
        window.setTimeout(() => {
          const latestDraft = deps.getWorkspaceDraft();
          if (!latestDraft || latestDraft.id !== draftId) return;
          deps.cancelWorkspaceDraft();
        }, 80);
      });
      row.addEventListener('click', (evt) => {
        evt.stopPropagation();
        autoSelectDraftName();
      });

      return row;
    }

    function buildWorkspaceRow(entry, depth = 0) {
      const row = document.createElement('div');
      row.className = `ws-row ${entry.kind}`;
      row.style.paddingLeft = `${6 + (depth * 6)}px`;
      if (deps.getWorkspaceSelectedPaths().has(entry.path)) {
        row.classList.add('selected');
      }
      row.title = entry.path;

      if (entry.kind === 'folder') {
        const state = deps.getWorkspaceNodeState(entry.path);
        const chevron = document.createElement('button');
        chevron.type = 'button';
        chevron.className = `ws-chevron ${state.expanded ? 'expanded' : ''}`;
        chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"></polyline></svg>';
        chevron.addEventListener('click', async (evt) => {
          evt.stopPropagation();
          state.expanded = !state.expanded;
          if (state.expanded && !state.loaded) {
            await deps.loadWorkspaceChildren(entry.path);
          }
          void renderArtifacts();
        });
        row.appendChild(chevron);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'ws-spacer';
        row.appendChild(spacer);
      }

      const icon = document.createElement('span');
      icon.className = 'ws-icon';
      icon.innerHTML = entry.kind === 'folder'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H3z"></path><path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2"></path></svg>'
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${workspaceFileIconSvg(entry.name)}</svg>`;
      row.appendChild(icon);

      const workspaceRenameDraft = deps.getWorkspaceRenameDraft();
      const isRenaming = Boolean(workspaceRenameDraft && deps.normalizeWorkspacePath(workspaceRenameDraft.path) === entry.path);
      if (isRenaming) {
        const renameInput = document.createElement('input');
        renameInput.type = 'text';
        renameInput.className = 'ws-draft-input';
        renameInput.value = workspaceRenameDraft.name || entry.name;
        renameInput.spellcheck = false;
        row.appendChild(renameInput);

        const renameId = workspaceRenameDraft.id;
        if (deps.getWorkspaceRenameFocusId() === renameId) {
          queueMicrotask(() => {
            const latestDraft = deps.getWorkspaceRenameDraft();
            if (!latestDraft || latestDraft.id !== renameId) return;
            renameInput.focus();
            renameInput.select();
            deps.setWorkspaceRenameFocusId(0);
          });
        }

        renameInput.addEventListener('keydown', (evt) => {
          if (evt.key === 'Enter') {
            evt.preventDefault();
            void deps.commitWorkspaceRenameDraft(renameInput.value);
          } else if (evt.key === 'Escape') {
            evt.preventDefault();
            deps.cancelWorkspaceRenameDraft();
          }
        });
        renameInput.addEventListener('blur', () => {
          window.setTimeout(() => {
            const latestDraft = deps.getWorkspaceRenameDraft();
            if (!latestDraft || latestDraft.id !== renameId) return;
            deps.cancelWorkspaceRenameDraft();
          }, 80);
        });
        row.addEventListener('click', (evt) => {
          evt.stopPropagation();
          renameInput.focus();
        });
      } else {
        const label = document.createElement('span');
        label.className = 'ws-label';
        label.textContent = entry.name;
        row.appendChild(label);

        const meta = document.createElement('span');
        meta.className = 'ws-meta';
        meta.textContent = entry.kind === 'folder'
          ? `${Number(entry.childCount) || 0}`
          : (entry.size || '0 B');
        row.appendChild(meta);
      }

      row.addEventListener('click', async (evt) => {
        if (isRenaming) return;
        if (deps.getWorkspaceDraft()) {
          deps.setWorkspaceDraft(null);
          deps.setWorkspaceDraftFocusId(0);
        }
        if (deps.getWorkspaceRenameDraft() && deps.getWorkspaceRenameDraft().path !== entry.path) {
          deps.setWorkspaceRenameDraft(null);
          deps.setWorkspaceRenameFocusId(0);
        }
        if (evt.shiftKey) {
          const selectedPaths = deps.getWorkspaceSelectedPaths();
          const isAlreadySelected = selectedPaths.has(entry.path);
          const shouldRemove = isAlreadySelected && selectedPaths.size > 1;
          if (shouldRemove) {
            selectedPaths.delete(entry.path);
          } else {
            selectedPaths.add(entry.path);
          }
          deps.setWorkspaceSelection(entry.path, entry.kind, true, !shouldRemove);
        } else {
          deps.setWorkspaceSelection(entry.path, entry.kind);
        }
        if (entry.kind === 'folder') {
          const state = deps.getWorkspaceNodeState(entry.path);
          if (!state.loaded) {
            await deps.loadWorkspaceChildren(entry.path);
          }
        }
        if (entry.kind === 'file' && !evt.shiftKey) {
          await deps.openFileTab(entry.path, entry.name);
        }
        void renderArtifacts();
      });

      row.addEventListener('dblclick', async (evt) => {
        if (isRenaming) return;
        if (evt.target && evt.target.closest('.ws-chevron')) return;
        evt.preventDefault();
        evt.stopPropagation();
        await deps.startWorkspaceRenamePath(entry.path);
      });

      row.addEventListener('mousedown', (evt) => {
        if (evt.shiftKey) {
          evt.preventDefault();
        }
      });

      row.draggable = entry.path !== '/' && !isRenaming;
      row.addEventListener('dragstart', (evt) => {
        row.classList.add('dragging');
        if (evt.dataTransfer) {
          const selectedPaths = deps.getWorkspaceSelectedPaths();
          const dragPaths = selectedPaths.has(entry.path)
            ? deps.normalizeWorkspacePathList(Array.from(selectedPaths))
            : [entry.path];
          if (!selectedPaths.has(entry.path)) {
            deps.setWorkspaceSelection(entry.path, entry.kind);
          }
          evt.dataTransfer.effectAllowed = 'move';
          evt.dataTransfer.setData('application/x-aiexe-paths', JSON.stringify(dragPaths));
          evt.dataTransfer.setData('text/plain', entry.path);
        }
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        row.classList.remove('drop-target');
        deps.clearWorkspaceDragExpandTimers();
      });

      if (entry.kind === 'folder') {
        const ensureFolderAutoExpand = () => {
          const state = deps.getWorkspaceNodeState(entry.path);
          const timers = deps.getWorkspaceDragExpandTimers();
          if (state.expanded || timers.has(entry.path)) return;
          const timerId = window.setTimeout(() => {
            timers.delete(entry.path);
            const latest = deps.getWorkspaceNodeState(entry.path);
            if (latest.expanded) return;
            latest.expanded = true;
            void deps.loadWorkspaceChildren(entry.path).then(() => { void renderArtifacts(); });
          }, 220);
          timers.set(entry.path, timerId);
        };

        row.addEventListener('dragover', (evt) => {
          evt.preventDefault();
          row.classList.add('drop-target');
          ensureFolderAutoExpand();
        });
        row.addEventListener('dragenter', (evt) => {
          evt.preventDefault();
          row.classList.add('drop-target');
          ensureFolderAutoExpand();
        });
        row.addEventListener('dragleave', () => {
          row.classList.remove('drop-target');
        });
        row.addEventListener('drop', (evt) => {
          evt.preventDefault();
          row.classList.remove('drop-target');
          deps.clearWorkspaceDragExpandTimers();
          const droppedFiles = evt.dataTransfer && evt.dataTransfer.files ? Array.from(evt.dataTransfer.files) : [];
          const droppedEntries = deps.getDroppedFileSystemEntries(evt.dataTransfer);
          if (droppedFiles.length > 0 || droppedEntries.length > 0) {
            void deps.uploadDroppedDataTransfer(evt.dataTransfer, entry.path);
            return;
          }
          const sourcePaths = deps.parseDraggedWorkspacePaths(evt.dataTransfer);
          if (!sourcePaths.length) return;
          void deps.moveWorkspaceEntries(sourcePaths, entry.path);
        });
      }

      return row;
    }

    function buildWorkspaceChildrenTree(path, depth = 0) {
      const node = deps.getWorkspaceNodeState(path);
      const container = document.createElement('div');
      container.className = depth > 0 ? 'ws-children' : '';
      node.children.forEach((entry) => {
        container.appendChild(buildWorkspaceRow(entry, depth));
        if (entry.kind === 'folder') {
          const childNode = deps.getWorkspaceNodeState(entry.path);
          if (childNode.expanded) {
            if (!childNode.loaded && !childNode.loading) {
              void deps.loadWorkspaceChildren(entry.path).then(() => { void renderArtifacts(); });
            }
            if (childNode.loaded) {
              container.appendChild(buildWorkspaceChildrenTree(entry.path, depth + 1));
            } else if (childNode.loading) {
              const loading = document.createElement('div');
              loading.className = 'ws-loading';
              loading.style.paddingLeft = `${22 + ((depth + 1) * 6)}px`;
              loading.textContent = 'Loading...';
              container.appendChild(loading);
            } else if (childNode.error) {
              const err = document.createElement('div');
              err.className = 'ws-error';
              err.style.paddingLeft = `${22 + ((depth + 1) * 6)}px`;
              err.textContent = childNode.error;
              container.appendChild(err);
            }
          }
        }
      });
      const draftRow = buildWorkspaceDraftRow(path, depth);
      if (draftRow) container.appendChild(draftRow);
      return container;
    }

    async function renderArtifacts() {
      const token = deps.nextWorkspaceRenderToken();
      updateWorkspaceHeaderUi();
      if (!deps.folderArea) return;
      const existingTree = deps.folderArea.querySelector('.workspace-tree');
      if (!deps.currentAuthUser()) {
        deps.folderArea.querySelectorAll('.workspace-tree').forEach((el) => el.remove());
        updateFolderEmptyState();
        if (deps.emptyFolder) deps.emptyFolder.style.display = 'flex';
        return;
      }
      if (!deps.nativeBridge.available()) {
        deps.folderArea.querySelectorAll('.workspace-tree').forEach((el) => el.remove());
        updateFolderEmptyState();
        if (deps.emptyFolder) deps.emptyFolder.style.display = 'flex';
        return;
      }

      const selectedFolderPath = deps.getWorkspaceCurrentKind() === 'folder'
        ? deps.normalizeWorkspacePath(deps.getWorkspaceCurrentPath())
        : deps.parentWorkspacePath(deps.getWorkspaceCurrentPath());
      const hasNoProject = !deps.getWorkspaceRootName();
      if (hasNoProject) {
        deps.folderArea.querySelectorAll('.workspace-tree').forEach((el) => el.remove());
        updateFolderEmptyState('no-project');
        if (deps.emptyFolder) deps.emptyFolder.style.display = 'flex';
        return;
      }

      if (!existingTree) {
        updateFolderEmptyState('loading');
        if (deps.emptyFolder) deps.emptyFolder.style.display = 'flex';
      } else if (deps.emptyFolder) {
        deps.emptyFolder.style.display = 'none';
      }

      await deps.loadWorkspaceChildren('/', false);
      const selectedNode = deps.getWorkspaceNodeState(selectedFolderPath);
      if (selectedFolderPath !== '/' && !selectedNode.loaded && !selectedNode.loading) {
        await deps.loadWorkspaceChildren(selectedFolderPath, false);
      }
      if (token !== deps.getWorkspaceRenderToken()) return;
      if (selectedNode.error && selectedFolderPath !== '/') {
        deps.setWorkspaceSelection('/', 'folder');
        deps.folderArea.querySelectorAll('.workspace-tree').forEach((el) => el.remove());
        updateFolderEmptyState('error');
        if (deps.emptyFolder) deps.emptyFolder.style.display = 'flex';
        return;
      }
      deps.setWorkspaceItems(selectedNode.loaded ? selectedNode.children.slice() : []);

      const rootNode = deps.getWorkspaceNodeState('/');
      if (!rootNode.loaded && !rootNode.loading) {
        await deps.loadWorkspaceChildren('/', true);
      }
      if (token !== deps.getWorkspaceRenderToken()) return;

      if (deps.emptyFolder) deps.emptyFolder.style.display = 'none';
      deps.folderArea.querySelectorAll('.workspace-tree').forEach((el) => el.remove());

      const rootLabel = deps.getWorkspaceRootName() || 'Workspace';
      const tree = document.createElement('div');
      tree.className = 'workspace-tree';

      const rootRow = document.createElement('div');
      rootRow.className = 'ws-row folder ws-root-row';
      if (deps.getWorkspaceSelectedPaths().has('/')) rootRow.classList.add('selected');
      rootRow.innerHTML = `
          <button type="button" class="ws-chevron expanded">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"></polyline></svg>
          </button>
          <span class="ws-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H3z"></path><path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2"></path></svg></span>
          <span class="ws-label" title="${rootLabel}">${rootLabel}</span>
        `;
      const rootChev = rootRow.querySelector('.ws-chevron');
      if (rootChev) {
        if (!rootNode.expanded) rootChev.classList.remove('expanded');
        rootChev.addEventListener('click', (evt) => {
          evt.stopPropagation();
          rootNode.expanded = !rootNode.expanded;
          void renderArtifacts();
        });
      }
      rootRow.addEventListener('click', (evt) => {
        if (deps.getWorkspaceDraft()) {
          deps.setWorkspaceDraft(null);
          deps.setWorkspaceDraftFocusId(0);
        }
        if (deps.getWorkspaceRenameDraft()) {
          deps.setWorkspaceRenameDraft(null);
          deps.setWorkspaceRenameFocusId(0);
        }
        if (evt.shiftKey) {
          deps.getWorkspaceSelectedPaths().add('/');
          deps.setWorkspaceSelection('/', 'folder', true);
        } else {
          deps.setWorkspaceSelection('/', 'folder');
        }
        void renderArtifacts();
      });
      rootRow.addEventListener('dragover', (evt) => {
        evt.preventDefault();
        rootRow.classList.add('drop-target');
      });
      rootRow.addEventListener('dragleave', () => {
        rootRow.classList.remove('drop-target');
      });
      rootRow.addEventListener('drop', (evt) => {
        evt.preventDefault();
        rootRow.classList.remove('drop-target');
        deps.clearWorkspaceDragExpandTimers();
        const droppedFiles = evt.dataTransfer && evt.dataTransfer.files ? Array.from(evt.dataTransfer.files) : [];
        const droppedEntries = deps.getDroppedFileSystemEntries(evt.dataTransfer);
        if (droppedFiles.length > 0 || droppedEntries.length > 0) {
          void deps.uploadDroppedDataTransfer(evt.dataTransfer, '/');
          return;
        }
        const sourcePaths = deps.parseDraggedWorkspacePaths(evt.dataTransfer);
        if (!sourcePaths.length) return;
        void deps.moveWorkspaceEntries(sourcePaths, '/');
      });
      tree.appendChild(rootRow);

      if (rootNode.expanded) {
        const childTree = buildWorkspaceChildrenTree('/', 1);
        tree.appendChild(childTree);
        if (!rootNode.children.length && !deps.getWorkspaceDraft()) {
          const hintRow = document.createElement('div');
          hintRow.className = 'ws-empty-hint';
          hintRow.style.paddingLeft = '24px';
          hintRow.style.opacity = '0.5';
          hintRow.style.fontSize = '0.82em';
          hintRow.style.padding = '4px 8px 4px 24px';
          hintRow.textContent = 'Empty — use + buttons above to add files';
          tree.appendChild(hintRow);
        }
      }
      deps.folderArea.appendChild(tree);
    }

    return {
      updateWorkspaceHeaderUi,
      renderArtifacts,
    };
  }

  global.AIExeWorkspaceRenderer = {
    createWorkspaceRenderer,
  };
})(window);
