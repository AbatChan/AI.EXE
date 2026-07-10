(function () {
  function createFileViewer(deps) {
    const d = deps || {};
    const normalizeWorkspacePath = d.normalizeWorkspacePath || ((value) => String(value || ''));
    const workspaceBaseName = d.workspaceBaseName || ((value) => String(value || '').split('/').filter(Boolean).pop() || 'file');
    const normalizeCodeLanguage = d.normalizeCodeLanguage || ((value) => String(value || '').trim().toLowerCase());
    const highlightCodeHtml = d.highlightCodeHtml || ((code) => String(code || ''));

    function getOpenFileTabs() {
      return typeof d.getOpenFileTabs === 'function' ? d.getOpenFileTabs() : [];
    }

    function setOpenFileTabs(next) {
      if (typeof d.setOpenFileTabs === 'function') d.setOpenFileTabs(next);
    }

    function getActiveTabId() {
      return typeof d.getActiveTabId === 'function' ? d.getActiveTabId() : 'chat';
    }

    function setActiveTabId(next) {
      if (typeof d.setActiveTabId === 'function') d.setActiveTabId(next);
    }

    function getFileTabsPersistTimer() {
      return typeof d.getFileTabsPersistTimer === 'function' ? d.getFileTabsPersistTimer() : 0;
    }

    function setFileTabsPersistTimer(next) {
      if (typeof d.setFileTabsPersistTimer === 'function') d.setFileTabsPersistTimer(next);
    }

    function getFileTabsRestoreToken() {
      return typeof d.getFileTabsRestoreToken === 'function' ? d.getFileTabsRestoreToken() : 0;
    }

    function getFileViewerSearchState() {
      return typeof d.getFileViewerSearchState === 'function'
        ? d.getFileViewerSearchState()
        : { query: '', matches: [], index: -1 };
    }

    function setFileViewerSearchState(next) {
      if (typeof d.setFileViewerSearchState === 'function') d.setFileViewerSearchState(next);
    }

    function getFileViewerCodeMirror() {
      return typeof d.getFileViewerCodeMirror === 'function' ? d.getFileViewerCodeMirror() : null;
    }

    function setFileViewerCodeMirror(next) {
      if (typeof d.setFileViewerCodeMirror === 'function') d.setFileViewerCodeMirror(next || null);
    }

    function getSuppressFileViewerEditorChange() {
      return typeof d.getSuppressFileViewerEditorChange === 'function' ? d.getSuppressFileViewerEditorChange() : false;
    }

    function setSuppressFileViewerEditorChange(next) {
      if (typeof d.setSuppressFileViewerEditorChange === 'function') d.setSuppressFileViewerEditorChange(Boolean(next));
    }

    function getFileViewerCodeMirrorReady() {
      return typeof d.getFileViewerCodeMirrorReady === 'function' ? d.getFileViewerCodeMirrorReady() : null;
    }

    function setFileViewerCodeMirrorReady(next) {
      if (typeof d.setFileViewerCodeMirrorReady === 'function') d.setFileViewerCodeMirrorReady(next || null);
    }

    function getOpenFileTab(path) {
      const normalized = normalizeWorkspacePath(path || '');
      return getOpenFileTabs().find((t) => t.path === normalized) || null;
    }

    function getActiveFileTab() {
      const activeTabId = getActiveTabId();
      if (!activeTabId || activeTabId === 'chat') return null;
      return getOpenFileTabs().find((t) => t.path === activeTabId) || null;
    }

    function formatFileViewerBreadcrumb(path) {
      const normalized = normalizeWorkspacePath(path || '');
      const parts = normalized.split('/').filter(Boolean);
      if (parts.length === 0) return 'file';
      if (parts.length === 1) return parts[0];
      return `${parts[parts.length - 2]} > ${parts[parts.length - 1]}`;
    }

    function inferFileViewerLanguage(path) {
      const normalized = normalizeWorkspacePath(path || '');
      const name = workspaceBaseName(normalized).toLowerCase();
      const ext = name.includes('.') ? name.split('.').pop() : '';
      const map = {
        js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', jsx: 'jsx', tsx: 'tsx',
        py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', html: 'html', htm: 'html',
        xml: 'xml', css: 'css', scss: 'scss', less: 'less', yml: 'yaml', yaml: 'yaml', md: 'markdown',
        java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
        go: 'go', rs: 'rust', php: 'php', rb: 'ruby', sql: 'sql',
      };
      return normalizeCodeLanguage(map[ext] || ext || 'text') || 'text';
    }

    function renderFileViewerHighlight(text, lang) {
      const codeEl = d.getFileViewerHighlightCode ? d.getFileViewerHighlightCode() : null;
      if (!codeEl) return;
      const content = String(text || '');
      const safe = content.endsWith('\n') ? `${content}\u200b` : content;
      codeEl.innerHTML = highlightCodeHtml(safe, lang || 'text');
    }

    function loadFileViewerCodeMirrorBundle() {
      if (window.AIExeCodeMirror && typeof window.AIExeCodeMirror.createFileEditor === 'function') {
        return Promise.resolve(window.AIExeCodeMirror);
      }
      const existingReady = getFileViewerCodeMirrorReady();
      if (existingReady) return existingReady;
      const promise = new Promise((resolve) => {
        const existing = document.querySelector('script[data-codemirror-bundle="true"]');
        if (existing) {
          existing.addEventListener('load', () => resolve(window.AIExeCodeMirror || null), { once: true });
          existing.addEventListener('error', () => resolve(null), { once: true });
          return;
        }
        const script = document.createElement('script');
        script.src = 'vendor/codemirror/file-editor.bundle.js';
        script.async = false;
        script.dataset.codemirrorBundle = 'true';
        script.addEventListener('load', () => resolve(window.AIExeCodeMirror || null), { once: true });
        script.addEventListener('error', () => resolve(null), { once: true });
        document.head.appendChild(script);
      });
      setFileViewerCodeMirrorReady(promise);
      return promise;
    }

    async function ensureCodeMirrorFileEditor() {
      const current = getFileViewerCodeMirror();
      const host = d.getFileViewerCmHost ? d.getFileViewerCmHost() : null;
      if (current || !host) return current;
      const mod = await loadFileViewerCodeMirrorBundle();
      if (!mod || typeof mod.createFileEditor !== 'function') return null;
      const editor = mod.createFileEditor(host, {
        value: '',
        language: 'text',
        onChange: (value) => {
          if (getSuppressFileViewerEditorChange()) return;
          setActiveFileTabContent(value);
        },
        onSave: () => {
          void saveFileTab();
        },
      });
      setFileViewerCodeMirror(editor);
      return editor;
    }

    function renderFileViewerLineNumbers(text) {
      const gutter = d.getFileViewerGutterLines ? d.getFileViewerGutterLines() : null;
      if (!gutter) return;
      const content = String(text || '');
      const lineCount = Math.max(1, content.split('\n').length);
      const lines = new Array(lineCount);
      for (let i = 0; i < lineCount; i += 1) {
        lines[i] = `<span class="file-viewer-gutter-line" data-line="${i + 1}">${i + 1}</span>`;
      }
      gutter.innerHTML = lines.join('');
    }

    function findLineBounds(text, lineNumber) {
      const content = String(text || '');
      const targetLine = Math.max(1, Number(lineNumber) || 1);
      let currentLine = 1;
      let start = 0;
      for (let i = 0; i < content.length; i += 1) {
        if (currentLine === targetLine) {
          start = i;
          break;
        }
        if (content.charCodeAt(i) === 10) currentLine += 1;
      }
      if (targetLine > 1 && currentLine < targetLine) start = content.length;
      let end = content.indexOf('\n', start);
      if (end === -1) end = content.length;
      return { start, end };
    }

    function getFileViewerActiveLineInfo() {
      const editor = d.getFileViewerEditor ? d.getFileViewerEditor() : null;
      const topPadding = Number(d.fileViewerLineTopPadding) || 0;
      if (!editor) return { lineNumber: 1, lineHeight: 20.8, lineTop: topPadding };
      const value = String(editor.value || '');
      const cursor = Number(editor.selectionStart || 0);
      const before = value.slice(0, cursor);
      const lineNumber = before.split('\n').length;
      const lineHeight = parseFloat(getComputedStyle(editor).lineHeight || '20.8');
      const lineTop = topPadding + ((lineNumber - 1) * lineHeight) - editor.scrollTop;
      return { lineNumber, lineHeight, lineTop };
    }

    function updateFileViewerCurrentLine() {
      const editor = d.getFileViewerEditor ? d.getFileViewerEditor() : null;
      const currentLine = d.getFileViewerCurrentLine ? d.getFileViewerCurrentLine() : null;
      if (!editor || !currentLine) return;
      const gutter = d.getFileViewerGutterLines ? d.getFileViewerGutterLines() : null;
      const { lineNumber, lineTop } = getFileViewerActiveLineInfo();
      currentLine.style.transform = `translateY(${lineTop}px)`;
      if (gutter) {
        gutter.querySelectorAll('.file-viewer-gutter-line.active').forEach((el) => el.classList.remove('active'));
        const activeLine = gutter.querySelector(`.file-viewer-gutter-line[data-line="${lineNumber}"]`);
        if (activeLine) activeLine.classList.add('active');
      }
    }

    function revealFileViewerSelection(start) {
      const editor = d.getFileViewerEditor ? d.getFileViewerEditor() : null;
      const topPadding = Number(d.fileViewerLineTopPadding) || 0;
      if (!editor) return;
      const value = String(editor.value || '');
      const lineHeight = parseFloat(getComputedStyle(editor).lineHeight || '20.8');
      const before = value.slice(0, Math.max(0, Number(start) || 0));
      const lineNumber = before.split('\n').length;
      const targetTop = topPadding + ((lineNumber - 1) * lineHeight);
      const centeredTop = Math.max(0, targetTop - ((editor.clientHeight - lineHeight) / 2));
      editor.scrollTop = centeredTop;
      syncFileViewerScroll();
    }

    function selectFileViewerLine(lineNumber, options = {}) {
      // The visible editor is CodeMirror (the textarea is the hidden input layer,
      // clientHeight 0), so scroll the CM view. Returns false if CM isn't ready yet
      // so the caller can retry once the editor finishes mounting.
      const cm = getFileViewerCodeMirror();
      if (cm && typeof cm.highlightRange === 'function') {
        const start = Math.max(0, Number(lineNumber) || 0);
        if (start <= 0) {
          if (typeof cm.clearHighlight === 'function') cm.clearHighlight();
        } else {
          cm.highlightRange(start, Number(options.endLine) || start, options.kind || 'read');
        }
        return true;
      }
      const editor = d.getFileViewerEditor ? d.getFileViewerEditor() : null;
      if (!editor) return false;
      const focusEditor = options.focusEditor !== false;
      const revealSelection = options.reveal !== false;
      const { start, end } = findLineBounds(editor.value, lineNumber);
      editor.selectionStart = start;
      editor.selectionEnd = end;
      if (typeof editor.setSelectionRange === 'function') editor.setSelectionRange(start, end);
      if (revealSelection) revealFileViewerSelection(start); else updateFileViewerCurrentLine();
      if (focusEditor) editor.focus();
      return editor.clientHeight > 0;
    }

    function resetFileViewerSearchState() {
      setFileViewerSearchState({ query: '', matches: [], index: -1 });
      const count = d.getFileViewerSearchCount ? d.getFileViewerSearchCount() : null;
      if (count) count.textContent = '';
    }

    function collectFileViewerSearchMatches(query) {
      const editor = d.getFileViewerEditor ? d.getFileViewerEditor() : null;
      const content = String(editor && editor.value || '');
      const needle = String(query || '');
      if (!needle) return [];
      const lowerHaystack = content.toLowerCase();
      const lowerNeedle = needle.toLowerCase();
      const matches = [];
      let start = 0;
      while (start <= lowerHaystack.length) {
        const idx = lowerHaystack.indexOf(lowerNeedle, start);
        if (idx === -1) break;
        matches.push({ start: idx, end: idx + needle.length });
        start = idx + Math.max(1, needle.length);
      }
      return matches;
    }

    function applyFileViewerSearchSelection(index, options = {}) {
      const editor = d.getFileViewerEditor ? d.getFileViewerEditor() : null;
      const count = d.getFileViewerSearchCount ? d.getFileViewerSearchCount() : null;
      if (!editor) return;
      const state = getFileViewerSearchState();
      if (!state.matches.length) {
        if (count) count.textContent = '0/0';
        return;
      }
      const keepSearchFocus = Boolean(options.keepSearchFocus);
      const nextIndex = ((index % state.matches.length) + state.matches.length) % state.matches.length;
      state.index = nextIndex;
      setFileViewerSearchState(state);
      const match = state.matches[nextIndex];
      selectFileViewerLine(String(editor.value || '').slice(0, match.start).split('\n').length, { focusEditor: !keepSearchFocus, reveal: true });
      editor.selectionStart = match.start;
      editor.selectionEnd = match.end;
      if (typeof editor.setSelectionRange === 'function') editor.setSelectionRange(match.start, match.end);
      updateFileViewerCurrentLine();
      if (!keepSearchFocus) editor.focus();
      if (count) count.textContent = `${nextIndex + 1}/${state.matches.length}`;
    }

    function updateFileViewerSearch() {
      const input = d.getFileViewerSearchInput ? d.getFileViewerSearchInput() : null;
      const count = d.getFileViewerSearchCount ? d.getFileViewerSearchCount() : null;
      if (!input) return;
      const query = String(input.value || '');
      const nextState = {
        query,
        matches: collectFileViewerSearchMatches(query),
        index: -1,
      };
      setFileViewerSearchState(nextState);
      if (!query) {
        if (count) count.textContent = '';
        return;
      }
      applyFileViewerSearchSelection(0, { keepSearchFocus: true });
    }

    function setFileViewerSearchOpen(open) {
      const search = d.getFileViewerSearch ? d.getFileViewerSearch() : null;
      const input = d.getFileViewerSearchInput ? d.getFileViewerSearchInput() : null;
      if (!search) return;
      const next = Boolean(open);
      search.classList.toggle('hidden', !next);
      if (!next) {
        resetFileViewerSearchState();
        if (input) input.value = '';
        return;
      }
      if (input) {
        input.focus();
        input.select();
      }
    }

    function syncFileViewerScroll() {
      const editor = d.getFileViewerEditor ? d.getFileViewerEditor() : null;
      const highlight = d.getFileViewerHighlight ? d.getFileViewerHighlight() : null;
      const gutter = d.getFileViewerGutterLines ? d.getFileViewerGutterLines() : null;
      if (!editor) return;
      if (highlight) {
        highlight.scrollTop = editor.scrollTop;
        highlight.scrollLeft = editor.scrollLeft;
      }
      if (gutter) gutter.style.transform = `translateY(${-editor.scrollTop}px)`;
      updateFileViewerCurrentLine();
    }

    function refreshActiveFileTabView() {
      const tab = getActiveFileTab();
      const fvFilename = d.getFileViewerFilename ? d.getFileViewerFilename() : null;
      const surface = d.getFileViewerSurface ? d.getFileViewerSurface() : null;
      const editor = d.getFileViewerEditor ? d.getFileViewerEditor() : null;
      const search = d.getFileViewerSearch ? d.getFileViewerSearch() : null;
      const codeEl = d.getFileViewerHighlightCode ? d.getFileViewerHighlightCode() : null;
      if (!tab) return;
      tab.dirty = String(tab.content || '') !== String(tab.savedContent || '');
      if (fvFilename) {
        fvFilename.textContent = `${formatFileViewerBreadcrumb(tab.path || tab.name || 'file')}${tab.deletedOnDisk ? ' (deleted)' : ''}`;
      }
      void ensureCodeMirrorFileEditor().then((cm) => {
        if (!cm || getActiveFileTab() !== tab) return;
        if (surface) surface.classList.add('cm-active');
        setSuppressFileViewerEditorChange(true);
        cm.setLanguage(tab.language || inferFileViewerLanguage(tab.path));
        cm.setValue(tab.content || '');
        setSuppressFileViewerEditorChange(false);
      });
      // CodeMirror virtualizes + highlights itself. When it's the renderer, skip the
      // legacy full-file highlight overlay + manual line-numbers entirely — rendering
      // them into hidden DOM is the main lag on large files.
      const cmRenders = !!window.AIExeCodeMirror;
      if (cmRenders && surface) surface.classList.add('cm-active');
      if (!cmRenders) {
        if (surface) surface.classList.toggle('no-highlight', !tab.highlightEnabled);
        if (editor && editor.value !== String(tab.content || '')) editor.value = String(tab.content || '');
        renderFileViewerLineNumbers(tab.content || '');
        if (tab.highlightEnabled) {
          renderFileViewerHighlight(tab.content || '', tab.language || inferFileViewerLanguage(tab.path));
        } else if (codeEl) {
          codeEl.textContent = '';
        }
        syncFileViewerScroll();
      }
      resetFileViewerSearchState();
      const state = getFileViewerSearchState();
      if (search && !search.classList.contains('hidden') && state.query) updateFileViewerSearch();
    }

    function setActiveFileTabContent(value) {
      const tab = getActiveFileTab();
      const cm = getFileViewerCodeMirror();
      const search = d.getFileViewerSearch ? d.getFileViewerSearch() : null;
      if (!tab) return;
      tab.content = String(value || '');
      tab.dirty = tab.content !== String(tab.savedContent || '');
      if (cm && cm.getValue() !== tab.content) {
        setSuppressFileViewerEditorChange(true);
        cm.setValue(tab.content);
        setSuppressFileViewerEditorChange(false);
      }
      if (!window.AIExeCodeMirror) {
        renderFileViewerLineNumbers(tab.content);
        if (tab.highlightEnabled) renderFileViewerHighlight(tab.content, tab.language || inferFileViewerLanguage(tab.path));
      }
      renderTabBar();
      syncFileViewerScroll();
      if (search && !search.classList.contains('hidden') && getFileViewerSearchState().query) updateFileViewerSearch();
      schedulePersistFileTabsState();
    }

    async function saveFileTab(tab) {
      const target = tab || getActiveFileTab();
      if (!target || !target.path) return false;
      const response = await d.invokeWorkspaceAction('workspaceWriteFile', {
        path: target.path,
        content: String(target.content || ''),
      });
      if (!response || !response.ok) {
        window.alert((response && response.message) || 'Failed to save file.');
        return false;
      }
      target.savedContent = String(target.content || '');
      target.dirty = false;
      target.deletedOnDisk = false;
      renderTabBar();
      if (getActiveTabId() === target.path) refreshActiveFileTabView();
      persistFileTabsStateNow();
      return true;
    }

    function serializeFileTabState() {
      return getOpenFileTabs().slice(0, 12).map((tab) => {
        const content = String(tab && tab.content || '');
        const savedContent = String(tab && tab.savedContent || '');
        const dirty = content !== savedContent;
        return {
          path: normalizeWorkspacePath(tab && tab.path || ''),
          name: String(tab && tab.name || workspaceBaseName(tab && tab.path || '') || 'file'),
          language: inferFileViewerLanguage(tab && tab.path || ''),
          dirty,
          content: dirty ? content : '',
          savedContent: dirty ? savedContent : '',
        };
      }).filter((tab) => Boolean(tab.path && tab.path !== '/'));
    }

    function persistFileTabsStateNow() {
      const timer = getFileTabsPersistTimer();
      if (timer) {
        clearTimeout(timer);
        setFileTabsPersistTimer(0);
      }
      const key = d.scopedStorageKey(d.fileTabsStoragePrefix);
      if (!key) return;
      const activeTabId = getActiveTabId();
      const payload = {
        activeTabId: activeTabId === 'chat' ? 'chat' : normalizeWorkspacePath(activeTabId),
        tabs: serializeFileTabState(),
      };
      try {
        localStorage.setItem(key, JSON.stringify(payload));
      } catch (_) { }
    }

    function schedulePersistFileTabsState(delay = 160) {
      const timer = getFileTabsPersistTimer();
      if (timer) clearTimeout(timer);
      setFileTabsPersistTimer(setTimeout(() => {
        setFileTabsPersistTimer(0);
        persistFileTabsStateNow();
      }, Math.max(0, Number(delay) || 0)));
    }

    async function loadStoredFileTabs(restoreToken = 0) {
      setOpenFileTabs([]);
      setActiveTabId('chat');
      const key = d.scopedStorageKey(d.fileTabsStoragePrefix);
      if (!key) {
        renderTabBar();
        return;
      }
      let storedActive = 'chat';
      let storedTabs = [];
      try {
        const raw = localStorage.getItem(key);
        if (!raw) {
          renderTabBar();
          return;
        }
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.activeTabId === 'string') storedActive = parsed.activeTabId;
          if (Array.isArray(parsed.tabs)) storedTabs = parsed.tabs.slice(0, 12);
        }
      } catch (_) {
        renderTabBar();
        return;
      }
      const restoredTabs = [];
      for (const entry of storedTabs) {
        const path = normalizeWorkspacePath(entry && entry.path || '');
        if (!path || path === '/') continue;
        let content = '';
        let savedContent = '';
        let dirty = false;
        if (entry && entry.dirty && typeof entry.content === 'string') {
          content = String(entry.content || '');
          savedContent = typeof entry.savedContent === 'string' ? String(entry.savedContent) : content;
          dirty = content !== savedContent;
        } else {
          const response = await d.invokeWorkspaceAction('workspaceReadFile', { path });
          if (!response || !response.ok) continue;
          content = String(response.output || '');
          savedContent = content;
          dirty = false;
        }
        if (restoreToken !== getFileTabsRestoreToken()) return;
        restoredTabs.push({
          path,
          name: String(entry && entry.name || workspaceBaseName(path) || 'file'),
          content,
          savedContent,
          dirty,
          language: inferFileViewerLanguage(path),
          highlightEnabled: new Blob([content]).size <= Number(d.fileViewerHighlightLimitBytes || 0),
        });
      }
      if (restoreToken !== getFileTabsRestoreToken()) return;
      setOpenFileTabs(restoredTabs);
      if (storedActive === 'chat') {
        setActiveTabId('chat');
      } else if (restoredTabs.some((tab) => tab.path === storedActive)) {
        setActiveTabId(storedActive);
      } else {
        setActiveTabId(restoredTabs[0]?.path || 'chat');
      }
      renderTabBar();
      if (getActiveTabId() === 'chat') {
        const chatArea = d.getChatArea ? d.getChatArea() : null;
        const fileViewer = d.getFileViewer ? d.getFileViewer() : null;
        if (chatArea) chatArea.style.display = 'flex';
        if (fileViewer) fileViewer.classList.add('hidden');
        if (typeof d.renderMiddleView === 'function') d.renderMiddleView();
      } else {
        switchToTab(getActiveTabId());
      }
    }

    function renderTabBar() {
      const middleTabBar = d.getMiddleTabBar ? d.getMiddleTabBar() : null;
      const tabChatEl = d.getTabChatEl ? d.getTabChatEl() : null;
      if (!middleTabBar) return;
      middleTabBar.querySelectorAll('.middle-tab[data-tab]:not(#tabChat)').forEach((el) => el.remove());
      if (tabChatEl) {
        tabChatEl.classList.toggle('active', getActiveTabId() === 'chat');
        tabChatEl.onclick = () => switchToTab('chat');
      }
      getOpenFileTabs().forEach((tab) => {
        const el = document.createElement('div');
        el.className = `middle-tab${getActiveTabId() === tab.path ? ' active' : ''}${tab.dirty ? ' dirty' : ''}${tab.deletedOnDisk ? ' deleted' : ''}`;
        el.dataset.tab = tab.path;
        el.title = tab.deletedOnDisk
          ? `${tab.path}\nDeleted on disk. Save to recreate it, or close the tab.`
          : tab.path;
        const label = document.createElement('span');
        label.className = 'middle-tab-label';
        label.textContent = tab.name || 'file';
        el.appendChild(label);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'middle-tab-close';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close tab';
        closeBtn.onclick = (evt) => {
          evt.stopPropagation();
          closeFileTab(tab.path);
        };
        el.appendChild(closeBtn);
        el.onclick = () => switchToTab(tab.path);
        el.addEventListener('auxclick', (evt) => {
          if (evt.button === 1) {
            evt.preventDefault();
            closeFileTab(tab.path);
          }
        });
        middleTabBar.appendChild(el);
      });
      if (typeof d.syncWorkspaceTabStrip === 'function') d.syncWorkspaceTabStrip();
    }

    function syncFileTabFromWorkspaceWrite(path, content, name = '', options = {}) {
      const normalized = normalizeWorkspacePath(path);
      if (!normalized || normalized === '/') return;
      const nextContent = String(content || '');
      const openIfMissing = Boolean(options && options.openIfMissing);
      const activate = Boolean(options && options.activate);
      const tabs = getOpenFileTabs();
      let tab = tabs.find((entry) => entry.path === normalized) || null;
      if (!tab) {
        if (!openIfMissing) return;
        tab = {
          path: normalized,
          name: String(name || workspaceBaseName(normalized) || 'file'),
          content: nextContent,
          savedContent: nextContent,
          dirty: false,
          language: inferFileViewerLanguage(normalized),
          highlightEnabled: new Blob([nextContent]).size <= Number(d.fileViewerHighlightLimitBytes || 0),
        };
        tabs.push(tab);
      } else {
        tab.name = String(name || tab.name || workspaceBaseName(normalized) || 'file');
        if (tab.dirty) {
          renderTabBar();
          return;
        }
        tab.content = nextContent;
        tab.savedContent = nextContent;
        tab.dirty = false;
        tab.deletedOnDisk = false;
        tab.language = inferFileViewerLanguage(normalized);
        tab.highlightEnabled = new Blob([nextContent]).size <= Number(d.fileViewerHighlightLimitBytes || 0);
      }
      persistFileTabsStateNow();
      renderTabBar();
      if (activate) {
        if (typeof d.setMiddleViewMode === 'function') d.setMiddleViewMode('chat');
        switchToTab(normalized);
      } else if (getActiveTabId() === normalized) {
        refreshActiveFileTabView();
      }
    }

    async function refreshOpenFileTabsFromWorkspace() {
      const tabs = getOpenFileTabs();
      if (!Array.isArray(tabs) || !tabs.length || typeof d.invokeWorkspaceAction !== 'function') return;
      let changed = false;
      const nextTabs = [];
      for (const tab of tabs) {
        if (!tab || !tab.path) continue;
        const normalized = normalizeWorkspacePath(tab.path);
        if (!normalized || normalized === '/') continue;
        let response = null;
        try {
          response = await d.invokeWorkspaceAction('workspaceReadFile', { path: normalized });
        } catch (_) {
          response = null;
        }
        if (!response || !response.ok) {
          if (tab.dirty) {
            if (!tab.deletedOnDisk) {
              tab.deletedOnDisk = true;
              changed = true;
            }
            nextTabs.push(tab);
          } else {
            changed = true;
            if (getActiveTabId() === normalized) setActiveTabId('chat');
          }
          continue;
        }
        const content = String(response.output || '');
        if (tab.deletedOnDisk) {
          tab.deletedOnDisk = false;
          changed = true;
        }
        if (!tab.dirty && content !== String(tab.content || '')) {
          tab.content = content;
          tab.savedContent = content;
          tab.language = inferFileViewerLanguage(normalized);
          tab.highlightEnabled = new Blob([content]).size <= Number(d.fileViewerHighlightLimitBytes || 0);
          changed = true;
        }
        nextTabs.push(tab);
      }
      if (nextTabs.length !== tabs.length) changed = true;
      if (!changed) return;
      setOpenFileTabs(nextTabs);
      if (getActiveTabId() !== 'chat' && !nextTabs.some((tab) => tab.path === getActiveTabId())) {
        setActiveTabId('chat');
      }
      persistFileTabsStateNow();
      renderTabBar();
      if (getActiveTabId() === 'chat') {
        if (typeof d.renderMiddleView === 'function') d.renderMiddleView();
      } else {
        refreshActiveFileTabView();
      }
    }

    function switchToTab(tabId) {
      const chatArea = d.getChatArea ? d.getChatArea() : null;
      const fileViewer = d.getFileViewer ? d.getFileViewer() : null;
      const artifactBrowser = d.getArtifactBrowser ? d.getArtifactBrowser() : null;
      setActiveTabId(tabId);
      if (tabId === 'chat') {
        if (chatArea) chatArea.style.display = 'flex';
        if (fileViewer) fileViewer.classList.add('hidden');
      } else {
        if (chatArea) chatArea.style.display = 'none';
        if (artifactBrowser) artifactBrowser.classList.add('hidden');
        const tab = getOpenFileTabs().find((t) => t.path === tabId);
        if (tab && fileViewer) {
          fileViewer.classList.remove('hidden');
          refreshActiveFileTabView();
        }
      }
      renderTabBar();
      persistFileTabsStateNow();
      if (tabId === 'chat' && typeof d.renderMiddleView === 'function') d.renderMiddleView();
    }

    async function openFileTab(path, name) {
      const normalized = normalizeWorkspacePath(path);
      if (!normalized || normalized === '/') return;
      const tabs = getOpenFileTabs();
      const existing = tabs.find((t) => t.path === normalized);
      if (existing) {
        switchToTab(normalized);
        return;
      }
      const response = await d.invokeWorkspaceAction('workspaceReadFile', { path: normalized });
      if (!response || !response.ok) {
        window.alert((response && response.message) || 'Failed to read file.');
        return;
      }
      const content = String(response.output || '');
      // One file at a time: opening replaces the current tab (dirty tabs are
      // kept so unsaved edits are never silently dropped).
      for (let i = tabs.length - 1; i >= 0; i -= 1) {
        if (!tabs[i].dirty) tabs.splice(i, 1);
      }
      tabs.push({
        path: normalized,
        name: name || workspaceBaseName(normalized) || 'file',
        content,
        savedContent: content,
        dirty: false,
        language: inferFileViewerLanguage(normalized),
        highlightEnabled: new Blob([content]).size <= Number(d.fileViewerHighlightLimitBytes || 0),
      });
      if (typeof d.setMiddleViewMode === 'function') d.setMiddleViewMode('chat');
      persistFileTabsStateNow();
      switchToTab(normalized);
    }

    function closeFileTab(path) {
      const tabs = getOpenFileTabs();
      const idx = tabs.findIndex((t) => t.path === path);
      if (idx === -1) return;
      if (tabs[idx] && tabs[idx].dirty) {
        const shouldClose = window.confirm(`Close ${tabs[idx].name || 'file'} without saving?`);
        if (!shouldClose) return;
      }
      tabs.splice(idx, 1);
      if (getActiveTabId() === path) {
        if (tabs.length > 0) {
          const nextIdx = Math.min(idx, tabs.length - 1);
          switchToTab(tabs[nextIdx].path);
        } else {
          switchToTab('chat');
        }
      } else {
        renderTabBar();
        persistFileTabsStateNow();
      }
    }

    return {
      getOpenFileTab,
      getActiveFileTab,
      formatFileViewerBreadcrumb,
      inferFileViewerLanguage,
      renderFileViewerHighlight,
      renderFileViewerLineNumbers,
      updateFileViewerCurrentLine,
      selectFileViewerLine,
      applyFileViewerSearchSelection,
      updateFileViewerSearch,
      setFileViewerSearchOpen,
      syncFileViewerScroll,
      refreshActiveFileTabView,
      setActiveFileTabContent,
      saveFileTab,
      persistFileTabsStateNow,
      schedulePersistFileTabsState,
      loadStoredFileTabs,
      renderTabBar,
      syncFileTabFromWorkspaceWrite,
      refreshOpenFileTabsFromWorkspace,
      switchToTab,
      openFileTab,
      closeFileTab,
    };
  }

  window.AIExeFileViewer = { createFileViewer };
})();
