(function initAIExeChatShell(global) {
  function createChatShell(deps) {
    function renderSidebarCounts() {
      if (deps.artifactCountEl) deps.artifactCountEl.textContent = String(deps.getBrowsableArtifacts().length);
      if (deps.codeCountEl) deps.codeCountEl.textContent = String(deps.getGeneratedCodeCount());
    }

    function syncSidebarNavState() {
      const financeMode = deps.getMiddleViewMode() === 'finance';
      const artifactMode = deps.getMiddleViewMode() !== 'chat' && !financeMode;
      const codeMode = artifactMode && deps.getArtifactListFilter && deps.getArtifactListFilter() === 'code';
      if (deps.newChatBtn) {
        deps.newChatBtn.classList.toggle('active', deps.isInNewChatMode());
      }
      if (deps.artifactsBtn) {
        deps.artifactsBtn.classList.toggle('active', !deps.isInNewChatMode() && artifactMode && !codeMode);
      }
      if (deps.codeBtn) {
        deps.codeBtn.classList.toggle('active', !deps.isInNewChatMode() && codeMode);
      }
      if (deps.financeBtn) {
        deps.financeBtn.classList.toggle('active', !deps.isInNewChatMode() && financeMode);
      }
      if (deps.isInNewChatMode()) {
        if (deps.artifactsBtn) deps.artifactsBtn.classList.remove('active');
        if (deps.codeBtn) deps.codeBtn.classList.remove('active');
        if (deps.financeBtn) deps.financeBtn.classList.remove('active');
      }
    }

    function renderMiddleView() {
      const financeMode = deps.getMiddleViewMode() === 'finance';
      const showArtifacts = deps.getMiddleViewMode() !== 'chat' && !financeMode;
      const hasCanvasContent = Boolean(deps.canvasEditor && String(deps.canvasEditor.value || '').trim());
      const showCanvasDock = !showArtifacts && !financeMode && deps.isCanvasDockOpen() && (deps.isCanvasModeEnabled() || hasCanvasContent);
      const showingFile = deps.getActiveTabId() !== 'chat';
      if (deps.chatArea) {
        deps.chatArea.style.display = (showArtifacts || financeMode || showingFile) ? 'none' : 'flex';
      }
      if (deps.fileViewer) {
        deps.fileViewer.classList.toggle('hidden', !showingFile || showArtifacts || financeMode);
      }
      if (deps.artifactBrowser) {
        deps.artifactBrowser.classList.toggle('hidden', !showArtifacts);
      }
      if (deps.financeDashboard) {
        deps.financeDashboard.classList.toggle('hidden', !financeMode);
      }
      if (deps.bottomBar) {
        deps.bottomBar.classList.toggle('hidden', financeMode);
      }
      if (deps.canvasDock) {
        deps.canvasDock.classList.toggle('hidden', !showCanvasDock);
      }
      if (showArtifacts) {
        deps.setActiveTabId('chat');
        deps.renderArtifactBrowser();
      }
      if (financeMode && typeof deps.renderFinanceDashboard === 'function') {
        deps.setActiveTabId('chat');
        deps.renderFinanceDashboard();
      }
      deps.renderTabBar();
      syncSidebarNavState();
      deps.updateChatScrollDownButtonVisibility();
    }

    function buildHistoryEmpty() {
      const signedIn = Boolean(deps.currentAuthUser());
      const title = signedIn ? 'No Session History' : 'Sign In Required';
      const sub = signedIn
        ? 'Your real prompts will appear here once you start using the runtime.'
        : 'Your private chats are hidden while signed out. Log back into the same account to restore them.';
      const wrapper = document.createElement('div');
      wrapper.className = 'history-empty';
      wrapper.id = 'historyEmpty';
      wrapper.innerHTML = `
          <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>
          </svg>
          <div class="history-empty-title">${title}</div>
          <div class="history-empty-sub">${sub}</div>
        `;
      return wrapper;
    }

    function renderHistory() {
      deps.histList.innerHTML = '';
      const chats = deps.getChats();
      if (chats.length === 0) {
        deps.histList.appendChild(buildHistoryEmpty());
        return;
      }

      chats.forEach((chat) => {
        const el = document.createElement('div');
        el.className = 'hist-item';
        if (!deps.isInNewChatMode() && deps.getMiddleViewMode() === 'chat' && chat.id === deps.getActiveChatId()) {
          el.classList.add('active');
        }
        const dot = document.createElement('span');
        dot.className = 'hi-dot';
        const text = document.createElement('span');
        text.className = 'hi-text';
        text.textContent = chat.name;
        if (!chat.customName && chat.isNaming) {
          text.classList.add('naming');
        }
        const showRunning = Boolean(
          deps.isChatOperationRunning
          && deps.isChatOperationRunning(chat.id)
          && !(deps.isChatOperationVisibleHere && deps.isChatOperationVisibleHere(chat.id))
        );
        const time = document.createElement('span');
        time.className = 'hi-time';
        time.textContent = deps.formatHistoryTime(chat.updatedAt);
        time.title = deps.formatTimeAgo(chat.updatedAt);
        const menuBtn = document.createElement('button');
        menuBtn.className = 'hi-menu-btn';
        menuBtn.type = 'button';
        menuBtn.title = 'Chat options';
        menuBtn.innerHTML = `
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="5" cy="12" r="1.5"></circle>
              <circle cx="12" cy="12" r="1.5"></circle>
              <circle cx="19" cy="12" r="1.5"></circle>
            </svg>
          `;
        menuBtn.addEventListener('click', (evt) => {
          evt.stopPropagation();
          deps.openChatActionModal(chat.id);
        });
        el.appendChild(dot);
        el.appendChild(text);
        el.appendChild(time);
        if (showRunning) {
          el.classList.add('running');
          const spinner = document.createElement('span');
          spinner.className = 'hi-run-spinner';
          spinner.title = 'Operation running';
          spinner.setAttribute('aria-hidden', 'true');
          el.appendChild(spinner);
        }
        el.appendChild(menuBtn);
        el.onclick = () => loadHistory(chat.id);
        deps.histList.appendChild(el);
      });
    }

    function loadHistory(chatId) {
      const chat = deps.findChatById(chatId);
      if (!chat) return;
      deps.ensureChatThreadState(chat);
      deps.enterChatView();
      deps.setActiveChatId(chatId);
      deps.setInNewChatMode(false);
      deps.persistActiveChatId();
      renderHistory();
      deps.renderActiveChat();
      deps.syncInputAugmentState();
      syncSidebarNavState();
    }

    function startNewChat() {
      if (!deps.ensureSignedIn()) return;
      deps.clearDebugTraceEntries();
      deps.enterChatView();
      deps.setInNewChatMode(true);
      deps.setActiveChatId(null);
      deps.setCanvasMode(false);
      deps.setDeveloperAgentMode(false);
      deps.setThinkMode(false);
      deps.setWebSearchMode(false);
      deps.setPendingManualContext('');
      deps.setPendingNewChatAttachments([]);
      deps.clearPendingAttachments();
      deps.pushDebugTrace('new_chat_mode', {
        chatId: '',
      });
      deps.persistActiveChatId();
      renderHistory();
      deps.renderActiveChat();
      deps.syncInputAugmentState();
      syncSidebarNavState();
      if (deps.mainInput) deps.mainInput.focus();
    }

    return {
      renderSidebarCounts,
      syncSidebarNavState,
      renderMiddleView,
      buildHistoryEmpty,
      renderHistory,
      loadHistory,
      startNewChat,
    };
  }

  global.AIExeChatShell = {
    createChatShell,
  };
})(window);
