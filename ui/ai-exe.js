// ── Panel sizing + sidebar toggle
const leftSidebar = document.getElementById('leftSidebar');
const rightSidebar = document.getElementById('rightSidebar');
const leftResizer = document.getElementById('leftResizer');
const rightResizer = document.getElementById('rightResizer');
const toggleIcon = document.getElementById('toggleIcon');
const plusButton = document.querySelector('.btn-plus');
const rootStyle = document.documentElement.style;
const layoutStorageKey = 'ai_exe_layout_v1';
const chatsStoragePrefix = 'ai_exe_chats_v3';
const activeChatStoragePrefix = 'ai_exe_active_chat_v2';
const artifactsStoragePrefix = 'ai_exe_artifacts_v1';
const workspaceStoragePrefix = 'ai_exe_workspace_v1';
const fileTabsStoragePrefix = 'ai_exe_file_tabs_v1';
const authStorageKey = 'ai_exe_auth_v1';
const settingsStorageKey = 'ai_exe_settings_v1';
if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.aiexe) {
  document.documentElement.classList.add('platform-mac');
}

const nativeBridge = (() => {
  let seq = 0;
  const pending = new Map();
  const streamPending = new Map();

  const hasMacBridge = () =>
    Boolean(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.aiexe);
  const hasWinBridge = () =>
    Boolean(window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function');
  const available = () => hasMacBridge() || hasWinBridge();

  function resolveMessage(raw) {
    let msg = raw;
    if (typeof raw === 'string') {
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }
    }
    if (!msg || typeof msg !== 'object' || !msg.id) {
      return;
    }

    if (msg.stream && streamPending.has(msg.id)) {
      const streamReq = streamPending.get(msg.id);
      if (msg.done) {
        streamPending.delete(msg.id);
        clearTimeout(streamReq.timeoutId);
        streamReq.onDone(msg);
      } else if (msg.delta) {
        streamReq.onDelta(String(msg.delta));
        clearTimeout(streamReq.timeoutId);
        streamReq.timeoutId = setTimeout(() => {
          streamPending.delete(msg.id);
          streamReq.onDone({ id: msg.id, ok: false, message: 'Streaming request timed out.' });
        }, streamReq.timeoutMs);
      }
      return;
    }

    const waiter = pending.get(msg.id);
    if (!waiter) {
      return;
    }
    pending.delete(msg.id);
    waiter.resolve(msg);
  }

  window.__aiExeOnNativeMessage = resolveMessage;

  if (hasWinBridge()) {
    window.chrome.webview.addEventListener('message', (event) => {
      resolveMessage(event && event.data);
    });
  }

  function post(payload) {
    if (!available()) {
      return false;
    }
    if (hasWinBridge()) {
      window.chrome.webview.postMessage(payload);
      return true;
    }
    if (hasMacBridge()) {
      window.webkit.messageHandlers.aiexe.postMessage(payload);
      return true;
    }
    return false;
  }

  async function invoke(action, data = {}) {
    if (!available()) {
      return { ok: false, message: 'Native runtime bridge unavailable.' };
    }
    const id = `req_${Date.now()}_${++seq}`;
    const request = JSON.stringify({ id, action, ...data });
    return new Promise((resolve) => {
      const timeoutMs = Math.max(1000, Number(data && data.timeoutMs) || 120000);
      const timeoutId = setTimeout(() => {
        pending.delete(id);
        resolve({ id, action, ok: false, message: 'Request timed out.' });
      }, timeoutMs);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timeoutId);
          resolve(msg);
        },
      });
      if (!post(request)) {
        clearTimeout(timeoutId);
        pending.delete(id);
        resolve({ id, action, ok: false, message: 'Failed to send request to native host.' });
      }
    });
  }

  async function streamInfer(prompt, handlers = {}, options = {}) {
    if (!available()) {
      return { ok: false, message: 'Native runtime bridge unavailable.' };
    }
    const id = `req_${Date.now()}_${++seq}`;
    const timeoutMs = 180000;
    const request = JSON.stringify({
      id,
      action: 'inferStream',
      prompt: String(prompt || ''),
      maxTokens: Number(options.maxTokens) || 0,
      max_tokens: Number(options.maxTokens) || 0,
    });
    return new Promise((resolve) => {
      if (typeof handlers.onStart === 'function') {
        handlers.onStart(id);
      }
      const streamReq = {
        timeoutMs,
        timeoutId: null,
        onDelta: (delta) => {
          if (typeof handlers.onDelta === 'function') {
            handlers.onDelta(delta);
          }
        },
        onDone: (msg) => {
          if (typeof handlers.onDone === 'function') {
            handlers.onDone(msg);
          }
          resolve(msg || { id, ok: false, message: 'No response from stream.' });
        },
      };
      streamReq.timeoutId = setTimeout(() => {
        streamPending.delete(id);
        streamReq.onDone({ id, ok: false, message: 'Streaming request timed out.' });
      }, timeoutMs);
      streamPending.set(id, streamReq);
      if (!post(request)) {
        clearTimeout(streamReq.timeoutId);
        streamPending.delete(id);
        resolve({ id, ok: false, message: 'Failed to send stream request to native host.' });
      }
    });
  }

  function cancelStream(streamId) {
    const id = String(streamId || '').trim();
    if (!id) return;
    const streamReq = streamPending.get(id);
    if (streamReq) {
      clearTimeout(streamReq.timeoutId);
      streamPending.delete(id);
      streamReq.onDone({ id, ok: false, cancelled: true, message: 'Cancelled by user.' });
    }
    post(JSON.stringify({ id: `cancel_${Date.now()}_${++seq}`, action: 'cancelStream', streamId: id }));
  }

  return {
    available,
    invoke,
    streamInfer,
    cancelStream,
  };
})();

function setupMacTopbarNativeDrag() {
  if (!document.documentElement.classList.contains('platform-mac')) return;
  if (!nativeBridge.available()) return;
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  const noDragSelector = [
    'button',
    'input',
    'textarea',
    'select',
    'a',
    '.search-wrap',
    '.search-dropdown',
    '.avatar-btn',
    '.top-icon-btn',
    '.btn-plus',
  ].join(',');
  let dragging = false;
  let lastScreenX = 0;
  let lastScreenY = 0;
  let queuedDx = 0;
  let queuedDy = 0;
  let inFlight = false;

  const flushMove = () => {
    if (!dragging || inFlight) return;
    if (Math.abs(queuedDx) < 0.1 && Math.abs(queuedDy) < 0.1) return;
    const dx = queuedDx;
    const dy = queuedDy;
    queuedDx = 0;
    queuedDy = 0;
    inFlight = true;
    nativeBridge.invoke('windowMoveBy', {
      dx: String(dx),
      dy: String(dy),
    }).catch(() => { }).finally(() => {
      inFlight = false;
      if (dragging) flushMove();
    });
  };

  const onMouseMove = (evt) => {
    if (!dragging || !evt) return;
    const sx = Number(evt.screenX) || 0;
    const sy = Number(evt.screenY) || 0;
    const dx = sx - lastScreenX;
    const dy = sy - lastScreenY;
    lastScreenX = sx;
    lastScreenY = sy;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
    queuedDx += dx;
    queuedDy += dy;
    flushMove();
  };

  const stopDrag = () => {
    dragging = false;
    queuedDx = 0;
    queuedDy = 0;
    lastScreenX = 0;
    lastScreenY = 0;
    inFlight = false;
  };

  topbar.addEventListener('mousedown', (evt) => {
    if (!evt || evt.button !== 0) return;
    const target = evt.target;
    if (target && typeof target.closest === 'function' && target.closest(noDragSelector)) {
      return;
    }
    evt.preventDefault();
    dragging = true;
    lastScreenX = Number(evt.screenX) || 0;
    lastScreenY = Number(evt.screenY) || 0;
  });
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('mouseup', stopDrag, true);
  window.addEventListener('blur', stopDrag);
}

const uiConfig = window.AI_EXE_UI_CONFIG || {};
const panelCfg = uiConfig.panel || {};
const uiCfg = uiConfig.ui || {};
const uiMinW = Number.isFinite(uiConfig.minWindowWidth) ? uiConfig.minWindowWidth : 1050;
const uiMinH = Number.isFinite(uiConfig.minWindowHeight) ? uiConfig.minWindowHeight : 760;
const sidebarDefaultWidth = Number.isFinite(panelCfg.sidebarDefaultWidth) ? panelCfg.sidebarDefaultWidth : 260;
const rightDefaultWidth = Number.isFinite(panelCfg.rightDefaultWidth) ? panelCfg.rightDefaultWidth : 300;
const resizerWidth = Number.isFinite(uiCfg.resizerWidth) ? uiCfg.resizerWidth : 6;
const rememberLayout = (typeof uiCfg.rememberLayout === 'boolean') ? uiCfg.rememberLayout : true;
const animationsDefault = (typeof uiCfg.animationsDefault === 'boolean') ? uiCfg.animationsDefault : true;
const remoteProvidersEnabled = (typeof uiCfg.remoteProvidersEnabled === 'boolean') ? uiCfg.remoteProvidersEnabled : false;
const devPlannerEnabled = (typeof uiCfg.devPlannerEnabled === 'boolean') ? uiCfg.devPlannerEnabled : false;

const panelLimits = {
  leftMin: Number.isFinite(panelCfg.sidebarMinWidth) ? panelCfg.sidebarMinWidth : 200,
  leftMax: Number.isFinite(panelCfg.sidebarMaxWidth) ? panelCfg.sidebarMaxWidth : 420,
  rightMin: Number.isFinite(panelCfg.rightMinWidth) ? panelCfg.rightMinWidth : 260,
  rightMax: Number.isFinite(panelCfg.rightMaxWidth) ? panelCfg.rightMaxWidth : 520,
  middleMin: Number.isFinite(panelCfg.middleMinWidth) ? panelCfg.middleMinWidth : 620,
};

rootStyle.setProperty('--ui-min-w', `${uiMinW}px`);
rootStyle.setProperty('--ui-min-h', `${uiMinH}px`);
rootStyle.setProperty('--resizer-w', `${resizerWidth}px`);
if (!animationsDefault) {
  document.documentElement.classList.add('reduced-anim');
}

let resizeSession = null;
let plusCloseTimer = null;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function getCssPx(name, fallbackPx) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallbackPx;
}

function viewportMaxLeft(rightWidth, viewportWidth = window.innerWidth) {
  const viewportMax = viewportWidth - rightWidth - panelLimits.middleMin;
  return Math.min(panelLimits.leftMax, Math.max(panelLimits.leftMin, viewportMax));
}

function viewportMaxRight(leftWidth, viewportWidth = window.innerWidth) {
  const viewportMax = viewportWidth - leftWidth - panelLimits.middleMin;
  return Math.min(panelLimits.rightMax, Math.max(panelLimits.rightMin, viewportMax));
}

function applyLayoutWidths(leftWidth, rightWidth, viewportWidth = window.innerWidth) {
  let left = clamp(leftWidth, panelLimits.leftMin, viewportMaxLeft(rightWidth, viewportWidth));
  let right = clamp(rightWidth, panelLimits.rightMin, viewportMaxRight(left, viewportWidth));
  left = clamp(left, panelLimits.leftMin, viewportMaxLeft(right, viewportWidth));

  rootStyle.setProperty('--sidebar-w', `${left}px`);
  rootStyle.setProperty('--right-w', `${right}px`);
}

function persistLayoutWidths() {
  if (!rememberLayout) {
    return;
  }
  const state = {
    left: getCssPx('--sidebar-w', sidebarDefaultWidth),
    right: getCssPx('--right-w', rightDefaultWidth),
    rightCollapsed: Boolean(rightSidebar && rightSidebar.classList.contains('collapsed')),
  };
  localStorage.setItem(layoutStorageKey, JSON.stringify(state));
}

function restoreLayoutWidths() {
  let left = sidebarDefaultWidth;
  let right = rightDefaultWidth;
  let rightCollapsed = false;
  if (!rememberLayout) {
    applyLayoutWidths(left, right);
    applyRightSidebarCollapsed(false);
    return;
  }
  try {
    const raw = localStorage.getItem(layoutStorageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Number.isFinite(parsed.left)) left = parsed.left;
      if (Number.isFinite(parsed.right)) right = parsed.right;
      rightCollapsed = Boolean(parsed.rightCollapsed);
    }
  } catch (_) { }

  applyLayoutWidths(left, right);
  applyRightSidebarCollapsed(rightCollapsed);
}

function setResizerGlowFromClientY(resizer, clientY, top, height) {
  if (!resizer || !Number.isFinite(height) || height <= 0) return;
  const pct = ((clientY - top) / height) * 100;
  const clamped = Math.max(0, Math.min(100, pct));
  resizer.style.setProperty('--hover-y', `${clamped}%`);
}

function setResizerGlowFromEvent(resizer, e) {
  if (!resizer || !e) return;
  const rect = resizer.getBoundingClientRect();
  setResizerGlowFromClientY(resizer, e.clientY, rect.top, rect.height);
}

function flushResizeFrame() {
  if (!resizeSession) return;
  resizeSession.rafId = 0;

  setResizerGlowFromClientY(
    resizeSession.handle,
    resizeSession.pendingClientY,
    resizeSession.handleTop,
    resizeSession.handleHeight
  );

  const delta = resizeSession.pendingClientX - resizeSession.startX;
  if (resizeSession.which === 'left') {
    applyLayoutWidths(
      resizeSession.startLeft + delta,
      resizeSession.startRight,
      resizeSession.viewportWidth
    );
  } else {
    applyLayoutWidths(
      resizeSession.startLeft,
      resizeSession.startRight - delta,
      resizeSession.viewportWidth
    );
  }
}

function beginResize(which, handle, e) {
  if (which === 'left' && leftSidebar.classList.contains('collapsed')) {
    return;
  }

  e.preventDefault();
  const handleRect = handle.getBoundingClientRect();
  setResizerGlowFromClientY(handle, e.clientY, handleRect.top, handleRect.height);
  resizeSession = {
    which,
    handle,
    startX: e.clientX,
    startLeft: getCssPx('--sidebar-w', sidebarDefaultWidth),
    startRight: getCssPx('--right-w', rightDefaultWidth),
    pendingClientX: e.clientX,
    pendingClientY: e.clientY,
    viewportWidth: window.innerWidth,
    handleTop: handleRect.top,
    handleHeight: handleRect.height,
    rafId: 0,
  };

  handle.classList.add('active');
  document.body.classList.add('resizing-panels');
  if (typeof e.pointerId === 'number' && handle.setPointerCapture) {
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (_) { }
  }
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', endResize);
  window.addEventListener('pointercancel', endResize);
}

function onResizeMove(e) {
  if (!resizeSession) return;
  resizeSession.pendingClientX = e.clientX;
  resizeSession.pendingClientY = e.clientY;
  if (resizeSession.rafId === 0) {
    resizeSession.rafId = requestAnimationFrame(flushResizeFrame);
  }
}

function endResize() {
  if (!resizeSession) return;
  if (resizeSession.rafId) {
    cancelAnimationFrame(resizeSession.rafId);
    resizeSession.rafId = 0;
    flushResizeFrame();
  }
  if (resizeSession.handle) {
    resizeSession.handle.classList.remove('active');
  }
  resizeSession = null;
  document.body.classList.remove('resizing-panels');
  window.removeEventListener('pointermove', onResizeMove);
  window.removeEventListener('pointerup', endResize);
  window.removeEventListener('pointercancel', endResize);
  persistLayoutWidths();
}

if (leftResizer) {
  leftResizer.addEventListener('pointerdown', (e) => beginResize('left', leftResizer, e));
  leftResizer.addEventListener('pointermove', (e) => setResizerGlowFromEvent(leftResizer, e));
}
if (rightResizer) {
  rightResizer.addEventListener('pointerdown', (e) => beginResize('right', rightResizer, e));
  rightResizer.addEventListener('pointermove', (e) => setResizerGlowFromEvent(rightResizer, e));
}

window.addEventListener('resize', () => {
  applyLayoutWidths(getCssPx('--sidebar-w', sidebarDefaultWidth), getCssPx('--right-w', rightDefaultWidth));
});

restoreLayoutWidths();

function toggleSidebar() {
  leftSidebar.classList.toggle('collapsed');
  if (leftSidebar.classList.contains('collapsed')) {
    toggleIcon.innerHTML = '<path d="M9 18l6-6-6-6"/>';
  } else {
    toggleIcon.innerHTML = '<path d="M15 18l-6-6 6-6"/>';
    applyLayoutWidths(getCssPx('--sidebar-w', sidebarDefaultWidth), getCssPx('--right-w', rightDefaultWidth));
    persistLayoutWidths();
  }
}

function applyRightSidebarCollapsed(collapsed) {
  const isCollapsed = Boolean(collapsed);
  if (rightSidebar) rightSidebar.classList.toggle('collapsed', isCollapsed);
  document.body.classList.toggle('right-panel-collapsed', isCollapsed);
  const btn = document.getElementById('rightCollapseBtn');
  const icon = document.getElementById('rightCollapseIcon');
  if (icon) {
    // Point the chevrons toward where the panel will go: right when open
    // (collapse outward), left when collapsed (expand back in).
    icon.innerHTML = isCollapsed
      ? '<path d="M11 18l-6-6 6-6"></path><path d="M18 18l-6-6 6-6"></path>'
      : '<path d="M13 18l6-6-6-6"></path><path d="M6 18l6-6-6-6"></path>';
  }
  if (btn) btn.title = isCollapsed ? 'Expand Explorer' : 'Collapse Explorer';
}

function toggleRightSidebar() {
  const next = !(rightSidebar && rightSidebar.classList.contains('collapsed'));
  applyRightSidebarCollapsed(next);
  persistLayoutWidths();
}

// ── Nav active
function setActive(btn) {
  if (!btn || btn.id === 'newChatBtn') return;
  inNewChatMode = false;
  if (newChatBtn) {
    newChatBtn.classList.remove('active');
  }
  document.querySelectorAll('.snav-btn').forEach((b) => {
    if (b.id !== 'newChatBtn') {
      b.classList.remove('active');
    }
  });
  btn.classList.add('active');
}

function makeArtifactKey(item) {
  return `${Number(item && item.createdAt ? item.createdAt : 0)}::${String(item && item.name ? item.name : '')}`;
}

function formatTimeAgo(tsMillis) {
  const ts = Number(tsMillis) || Date.now();
  let deltaSec = Math.floor((Date.now() - ts) / 1000);
  if (!Number.isFinite(deltaSec) || deltaSec < 0) deltaSec = 0;

  if (deltaSec < 10) return 'just now';
  if (deltaSec < 60) return `${deltaSec} secs ago`;

  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin === 1) return '1 min ago';
  if (deltaMin < 60) return `${deltaMin} mins ago`;

  const deltaHour = Math.floor(deltaMin / 60);
  if (deltaHour === 1) return '1 hour ago';
  if (deltaHour < 24) return `${deltaHour} hours ago`;

  const deltaDay = Math.floor(deltaHour / 24);
  if (deltaDay === 1) return '1 day ago';
  if (deltaDay < 30) return `${deltaDay} days ago`;

  const deltaMonth = Math.floor(deltaDay / 30);
  if (deltaMonth === 1) return '1 month ago';
  if (deltaMonth < 12) return `${deltaMonth} months ago`;

  const deltaYear = Math.floor(deltaDay / 365);
  if (deltaYear <= 1) return '1 year ago';
  return `${deltaYear} years ago`;
}

function getCanvasArtifacts() {
  return artifacts
    .filter((item) => item && item.type === 'canvas')
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

function getAllStoredArtifacts() {
  return artifacts
    .filter((item) => item && (item.type === 'canvas' || item.type === 'code'))
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

function isCodeArtifact(item) {
  return Boolean(
    item
    && (
      item.type === 'code'
      || (item.type === 'canvas' && String(item.canvasFormat || '').toLowerCase() === 'code')
    )
  );
}

function getBrowsableArtifacts() {
  return getAllStoredArtifacts().filter((item) => !isCodeArtifact(item));
}

function getCodeArtifacts() {
  return getAllStoredArtifacts().filter((item) => isCodeArtifact(item));
}

function getCanvasArtifactsForChat(chatId) {
  const key = String(chatId || '');
  if (!key) return [];
  return getCanvasArtifacts().filter((item) => String(item.chatId || '') === key);
}

function getArtifactsForMessage(chatId, messageTs) {
  const chatKey = String(chatId || '');
  const ts = Number(messageTs) || 0;
  if (!chatKey || !ts) return [];
  return getAllStoredArtifacts().filter((item) => String(item.chatId || '') === chatKey && Number(item.messageTs) === ts);
}

function getArtifactTypeLabel(itemOrType, canvasFormat = '') {
  const type = typeof itemOrType === 'object' && itemOrType
    ? String(itemOrType.type || '')
    : String(itemOrType || '');
  const format = typeof itemOrType === 'object' && itemOrType
    ? String(itemOrType.canvasFormat || '')
    : String(canvasFormat || '');
  if (type === 'code' || (type === 'canvas' && format.toLowerCase() === 'code')) return 'Code';
  if (type === 'canvas') return 'Canvas';
  return 'Artifact';
}

function openArtifactsView(btn) {
  if (!ensureSignedIn()) return;
  artifactListFilter = 'all';
  if (btn) setActive(btn);
  middleViewMode = 'artifacts_list';
  artifactDetailKey = '';
  artifactDetailOrigin = 'artifacts';
  renderHistory();
  renderMiddleView();
}

function openCodeArtifactsView(btn) {
  if (!ensureSignedIn()) return;
  artifactListFilter = 'code';
  if (btn) setActive(btn);
  middleViewMode = 'artifacts_list';
  artifactDetailKey = '';
  artifactDetailOrigin = 'artifacts';
  renderHistory();
  renderMiddleView();
}

function openArtifactDetail(artifactKey, origin = 'artifacts') {
  artifactDetailKey = String(artifactKey || '');
  artifactDetailOrigin = String(origin || 'artifacts') === 'chat' ? 'chat' : 'artifacts';
  middleViewMode = 'artifacts_detail';
  renderMiddleView();
}

function backToArtifactList() {
  if (artifactDetailOrigin === 'chat') {
    artifactDetailOrigin = 'artifacts';
    enterChatView();
    return;
  }
  artifactDetailKey = '';
  middleViewMode = 'artifacts_list';
  renderMiddleView();
}

function enterChatView() {
  middleViewMode = 'chat';
  artifactDetailKey = '';
  artifactDetailOrigin = 'artifacts';
  artifactListFilter = 'all';
  if (artifactsBtn) artifactsBtn.classList.remove('active');
  renderHistory();
  renderMiddleView();
}

const histList = document.getElementById('historyList');
const avatarBadge = document.getElementById('avatarBadge');
const sidebarBottomActions = document.getElementById('sidebarBottomActions');
const accountPopover = document.getElementById('accountPopover');
const accountPopoverName = document.getElementById('accountPopoverName');
const accountProfileBtn = document.getElementById('accountProfileBtn');
const accountSettingsBtn = document.getElementById('accountSettingsBtn');
const accountUsageBtn = document.getElementById('accountUsageBtn');
const accountLogoutBtn = document.getElementById('accountLogoutBtn');
const accountLogoutText = document.getElementById('accountLogoutText');
const newChatBtn = document.getElementById('newChatBtn');
const artifactsBtn = document.getElementById('artifactsBtn');
const codeBtn = document.getElementById('codeBtn');
const artifactCountEl = document.getElementById('artifactCount');
const codeCountEl = document.getElementById('codeCount');
const chatArea = document.getElementById('chatArea');
const artifactBrowser = document.getElementById('artifactBrowser');
const artifactBrowserTitle = document.getElementById('artifactBrowserTitle');
const artifactBackBtn = document.getElementById('artifactBackBtn');
const artifactListView = document.getElementById('artifactListView');
const artifactDetailView = document.getElementById('artifactDetailView');
const artifactDetailMeta = document.getElementById('artifactDetailMeta');
const artifactEditor = document.getElementById('artifactEditor');
const artifactOpenChatBtn = document.getElementById('artifactOpenChatBtn');
const artifactCopyBtn = document.getElementById('artifactCopyBtn');
const mainInput = document.getElementById('mainInput');
const inputRow = document.getElementById('inputRow');
const composerConfirm = document.getElementById('composerConfirm');
const phaseTracker = document.getElementById('phaseTracker');
const composerConfirmTitle = document.getElementById('composerConfirmTitle');
const composerConfirmOptions = document.getElementById('composerConfirmOptions');
const composerConfirmDismissBtn = document.getElementById('composerConfirmDismissBtn');
const composerConfirmSubmitBtn = document.getElementById('composerConfirmSubmitBtn');
const sendBtn = document.getElementById('sendBtn');
const continueBtn = document.getElementById('continueBtn');
const chatScrollDownBtn = document.getElementById('chatScrollDownBtn');
const canvasBtn = document.getElementById('canvasBtn');
const attachBtn = document.getElementById('attachBtn');
const agentBtn = document.getElementById('agentBtn');
const thinkBtn = document.getElementById('thinkBtn');
const contextBtn = document.getElementById('contextBtn');
const composerPlusBtn = document.getElementById('composerPlusBtn');
const composerMenu = document.getElementById('composerMenu');
const menuCanvasBtn = document.getElementById('menuCanvasBtn');
const menuAttachBtn = document.getElementById('menuAttachBtn');
const menuAgentBtn = document.getElementById('menuAgentBtn');
const menuThinkBtn = document.getElementById('menuThinkBtn');
const menuContextBtn = document.getElementById('menuContextBtn');
const micBtn = document.getElementById('micBtn');
const dictationBar = document.getElementById('dictationBar');
const dictationWaveCanvas = document.getElementById('dictationWaveCanvas');
const dictationCancelBtn = document.getElementById('dictationCancelBtn');
const dictationApplyBtn = document.getElementById('dictationApplyBtn');
const attachFileInput = document.getElementById('attachFileInput');
const workspaceImportInput = document.getElementById('workspaceImportInput');
const workspaceImportFolderInput = document.getElementById('workspaceImportFolderInput');
const inputAttachments = document.getElementById('inputAttachments');
const canvasDock = document.getElementById('canvasDock');
const canvasEditor = document.getElementById('canvasEditor');
const canvasCopyBtn = document.getElementById('canvasCopyBtn');
const canvasCloseBtn = document.getElementById('canvasCloseBtn');
const canvasTitle = document.getElementById('canvasTitle');
const projInput = document.getElementById('projInput');
const projType = document.getElementById('projType');
const thinkingStatus = document.getElementById('thinkingStatus');
const composerStatusLine = document.querySelector('.composer-status-line');
const folderArea = document.getElementById('folderArea');
const emptyFolder = document.getElementById('emptyFolder');
const workspacePathLabel = document.getElementById('workspacePathLabel');
const middleTabBar = document.getElementById('middleTabBar');
const tabChatEl = document.getElementById('tabChat');
const fileViewer = document.getElementById('fileViewer');
const fileViewerSurface = document.getElementById('fileViewerSurface');
const fileViewerCmHost = document.getElementById('fileViewerCmHost');
const fileViewerGutter = document.getElementById('fileViewerGutter');
const fileViewerGutterLines = document.getElementById('fileViewerGutterLines');
const fileViewerCurrentLine = document.getElementById('fileViewerCurrentLine');
const fileViewerHighlight = document.getElementById('fileViewerHighlight');
const fileViewerHighlightCode = document.getElementById('fileViewerHighlightCode');
const fileViewerEditor = document.getElementById('fileViewerEditor');
const fvFilename = document.getElementById('fvFilename');
const fileViewerSearch = document.getElementById('fileViewerSearch');
const fileViewerSearchInput = document.getElementById('fileViewerSearchInput');
const fileViewerSearchCount = document.getElementById('fileViewerSearchCount');
const fileViewerSearchPrev = document.getElementById('fileViewerSearchPrev');
const fileViewerSearchNext = document.getElementById('fileViewerSearchNext');
const fileViewerSearchClose = document.getElementById('fileViewerSearchClose');
const workspaceBackBtn = document.getElementById('workspaceBackBtn');
const expImportBtn = document.getElementById('expImportBtn');
const expImportMenu = document.getElementById('expImportMenu');
const expMoreBtn = document.getElementById('expMoreBtn');
const expMoreMenu = document.getElementById('expMoreMenu');
const expCloseProjectBtn = document.getElementById('expCloseProjectBtn');
const expDeleteSelectedBtn = document.getElementById('expDeleteSelectedBtn');
let emptyStateTemplate = (document.getElementById('emptyState') || { outerHTML: '' }).outerHTML;
const loginBtn = document.getElementById('loginBtn');
const loginBtnText = document.getElementById('loginBtnText');
const loginSubText = document.getElementById('loginSubText');
const chatActionBackdrop = document.getElementById('chatActionBackdrop');
const chatNameInput = document.getElementById('chatNameInput');
const chatSaveBtn = document.getElementById('chatSaveBtn');
const chatCancelBtn = document.getElementById('chatCancelBtn');
const chatDeleteBtn = document.getElementById('chatDeleteBtn');
const chatDeleteConfirmNote = document.getElementById('chatDeleteConfirmNote');
const authBackdrop = document.getElementById('authBackdrop');
const authTitle = document.getElementById('authTitle');
const authSwitch = document.getElementById('authSwitch');
const authLoginTab = document.getElementById('authLoginTab');
const authSignupTab = document.getElementById('authSignupTab');
const authUserWrap = document.getElementById('authUserWrap');
const authPassWrap = document.getElementById('authPassWrap');
const authUserInput = document.getElementById('authUserInput');
const authPassInput = document.getElementById('authPassInput');
const authConfirmWrap = document.getElementById('authConfirmWrap');
const authConfirmInput = document.getElementById('authConfirmInput');
const authNote = document.getElementById('authNote');
const authLogoutBtn = document.getElementById('authLogoutBtn');
const authCancelBtn = document.getElementById('authCancelBtn');
const authActionBtn = document.getElementById('authActionBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsBackdrop = document.getElementById('settingsBackdrop');
const settingsModelPath = document.getElementById('settingsModelPath');
const settingsModelHash = document.getElementById('settingsModelHash');
const settingsBackendStatus = document.getElementById('settingsBackendStatus');
const settingsProviderSelect = document.getElementById('settingsProviderSelect');
const settingsRemoteFieldsWrap = document.getElementById('settingsRemoteFieldsWrap');
const settingsApiKeyLabel = document.getElementById('settingsApiKeyLabel');
const settingsApiKeyInput = document.getElementById('settingsApiKeyInput');
const settingsApiKeyToggle = document.getElementById('settingsApiKeyToggle');
const settingsApiEndpointWrap = document.getElementById('settingsApiEndpointWrap');
const settingsApiEndpointLabel = document.getElementById('settingsApiEndpointLabel');
const settingsApiEndpointInput = document.getElementById('settingsApiEndpointInput');
const settingsApiModelPreset = document.getElementById('settingsApiModelPreset');
const settingsApiModelInput = document.getElementById('settingsApiModelInput');
const settingsProviderHelp = document.getElementById('settingsProviderHelp');
const settingsModelUrlWrap = document.getElementById('settingsModelUrlWrap');
const settingsModelUrlInput = document.getElementById('settingsModelUrlInput');
const settingsKeepModelChk = document.getElementById('settingsKeepModelChk');
const settingsDebugTraceChk = document.getElementById('settingsDebugTraceChk');
const settingsImportBtn = document.getElementById('settingsImportBtn');
const settingsDebugDumpBtn = document.getElementById('settingsDebugDumpBtn');
const settingsVerifyBtn = document.getElementById('settingsVerifyBtn');
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
const settingsSaveBtn = document.getElementById('settingsSaveBtn');
const settingsNote = document.getElementById('settingsNote');
const settingsViewTitle = document.getElementById('settingsViewTitle');
const settingsViewSubtitle = document.getElementById('settingsViewSubtitle');
const settingsNavButtons = Array.from(document.querySelectorAll('[data-settings-section]'));
const settingsPanes = Array.from(document.querySelectorAll('[data-settings-pane]'));
const settingsWorkModeCoding = document.getElementById('settingsWorkModeCoding');
const settingsWorkModeEveryday = document.getElementById('settingsWorkModeEveryday');
const settingsWorkModeCodingCard = document.getElementById('settingsWorkModeCodingCard');
const settingsWorkModeEverydayCard = document.getElementById('settingsWorkModeEverydayCard');
const settingsWorkerList = document.getElementById('settingsWorkerList');
let settingsAutosaveTimer = 0;
const searchInput = document.getElementById('searchInput');
const searchDropdown = document.getElementById('searchDropdown');
const plusBtn = document.getElementById('plusBtn');
const plusModalBackdrop = document.getElementById('plusModalBackdrop');
const plusModalCloseBtn = document.getElementById('plusModalCloseBtn');
const plusDatasetBtn = document.getElementById('plusDatasetBtn');
const plusUrlBtn = document.getElementById('plusUrlBtn');
const plusProjectBtn = document.getElementById('plusProjectBtn');
const plusApiBtn = document.getElementById('plusApiBtn');
const urlContextBackdrop = document.getElementById('urlContextBackdrop');
const urlContextTitle = document.getElementById('urlContextTitle');
const urlContextLabel = document.getElementById('urlContextLabel');
const urlContextInput = document.getElementById('urlContextInput');
const urlContextNote = document.getElementById('urlContextNote');
const urlContextCancelBtn = document.getElementById('urlContextCancelBtn');
const urlContextAddBtn = document.getElementById('urlContextAddBtn');
const datasetFileInput = document.getElementById('datasetFileInput');

let chats = [];
let activeChatId = null;
let artifacts = [];
let workspaceItems = [];
let workspaceCurrentPath = '/';
let workspaceCurrentKind = 'folder';
let workspaceRenderToken = 0;
let workspaceRefreshTimer = 0;
const workspaceTreeState = new Map();
const workspaceSelectedPaths = new Set();
const workspaceDragExpandTimers = new Map();
let workspaceRenameDraft = null;
let workspaceRenameFocusId = 0;
let workspaceDraft = null;
let workspaceDraftFocusId = 0;
let workspaceRootName = '';
// Absolute on-disk workspace root — for real file:// URLs on drag-out.
let workspaceRootPath = '';
let explorerImportMenuOpen = false;
let explorerMoreMenuOpen = false;
let modalChatId = null;
let typingTimer = null;
let thinkingInterval = null;
let thinkingStartedAt = 0;
// Independent elapsed timer for agent runs. The typing indicator (and its thinking
// timer) gets cleared once the agent shows its activity stream, which used to freeze
// the "Xs" counter below the input for the whole run. This keeps it ticking so the
// user can see the run is alive (and notice when it stalls).
let agentElapsedInterval = null;
let agentElapsedStartedAt = 0;
function formatTokenCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}
// Context window (tokens) by provider — 0 means unknown (∞). Drives the token ring.
const MODEL_CONTEXT_WINDOWS = {
  deepseek: 131072,
  anthropic: 200000,
  gemini: 1048576,
  openai: 256000,
  local: 32768,
};
function getModelContextWindow() {
  try { return Number(MODEL_CONTEXT_WINDOWS[getSelectedInferenceProvider()]) || 0; } catch (_) { return 0; }
}
// Agent-run inference accounting for the token ring; depth guard prevents
// double-counting nested calls.
let agentInferenceDepth = 0;
let agentLiveInferencePromptChars = 0;
let agentLastInferenceChars = 0;
let agentRunInferenceChars = 0;
// Survives across runs: "last run" stays readable in the tooltip after a run
// ends (it used to be wiped at stop, so the counter looked like it lost the
// run), and the session total keeps accumulating.
let agentSessionInferenceChars = 0;
function resetAgentInferenceTokenStats() {
  agentInferenceDepth = 0;
  agentLiveInferencePromptChars = 0;
  agentLastInferenceChars = 0;
  agentRunInferenceChars = 0;
}
function noteAgentInferenceStart(promptChars) {
  if (!isAgentElapsedTimerActive()) return;
  agentInferenceDepth += 1;
  if (agentInferenceDepth > 1) return;
  agentLiveInferencePromptChars = Number(promptChars) || 0;
  agentLastInferenceChars = agentLiveInferencePromptChars;
  agentRunInferenceChars += agentLiveInferencePromptChars;
  agentSessionInferenceChars += agentLiveInferencePromptChars;
  updateTokenRing();
}
function noteAgentInferenceEnd(outputChars) {
  if (agentInferenceDepth <= 0) return;
  agentInferenceDepth -= 1;
  if (agentInferenceDepth > 0) return;
  const out = Number(outputChars) || 0;
  agentLastInferenceChars = agentLiveInferencePromptChars + out;
  agentRunInferenceChars += out;
  agentSessionInferenceChars += out;
  if (typeof recordDebugTrace === 'function') {
    recordDebugTrace('agent_inference_usage', {
      promptChars: String(agentLiveInferencePromptChars),
      outputChars: String(out),
      approxCallTokens: String(Math.round(agentLastInferenceChars / 4)),
      approxRunTokens: String(Math.round(agentRunInferenceChars / 4)),
    }, {
      promptChars: agentLiveInferencePromptChars,
      outputChars: out,
      runChars: agentRunInferenceChars,
    });
  }
  agentLiveInferencePromptChars = 0;
  updateTokenRing();
}
// Estimated tokens of the active chat's context (all messages + the in-flight stream
// + what's typed), ~4 chars/token. Real-time numerator for the token ring.
function getActiveChatTokenEstimate() {
  if (isAgentElapsedTimerActive() && agentLastInferenceChars > 0
    && typeof isViewingAgentRunChat === 'function' && isViewingAgentRunChat()) {
    return Math.round(agentLastInferenceChars / 4);
  }
  let chars = 0;
  try {
    const chat = getActiveChat();
    const thread = chat ? getChatActiveThread(chat) : null;
    const msgs = thread && Array.isArray(thread.messages) ? thread.messages : [];
    for (const m of msgs) chars += String((m && m.text) || '').length + String((m && m.thinking) || '').length;
  } catch (_) { /* no active chat */ }
  if (typeof mainInput !== 'undefined' && mainInput) chars += String(mainInput.value || '').length;
  if (activeInferenceRequest && activeInferenceRequest.streamRaw) chars += String(activeInferenceRequest.streamRaw).length;
  return Math.round(chars / 4);
}
const TOKEN_RING_CIRCUMFERENCE = 2 * Math.PI * 8; // r=8
function updateTokenRing() {
  const ring = document.getElementById('tokenRing');
  const fg = document.getElementById('tokenRingFg');
  if (!ring || !fg) return;
  const tokens = getActiveChatTokenEstimate();
  const ctx = getModelContextWindow();
  const pct = ctx > 0 ? Math.min(1, tokens / ctx) : 0;
  fg.style.strokeDashoffset = String(TOKEN_RING_CIRCUMFERENCE * (1 - pct));
  ring.classList.toggle('warn', ctx > 0 && pct >= 0.8);
  ring.classList.toggle('full', ctx > 0 && pct >= 0.98);
  const denom = ctx > 0 ? formatTokenCount(ctx) : '∞';
  const pctLabel = ctx > 0 ? ` (${Math.round(pct * 100)}%)` : '';
  let label = `${formatTokenCount(tokens)} / ${denom} tokens${pctLabel}`;
  if (agentRunInferenceChars > 0 && typeof isViewingAgentRunChat === 'function' && isViewingAgentRunChat()) {
    label += isAgentElapsedTimerActive()
      ? ` · run ≈${formatTokenCount(Math.round(agentRunInferenceChars / 4))} tok`
      : ` · last agent run ≈${formatTokenCount(Math.round(agentRunInferenceChars / 4))} tok`;
  }
  if (agentSessionInferenceChars > agentRunInferenceChars) {
    label += ` · session ≈${formatTokenCount(Math.round(agentSessionInferenceChars / 4))} tok`;
  }
  // Use the app's custom tooltip system (global delegation on .ui-tooltip-anchor[data-tooltip]).
  ring.classList.add('ui-tooltip-anchor');
  ring.dataset.tooltip = label;
  ring.setAttribute('aria-label', label);
  if (ring.hasAttribute('title')) ring.removeAttribute('title');
  if (activeTooltipTarget === ring) {
    updateGlobalTooltipPosition(ring);
  }
  if (window.AI_EXE_DEBUG_TOKENS) console.log('[token-ring]', label, { tokens, ctx, pct });
}
let activeStreamRow = null;
let activeStreamRawText = '';
let activeStreamText = '';
let activeAgentStreamState = null;
let liveStreamRenderRaf = 0;
let liveStreamRenderTimer = 0;
let liveStreamLastRenderAt = 0;
let lastRenderedChatId = '';
let chatAutoScrollPinned = true;
let chatProgrammaticScrollDepth = 0;
let canvasModeEnabled = false;
let developerAgentEnabled = false;
let thinkModeEnabled = false;
let canvasDockOpen = false;
let composerMenuOpen = false;
let composerConfirmSelectedIndex = 0;
let speechRecognitionActive = false;
let dictationOpToken = 0;
let pendingDictationTranscript = '';
let dictationApplyPending = false;
let dictationTranscriptInFlight = false;
let dictationApplyLoadingSinceMs = 0;
let dictationWaveRaf = 0;
let dictationWaveStream = null;
let dictationWaveAudioCtx = null;
let dictationWaveAnalyser = null;
let dictationWaveData = null;
let dictationWaveHistory = [];
let dictationWaveFallbackPhase = 0;
let dictationNativeLevel = 0;
let dictationLevelPollTimer = 0;
let latestCanvasName = '';
let middleViewMode = 'chat';
let artifactDetailKey = '';
let artifactDetailOrigin = 'artifacts';
let artifactListFilter = 'all';
let openFileTabs = [];
let fileTabsPersistTimer = 0;
let fileTabsRestoreToken = 0;
const FILE_VIEWER_HIGHLIGHT_LIMIT_BYTES = 64 * 1024;
const FILE_VIEWER_LINE_TOP_PADDING = 16;
let fileViewerSearchState = { query: '', matches: [], index: -1 };
let fileViewerCodeMirror = null;
let suppressFileViewerEditorChange = false;
let fileViewerCodeMirrorReady = null;
let activeTabId = 'chat';
let inNewChatMode = false;
let deleteArmed = false;
let authMode = 'login';
let pendingInferenceCount = 0;
let activeInferenceRequest = null;
let inferenceIdleResolvers = [];
// In-flight agent inference fetches, so cancel/abort can actually stop them.
const inFlightInferenceControllers = new Set();
function abortAllInFlightInferenceControllers(reason = 'cancelled') {
  inFlightInferenceControllers.forEach((c) => { try { c.abort(reason); } catch (_) { /* noop */ } });
  inFlightInferenceControllers.clear();
}
const thinkingStartedByChatId = new Map();
const pendingPreflightConfirmations = new Map();
const smartTitleRenamePending = new Set();
let notificationContainer = null;
let urlContextMode = 'chat';
let pendingAttachments = [];
let pendingNewChatAttachments = [];
let pendingManualContext = '';
let authStore = {
  users: [],
  currentUser: null,
};
let appSettings = {
  inferenceProvider: 'local',
  workMode: 'coding',
  huggingFaceToken: '',
  huggingFaceModel: 'Qwen/Qwen2.5-Coder-32B-Instruct:fastest',
  customOpenAiApiKey: '',
  customOpenAiModel: 'google/gemma-4-E2B-it',
  customOpenAiEndpoint: '',
  openAiApiKey: '',
  openAiModel: 'gpt-5.4',
  anthropicApiKey: '',
  anthropicModel: 'claude-opus-4-1-20250805',
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-pro',
  deepseekApiKey: '',
  deepseekModel: 'deepseek-v4-flash',
  veniceApiKey: '',
  veniceModel: 'venice-uncensored-1-2',
  modelUrl: '',
  keepModelOnUpdate: true,
  debugTraceEnabled: false,
};
const inferenceProviderDefs = {
  local: {
    label: 'Local Model',
  },
  huggingface: {
    label: 'Hugging Face Test',
    keyField: 'huggingFaceToken',
    modelField: 'huggingFaceModel',
    keyLabel: 'Hugging Face Token',
    keyPlaceholder: 'hf_...',
    modelPlaceholder: 'Qwen/Qwen2.5-Coder-32B-Instruct:fastest',
    defaultModel: 'Qwen/Qwen2.5-Coder-32B-Instruct:fastest',
    helpText: 'Uses Hugging Face Inference Providers via router.huggingface.co. Token stays in local app settings on this machine. You can also enter a custom Hugging Face model ID to A/B test agent prompts without changing the local runtime.',
    endpointUrl: 'https://router.huggingface.co/v1/chat/completions',
    protocol: 'openai',
  },
  customopenai: {
    label: 'Custom OpenAI-Compatible',
    keyField: 'customOpenAiApiKey',
    modelField: 'customOpenAiModel',
    endpointField: 'customOpenAiEndpoint',
    keyLabel: 'Provider API Key',
    keyPlaceholder: 'sk-...',
    endpointLabel: 'Endpoint URL',
    endpointPlaceholder: 'https://example.com/v1/chat/completions',
    modelPlaceholder: 'google/gemma-4-E2B-it',
    defaultModel: 'google/gemma-4-E2B-it',
    defaultEndpoint: '',
    helpText: 'Uses any OpenAI-compatible chat completion endpoint. This is the fastest path to A/B test hosted Gemma 4 E2B in agent mode before downloading a local model.',
    endpointUrl: '',
    protocol: 'openai',
  },
  openai: {
    label: 'OpenAI API',
    keyField: 'openAiApiKey',
    modelField: 'openAiModel',
    keyLabel: 'OpenAI API Key',
    keyPlaceholder: 'sk-...',
    modelPlaceholder: 'gpt-5.4',
    defaultModel: 'gpt-5.4',
    helpText: 'Uses the official OpenAI Chat Completions API. Token stays in local app settings on this machine.',
    endpointUrl: 'https://api.openai.com/v1/chat/completions',
    protocol: 'openai',
    supportsToolCalling: true,
  },
  anthropic: {
    label: 'Claude API',
    keyField: 'anthropicApiKey',
    modelField: 'anthropicModel',
    keyLabel: 'Anthropic API Key',
    keyPlaceholder: 'sk-ant-...',
    modelPlaceholder: 'claude-opus-4-1-20250805',
    defaultModel: 'claude-opus-4-1-20250805',
    helpText: 'Uses Anthropic Messages streaming. Token stays in local app settings on this machine.',
    endpointUrl: 'https://api.anthropic.com/v1/messages',
    protocol: 'anthropic',
  },
  gemini: {
    label: 'Gemini API',
    keyField: 'geminiApiKey',
    modelField: 'geminiModel',
    keyLabel: 'Gemini API Key',
    keyPlaceholder: 'AIza...',
    modelPlaceholder: 'gemini-2.5-pro',
    defaultModel: 'gemini-2.5-pro',
    helpText: 'Uses Gemini\'s OpenAI-compatible endpoint. Key stays in local app settings on this machine.',
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    protocol: 'openai',
    supportsToolCalling: true,
  },
  deepseek: {
    label: 'DeepSeek API',
    keyField: 'deepseekApiKey',
    modelField: 'deepseekModel',
    keyLabel: 'DeepSeek API Key',
    keyPlaceholder: 'sk-...',
    modelPlaceholder: 'deepseek-v4-flash',
    defaultModel: 'deepseek-v4-flash',
    helpText: 'Uses DeepSeek\'s OpenAI-compatible chat API. Key stays in local app settings on this machine.',
    endpointUrl: 'https://api.deepseek.com/chat/completions',
    protocol: 'openai',
    supportsToolCalling: true,
  },
  venice: {
    label: 'Venice API',
    keyField: 'veniceApiKey',
    modelField: 'veniceModel',
    keyLabel: 'Venice API Key',
    keyPlaceholder: 'via_...',
    modelPlaceholder: 'venice-uncensored-1-2',
    defaultModel: 'venice-uncensored-1-2',
    helpText: 'Uses Venice\'s OpenAI-compatible API. Key stays in local app settings on this machine.',
    endpointUrl: 'https://api.venice.ai/api/v1/chat/completions',
    protocol: 'openai',
    supportsToolCalling: true,
  },
};
const inferenceProviderModelPresets = {
  huggingface: [
    'google/gemma-4-E2B-it',
    'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8:fastest',
    'deepseek-ai/DeepSeek-V3-0324:fastest',
    'moonshotai/Kimi-K2-Instruct:fastest',
    'Qwen/Qwen2.5-Coder-32B-Instruct:fastest',
    'meta-llama/Llama-3.3-70B-Instruct:fireworks-ai',
    'deepseek-ai/DeepSeek-V3-0324:novita',
  ],
  customopenai: [
    'google/gemma-4-E2B-it',
  ],
  openai: [
    'gpt-5.4',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
  ],
  anthropic: [
    'claude-opus-4-1-20250805',
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-latest',
    'claude-3-5-haiku-latest',
    'claude-3-haiku-20240307',
  ],
  gemini: [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3-flash-preview',
  ],
  deepseek: [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-chat',
    'deepseek-reasoner',
  ],
  // Fallback only — the live list is fetched from the user's Venice key at runtime
  // (refreshProviderModelList). These are verified-valid IDs as of 2026-06.
  venice: [
    'venice-uncensored-1-2',
    'qwen3-coder-480b-a35b-instruct-turbo',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'qwen3-235b-a22b-instruct-2507',
    'claude-opus-4-8',
    'zai-org-glm-5',
    'gemma-4-uncensored',
    'qwen3-next-80b',
    'hermes-3-llama-3.1-405b',
  ],
};
let debugTraceEntries = [];
const debugTraceMaxEntries = 120;
const maxArtifactContentChars = 12000;
const maxPendingAttachments = 6;
const maxAttachmentTextChars = 7000;
const AI_EXE_APP_CONFIG = (window.AI_EXE_UI_CONFIG && window.AI_EXE_UI_CONFIG.app) || {};
const AI_EXE_VERSION = String(AI_EXE_APP_CONFIG.version || 'dev');
const AI_EXE_BUILD = String(AI_EXE_APP_CONFIG.buildLabel || `v${AI_EXE_VERSION}`);
try {
  console.log('%cAI.EXE build ' + AI_EXE_BUILD, 'color:#4ad; font-weight:bold;');
  const applyBuildVer = () => {
    document.querySelectorAll('[data-app-version]').forEach((el) => {
      el.textContent = `v${AI_EXE_VERSION}`;
      el.title = AI_EXE_BUILD;
    });
  };
  applyBuildVer(); // element is above this script, so usually set right away
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', applyBuildVer);
  }
  window.addEventListener('load', applyBuildVer); // re-apply if the topbar re-renders
} catch (_) {}

// In-app update check: compare our version to the latest public GitHub Release and
// surface an "Update" badge. Clicking it runs the native auto-updater (download +
// swap + relaunch) on the desktop app, or opens the release page as a fallback.
(function setupUpdateCheck() {
  const REPO = 'AbatChan/AI.EXE';
  const cmpVer = (a, b) => {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  };
  let updateInfo = null;
  const ulog = (event, fields) => {
    try { if (typeof recordDebugTrace === 'function') recordDebugTrace(event, fields || {}, fields || {}); } catch (_) {}
    try { console.log(`[update] ${event}`, fields || {}); } catch (_) {}
  };
  async function checkForUpdate() {
    ulog('update_check_start', { current: AI_EXE_VERSION, repo: REPO });
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res || !res.ok) {
        ulog('update_check_http_fail', { status: String(res && res.status), ok: String(res && res.ok) });
        return;
      }
      const data = await res.json();
      const latest = String(data.tag_name || '').replace(/^v/i, '').trim();
      const newer = latest ? cmpVer(latest, AI_EXE_VERSION) : 0;
      const asset = Array.isArray(data.assets)
        ? data.assets.find((a) => /\.zip$/i.test(a && a.name || ''))
        : null;
      ulog('update_check_result', {
        current: AI_EXE_VERSION,
        latest: latest || '(none)',
        isNewer: String(newer > 0),
        hasAsset: String(Boolean(asset)),
        badgeEl: String(Boolean(document.getElementById('updateBadge'))),
      });
      if (!latest || newer <= 0) return;
      updateInfo = {
        version: latest,
        url: asset ? asset.browser_download_url : '',
        page: data.html_url || '',
      };
      const badge = document.getElementById('updateBadge');
      const text = document.getElementById('updateBadgeText');
      if (badge) {
        if (text) text.textContent = `Update to v${latest}`;
        badge.style.display = '';
        badge.title = `Version ${latest} is available — click to update`;
        ulog('update_badge_shown', { latest });
      }
    } catch (err) {
      ulog('update_check_error', { error: String(err && err.message ? err.message : err) });
    }
  }
  function onBadgeClick() {
    if (!updateInfo) return;
    const badge = document.getElementById('updateBadge');
    const text = document.getElementById('updateBadgeText');
    const nativeOk = typeof nativeBridge !== 'undefined'
      && nativeBridge && nativeBridge.available && nativeBridge.available();
    if (nativeOk && updateInfo.url) {
      if (text) text.textContent = 'Updating…';
      if (badge) badge.disabled = true;
      // Native handler downloads the new build, swaps files, and relaunches.
      nativeBridge.invoke('applyUpdate', { url: updateInfo.url, version: updateInfo.version });
    } else if (updateInfo.page) {
      window.open(updateInfo.page, '_blank');
    }
  }
  const startUpdateChecks = () => {
    const badge = document.getElementById('updateBadge');
    if (badge) badge.addEventListener('click', onBadgeClick);
    setTimeout(checkForUpdate, 2500);
    setInterval(checkForUpdate, 30 * 60 * 1000);
  };
  // Run even if 'load' already fired before this script executed (otherwise the
  // listener never fires and the check never runs).
  if (document.readyState === 'complete') startUpdateChecks();
  else window.addEventListener('load', startUpdateChecks);
})();
// Step budget. 16 was too tight for multi-item tasks (e.g. a 3-item checklist):
// inspection + a couple of failed edit-anchor retries exhausted it before the
// agent finished every item. The mechanical guards (inspection-budget, read-loop,
// circuit breaker) still bound bad loops, so the extra headroom mostly helps
// legitimate multi-step work reach completion.
const agentMaxSteps = 24;
// Read window. Sized so a typical single app file (HTML/CSS/JS up to ~25KB) is
// returned whole in one read instead of being truncated — truncation forced the
// model to page through the tail, which the read-loop guard then blocked, so it
// never saw the rest. Files larger than this still paginate (and the range-aware
// guard allows that), but the common case now needs no paging at all.
const agentMaxToolOutputChars = 26000;
const agentStepTimeoutMs = 45000;
// Tool execution can run its own (slow) content-generation inference; bound it so a
// stalled write/edit can't hang the agent loop. This is now an IDLE limit, not a
// flat wall-clock: a large file is generated in several sequential inference passes,
// and a flat 150s wrongly killed a legitimately long (but progressing) generation.
// generateFullAgentFile heartbeats markAgentToolProgress() after each pass, so the
// loop only abandons a tool that makes NO progress for this long (a true hang).
const agentToolTimeoutMs = 150000;
const agentToolIdleTimeoutMs = 130000;
const agentToolHardCapMs = 420000;
const agentTotalTimeoutMs = 600000;
// Heartbeat for in-progress tool generation (loop's idle watchdog reads this).
let lastAgentToolProgressAt = 0;
function markAgentToolProgress() { lastAgentToolProgressAt = Date.now(); }
function getLastAgentToolProgressAt() { return lastAgentToolProgressAt; }
// Live file-write streaming: hold the partial content of the file being generated
// so the work panel can render it filling in. Committed by write_file separately.
// The model often wraps streamed file content in a ```lang fence; the committed
// file is de-fenced by sanitizeAgentGeneratedFileContent, but the LIVE stream
// showed the raw fence. Strip a leading wrapper fence (and its closer) for display
// only — and only when a leading fence is present, so genuine markdown is untouched.
function stripStreamDisplayFences(text) {
  const s = String(text || '');
  const lead = s.match(/^﻿?\s*```[a-z0-9]*[^\n]*\n/i);
  if (!lead) return s;
  return s.slice(lead[0].length).replace(/\n?```\s*$/i, '');
}
function updateAgentStreamingFile(path, content) {
  if (!activeAgentStreamState) return;
  const prev = activeAgentStreamState.streamingFile;
  if (!prev || prev.path !== String(path || '')) {
    recordDebugTrace('agent_stream_file_begin', {
      chatId: String(activeAgentStreamState.chatId || ''),
      path: String(path || ''),
    });
  }
  activeAgentStreamState.streamingFile = { path: String(path || ''), content: stripStreamDisplayFences(content) };
  scheduleLiveStreamRender();
}
function clearAgentStreamingFile() {
  if (!activeAgentStreamState || !activeAgentStreamState.streamingFile) return;
  const sf = activeAgentStreamState.streamingFile;
  recordDebugTrace('agent_stream_file_done', {
    path: String(sf.path || ''),
    streamedChars: String(String(sf.content || '').length),
    streamedLines: String(String(sf.content || '').split('\n').length),
  });
  activeAgentStreamState.streamingFile = null;
  scheduleLiveStreamRender();
}
const agentDecisionMaxTokens = 768;
const agentFileContentMaxTokens = 5000;
// Local GGUF context window (matches the native --ctx-size launch arg in
// inference_engine.cpp). A single file-generation call's output must leave room for
// the prompt within this.
const agentLocalContextTokens = 32768;
// Per-provider single-call output ceiling for file generation. Remote models have
// large context windows, so the old flat 5000 needlessly truncated them; the
// continuation loop still stitches anything that overflows a single call.
const agentFileOutputCeilings = {
  openai: 32000,
  anthropic: 32000,
  gemini: 32000,
  huggingface: 16000,
  customopenai: 8000,
  deepseek: 16000,
  venice: 32000,
};
const agentPlannerEndpoint = devPlannerEnabled ? 'http://127.0.0.1:8765/plan' : '';
const agentPlannerRequestTimeoutMs = 7000;
const agentFileGenerationRequestTimeoutMs = 120000;
const chatAutoScrollThresholdPx = 56;
const autoContinuationMaxPasses = 1;
const continuationTailChars = 700;
const autoContinuingChatIds = new Set();
const attachAcceptTypes = '.txt,.md,.markdown,.json,.yaml,.yml,.csv,.tsv,.log,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.cpp,.c,.h,.hpp,.java,.go,.rs,.rb,.php,.sql,.xml,.html,.css,.scss,.sass,.less,.sh,.bash,.zsh,.fish,.ini,.toml,.conf,.env,.dockerfile,.makefile,.cmake,.pdf,.doc,.docx,.rtf';

function nowTs() {
  return Date.now();
}

function getPendingPreflightConfirmation(chatId) {
  return pendingPreflightConfirmations.get(String(chatId || '')) || null;
}

function setPendingPreflightConfirmation(chatId, payload) {
  const key = String(chatId || '');
  if (!key) return;
  const chat = findChatById(key);
  if (!payload || typeof payload !== 'object') {
    pendingPreflightConfirmations.delete(key);
    if (chat) {
      chat.pendingPreflightConfirmation = null;
      chat.updatedAt = nowTs();
      saveChats();
    }
    if (key === String(activeChatId || '')) {
      composerConfirmSelectedIndex = 0;
      renderComposerConfirmationUi();
    }
    return;
  }
  const nextPending = {
    kind: String(payload.kind || 'confirm').trim() || 'confirm',
    originalTask: String(payload.originalTask || '').trim(),
    userMessage: String(payload.userMessage || '').trim(),
    workspaceOpen: payload.workspaceOpen === false ? false : Boolean(payload.workspaceOpen),
    midFlightAgentResume: Boolean(payload.midFlightAgentResume),
    createdAt: nowTs(),
  };
  pendingPreflightConfirmations.set(key, nextPending);
  if (chat) {
    chat.pendingPreflightConfirmation = { ...nextPending };
    chat.updatedAt = Math.max(Number(chat.updatedAt) || 0, Number(nextPending.createdAt) || nowTs());
    saveChats();
  }
  if (key === String(activeChatId || '')) {
    composerConfirmSelectedIndex = 0;
    renderComposerConfirmationUi();
  }
}

async function resolvePendingPreflightConfirmation(chatId, latestUserMessage) {
  const pending = getPendingPreflightConfirmation(chatId);
  if (!pending) return null;
  const latest = String(latestUserMessage || '').trim();
  if (!latest) return null;
  const prompt = [
    'Return exactly one JSON object. No prose.',
    'Keys: resolution, rewrittenPrompt',
    'resolution must be one of: create_new_project, use_existing_workspace, cancelled, unresolved',
    'Interpret the latest user message in the context of the pending confirmation below.',
    'If the user is agreeing to create a new project, return create_new_project.',
    'If the user wants to use or open an existing folder or workspace, return use_existing_workspace.',
    'If the user is declining or cancelling, return cancelled.',
    'If the user answer is still ambiguous, return unresolved.',
    'When resolution is create_new_project or use_existing_workspace, provide a rewrittenPrompt that merges the original task with that resolved choice.',
    '',
    `Pending confirmation message:\n${String(pending.userMessage || '').trim()}`,
    '',
    `Original task:\n${String(pending.originalTask || '').trim()}`,
    '',
    `Latest user reply:\n${latest}`,
    '',
    'JSON:',
  ].join('\n');

  let parsed = null;
  const remote = await requestSelectedRemoteTextCompletion(prompt, 120);
  parsed = extractFirstJsonObject(remote && remote.ok ? remote.output : '');
  if (!parsed && nativeBridge.available()) {
    const nativeRes = await nativeBridge.invoke('infer', {
      prompt,
      maxTokens: 120,
      max_tokens: 120,
    });
    parsed = extractFirstJsonObject(nativeRes && nativeRes.ok ? nativeRes.output : '');
  }
  const resolution = ['create_new_project', 'use_existing_workspace', 'cancelled', 'unresolved'].includes(String(parsed && parsed.resolution || '').toLowerCase())
    ? String(parsed.resolution).toLowerCase()
    : 'unresolved';
  if (resolution === 'unresolved') {
    const lower = latest.toLowerCase();
    if (/^(yes|yeah|yep|sure|ok|okay|absolutely|definitely|please do|go ahead|do it|yes sure|affirmative)\b/.test(lower)) {
      setPendingPreflightConfirmation(chatId, null);
      return {
        resolved: true,
        mode: 'create_new_project',
        rewrittenPrompt: `${pending.originalTask || latest}\n\nCreate a new project for this request.`,
      };
    }
    if (/\b(open|use)\b[\s\S]*\b(existing|current)\b[\s\S]*\b(folder|project|workspace)\b/.test(lower)) {
      setPendingPreflightConfirmation(chatId, null);
      return {
        resolved: true,
        mode: 'use_existing_workspace',
        rewrittenPrompt: `${pending.originalTask || latest}\n\nUse the existing folder or workspace instead of creating a new project.`,
      };
    }
    if (/^(no|nope|cancel|never mind|stop)\b/.test(lower)) {
      setPendingPreflightConfirmation(chatId, null);
      return {
        resolved: true,
        mode: 'cancelled',
      };
    }
  }
  if (resolution === 'unresolved') return null;
  setPendingPreflightConfirmation(chatId, null);
  if (resolution === 'cancelled') {
    return { resolved: true, mode: 'cancelled' };
  }
  const rewrittenPrompt = String(parsed && parsed.rewrittenPrompt ? parsed.rewrittenPrompt : '').trim()
    || (resolution === 'create_new_project'
      ? `${pending.originalTask || latest}\n\nCreate a new project for this request.`
      : `${pending.originalTask || latest}\n\nUse the existing folder or workspace instead of creating a new project.`);
  return {
    resolved: true,
    mode: resolution,
    rewrittenPrompt,
  };
}

function submitPendingPreflightChoice(chatId, mode) {
  if (pendingInferenceCount > 0) return false;
  const chat = findChatById(chatId);
  const pending = getPendingPreflightConfirmation(chatId);
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (!chat || !pending) return false;

  let rewrittenPrompt = '';
  if (normalizedMode === 'create_new_project') {
    rewrittenPrompt = `${pending.originalTask || ''}\n\nStart from a fresh workspace.`.trim();
  } else if (normalizedMode === 'use_existing_workspace') {
    rewrittenPrompt = `${pending.originalTask || ''}\n\n[System Note: The user chose to use the current open workspace. Do not call new_project. If this is a request to build an app, generate the expected files directly in this workspace.]`.trim();
  } else {
    return false;
  }

  recordDebugTrace('preflight_confirmation_choice_submitted', {
    chatId: String(chatId || ''),
    mode: normalizedMode,
    taskPreview: debugPreview(String(pending.originalTask || ''), 220),
  }, {
    chatId: String(chatId || ''),
    mode: normalizedMode,
    pendingConfirmation: pending,
    workspace: getWorkspaceDebugSnapshot(),
  });

  setPendingPreflightConfirmation(chatId, null);
  enterChatView();
  chatAutoScrollPinned = true;
  beginInferenceRequest();

  const isCreateNewProject = normalizedMode === 'create_new_project';
  const isUseExistingWorkspace = normalizedMode === 'use_existing_workspace';
  const startReply = () => {
    void requestAssistantReply(chat.id, String(pending.originalTask || '').trim() || rewrittenPrompt, true, {
      latestUserOverride: String(pending.originalTask || '').trim() || rewrittenPrompt,
      preflightChoiceResolved: normalizedMode,
      approvedNewProject: isCreateNewProject,
      skipNewProjectConfirmation: isCreateNewProject,
      forceCurrentWorkspace: isUseExistingWorkspace,
    });
  };

  // NOTE: read the live workspace via the accessor. There is no `workspace`
  // variable in this scope — referencing one here used to throw ReferenceError
  // right after beginInferenceRequest(), stranding the spinner forever (the close
  // branch was never even reached).
  const currentWorkspaceSnapshot = getWorkspaceDebugSnapshot();
  if (isCreateNewProject && currentWorkspaceSnapshot && currentWorkspaceSnapshot.workspaceRootName) {
    // Close the existing workspace before handing off to the agent so the
    // planner sees a clean state from step 1 rather than wasting steps
    // reading old workspace files before the new_project tool runs.
    recordDebugTrace('preflight_close_workspace_started', {
      chatId: String(chatId || ''),
      workspaceRootName: String(currentWorkspaceSnapshot.workspaceRootName || ''),
    }, { chatId: String(chatId || '') });
    // Guard the native close with a timeout so a stalled bridge can never leave
    // the UI stuck in an infinite "thinking" state.
    Promise.race([
      Promise.resolve(invokeWorkspaceAction('workspaceCloseRoot', {})),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timedOut: true }), 10000)),
    ]).then((closeRes) => {
      recordDebugTrace('preflight_preflight_close_workspace_result', {
        chatId: String(chatId || ''),
        ok: Boolean(closeRes && closeRes.ok),
        timedOut: Boolean(closeRes && closeRes.timedOut),
      }, { closeRes });
      if (closeRes && closeRes.ok) {
        resetWorkspaceForNewProject();
        startReply();
      } else {
        // Close failed/stalled — do not start the agent with a live workspace.
        // The executor would retry close, but starting here risks the planner
        // inspecting the wrong project. Surface the error and let the user retry.
        endInferenceRequest();
        showAppNotification({
          message: closeRes && closeRes.timedOut
            ? 'Closing the current workspace timed out. Please close it manually and try again.'
            : 'Could not close the current workspace. Please try again.',
          kind: 'error',
        });
      }
    }).catch(() => {
      endInferenceRequest();
      showAppNotification({ message: 'Could not close the current workspace. Please try again.', kind: 'error' });
    });
  } else {
    startReply();
  }
  return true;
}

function dismissPendingPreflightChoice(chatId, options = {}) {
  const key = String(chatId || '');
  const pending = getPendingPreflightConfirmation(key);
  if (!pending) return false;
  if (typeof activeProjectScopeResolve === 'function') {
    activeProjectScopeResolve(null);
    activeProjectScopeResolve = null;
  }
  setPendingPreflightConfirmation(key, null);
  resolveChatNamingFallback(key, 'New Chat');
  recordDebugTrace('preflight_confirmation_dismissed', {
    chatId: key,
    taskPreview: debugPreview(String(pending.originalTask || ''), 220),
  }, {
    chatId: key,
    pendingConfirmation: pending,
    via: String(options && options.via ? options.via : 'dismiss'),
  });
  if (!options || options.focusInput !== false) {
    requestAnimationFrame(() => {
      if (mainInput) mainInput.focus();
    });
  }
  return true;
}

function getScrollBottomDistance(element) {
  if (!element) return 0;
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

function isElementNearBottom(element, thresholdPx = chatAutoScrollThresholdPx) {
  if (!element) return true;
  return getScrollBottomDistance(element) <= Math.max(0, Number(thresholdPx) || 0);
}

function shouldShowChatScrollDownButton() {
  if (!chatArea || middleViewMode !== 'chat') return false;
  if (inNewChatMode) return false;
  if (getScrollBottomDistance(chatArea) <= Math.max(72, chatAutoScrollThresholdPx)) return false;
  return chatArea.scrollHeight > (chatArea.clientHeight + 24);
}

function updateChatScrollDownButtonVisibility() {
  if (!chatScrollDownBtn) return;
  const show = shouldShowChatScrollDownButton();
  chatScrollDownBtn.classList.toggle('visible', show);
  chatScrollDownBtn.classList.toggle('hidden', !show);
  chatScrollDownBtn.disabled = !show;
  chatScrollDownBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function withProgrammaticChatScroll(fn) {
  if (typeof fn !== 'function') return;
  chatProgrammaticScrollDepth += 1;
  try {
    fn();
  } finally {
    requestAnimationFrame(() => {
      chatProgrammaticScrollDepth = Math.max(0, chatProgrammaticScrollDepth - 1);
      chatAutoScrollPinned = isElementNearBottom(chatArea);
    });
  }
}

function scrollChatToBottom(force = false) {
  if (!chatArea) return;
  if (!force && !chatAutoScrollPinned) {
    updateChatScrollDownButtonVisibility();
    return;
  }
  withProgrammaticChatScroll(() => {
    chatArea.scrollTop = chatArea.scrollHeight;
  });
  chatAutoScrollPinned = true;
  updateChatScrollDownButtonVisibility();
}

function restoreChatScrollPosition(distanceFromBottom = 0) {
  if (!chatArea) return;
  const safeDistance = Math.max(0, Number(distanceFromBottom) || 0);
  withProgrammaticChatScroll(() => {
    chatArea.scrollTop = Math.max(0, chatArea.scrollHeight - chatArea.clientHeight - safeDistance);
  });
  updateChatScrollDownButtonVisibility();
}

function syncStreamingCodeBlockScroll(container, force = false) {
  if (!container) return;
  if (!force && !chatAutoScrollPinned) return;
  container.querySelectorAll('.code-block').forEach((block) => {
    block.scrollTop = block.scrollHeight;
  });
}

if (chatArea) {
  chatArea.addEventListener('scroll', () => {
    if (chatProgrammaticScrollDepth > 0) return;
    chatAutoScrollPinned = isElementNearBottom(chatArea);
    updateChatScrollDownButtonVisibility();
  }, { passive: true });
}

if (chatScrollDownBtn) {
  chatScrollDownBtn.addEventListener('click', () => {
    if (!chatArea) return;
    chatAutoScrollPinned = true;
    withProgrammaticChatScroll(() => {
      chatArea.scrollTo({
        top: chatArea.scrollHeight,
        behavior: 'smooth',
      });
    });
    updateChatScrollDownButtonVisibility();
  });
}

function makeMessageActionIcon(kind) {
  if (kind === 'edit') {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"></path>
      </svg>
    `;
  }
  if (kind === 'retry') {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 12a9 9 0 1 0 3-6.7"></path>
        <polyline points="3 3 3 9 9 9"></polyline>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
}

function applyCustomTooltip(target, fallback = '') {
  if (!target) return;
  if (
    target.classList.contains('panel-resizer')
    || target.classList.contains('sidebar-toggle')
    || target.classList.contains('explorer-help-btn')
    || target.classList.contains('iact-btn')
    || target.classList.contains('send-btn')
  ) {
    return;
  }
  const text = String(
    target.dataset.tooltip
    || target.getAttribute('title')
    || target.getAttribute('aria-label')
    || fallback
    || ''
  ).trim();
  if (!text) return;
  target.dataset.tooltip = text;
  target.classList.add('ui-tooltip-anchor');
  if (target.hasAttribute('title')) {
    target.removeAttribute('title');
  }
}

function hydrateCustomTooltips(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const selectors = [
    'button[title]',
    'button[aria-label]',
    '.col-icon[title]',
    '.avatar-btn[title]',
    '.artifact-open-chat-btn[title]',
    '.artifact-delete-btn[title]',
  ];
  root.querySelectorAll(selectors.join(',')).forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    applyCustomTooltip(node);
  });
}

let globalTooltipEl = null;
let globalTooltipLabelEl = null;
let globalTooltipArrowEl = null;
let activeTooltipTarget = null;

function ensureGlobalTooltip() {
  if (globalTooltipEl && globalTooltipLabelEl && globalTooltipArrowEl) {
    return globalTooltipEl;
  }
  const el = document.createElement('div');
  el.className = 'ui-global-tooltip';
  el.setAttribute('aria-hidden', 'true');
  const label = document.createElement('div');
  label.className = 'ui-global-tooltip-label';
  const arrow = document.createElement('div');
  arrow.className = 'ui-global-tooltip-arrow';
  el.appendChild(label);
  el.appendChild(arrow);
  document.body.appendChild(el);
  globalTooltipEl = el;
  globalTooltipLabelEl = label;
  globalTooltipArrowEl = arrow;
  return el;
}

function hideGlobalTooltip() {
  activeTooltipTarget = null;
  if (!globalTooltipEl) return;
  globalTooltipEl.classList.remove('visible');
  globalTooltipEl.setAttribute('aria-hidden', 'true');
}

function updateGlobalTooltipPosition(target) {
  if (!target) return;
  if (!(target instanceof HTMLElement) || !target.isConnected) {
    hideGlobalTooltip();
    return;
  }
  const tooltip = ensureGlobalTooltip();
  const text = String(target.dataset.tooltip || '').trim();
  if (!text) {
    hideGlobalTooltip();
    return;
  }

  globalTooltipLabelEl.textContent = text;
  tooltip.dataset.placement = 'bottom';
  tooltip.style.left = '-9999px';
  tooltip.style.top = '-9999px';
  tooltip.classList.add('visible');
  tooltip.setAttribute('aria-hidden', 'false');

  const rect = target.getBoundingClientRect();
  const tipRect = tooltip.getBoundingClientRect();
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
  const gap = 12;
  const edge = 10;
  const arrowInset = 14;

  const spaceTop = rect.top;
  const spaceBottom = viewportH - rect.bottom;
  const spaceLeft = rect.left;
  const spaceRight = viewportW - rect.right;

  let placement = 'bottom';
  if (spaceBottom >= tipRect.height + gap) {
    placement = 'bottom';
  } else if (spaceTop >= tipRect.height + gap) {
    placement = 'top';
  } else if (spaceRight >= tipRect.width + gap) {
    placement = 'right';
  } else if (spaceLeft >= tipRect.width + gap) {
    placement = 'left';
  } else {
    placement = spaceBottom >= spaceTop ? 'bottom' : 'top';
  }

  let left = 0;
  let top = 0;
  let arrowX = tipRect.width / 2;
  let arrowY = tipRect.height / 2;

  if (placement === 'top' || placement === 'bottom') {
    left = rect.left + (rect.width / 2) - (tipRect.width / 2);
    left = Math.min(Math.max(left, edge), Math.max(edge, viewportW - tipRect.width - edge));
    top = placement === 'top'
      ? rect.top - tipRect.height - gap
      : rect.bottom + gap;
    arrowX = Math.min(Math.max((rect.left + rect.width / 2) - left, arrowInset), tipRect.width - arrowInset);
  } else {
    top = rect.top + (rect.height / 2) - (tipRect.height / 2);
    top = Math.min(Math.max(top, edge), Math.max(edge, viewportH - tipRect.height - edge));
    left = placement === 'right'
      ? rect.right + gap
      : rect.left - tipRect.width - gap;
    arrowY = Math.min(Math.max((rect.top + rect.height / 2) - top, arrowInset), tipRect.height - arrowInset);
  }

  tooltip.dataset.placement = placement;
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.style.setProperty('--tooltip-arrow-x', `${Math.round(arrowX)}px`);
  tooltip.style.setProperty('--tooltip-arrow-y', `${Math.round(arrowY)}px`);
}

function showGlobalTooltip(target) {
  if (!target || !(target instanceof HTMLElement)) return;
  activeTooltipTarget = target;
  updateGlobalTooltipPosition(target);
}

function initGlobalTooltipSystem() {
  ensureGlobalTooltip();

  document.addEventListener('mousemove', (evt) => {
    const target = evt.target instanceof Element
      ? evt.target.closest('.ui-tooltip-anchor[data-tooltip]')
      : null;
    if (!(target instanceof HTMLElement)) {
      if (activeTooltipTarget) hideGlobalTooltip();
      return;
    }
    if (target === activeTooltipTarget) return;
    showGlobalTooltip(target);
  });

  document.addEventListener('mouseleave', () => {
    hideGlobalTooltip();
  }, true);

  document.addEventListener('pointerdown', () => {
    hideGlobalTooltip();
  });

  document.addEventListener('focusin', (evt) => {
    const target = evt.target instanceof Element
      ? evt.target.closest('.ui-tooltip-anchor[data-tooltip]')
      : null;
    if (!(target instanceof HTMLElement)) return;
    showGlobalTooltip(target);
  });

  document.addEventListener('focusout', (evt) => {
    if (!activeTooltipTarget) return;
    const related = evt.relatedTarget instanceof Node ? evt.relatedTarget : null;
    if (related && activeTooltipTarget.contains(related)) return;
    hideGlobalTooltip();
  });

  window.addEventListener('resize', () => {
    if (activeTooltipTarget) {
      updateGlobalTooltipPosition(activeTooltipTarget);
    }
  });

  window.addEventListener('scroll', () => {
    if (activeTooltipTarget) {
      updateGlobalTooltipPosition(activeTooltipTarget);
    }
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hideGlobalTooltip();
      persistFileTabsStateNow();
      return;
    }
    void refreshWorkspaceFromExternalChange('visibility_return');
  });

  window.addEventListener('focus', () => {
    void refreshWorkspaceFromExternalChange('window_focus');
  });

  startWorkspaceExternalRefreshLoop();
}

function placeComposerText(text) {
  if (!mainInput) return;
  const value = String(text || '').trim();
  if (!value) return;
  if (activeChatId) {
    enterChatView();
  }
  mainInput.value = value;
  autoResize(mainInput);
  mainInput.focus();
  const end = mainInput.value.length;
  if (typeof mainInput.setSelectionRange === 'function') {
    mainInput.setSelectionRange(end, end);
  }
}

let editingMessageState = null;

function makeBranchGroupId() {
  return `branch_${nowTs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeThreadId() {
  return `thread_${nowTs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function cloneThreadState(source, overrides = {}) {
  const thread = source && typeof source === 'object' ? source : {};
  return {
    id: String(thread.id || makeThreadId()),
    messages: Array.isArray(thread.messages)
      ? thread.messages.map((msg) => {
        if (!msg) return msg;
        const next = { ...msg };
        if (msg.role === 'ai') {
          next.agentActivities = cloneAgentActivities(msg.agentActivities);
          next.agentMeta = cloneAgentMeta(msg.agentMeta);
        }
        return next;
      })
      : [],
    branchLinks: normalizeBranchLinks(thread.branchLinks),
    pendingBranchLink: thread.pendingBranchLink && typeof thread.pendingBranchLink === 'object'
      ? {
        anchorTs: Number(thread.pendingBranchLink.anchorTs) || 0,
        groupId: String(thread.pendingBranchLink.groupId || '').trim(),
        order: Number(thread.pendingBranchLink.order) || 0,
        kind: String(thread.pendingBranchLink.kind || '').trim().toLowerCase(),
      }
      : null,
    needsContinue: Boolean(thread.needsContinue),
    ...overrides,
  };
}

function ensureChatThreadState(chat) {
  if (!chat || typeof chat !== 'object') return null;
  if (!Array.isArray(chat.threads) || !chat.threads.length) {
    const baseThread = cloneThreadState({
      id: makeThreadId(),
      messages: Array.isArray(chat.messages) ? chat.messages : [],
      branchLinks: chat.branchLinks,
      pendingBranchLink: chat.pendingBranchLink,
      needsContinue: chat.needsContinue,
    });
    chat.threads = [baseThread];
    chat.activeThreadId = baseThread.id;
  }
  const active = chat.threads.find((thread) => String(thread.id || '') === String(chat.activeThreadId || '')) || chat.threads[0];
  if (!active) return null;
  if (!chat.activeThreadId || String(chat.activeThreadId) !== String(active.id)) {
    chat.activeThreadId = active.id;
  }
  chat.messages = Array.isArray(active.messages) ? active.messages : [];
  chat.branchLinks = normalizeBranchLinks(active.branchLinks);
  if (active.pendingBranchLink && typeof active.pendingBranchLink === 'object') {
    chat.pendingBranchLink = {
      anchorTs: Number(active.pendingBranchLink.anchorTs) || 0,
      groupId: String(active.pendingBranchLink.groupId || '').trim(),
      order: Number(active.pendingBranchLink.order) || 0,
      kind: String(active.pendingBranchLink.kind || '').trim().toLowerCase(),
    };
  } else {
    delete chat.pendingBranchLink;
  }
  chat.needsContinue = Boolean(active.needsContinue);
  return active;
}

function getChatActiveThread(chat) {
  return ensureChatThreadState(chat);
}

function syncChatFromThread(chat, thread) {
  if (!chat || !thread) return;
  chat.activeThreadId = String(thread.id || '');
  chat.messages = Array.isArray(thread.messages) ? thread.messages : [];
  chat.branchLinks = normalizeBranchLinks(thread.branchLinks);
  if (thread.pendingBranchLink && typeof thread.pendingBranchLink === 'object') {
    chat.pendingBranchLink = {
      anchorTs: Number(thread.pendingBranchLink.anchorTs) || 0,
      groupId: String(thread.pendingBranchLink.groupId || '').trim(),
      order: Number(thread.pendingBranchLink.order) || 0,
      kind: String(thread.pendingBranchLink.kind || '').trim().toLowerCase(),
    };
  } else {
    delete chat.pendingBranchLink;
  }
  chat.needsContinue = Boolean(thread.needsContinue);
}

function normalizeBranchLinks(list) {
  return Array.from(list || [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const messageTs = Number(item.messageTs) || 0;
      const groupId = String(item.groupId || '').trim();
      const order = Number.isFinite(Number(item.order)) ? Number(item.order) : 0;
      const kind = String(item.kind || '').trim().toLowerCase();
      if (!messageTs || !groupId) return null;
      return { messageTs, groupId, order, kind: kind === 'retry' ? 'retry' : (kind === 'edit' ? 'edit' : '') };
    })
    .filter(Boolean);
}

function getChatBranchLink(chat, messageTs) {
  const target = chat && typeof chat === 'object' ? chat : null;
  if (!target || !Array.isArray(target.branchLinks)) return null;
  const targetTs = Number(messageTs) || 0;
  return target.branchLinks.find((item) => Number(item && item.messageTs) === targetTs) || null;
}

function setChatBranchLink(chat, messageTs, groupId, order, kind = '') {
  const target = chat && typeof chat === 'object' ? chat : null;
  if (!target) return;
  const targetTs = Number(messageTs) || 0;
  const cleanGroupId = String(groupId || '').trim();
  const cleanKind = String(kind || '').trim().toLowerCase();
  if (!targetTs || !cleanGroupId) return;
  const links = normalizeBranchLinks(target.branchLinks);
  const next = links.filter((item) => Number(item.messageTs) !== targetTs);
  next.push({
    messageTs: targetTs,
    groupId: cleanGroupId,
    order: Number.isFinite(Number(order)) ? Number(order) : 0,
    kind: cleanKind === 'retry' ? 'retry' : (cleanKind === 'edit' ? 'edit' : ''),
  });
  target.branchLinks = next.sort((a, b) => a.messageTs - b.messageTs);
}

function getBranchLinkMap(thread) {
  const map = new Map();
  normalizeBranchLinks(thread && thread.branchLinks).forEach((item) => {
    map.set(Number(item.messageTs) || 0, item);
  });
  return map;
}

function areThreadsCompatibleBeforeMessage(referenceThread, candidateThread, messageTs) {
  const cutoffTs = Number(messageTs) || 0;
  if (!cutoffTs) return true;
  const refMap = getBranchLinkMap(referenceThread);
  const candidateMap = getBranchLinkMap(candidateThread);
  const keys = new Set([
    ...Array.from(refMap.keys()),
    ...Array.from(candidateMap.keys()),
  ]);
  for (const key of keys) {
    if (!(Number(key) < cutoffTs)) continue;
    const ref = refMap.get(key) || null;
    const candidate = candidateMap.get(key) || null;
    if (!ref && !candidate) continue;
    if (!ref || !candidate) return false;
    if (String(ref.groupId || '') !== String(candidate.groupId || '')) return false;
    if ((Number(ref.order) || 0) !== (Number(candidate.order) || 0)) return false;
    if (String(ref.kind || '') !== String(candidate.kind || '')) return false;
  }
  return true;
}

function getMessageBranchState(chatId, messageTs, expectedKind = '') {
  const chat = findChatById(chatId);
  if (!chat) return { siblings: [], currentIndex: -1, total: 0 };
  const activeThread = getChatActiveThread(chat);
  if (!activeThread) return { siblings: [], currentIndex: -1, total: 0 };
  const link = getChatBranchLink(activeThread, messageTs);
  if (!link) return { siblings: [], currentIndex: -1, total: 0 };
  const cleanKind = String(expectedKind || '').trim().toLowerCase();
  if (cleanKind && link.kind !== cleanKind) return { siblings: [], currentIndex: -1, total: 0 };
  const recencyOfThread = (thread) => {
    const msgs = Array.isArray(thread && thread.messages) ? thread.messages : [];
    if (!msgs.length) return 0;
    return msgs.reduce((max, msg) => Math.max(max, Number(msg && msg.ts) || 0), 0);
  };
  const variantsByOrder = new Map();
  Array.from(chat.threads || []).forEach((entry) => {
    if (!areThreadsCompatibleBeforeMessage(activeThread, entry, messageTs)) {
      return;
    }
    const siblingLink = getChatBranchLink(entry, messageTs);
    if (!siblingLink || siblingLink.groupId !== link.groupId || (cleanKind && siblingLink.kind !== cleanKind)) {
      return;
    }
    const orderKey = Number(siblingLink.order) || 0;
    const existing = variantsByOrder.get(orderKey);
    if (!existing) {
      variantsByOrder.set(orderKey, entry);
      return;
    }
    if (String(entry.id || '') === String(activeThread.id || '')) {
      variantsByOrder.set(orderKey, entry);
      return;
    }
    if (String(existing.id || '') === String(activeThread.id || '')) {
      return;
    }
    if (recencyOfThread(entry) > recencyOfThread(existing)) {
      variantsByOrder.set(orderKey, entry);
    }
  });
  const siblings = Array.from(variantsByOrder.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);
  const currentOrder = Number(link.order) || 0;
  return {
    siblings,
    currentIndex: siblings.findIndex((entry) => {
      const siblingLink = getChatBranchLink(entry, messageTs);
      return (Number(siblingLink && siblingLink.order) || 0) === currentOrder;
    }),
    total: siblings.length,
  };
}

function navigateMessageBranch(chatId, messageTs, direction, expectedKind = '') {
  const state = getMessageBranchState(chatId, messageTs, expectedKind);
  if (state.total < 2 || state.currentIndex < 0) return;
  const nextIndex = state.currentIndex + Number(direction || 0);
  if (nextIndex < 0 || nextIndex >= state.total) return;
  const chat = findChatById(chatId);
  const nextThread = state.siblings[nextIndex];
  if (!chat || !nextThread) return;
  syncChatFromThread(chat, nextThread);
  chat.updatedAt = nowTs();
  saveChats();
  loadHistory(chat.id);
}

function buildBranchNavigator(chatId, messageTs, expectedKind = '') {
  const branchState = getMessageBranchState(chatId, messageTs, expectedKind);
  if (branchState.total < 2 || branchState.currentIndex < 0) return null;

  const nav = document.createElement('div');
  nav.className = 'msg-branch-nav';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'msg-branch-btn';
  prevBtn.type = 'button';
  prevBtn.setAttribute('aria-label', 'Previous branch');
  prevBtn.disabled = branchState.currentIndex <= 0;
  prevBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 18 9 12 15 6"></path>
    </svg>
  `;
  prevBtn.addEventListener('click', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    navigateMessageBranch(chatId, messageTs, -1, expectedKind);
  });
  nav.appendChild(prevBtn);

  const label = document.createElement('span');
  label.className = 'msg-branch-label';
  label.textContent = `${branchState.currentIndex + 1}/${branchState.total}`;
  nav.appendChild(label);

  const nextBtn = document.createElement('button');
  nextBtn.className = 'msg-branch-btn';
  nextBtn.type = 'button';
  nextBtn.setAttribute('aria-label', 'Next branch');
  nextBtn.disabled = branchState.currentIndex >= branchState.total - 1;
  nextBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 18 15 12 9 6"></path>
    </svg>
  `;
  nextBtn.addEventListener('click', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    navigateMessageBranch(chatId, messageTs, 1, expectedKind);
  });
  nav.appendChild(nextBtn);

  return nav;
}

function findFallbackRetryAnchorTs(chatId, messageTs) {
  const chat = findChatById(chatId);
  const activeThread = getChatActiveThread(chat);
  if (!chat || !activeThread || !Array.isArray(activeThread.messages)) return 0;
  const targetTs = Number(messageTs) || 0;
  const aiMessages = activeThread.messages.filter((msg) => msg && msg.role === 'ai');
  if (!aiMessages.length) return 0;
  const lastAi = aiMessages[aiMessages.length - 1];
  if (!lastAi || Number(lastAi.ts) !== targetTs) return 0;
  const retryLinks = normalizeBranchLinks(activeThread.branchLinks).filter((item) => item.kind === 'retry');
  if (!retryLinks.length) return 0;
  const anchorsAlreadyUsed = new Set(
    aiMessages
      .map((msg) => Number(msg && msg.branchAnchorTs) || 0)
      .filter((value) => value > 0),
  );
  const directMatch = retryLinks.find((item) => Number(item.messageTs) === targetTs);
  if (directMatch) return Number(directMatch.messageTs) || 0;
  const candidate = [...retryLinks]
    .sort((a, b) => (Number(b.order) || 0) - (Number(a.order) || 0))
    .find((item) => !anchorsAlreadyUsed.has(Number(item.messageTs) || 0));
  return Number(candidate && candidate.messageTs) || 0;
}

function isEditingUserMessage(chatId, messageTs) {
  return Boolean(
    editingMessageState
    && String(editingMessageState.chatId || '') === String(chatId || '')
    && Number(editingMessageState.messageTs) === Number(messageTs)
  );
}

function focusInlineMessageEditor(chatId, messageTs) {
  if (!chatArea) return;
  const selector = `.msg.user[data-msg-ts="${Number(messageTs) || 0}"] .msg-edit-textarea`;
  const textarea = chatArea.querySelector(selector);
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  autoResizeInlineMessageEditor(textarea);
  textarea.focus();
  const end = textarea.value.length;
  if (typeof textarea.setSelectionRange === 'function') {
    textarea.setSelectionRange(end, end);
  }
}

function enterMessageEditMode(chatId, messageTs) {
  if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
  const chat = findChatById(chatId);
  if (!chat || !Array.isArray(chat.messages)) return;
  const target = chat.messages.find((msg) => msg && msg.role === 'user' && Number(msg.ts) === Number(messageTs));
  if (!target) return;
  editingMessageState = {
    chatId: String(chatId || ''),
    messageTs: Number(messageTs) || 0,
    draft: String(target.text || ''),
  };
  if (activeChatId !== String(chat.id || '')) {
    activeChatId = String(chat.id || '');
    inNewChatMode = false;
  }
  renderActiveChat();
  requestAnimationFrame(() => focusInlineMessageEditor(chatId, messageTs));
}

function cancelMessageEditMode() {
  if (!editingMessageState) return;
  const chatId = String(editingMessageState.chatId || '');
  editingMessageState = null;
  if (activeChatId === chatId && !inNewChatMode) {
    renderActiveChat();
  }
}

function updateEditingMessageDraft(value) {
  if (!editingMessageState) return;
  editingMessageState.draft = String(value || '');
}

function autoResizeInlineMessageEditor(el) {
  if (!(el instanceof HTMLTextAreaElement)) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}

function editUserMessage(chatId, messageTs) {
  enterMessageEditMode(chatId, messageTs);
}

function saveEditedUserMessage(chatId, messageTs, nextText) {
  if (pendingInferenceCount > 0) {
    if (typeof showComposerNotice === 'function' && !isCurrentViewInferenceChat()) {
      showComposerNotice('Another chat is still responding — wait for it to finish before editing.');
    }
    return;
  }
  maybeStopDictationForSend();
  if (!ensureSignedIn()) return;
  const chat = findChatById(chatId);
  const activeThread = getChatActiveThread(chat);
  if (!chat || !activeThread || !Array.isArray(activeThread.messages)) return;
  const userIndex = activeThread.messages.findIndex((msg) => msg && msg.role === 'user' && Number(msg.ts) === Number(messageTs));
  if (userIndex < 0) return;

  const cleaned = String(nextText || '').trim();
  if (!cleaned) return;

  const target = activeThread.messages[userIndex];
  const original = String(target && target.text || '').trim();
  if (!target) return;

  editingMessageState = null;
  if (cleaned === original) {
    if (activeChatId === String(chat.id || '') && !inNewChatMode) {
      renderActiveChat();
    }
    return;
  }

  const targetTs = Number(messageTs) || 0;
  let branchLink = getChatBranchLink(activeThread, targetTs);
  if (!branchLink) {
    branchLink = {
      groupId: makeBranchGroupId(),
      order: 0,
    };
    setChatBranchLink(activeThread, targetTs, branchLink.groupId, 0, 'edit');
  }

  const siblingOrders = Array.from(chat.threads || [])
    .map((entry) => {
      const link = getChatBranchLink(entry, targetTs);
      if (!link || link.groupId !== branchLink.groupId) return -1;
      return Number(link.order) || 0;
    })
    .filter((value) => value >= 0);
  const nextOrder = siblingOrders.length > 0 ? Math.max(...siblingOrders) + 1 : 1;

  const branchedMessages = activeThread.messages.slice(0, userIndex + 1).map((msg) => {
    if (!msg) return msg;
    if (Number(msg.ts) === targetTs && msg.role === 'user') {
      return { ...msg, text: cleaned, displayTs: nowTs() };
    }
    return { ...msg };
  });

  const branchedThread = cloneThreadState(activeThread, {
    id: makeThreadId(),
    messages: branchedMessages,
    needsContinue: false,
    pendingBranchLink: null,
  });
  setChatBranchLink(branchedThread, targetTs, branchLink.groupId, nextOrder, 'edit');
  chat.threads.push(branchedThread);
  syncChatFromThread(chat, branchedThread);
  activeChatId = chat.id;
  inNewChatMode = false;
  chat.updatedAt = nowTs();
  saveChats();
  renderHistory();
  renderSidebarCounts();
  renderActiveChat();

  beginInferenceRequest();
  chatAutoScrollPinned = true;
  // Edit-and-resend in this chat — keep its current project, don't re-ask new-vs-current.
  void requestAssistantReply(chat.id, buildPromptWithInputAugments(cleaned), true, {
    skipNewProjectConfirmation: true,
    forceCurrentWorkspace: true,
  });
}

function isRetryableAssistantMessage(chatId, messageTs) {
  const chat = findChatById(chatId);
  if (!chat || !Array.isArray(chat.messages)) return false;
  for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
    const msg = chat.messages[i];
    if (msg && msg.role === 'ai') {
      return Number(msg.ts) === Number(messageTs);
    }
  }
  return false;
}

function removeArtifactsForChatAfter(chatId, minMessageTs) {
  const chatKey = String(chatId || '');
  const cutoff = Number(minMessageTs) || 0;
  const before = artifacts.length;
  artifacts = artifacts.filter((item) => !(item && String(item.chatId || '') === chatKey && Number(item.messageTs || 0) > cutoff));
  if (artifacts.length !== before) {
    saveArtifacts();
    renderArtifacts();
  }
}

function retryAssistantMessage(chatId, messageTs) {
  if (pendingInferenceCount > 0) {
    if (typeof showComposerNotice === 'function' && !isCurrentViewInferenceChat()) {
      showComposerNotice('Another chat is still responding — wait for it to finish before retrying.');
    }
    return;
  }
  maybeStopDictationForSend();
  if (!ensureSignedIn()) return;
  const chat = findChatById(chatId);
  const activeThread = getChatActiveThread(chat);
  if (!chat || !activeThread || !Array.isArray(activeThread.messages)) return;
  const aiIndex = activeThread.messages.findIndex((msg) => msg && msg.role === 'ai' && Number(msg.ts) === Number(messageTs));
  if (aiIndex <= 0) return;
  let userIndex = -1;
  for (let i = aiIndex - 1; i >= 0; i -= 1) {
    if (activeThread.messages[i] && activeThread.messages[i].role === 'user') {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return;

  const userMessage = String(activeThread.messages[userIndex].text || '').trim();
  if (!userMessage) return;

  const originalAiMessage = activeThread.messages[aiIndex];
  const targetTs = Number(originalAiMessage && originalAiMessage.branchAnchorTs) || Number(messageTs) || 0;
  if (originalAiMessage && !Number(originalAiMessage.branchAnchorTs)) {
    originalAiMessage.branchAnchorTs = targetTs;
  }
  let branchLink = getChatBranchLink(activeThread, targetTs);
  if (!branchLink) {
    branchLink = {
      groupId: makeBranchGroupId(),
      order: 0,
      kind: 'retry',
    };
    setChatBranchLink(activeThread, targetTs, branchLink.groupId, 0, 'retry');
  } else if (branchLink.kind !== 'retry') {
    setChatBranchLink(activeThread, targetTs, branchLink.groupId, branchLink.order, 'retry');
    branchLink = getChatBranchLink(activeThread, targetTs) || branchLink;
  }

  const siblingOrders = Array.from(chat.threads || [])
    .map((entry) => {
      const link = getChatBranchLink(entry, targetTs);
      if (!link || link.groupId !== branchLink.groupId) return -1;
      return Number(link.order) || 0;
    })
    .filter((value) => value >= 0);
  const nextOrder = siblingOrders.length > 0 ? Math.max(...siblingOrders) + 1 : 1;

  const branchedMessages = activeThread.messages.slice(0, userIndex + 1).map((msg) => msg ? { ...msg } : msg);
  const branchedThread = cloneThreadState(activeThread, {
    id: makeThreadId(),
    messages: branchedMessages,
    needsContinue: false,
    pendingBranchLink: {
      anchorTs: targetTs,
      groupId: branchLink.groupId,
      order: nextOrder,
      kind: 'retry',
    },
  });

  chat.threads.push(branchedThread);
  syncChatFromThread(chat, branchedThread);
  activeChatId = chat.id;
  inNewChatMode = false;
  chat.updatedAt = nowTs();
  saveChats();
  renderHistory();
  renderSidebarCounts();
  renderActiveChat();

  beginInferenceRequest();
  chatAutoScrollPinned = true;
  // Retry of an existing turn — keep using the chat's current project, don't re-ask new-vs-current.
  void requestAssistantReply(chat.id, buildPromptWithInputAugments(userMessage), true, {
    skipNewProjectConfirmation: true,
    forceCurrentWorkspace: true,
  });
}

function makeChatId() {
  return `chat_${nowTs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeChatName(text) {
  const clean = (text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return 'New Chat';
  return clean.length > 44 ? `${clean.slice(0, 44)}...` : clean;
}

function toAutoTitleCase(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (/^[A-Z0-9_+\-]{2,4}$/.test(word)) return word;
      return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
    })
    .join(' ');
}

function normalizeUsername(text) {
  return (text || '').trim().replace(/\s+/g, ' ');
}

function usernameKey(text) {
  return normalizeUsername(text).toLowerCase();
}

function bytesToHex(bytes) {
  return Array.from(bytes || [])
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomSaltHex(length = 16) {
  const size = Math.max(8, Math.min(length, 64));
  if (window.crypto && window.crypto.getRandomValues) {
    const buf = new Uint8Array(size);
    window.crypto.getRandomValues(buf);
    return bytesToHex(buf);
  }
  let out = '';
  for (let i = 0; i < size; i += 1) {
    out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return out;
}

async function sha256Hex(text) {
  if (window.crypto && window.crypto.subtle && window.TextEncoder) {
    const input = new TextEncoder().encode(String(text));
    const digest = await window.crypto.subtle.digest('SHA-256', input);
    return bytesToHex(new Uint8Array(digest));
  }

  // Fallback hash for environments without Web Crypto.
  let hash = 2166136261 >>> 0;
  const str = String(text);
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
    hash >>>= 0;
  }
  return `fnv1a_${hash.toString(16).padStart(8, '0')}`;
}

async function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}

function findUserByKey(key) {
  return (authStore.users || []).find((u) => u && u.usernameKey === key) || null;
}

function currentAuthUser() {
  if (!authStore.currentUser) return null;
  return findUserByKey(authStore.currentUser);
}

function scopedStorageKey(prefix) {
  const user = currentAuthUser();
  if (!user || !user.usernameKey) return null;
  return `${prefix}::${user.usernameKey}`;
}

function ensureSignedIn() {
  if (currentAuthUser()) return true;
  openAuthModal('login');
  setAuthNote('Sign in to access your private chats and files.', 'info');
  return false;
}

function setThinkingStatus(text, variant) {
  if (!thinkingStatus) return;
  const clean = String(text || '').trim();
  thinkingStatus.textContent = clean;
  thinkingStatus.classList.toggle('active', Boolean(clean));
  thinkingStatus.classList.toggle('thinking-status-escalate', variant === 'escalate' && Boolean(clean));
}

// Chat that owns the current/last agent run. The timer text and the run token
// stats are scoped to it so other chats aren't painted with a foreign run's UI.
let agentRunChatId = '';
function isViewingAgentRunChat() {
  return !agentRunChatId || String(activeChatId || '') === agentRunChatId;
}
// On chat switch: clear a foreign run's "Xs" status from the composer, or
// repaint it immediately when returning to the running chat.
function syncAgentElapsedStatusForActiveChat() {
  if (!agentElapsedInterval) return;
  if (!isViewingAgentRunChat()) {
    setThinkingStatus('');
  } else if (agentElapsedStartedAt) {
    setThinkingStatus(`${((Date.now() - agentElapsedStartedAt) / 1000).toFixed(1)}s`);
  }
}
function startAgentElapsedTimer(startedAtMs = 0, chatId = '') {
  stopAgentElapsedTimer();
  resetAgentInferenceTokenStats();
  agentRunChatId = String(chatId || activeChatId || '');
  agentElapsedStartedAt = Number(startedAtMs) || Date.now();
  const tick = () => {
    if (!agentElapsedStartedAt) return;
    // Only the owning chat shows the live timer; never blank here so transient
    // composer notices in other chats aren't overwritten every 200ms.
    if (!isViewingAgentRunChat()) return;
    const elapsed = ((Date.now() - agentElapsedStartedAt) / 1000).toFixed(1);
    setThinkingStatus(`${elapsed}s`);
  };
  tick();
  agentElapsedInterval = window.setInterval(tick, 200);
}

function stopAgentElapsedTimer() {
  if (agentElapsedInterval) {
    clearInterval(agentElapsedInterval);
    agentElapsedInterval = null;
  }
  agentElapsedStartedAt = 0;
  // Keep agentRunInferenceChars as the readable "last run" total; it resets on
  // the next run start. Only the in-flight call state is cleared here.
  agentInferenceDepth = 0;
  agentLiveInferencePromptChars = 0;
  agentLastInferenceChars = 0;
  updateTokenRing();
  setThinkingStatus('');
}

// True while an agent run owns the below-input status (used to ignore the loop's
// status-blanking so the live "Xs" counter isn't cleared between ticks).
function isAgentElapsedTimerActive() {
  return Boolean(agentElapsedInterval);
}

async function loadPromptTemplate(name) {
  return promptCoreApi.loadPromptTemplate
    ? promptCoreApi.loadPromptTemplate(name)
    : '';
}

function renderPromptTemplate(template, variables) {
  return promptCoreApi.renderPromptTemplate
    ? promptCoreApi.renderPromptTemplate(template, variables)
    : String(template || '');
}

// ── Plus modal
function openPlusModal() {
  if (!plusModalBackdrop) return;
  plusModalBackdrop.classList.add('open');
  plusModalBackdrop.setAttribute('aria-hidden', 'false');
}

function closePlusModal() {
  if (!plusModalBackdrop) return;
  plusModalBackdrop.classList.remove('open');
  plusModalBackdrop.setAttribute('aria-hidden', 'true');
}

function openUrlContextModal(mode = 'chat') {
  closePlusModal();
  if (!urlContextBackdrop) return;
  urlContextMode = String(mode || 'chat') === 'manual' ? 'manual' : 'chat';
  if (urlContextTitle) {
    urlContextTitle.textContent = urlContextMode === 'manual' ? 'Context Note' : 'Add URL / Context';
  }
  if (urlContextLabel) {
    urlContextLabel.textContent = urlContextMode === 'manual' ? 'Context (applies to this chat)' : 'URL or text context';
  }
  if (urlContextInput) {
    urlContextInput.placeholder = urlContextMode === 'manual'
      ? 'Add background instructions, constraints, or references...'
      : 'https://... or paste context text';
    urlContextInput.value = urlContextMode === 'manual' ? getActiveManualContext() : '';
  }
  if (urlContextAddBtn) {
    urlContextAddBtn.textContent = urlContextMode === 'manual' ? 'Save Context' : 'Add to Context';
  }
  if (urlContextNote) urlContextNote.textContent = '';
  urlContextBackdrop.classList.add('open');
  urlContextBackdrop.setAttribute('aria-hidden', 'false');
  setTimeout(() => urlContextInput && urlContextInput.focus(), 0);
}

function closeUrlContextModal() {
  if (!urlContextBackdrop) return;
  urlContextBackdrop.classList.remove('open');
  urlContextBackdrop.setAttribute('aria-hidden', 'true');
  urlContextMode = 'chat';
}

function handleAddUrlContext() {
  const val = String(urlContextInput ? urlContextInput.value : '').trim();
  if (!val) {
    if (urlContextNote) urlContextNote.textContent = 'Please enter a URL or context text.';
    return;
  }
  if (urlContextMode === 'manual') {
    if (!ensureSignedIn()) return;
    setActiveManualContext(val);
    syncInputAugmentState();
    closeUrlContextModal();
    return;
  }
  const activeChat = getActiveChat();
  if (!activeChat) {
    setActiveManualContext(val);
    syncInputAugmentState();
    closeUrlContextModal();
    return;
  }
  const contextMsg = val.startsWith('http') ? `[Context URL: ${val}]` : `[Context: ${val}]`;
  activeChat.messages = activeChat.messages || [];
  activeChat.messages.push({ role: 'user', text: contextMsg, ts: nowTs() });
  saveChats();
  renderActiveChat();
  closeUrlContextModal();
}

// ── Search
let searchQuery = '';
let searchBlurTimer = null;

function getWorkspaceSearchEntries() {
  const entries = [];
  const seen = new Set();

  if (workspaceRootName) {
    entries.push({
      type: 'project',
      name: workspaceRootName,
      path: '/',
      sub: 'Current project',
    });
  }

  workspaceTreeState.forEach((state) => {
    const children = Array.isArray(state && state.children) ? state.children : [];
    children.forEach((entry) => {
      const path = normalizeWorkspacePath(entry && entry.path);
      if (!path || seen.has(path)) return;
      seen.add(path);
      const kind = entry && entry.kind === 'file' ? 'file' : 'folder';
      const name = String((entry && entry.name) || workspaceBaseName(path) || (kind === 'file' ? 'file' : 'folder')).trim();
      entries.push({
        type: kind,
        name,
        path,
        sub: path,
      });
    });
  });

  return entries;
}

function renderSearchDropdown(query) {
  if (!searchDropdown) return;
  const q = String(query || '').toLowerCase().trim();
  if (!q) {
    searchDropdown.innerHTML = '';
    searchDropdown.classList.remove('open');
    return;
  }
  const matchedChats = chats.filter((c) => c && (
    String(c.name || '').toLowerCase().includes(q) ||
    (c.messages || []).some((m) => String(m.text || '').toLowerCase().includes(q))
  )).slice(0, 5);
  const matchedArtifacts = getAllStoredArtifacts().filter((a) => a && (
    String(a.name || '').toLowerCase().includes(q) ||
    String(a.content || '').toLowerCase().includes(q)
  )).slice(0, 4);
  const workspaceMatches = getWorkspaceSearchEntries().filter((entry) => entry && (
    String(entry.name || '').toLowerCase().includes(q) ||
    String(entry.path || '').toLowerCase().includes(q) ||
    String(entry.sub || '').toLowerCase().includes(q)
  ));
  const matchedProjects = workspaceMatches.filter((entry) => entry.type === 'project').slice(0, 2);
  const matchedFiles = workspaceMatches.filter((entry) => entry.type === 'file').slice(0, 5);
  const matchedFolders = workspaceMatches.filter((entry) => entry.type === 'folder').slice(0, 4);
  if (matchedChats.length === 0 && matchedArtifacts.length === 0 && matchedProjects.length === 0 && matchedFiles.length === 0 && matchedFolders.length === 0) {
    searchDropdown.innerHTML = '<div class="search-no-results">No results</div>';
    searchDropdown.classList.add('open');
    return;
  }
  let html = '';
  if (matchedChats.length > 0) {
    html += '<div class="search-section-label">CHATS</div>';
    matchedChats.forEach((c) => {
      const matchedMsg = [...(c.messages || [])]
        .reverse()
        .find((m) => String(m && m.text ? m.text : '').toLowerCase().includes(q));
      const sub = matchedMsg ? String(matchedMsg.text || '').slice(0, 60) : '';
      const targetTs = matchedMsg ? Number(matchedMsg.ts) || 0 : 0;
      html += `<button class="search-result-item" data-type="chat" data-id="${escapeHtml(c.id)}" data-ts="${targetTs}" type="button"><svg class="search-result-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><div class="search-result-text"><div class="search-result-title">${escapeHtml(c.name || 'Untitled')}</div>${sub ? `<div class="search-result-sub">${escapeHtml(sub)}</div>` : ''}</div></button>`;
    });
  }
  if (matchedArtifacts.length > 0) {
    html += '<div class="search-section-label">ARTIFACTS</div>';
    matchedArtifacts.forEach((a) => {
      const typeLabel = isCodeArtifact(a) ? (a.language || 'code').toUpperCase() : 'Canvas';
      html += `<button class="search-result-item" data-type="artifact" data-key="${escapeHtml(makeArtifactKey(a))}" type="button"><svg class="search-result-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 10h8"/><path d="M8 14h5"/></svg><div class="search-result-text"><div class="search-result-title">${escapeHtml(a.name || 'Artifact')}</div><div class="search-result-sub">${escapeHtml(typeLabel)}</div></div></button>`;
    });
  }
  if (matchedProjects.length > 0) {
    html += '<div class="search-section-label">PROJECTS</div>';
    matchedProjects.forEach((entry) => {
      html += `<button class="search-result-item" data-type="project" data-path="${escapeHtml(entry.path)}" type="button"><svg class="search-result-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H3z"></path><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"></path></svg><div class="search-result-text"><div class="search-result-title">${escapeHtml(entry.name || 'Project')}</div><div class="search-result-sub">${escapeHtml(entry.sub || 'Current project')}</div></div></button>`;
    });
  }
  if (matchedFiles.length > 0) {
    html += '<div class="search-section-label">FILES</div>';
    matchedFiles.forEach((entry) => {
      html += `<button class="search-result-item" data-type="file" data-path="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}" type="button"><svg class="search-result-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg><div class="search-result-text"><div class="search-result-title">${escapeHtml(entry.name || 'File')}</div><div class="search-result-sub">${escapeHtml(entry.sub || entry.path || '')}</div></div></button>`;
    });
  }
  if (matchedFolders.length > 0) {
    html += '<div class="search-section-label">FOLDERS</div>';
    matchedFolders.forEach((entry) => {
      html += `<button class="search-result-item" data-type="folder" data-path="${escapeHtml(entry.path)}" type="button"><svg class="search-result-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H3z"></path><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"></path></svg><div class="search-result-text"><div class="search-result-title">${escapeHtml(entry.name || 'Folder')}</div><div class="search-result-sub">${escapeHtml(entry.sub || entry.path || '')}</div></div></button>`;
    });
  }
  searchDropdown.innerHTML = html;
  searchDropdown.classList.add('open');
  searchDropdown.querySelectorAll('.search-result-item').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.type === 'chat') {
        const targetTs = Number(btn.dataset.ts) || 0;
        const targetQuery = String(q || '');
        loadHistory(btn.dataset.id);
        setTimeout(() => focusSearchChatResult(targetTs, targetQuery), 60);
      } else if (btn.dataset.type === 'artifact') {
        openArtifactDetail(btn.dataset.key, 'artifacts');
        setTimeout(() => flashArtifactSearchResult(), 60);
      } else if (btn.dataset.type === 'project') {
        setWorkspaceSelection('/', 'folder');
        await renderArtifacts();
      } else if (btn.dataset.type === 'file') {
        const path = normalizeWorkspacePath(btn.dataset.path || '/');
        const name = String(btn.dataset.name || '').trim();
        setWorkspaceSelection(path, 'file');
        await renderArtifacts();
        await openFileTab(path, name);
      } else if (btn.dataset.type === 'folder') {
        const path = normalizeWorkspacePath(btn.dataset.path || '/');
        setWorkspaceSelection(path, 'folder');
        await renderArtifacts();
      }
      if (searchInput) searchInput.value = '';
      searchQuery = '';
      searchDropdown.innerHTML = '';
      searchDropdown.classList.remove('open');
    });
  });
}

if (plusBtn) plusBtn.addEventListener('click', openPlusModal);
if (plusModalBackdrop) plusModalBackdrop.addEventListener('click', (e) => { if (e.target === plusModalBackdrop) closePlusModal(); });
if (plusModalCloseBtn) plusModalCloseBtn.addEventListener('click', closePlusModal);
if (plusDatasetBtn) plusDatasetBtn.addEventListener('click', () => { closePlusModal(); if (datasetFileInput) datasetFileInput.click(); });
if (plusUrlBtn) plusUrlBtn.addEventListener('click', () => openUrlContextModal('chat'));
if (plusProjectBtn) plusProjectBtn.addEventListener('click', () => { closePlusModal(); newProject(); });
if (plusApiBtn) plusApiBtn.addEventListener('click', () => { closePlusModal(); void openSettingsModal(); });
if (urlContextCancelBtn) urlContextCancelBtn.addEventListener('click', closeUrlContextModal);
if (urlContextBackdrop) urlContextBackdrop.addEventListener('click', (e) => { if (e.target === urlContextBackdrop) closeUrlContextModal(); });
if (urlContextAddBtn) urlContextAddBtn.addEventListener('click', handleAddUrlContext);
if (urlContextInput) {
  urlContextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddUrlContext();
    if (e.key === 'Escape') closeUrlContextModal();
  });
}
if (datasetFileInput) {
  datasetFileInput.addEventListener('change', () => {
    void handleAttachSelection(datasetFileInput.files);
    datasetFileInput.value = '';
  });
}
if (workspaceImportInput) {
  workspaceImportInput.addEventListener('change', () => {
    void importWorkspacePickedFiles(workspaceImportInput.files);
    workspaceImportInput.value = '';
  });
}
if (workspaceImportFolderInput) {
  workspaceImportFolderInput.addEventListener('change', () => {
    void importWorkspacePickedFolderFiles(workspaceImportFolderInput.files);
    workspaceImportFolderInput.value = '';
  });
}
if (searchInput) {
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderSearchDropdown(searchQuery);
  });
  searchInput.addEventListener('focus', () => { if (searchQuery) renderSearchDropdown(searchQuery); });
  searchInput.addEventListener('blur', () => {
    searchBlurTimer = setTimeout(() => {
      if (searchDropdown) searchDropdown.classList.remove('open');
    }, 180);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchQuery = '';
      if (searchDropdown) searchDropdown.classList.remove('open');
    }
  });
}
if (searchDropdown) searchDropdown.addEventListener('mousedown', () => clearTimeout(searchBlurTimer));

function clearSearchTermHighlights(scope = document) {
  if (!scope || !scope.querySelectorAll) return;
  const marks = Array.from(scope.querySelectorAll('mark.search-term-hit'));
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    if (parent.normalize) parent.normalize();
  });
}

function highlightSearchTermInElement(element, query) {
  if (!element) return 0;
  const needle = String(query || '').trim();
  if (!needle) return 0;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(escaped, 'gi');
  const nodeFilter = (typeof NodeFilter !== 'undefined') ? NodeFilter : {
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    SHOW_TEXT: 4,
  };

  const walker = document.createTreeWalker(element, nodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = String((node && node.nodeValue) || '');
      if (!value.trim()) return nodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return nodeFilter.FILTER_REJECT;
      if (parent.closest('pre, code, script, style, textarea, mark.search-term-hit')) {
        return nodeFilter.FILTER_REJECT;
      }
      rx.lastIndex = 0;
      return rx.test(value) ? nodeFilter.FILTER_ACCEPT : nodeFilter.FILTER_REJECT;
    },
  });

  const matches = [];
  let current = walker.nextNode();
  while (current) {
    matches.push(current);
    current = walker.nextNode();
  }
  if (matches.length === 0) return 0;

  let total = 0;
  matches.forEach((textNode) => {
    const text = String(textNode.nodeValue || '');
    rx.lastIndex = 0;
    if (!rx.test(text)) return;
    rx.lastIndex = 0;
    let cursor = 0;
    const frag = document.createDocumentFragment();
    let m = rx.exec(text);
    while (m) {
      const start = m.index;
      const found = m[0] || '';
      if (start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, start)));
      }
      const mark = document.createElement('mark');
      mark.className = 'search-term-hit';
      mark.textContent = found;
      frag.appendChild(mark);
      cursor = start + found.length;
      total += 1;
      m = rx.exec(text);
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    if (textNode.parentNode) {
      textNode.parentNode.replaceChild(frag, textNode);
    }
  });
  return total;
}

function focusSearchChatResult(targetTs, queryLower) {
  if (!chatArea) return;
  clearSearchTermHighlights(chatArea);
  let target = null;
  if (targetTs > 0) {
    target = chatArea.querySelector(`.msg[data-msg-ts="${targetTs}"]`);
  }
  if (!target && queryLower) {
    const needle = String(queryLower || '').toLowerCase();
    const all = Array.from(chatArea.querySelectorAll('.msg'));
    target = all.find((row) => String(row.textContent || '').toLowerCase().includes(needle)) || null;
  }
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('search-hit');
  if (queryLower) {
    const bubble = target.querySelector('.msg-bubble');
    if (bubble) {
      highlightSearchTermInElement(bubble, queryLower);
    }
  }
  setTimeout(() => target && target.classList.remove('search-hit'), 1700);
}

function flashArtifactSearchResult() {
  if (!artifactDetailView) return;
  artifactDetailView.classList.add('search-hit');
  setTimeout(() => artifactDetailView && artifactDetailView.classList.remove('search-hit'), 1700);
}

function setComposerMenuOpen(open) {
  composerMenuOpen = Boolean(open);
  if (composerPlusBtn) composerPlusBtn.classList.toggle('open', composerMenuOpen);
  if (composerMenu) {
    composerMenu.classList.toggle('open', composerMenuOpen);
    composerMenu.setAttribute('aria-hidden', composerMenuOpen ? 'false' : 'true');
  }
}

function setExplorerImportMenuOpen(open) {
  explorerImportMenuOpen = Boolean(open);
  if (expImportMenu) {
    expImportMenu.classList.toggle('open', explorerImportMenuOpen);
  }
  if (expImportBtn) {
    expImportBtn.classList.toggle('active', explorerImportMenuOpen);
    expImportBtn.setAttribute('aria-expanded', explorerImportMenuOpen ? 'true' : 'false');
  }
}

function setExplorerMoreMenuOpen(open) {
  explorerMoreMenuOpen = Boolean(open);
  if (expMoreMenu) {
    expMoreMenu.classList.toggle('open', explorerMoreMenuOpen);
  }
  if (expMoreBtn) {
    expMoreBtn.classList.toggle('active', explorerMoreMenuOpen);
    expMoreBtn.setAttribute('aria-expanded', explorerMoreMenuOpen ? 'true' : 'false');
  }
}

function closeExplorerMenus() {
  setExplorerImportMenuOpen(false);
  setExplorerMoreMenuOpen(false);
}

function syncComposerLayoutState() {
  if (!inputRow) return;
  const buttons = [continueBtn, canvasBtn, attachBtn, agentBtn, thinkBtn, contextBtn];
  const hasVisibleAction = buttons.some((btn) => btn && !btn.classList.contains('hidden'));
  inputRow.classList.toggle('has-action-row', hasVisibleAction);
}

// Generic composer permission support. This keeps the UI reusable so future
// confirmation flows can plug into one renderer and one keyboard interaction model.
function getComposerPendingPreflightConfirmation() {
  if (inNewChatMode || !activeChatId) return null;
  return getPendingPreflightConfirmation(activeChatId);
}

function getComposerPreflightConfirmationChoices(pending = null) {
  if (pending && pending.kind === 'delete') {
    return [
      { mode: 'confirm_delete', label: 'Delete (move to Trash)' },
      { mode: 'cancel_delete', label: 'Keep it' },
    ];
  }
  if (pending && pending.workspaceOpen === false) {
    return [
      { mode: 'create_new_project', label: 'Create a new project' },
    ];
  }
  return [
    { mode: 'create_new_project', label: 'Create a new project' },
    { mode: 'use_existing_workspace', label: 'Use current project' },
  ];
}

function getActiveComposerPermissionRequest() {
  const pending = getComposerPendingPreflightConfirmation();
  if (!pending || !activeChatId) return null;
  const title = pending.workspaceOpen === false
    ? 'Create a new project for this request?'
    : String(pending.userMessage || 'Choose how I should continue.').trim();
  return {
    kind: 'preflight_project_scope',
    title,
    options: getComposerPreflightConfirmationChoices(pending),
    onSelect: (mode) => {
      recordDebugTrace('preflight_confirmation_button_clicked', {
        chatId: String(activeChatId || ''),
        mode: String(mode || ''),
        midFlightAgentResume: String(Boolean(pending && pending.midFlightAgentResume)),
        hasResolver: String(typeof activeProjectScopeResolve === 'function'),
        pendingInferenceCount: String(pendingInferenceCount),
      }, {
        chatId: String(activeChatId || ''),
        mode,
        pending,
      });
      if (pending.midFlightAgentResume) {
        if (typeof activeProjectScopeResolve === 'function') {
          setPendingPreflightConfirmation(activeChatId, null);
          activeProjectScopeResolve(mode);
          activeProjectScopeResolve = null;
        } else {
          // activeProjectScopeResolve was lost (page transition, race condition).
          // Cancel the stale inference so pendingInferenceCount drops to 0, then submit.
          cancelActiveInference();
          endInferenceRequest();
          submitPendingPreflightChoice(activeChatId, mode);
        }
        return;
      }
      submitPendingPreflightChoice(activeChatId, mode);
    },
    onDismiss: () => {
      if (typeof activeProjectScopeResolve === 'function') {
        activeProjectScopeResolve(null);
        activeProjectScopeResolve = null;
      }
      dismissPendingPreflightChoice(activeChatId, { via: 'composer_dismiss', focusInput: true });
    },
  };
}

let activeProjectScopeResolve = null;

function requestProjectScopeConfirmation(chatId, payload) {
  if (String(chatId || '') !== String(activeChatId || '')) return Promise.resolve(null);
  return new Promise((resolve) => {
    activeProjectScopeResolve = resolve;
    setPendingPreflightConfirmation(activeChatId, Object.assign({}, payload, { midFlightAgentResume: true }));
  });
}

function getActiveComposerPermissionOptions() {
  const request = getActiveComposerPermissionRequest();
  return Array.isArray(request && request.options) ? request.options : [];
}

function setComposerPermissionSelectedIndex(index) {
  const choices = getActiveComposerPermissionOptions();
  if (choices.length === 0) {
    composerConfirmSelectedIndex = 0;
    return;
  }
  const maxIndex = choices.length - 1;
  composerConfirmSelectedIndex = Math.max(0, Math.min(maxIndex, Number(index) || 0));
}

function submitComposerPermissionSelection(index = composerConfirmSelectedIndex) {
  const request = getActiveComposerPermissionRequest();
  const choices = getActiveComposerPermissionOptions();
  if (!request || choices.length === 0) return false;
  const choice = choices[Math.max(0, Math.min(choices.length - 1, Number(index) || 0))];
  if (!choice || typeof request.onSelect !== 'function') return false;
  return request.onSelect(choice.mode, choice);
}

function dismissComposerPermission() {
  const request = getActiveComposerPermissionRequest();
  if (!request || typeof request.onDismiss !== 'function') return false;
  return request.onDismiss();
}

function renderComposerConfirmationUi() {
  const request = getActiveComposerPermissionRequest();
  const visible = Boolean(request && composerConfirm && inputRow);
  if (inputRow) inputRow.classList.toggle('confirm-mode', visible);
  if (visible && composerMenuOpen) {
    setComposerMenuOpen(false);
  }
  if (composerConfirm) {
    composerConfirm.classList.toggle('hidden', !visible);
    composerConfirm.classList.toggle('visible', visible);
    composerConfirm.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }
  if (composerStatusLine) {
    composerStatusLine.classList.toggle('hidden', visible);
  }
  if (!visible) {
    if (composerConfirmTitle) composerConfirmTitle.textContent = '';
    if (composerConfirmOptions) composerConfirmOptions.innerHTML = '';
    if (composerConfirmSubmitBtn) composerConfirmSubmitBtn.disabled = false;
    return;
  }

  if (composerConfirmTitle) {
    composerConfirmTitle.textContent = String(request.title || 'Choose how I should continue.').trim();
  }
  if (!composerConfirmOptions) return;

  const choices = getActiveComposerPermissionOptions();
  setComposerPermissionSelectedIndex(composerConfirmSelectedIndex);
  composerConfirmOptions.innerHTML = '';
  choices.forEach((choice, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'composer-confirm-option';
    option.dataset.mode = choice.mode;
    option.dataset.index = String(index);
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', index === composerConfirmSelectedIndex ? 'true' : 'false');
    if (index === composerConfirmSelectedIndex) option.classList.add('active');

    const indexEl = document.createElement('span');
    indexEl.className = 'composer-confirm-option-index';
    indexEl.textContent = `${index + 1}.`;
    option.appendChild(indexEl);

    const labelEl = document.createElement('span');
    labelEl.className = 'composer-confirm-option-label';
    labelEl.textContent = choice.label;
    option.appendChild(labelEl);

    if (index === composerConfirmSelectedIndex) {
      const arrowEl = document.createElement('span');
      arrowEl.className = 'composer-confirm-option-arrow';
      arrowEl.setAttribute('aria-hidden', 'true');
      arrowEl.textContent = '›';
      option.appendChild(arrowEl);
    } else {
      const actionsEl = document.createElement('span');
      actionsEl.className = 'composer-confirm-actions-inline';

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'composer-confirm-dismiss';
      dismissBtn.innerHTML = `
        <span>Dismiss</span>
        <span class="composer-confirm-keycap">ESC</span>
      `;
      dismissBtn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        dismissComposerPermission();
      });
      actionsEl.appendChild(dismissBtn);

      const submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.className = 'composer-confirm-submit';
      submitBtn.innerHTML = `
        <span>Submit</span>
        <span class="composer-confirm-keycap enter">↵</span>
      `;
      submitBtn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        submitComposerPermissionSelection();
      });
      actionsEl.appendChild(submitBtn);
      option.appendChild(actionsEl);
    }

    option.addEventListener('click', () => {
      setComposerPermissionSelectedIndex(index);
      renderComposerConfirmationUi();
    });
    composerConfirmOptions.appendChild(option);
  });
  if (document.activeElement !== composerConfirm) {
    composerConfirm.focus({ preventScroll: true });
  }
}

function updateAttachButtonState() {
  if (!attachBtn) return;
  // Attach cards are now visible in-composer, so hide the attach action chip.
  attachBtn.classList.add('hidden');
  attachBtn.classList.remove('active');
  attachBtn.setAttribute('aria-pressed', 'false');
  attachBtn.title = 'Attach';
  syncComposerLayoutState();
}

function updateInputActionChips() {
  if (canvasBtn) {
    canvasBtn.classList.toggle('hidden', !canvasModeEnabled);
    canvasBtn.classList.toggle('active', canvasModeEnabled);
    canvasBtn.setAttribute('aria-pressed', canvasModeEnabled ? 'true' : 'false');
    canvasBtn.setAttribute('aria-label', canvasModeEnabled ? 'Canvas on' : 'Canvas');
  }
  if (agentBtn) {
    agentBtn.classList.toggle('hidden', !developerAgentEnabled);
    agentBtn.classList.toggle('active', developerAgentEnabled);
    agentBtn.setAttribute('aria-pressed', developerAgentEnabled ? 'true' : 'false');
    agentBtn.setAttribute('aria-label', developerAgentEnabled ? 'Agent on' : 'Agent');
  }
  if (thinkBtn) {
    thinkBtn.classList.toggle('hidden', !thinkModeEnabled);
    thinkBtn.classList.toggle('active', thinkModeEnabled);
    thinkBtn.setAttribute('aria-pressed', thinkModeEnabled ? 'true' : 'false');
    thinkBtn.setAttribute('aria-label', thinkModeEnabled ? 'Think on' : 'Think');
  }
  // Keep plus-menu actions visually neutral; active state is shown by chips only.
  if (menuThinkBtn) menuThinkBtn.setAttribute('aria-pressed', thinkModeEnabled ? 'true' : 'false');
  if (contextBtn) {
    const hasContext = Boolean(getActiveManualContext());
    contextBtn.classList.toggle('hidden', !hasContext);
    contextBtn.classList.toggle('active', hasContext);
    contextBtn.setAttribute('aria-pressed', hasContext ? 'true' : 'false');
    contextBtn.setAttribute('aria-label', hasContext ? 'Context on' : 'Context');
  }
  updateAttachButtonState();
  syncComposerLayoutState();
}

function setCanvasMode(enabled) {
  canvasModeEnabled = Boolean(enabled);
  canvasDockOpen = false;
  const activeChat = getActiveChat();
  if (activeChat && !inNewChatMode && Boolean(activeChat.canvasMode) !== canvasModeEnabled) {
    activeChat.canvasMode = canvasModeEnabled;
    saveChats();
  }
  updateInputActionChips();
  renderMiddleView();
}

function setDeveloperAgentMode(enabled) {
  developerAgentEnabled = Boolean(enabled);
  const activeChat = getActiveChat();
  if (activeChat && !inNewChatMode && Boolean(activeChat.agentMode) !== developerAgentEnabled) {
    activeChat.agentMode = developerAgentEnabled;
    saveChats();
  }
  updateInputActionChips();
}

function setThinkMode(enabled) {
  thinkModeEnabled = Boolean(enabled);
  const activeChat = getActiveChat();
  if (activeChat && !inNewChatMode && Boolean(activeChat.thinkMode) !== thinkModeEnabled) {
    activeChat.thinkMode = thinkModeEnabled;
    saveChats();
  }
  updateInputActionChips();
}

function getActiveManualContext() {
  if (inNewChatMode || !activeChatId) {
    return String(pendingManualContext || '').trim();
  }
  const chat = getActiveChat();
  return String((chat && chat.manualContext) || '').trim();
}

function setActiveManualContext(value) {
  const clean = String(value || '').trim();
  if (inNewChatMode || !activeChatId) {
    pendingManualContext = clean;
    return;
  }
  const chat = getActiveChat();
  if (!chat) {
    pendingManualContext = clean;
    return;
  }
  if (String(chat.manualContext || '') === clean) return;
  chat.manualContext = clean;
  chat.updatedAt = nowTs();
  saveChats();
  renderHistory();
}

function updateContextButtonState() {
  updateInputActionChips();
}

function normalizePendingAttachmentMeta(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || `att_${nowTs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`).trim();
  const name = String(item.name || 'attachment').trim() || 'attachment';
  const kind = String(item.kind || '').toLowerCase() === 'text' ? 'text' : 'file';
  const size = Math.max(0, Number(item.size) || 0);
  const mime = String(item.mime || '').slice(0, 120);
  const note = String(item.note || '').slice(0, 600);
  const content = kind === 'text' ? String(item.content || '').slice(0, maxAttachmentTextChars) : '';
  return {
    id,
    name,
    kind,
    size,
    mime,
    note,
    ...(kind === 'text' ? { content } : {}),
  };
}

function normalizePendingAttachmentList(list) {
  return Array.from(list || [])
    .map(normalizePendingAttachmentMeta)
    .filter(Boolean)
    .slice(0, maxPendingAttachments);
}

function persistPendingAttachmentsForCurrentContext() {
  const clean = normalizePendingAttachmentList(pendingAttachments);
  pendingAttachments = clean;
  if (inNewChatMode || !activeChatId) {
    pendingNewChatAttachments = clean;
    return;
  }
  const chat = getActiveChat();
  if (!chat) return;
  chat.pendingAttachments = clean;
  chat.updatedAt = nowTs();
  saveChats();
}

function loadPendingAttachmentsForCurrentContext() {
  if (inNewChatMode || !activeChatId) {
    pendingAttachments = normalizePendingAttachmentList(pendingNewChatAttachments);
    return;
  }
  const chat = getActiveChat();
  pendingAttachments = normalizePendingAttachmentList(chat && Array.isArray(chat.pendingAttachments) ? chat.pendingAttachments : []);
}

function isLikelyTextAttachment(file) {
  const mime = String((file && file.type) || '').toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (/^(application\/(json|xml|javascript|x-javascript|x-sh|x-httpd-php)|text\/)/.test(mime)) return true;
  const name = String((file && file.name) || '').toLowerCase();
  return /\.(txt|md|markdown|json|yaml|yml|csv|tsv|log|js|mjs|cjs|ts|tsx|jsx|py|cpp|c|h|hpp|java|go|rs|rb|php|sql|xml|html|css|scss|sass|less|sh|bash|zsh|fish|ini|toml|conf|env|dockerfile|makefile|cmake|kt|swift|lua|r|ps1)$/i.test(name);
}

function isLikelyDocumentAttachment(file) {
  const mime = String((file && file.type) || '').toLowerCase();
  if (
    /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/rtf|text\/rtf)$/.test(mime)
  ) {
    return true;
  }
  const name = String((file && file.name) || '').toLowerCase();
  return /\.(pdf|doc|docx|rtf)$/i.test(name);
}

function isLikelyImageAttachment(file) {
  const mime = String((file && file.type) || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  const name = String((file && file.name) || '').toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/i.test(name);
}

function renderInputAttachments() {
  if (!inputAttachments) return;
  inputAttachments.innerHTML = '';
  if (inputRow) {
    inputRow.classList.toggle('has-attachments', pendingAttachments.length > 0);
  }
  pendingAttachments.forEach((item) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    const ext = String(item.name || '').split('.').pop() || '';
    const typeLabel = item.kind === 'text'
      ? (ext ? ext.toUpperCase() : 'TEXT')
      : (ext ? ext.toUpperCase() : 'FILE');
    const kind = item.kind === 'text' ? 'TEXT' : 'FILE';
    chip.innerHTML = `
        <span class="attach-chip-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </span>
        <span class="attach-chip-text">
          <span class="attach-chip-label">${escapeHtml(item.name || 'attachment')}</span>
          <span class="attach-chip-kind">${escapeHtml(typeLabel || kind)}</span>
        </span>
      `;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'attach-chip-remove';
    removeBtn.title = 'Remove attachment';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      pendingAttachments = pendingAttachments.filter((a) => a.id !== item.id);
      persistPendingAttachmentsForCurrentContext();
      renderInputAttachments();
    });
    chip.appendChild(removeBtn);
    inputAttachments.appendChild(chip);
  });
  updateAttachButtonState();
}

function clearPendingAttachments() {
  pendingAttachments = [];
  persistPendingAttachmentsForCurrentContext();
  renderInputAttachments();
}

function clearInputAugments() {
  clearPendingAttachments();
  updateContextButtonState();
}

function syncInputAugmentState() {
  loadPendingAttachmentsForCurrentContext();
  updateInputActionChips();
  renderInputAttachments();
  renderComposerConfirmationUi();
}

async function parseAttachmentFile(file) {
  const safeName = String((file && file.name) || 'attachment').trim() || 'attachment';
  const size = Number((file && file.size) || 0);
  const base = {
    id: `att_${nowTs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: safeName,
    size,
    mime: String((file && file.type) || ''),
  };
  if (isLikelyImageAttachment(file)) {
    return {
      ...base,
      kind: 'file',
      note: 'Image files are not processed by Attach. Use text/code/document files here.',
    };
  }
  const isText = isLikelyTextAttachment(file);
  const isDoc = isLikelyDocumentAttachment(file);
  if (!isText && !isDoc) {
    return {
      ...base,
      kind: 'file',
      note: 'Binary file attached as metadata reference.',
    };
  }
  if (size > 1024 * 1024 * 2) {
    return {
      ...base,
      kind: isText ? 'text' : 'file',
      note: isText
        ? 'Text file too large to inline; attached as metadata reference.'
        : 'Document attached as metadata reference (too large for text extraction).',
    };
  }
  let content = '';
  try {
    if (file && typeof file.text === 'function') {
      content = String(await file.text());
    } else {
      content = await new Promise((resolve) => {
        try {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => resolve('');
          reader.readAsText(file);
        } catch (_) {
          resolve('');
        }
      });
    }
  } catch (_) {
    content = '';
  }
  if (isDoc) {
    const rough = String(content || '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const snippets = rough.match(/[A-Za-z0-9][A-Za-z0-9 ,.;:'"!?()\-_/]{18,}/g) || [];
    const extracted = snippets.join('\n').trim();
    if (!extracted || extracted.length < 80) {
      return {
        ...base,
        kind: 'file',
        note: 'Document attached as metadata reference (text extraction unavailable for this file).',
      };
    }
    return {
      ...base,
      kind: 'text',
      content: extracted.slice(0, maxAttachmentTextChars),
      note: extracted.length > maxAttachmentTextChars
        ? 'Extracted document text truncated for prompt context.'
        : 'Extracted partial text from document for prompt context.',
    };
  }
  return {
    ...base,
    kind: 'text',
    content: content.slice(0, maxAttachmentTextChars),
    note: content.length > maxAttachmentTextChars ? 'Text truncated for prompt context.' : '',
  };
}

function openAttachPicker() {
  if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
  if (!ensureSignedIn()) return;
  if (attachFileInput) {
    attachFileInput.accept = attachAcceptTypes;
    attachFileInput.multiple = true;
    try {
      if (typeof attachFileInput.showPicker === 'function') {
        attachFileInput.showPicker();
        return;
      }
    } catch (_) { }
    try {
      attachFileInput.click();
      return;
    } catch (_) { }
  }
  // Fallback: ephemeral picker for embedded webviews that ignore static input clicks.
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.accept = attachAcceptTypes;
  picker.style.position = 'fixed';
  picker.style.left = '-9999px';
  picker.style.opacity = '0';
  picker.addEventListener('change', () => {
    void handleAttachSelection(picker.files);
    picker.remove();
  }, { once: true });
  document.body.appendChild(picker);
  picker.click();
}

async function handleAttachSelection(fileList) {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList).slice(0, maxPendingAttachments);
  const parsed = [];
  for (const file of files) {
    parsed.push(await parseAttachmentFile(file));
  }
  const seen = new Set(
    pendingAttachments
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const name = String(item.name || '').trim().toLowerCase();
        const kind = String(item.kind || '').trim().toLowerCase();
        const size = String(Math.max(0, Number(item.size) || 0));
        const mime = String(item.mime || '').trim().toLowerCase();
        return `${name}|${kind}|${size}|${mime}`;
      })
      .filter(Boolean)
  );
  const deduped = [];
  parsed.forEach((item) => {
    const name = String(item && item.name ? item.name : '').trim().toLowerCase();
    const kind = String(item && item.kind ? item.kind : '').trim().toLowerCase();
    const size = String(Math.max(0, Number(item && item.size ? item.size : 0) || 0));
    const mime = String(item && item.mime ? item.mime : '').trim().toLowerCase();
    const key = `${name}|${kind}|${size}|${mime}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    deduped.push(item);
  });
  const next = pendingAttachments.concat(deduped).slice(0, maxPendingAttachments);
  pendingAttachments = next;
  persistPendingAttachmentsForCurrentContext();
  renderInputAttachments();
}

function editManualContext() {
  if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
  if (!ensureSignedIn()) return;
  openUrlContextModal('manual');
}

function sanitizeAutoTitle(rawTitle) {
  let out = String(rawTitle || '').replace(/[\r\n]+/g, ' ').trim();
  out = out.replace(/^[-*•]+\s+/g, '');
  out = out.replace(/^\d+[.)]\s+/g, '');
  out = out.replace(/^["'`]+|["'`]+$/g, '').trim();
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/[.?!,:;]+$/g, '').trim();
  if (out) {
    const words = out.split(/\s+/).filter(Boolean);
    if (words.length > 6) {
      out = words.slice(0, 6).join(' ');
    }
  }
  if (!out) return '';
  out = toAutoTitleCase(out);
  if (out.length > 52) out = `${out.slice(0, 52).trim()}...`;
  return out;
}

function sanitizeUserRequestTitle(rawTitle) {
  let out = String(rawTitle || '').split(/\r?\n/).find((line) => String(line || '').trim()) || '';
  out = out.trim();
  const intentTitle = getCommonIntentChatTitle(out);
  if (intentTitle) return intentTitle;
  const greetingTitle = getGreetingChatTitle(out);
  if (greetingTitle) return greetingTitle;
  out = out
    .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/i, '')
    .replace(/^(?:please\s+)?(?:help\s+me\s+)?(?:create|build|make|design|develop|generate|start|setup|set\s+up|implement)\s+(?:me\s+)?(?:a|an|the)?\s*/i, '')
    .replace(/^(?:i\s+(?:need|want|would\s+like)\s+(?:you\s+to\s+)?)?(?:create|build|make|design|develop|generate|implement)\s+(?:a|an|the)?\s*/i, '')
    .replace(/\s+(?:that|which)\s+(?:looks?|feels?|works?|runs?|shows?|includes?)\b[\s\S]*$/i, '')
    .replace(/\s+with\s+requirements?\b[\s\S]*$/i, '')
    .trim();
  return sanitizeAutoTitle(out || rawTitle);
}

function getCommonIntentChatTitle(text) {
  const clean = String(text || '').trim().toLowerCase()
    .replace(/[!?.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || clean.split(' ').length > 8) return '';
  if (/^(what can you do|what are your capabilities|what can you help with|what do you do)$/.test(clean)) {
    return 'Assistant Capabilities';
  }
  if (/^(who are you|what are you|introduce yourself)$/.test(clean)) {
    return 'Assistant Introduction';
  }
  if (/^(help|help me|get started|start here)$/.test(clean)) {
    return 'Getting Started';
  }
  return '';
}

function getGreetingChatTitle(text) {
  const clean = String(text || '').trim().toLowerCase();
  if (!clean) return '';
  const normalized = clean
    .replace(/[!?.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.split(' ').length > 6) return '';
  if (/^(hi|hello|hey|hey there|hello there|yo|sup|what'?s up|whats up|howdy)$/.test(normalized)) {
    return 'Greeting Exchange';
  }
  if (/^(how are you|how are you doing|how are things|how is it going|how's it going|hows it going)$/.test(normalized)) {
    return 'Casual Check-in';
  }
  if (/^(good morning|good afternoon|good evening)$/.test(normalized)) {
    return 'Greeting Exchange';
  }
  return '';
}


function hasDuplicateChatName(title, chatId) {
  const target = String(title || '').trim().toLowerCase();
  if (!target) return false;
  const currentId = String(chatId || '');
  return chats.some((c) => c && c.id !== currentId && String(c.name || '').trim().toLowerCase() === target);
}

function buildRephrasedTitleCandidates(baseTitle, sourceText) {
  const candidates = [];
  const add = (value) => {
    const clean = sanitizeAutoTitle(value);
    if (!clean) return;
    if (!candidates.some((c) => c.toLowerCase() === clean.toLowerCase())) {
      candidates.push(clean);
    }
  };

  const sourceWords = String(sourceText || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const baseWords = String(baseTitle || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const lead = (sourceWords.length ? sourceWords : baseWords).slice(0, 5).join(' ');
  const root = (baseWords.length ? baseWords : sourceWords).slice(0, 5).join(' ');

  add(lead);
  if (sourceWords.length > 2) add(sourceWords.slice(1, 7).join(' '));
  if (sourceWords.length > 2) add([sourceWords[sourceWords.length - 1], ...sourceWords.slice(0, 5)].join(' '));

  ['overview', 'discussion', 'notes', 'focus', 'recap', 'summary', 'brief'].forEach((suffix) => {
    if (lead) add(`${lead} ${suffix}`);
    if (root) add(`${root} ${suffix}`);
  });
  ['fresh', 'new', 'updated', 'focused', 'reframed', 'alternate'].forEach((prefix) => {
    if (lead) add(`${prefix} ${lead}`);
    if (root) add(`${prefix} ${root}`);
  });
  return candidates;
}

function makeUniqueChatName(baseTitle, chatId, sourceText = '') {
  const base = normalizeChatName(sanitizeAutoTitle(baseTitle) || 'New Chat');
  if (!hasDuplicateChatName(base, chatId)) return base;

  const rephrased = buildRephrasedTitleCandidates(base, sourceText);
  for (const candidate of rephrased) {
    const next = normalizeChatName(candidate);
    if (!hasDuplicateChatName(next, chatId)) return next;
  }

  const fallbackPrefixes = ['fresh', 'new', 'focused', 'alternate', 'updated', 'refined'];
  for (const prefix of fallbackPrefixes) {
    const candidate = normalizeChatName(sanitizeAutoTitle(`${prefix} ${base}`));
    if (candidate && !hasDuplicateChatName(candidate, chatId)) return candidate;
  }
  return base;
}

function stripInlineChatNameMarkers(text, options = {}) {
  const trimLeading = options && options.trimLeading !== false;
  let out = String(text || '')
    .replace(/\[\[\s*\*?\*?(?:CHAT_NAME\s*:\s*)?[^\]]+?\*?\*?\s*\]\]\s*\n?/gi, '')
    .replace(/^\s*\[\[\s*\*?\*?(?:CHAT_NAME\s*:\s*)?[^\]\n]*$/gim, '')
    .replace(/^\s*\[\[\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n');
  if (trimLeading) {
    out = out.trimStart();
  }
  return out;
}

function buildInlineChatNameInstructionForTurn(chatId, options = {}) {
  const chat = findChatById(chatId);
  if (!shouldInlineNameChatResponse(chat)) return '';
  if (options && options.suppress) return '';
  return [
    'MANDATORY OUTPUT PREFIX FOR THIS RESPONSE:',
    'First line must be exactly: [[CHAT_NAME: 2-6 word title]]',
    'Title rules: must reflect the user topic; do not use AI.EXE, Assistant, Chat, Hello, Hi, or generic greetings.',
    'Second line onward: your normal assistant response.',
    'Do not explain the tag. Do not skip the tag.',
  ].join('\n');
}

function stripLeadingInlineChatNameFragment(text, chatId = '') {
  const src = String(text || '');
  if (!src) return src;
  const chat = chatId ? findChatById(chatId) : null;
  if (!shouldInlineNameChatResponse(chat)) {
    return src;
  }
  if (!/^\s*\[/.test(src)) {
    return src;
  }

  const newlineIdx = src.indexOf('\n');
  if (newlineIdx < 0) {
    return '';
  }

  const firstLine = src.slice(0, newlineIdx).trim();
  if (/^\[\[$/.test(firstLine) ||
    /^\[\[/.test(firstLine) ||
    /^\[$/.test(firstLine) ||
    /chat_name/i.test(firstLine)) {
    return src.slice(newlineIdx + 1).trimStart();
  }

  return src;
}

function stripLeadingLlamaEngineNoise(text, options = {}) {
  const trimLeading = options && options.trimLeading !== false;
  const src = String(text || '');
  if (!src) return src;

  const isBannerGlyphLine = (line) => {
    const t = String(line || '').trim();
    if (!t) return false;
    for (const ch of t) {
      if (/\s/.test(ch)) continue;
      if (ch.charCodeAt(0) >= 128) continue;
      return false;
    }
    return true;
  };

  const isNoiseLine = (line) => {
    const t = String(line || '').trim();
    if (!t) return true;
    const lower = t.toLowerCase();
    if (
      lower.startsWith('ggml_') ||
      lower.startsWith('llama_') ||
      lower.startsWith('load_tensors:') ||
      lower.startsWith('main: ') ||
      lower === 'loading model...' ||
      lower === 'available commands:' ||
      lower.startsWith('build      :') ||
      lower.startsWith('model      :') ||
      lower.startsWith('modalities :') ||
      lower.startsWith('/exit') ||
      lower.startsWith('/regen') ||
      lower.startsWith('/clear') ||
      lower.startsWith('/read') ||
      lower.startsWith('> ')
    ) {
      return true;
    }
    return isBannerGlyphLine(t);
  };

  const lines = src.split('\n');
  const kept = [];
  let keeping = false;
  for (const line of lines) {
    if (!keeping && isNoiseLine(line)) {
      continue;
    }
    if (!keeping && !String(line || '').trim()) {
      continue;
    }
    keeping = true;
    kept.push(line);
  }

  const out = kept.join('\n');
  return trimLeading ? out.trimStart() : out;
}

function stripLeadingAiExePromptLeak(text, options = {}) {
  const trimLeading = options && options.trimLeading !== false;
  let src = stripLeadingLlamaEngineNoise(String(text || ''), { trimLeading: false });
  if (!src) return src;

  const lines = src.split('\n');
  const firstNonEmpty = lines.findIndex((line) => String(line || '').trim());
  if (firstNonEmpty < 0) return trimLeading ? src.trimStart() : src;

  const firstLine = String(lines[firstNonEmpty] || '').trim();
  if (!/^You are AI\.EXE\b/i.test(firstLine) && !/^<\|im_start\|>system$/i.test(firstLine)) {
    return trimLeading ? src.trimStart() : src;
  }

  const promptTrailerPatterns = [
    /\.\.\.\s+\(truncated\)/gi,
    /\.\.\.\(truncated\)/gi,
  ];
  for (const pattern of promptTrailerPatterns) {
    const matches = [...src.matchAll(pattern)];
    if (!matches.length) continue;
    const last = matches[matches.length - 1];
    const end = Number(last.index || 0) + String(last[0] || '').length;
    const suffix = src.slice(end).trimStart();
    if (suffix) {
      return trimLeading ? suffix.trimStart() : suffix;
    }
  }

  let skippingPrompt = true;
  let inKnownSection = false;
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || '');
    const t = line.trim();
    const lower = t.toLowerCase();

    if (!skippingPrompt) {
      kept.push(line);
      continue;
    }

    if (!t) {
      continue;
    }

    if (
      /^<\|im_(?:start|end)\|>.*$/i.test(t) ||
      /^you are ai\.exe\b/i.test(t) ||
      /^(identity|core capabilities|response style|safety)\s*:\s*$/i.test(t) ||
      /^current_user\s*:/i.test(t) ||
      /^mandatory output prefix for this response\s*:/i.test(t) ||
      /^title rules\s*:/i.test(t) ||
      /^(think_mode|canvas_mode)\s*:/i.test(t)
    ) {
      inKnownSection = true;
      continue;
    }

    if (inKnownSection && /^-\s+/.test(t)) {
      continue;
    }

    if (inKnownSection && /^[1-9]\.\s+/.test(t)) {
      continue;
    }

    skippingPrompt = false;
    kept.push(line);
  }

  const out = kept.join('\n');
  return trimLeading ? out.trimStart() : out;
}

function shouldInlineNameChatResponse(chat) {
  if (!chat || chat.customName || !chat.isNaming) return false;
  const aiCount = Array.isArray(chat.messages)
    ? chat.messages.filter((msg) => msg && msg.role === 'ai' && String(msg.text || '').trim()).length
    : 0;
  return aiCount === 0;
}

function isGreetingLikeChatSeed(text) {
  const clean = String(text || '').trim().toLowerCase();
  if (!clean) return true;
  const normalized = clean
    .replace(/[!?.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return true;
  if (normalized.split(' ').length > 5) return false;
  return /^(hi|hello|hey|hey there|hello there|yo|sup|what'?s up|whats up|howdy|good morning|good afternoon|good evening|how are you|how are you doing|who are you)$/.test(normalized);
}

function extractInlineChatNameMarker(text) {
  const src = String(text || '');
  if (!src) return { title: '', cleaned: '' };
  // Match [[CHAT_NAME: title]] OR plain [[title]]. Ignore other labeled markers such as [[CHAIN_NAME: ...]].
  const marker = src.match(/\[\[\s*\*?\*?([^\]]+?)\*?\*?\s*\]\]/i);
  if (!marker) {
    return { title: '', cleaned: src };
  }
  const rawMarker = String(marker[1] || '').trim();
  let rawTitle = rawMarker;
  const labelMatch = rawMarker.match(/^([A-Z_ -]{2,32})\s*:\s*(.+)$/i);
  if (labelMatch) {
    const label = String(labelMatch[1] || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (label !== 'CHAT_NAME') {
      return { title: '', cleaned: stripInlineChatNameMarkers(src) };
    }
    rawTitle = String(labelMatch[2] || '').trim();
  }
  const title = sanitizeAutoTitle(rawTitle);
  const cleaned = stripInlineChatNameMarkers(src);
  return { title, cleaned };
}

function deriveFallbackChatName(chat, assistantText = '') {
  const assistantRaw = String(assistantText || '');
  const canvasTitleMatch = assistantRaw.match(/<AIcanvas[^>]*\btitle="([^"]{2,90})"/i);
  if (canvasTitleMatch && canvasTitleMatch[1]) {
    const fromCanvas = sanitizeAutoTitle(canvasTitleMatch[1]);
    if (fromCanvas) {
      return makeUniqueChatName(fromCanvas, String(chat && chat.id ? chat.id : ''), fromCanvas);
    }
  }
  const fromUser = deriveFallbackChatNameFromUser(chat, '');
  if (fromUser && fromUser !== 'New Chat') {
    return fromUser;
  }
  const sourceParts = [];
  const userMsg = (chat && Array.isArray(chat.messages))
    ? chat.messages.find((m) => m && m.role === 'user' && String(m.text || '').trim())
    : null;
  if (userMsg) sourceParts.push(String(userMsg.text || '').trim());
  if (assistantText) sourceParts.push(String(assistantText || '').trim());
  const source = sourceParts.join(' ').replace(/\s+/g, ' ').trim();
  const candidate = sanitizeAutoTitle(source);
  if (!candidate) return 'New Chat';
  return makeUniqueChatName(candidate, String(chat && chat.id ? chat.id : ''), source);
}

function resolveChatNamingFallback(chatId, fallbackName = 'New Chat') {
  const chat = findChatById(chatId);
  if (!chat || chat.customName || !chat.isNaming) {
    return false;
  }
  chat.name = normalizeChatName(fallbackName || 'New Chat');
  chat.isNaming = false;
  chat.updatedAt = nowTs();
  saveChats();
  renderHistory();
  return true;
}

function deriveFallbackChatNameFromUser(chat, fallbackName = 'New Chat') {
  const firstUser = chat && Array.isArray(chat.messages)
    ? chat.messages.find((msg) => msg && msg.role === 'user' && String(msg.text || '').trim())
    : null;
  const firstUserText = firstUser ? String(firstUser.text || '').trim() : '';
  if (!firstUserText || isGreetingLikeChatSeed(firstUserText)) {
    return normalizeChatName(fallbackName || 'New Chat');
  }
  const candidate = sanitizeUserRequestTitle(firstUserText);
  if (!candidate) {
    return normalizeChatName(fallbackName || 'New Chat');
  }
  return makeUniqueChatName(candidate, String(chat && chat.id ? chat.id : ''), firstUserText);
}

function applyAgentProjectChatName(chatId, planSpec = null) {
  const chat = findChatById(chatId);
  if (!chat || chat.customName || (!chat.isNaming && !chat.autoNamed) || !planSpec) return false;
  if (String(planSpec.taskKind || '') !== 'project') return false;
  const sourceName = String(planSpec.projectName || '').trim();
  if (!sourceName) return false;
  const aiCount = Array.isArray(chat.messages)
    ? chat.messages.filter((msg) => msg && msg.role === 'ai' && String(msg.text || '').trim()).length
    : 0;
  const userCount = Array.isArray(chat.messages)
    ? chat.messages.filter((msg) => msg && msg.role === 'user' && String(msg.text || '').trim()).length
    : 0;
  if (aiCount > 0 || userCount !== 1) return false;
  // The project name IS the chat title for a project task. kebab-case slug ->
  // spaced Title Case (e.g. "factory-logistics-simulator" -> "Factory Logistics
  // Simulator"). Only fall back to a name derived from the user's message when
  // there is somehow no usable project name (the user asked for this priority).
  const prettyName = normalizeChatName(toAutoTitleCase(sourceName.replace(/[-_]+/g, ' ')) || sourceName);
  const userDerivedName = deriveFallbackChatNameFromUser(chat, prettyName);
  const displayName = normalizeChatName(prettyName || (userDerivedName && userDerivedName !== 'New Chat' ? userDerivedName : ''));
  if (!displayName) return false;
  chat.name = displayName;
  chat.isNaming = false;
  chat.autoNamed = true;
  chat.smartTitleAttempted = true; // project name is final; smart-rename won't override
  chat.updatedAt = nowTs();
  saveChats();
  renderHistory();
  pushDebugTrace('agent_namer_applied', {
    chatId: String(chatId || ''),
    title: chat.name,
  });
  return true;
}

function applyInlineChatNameFromResponse(chatId, text) {
  const parsed = extractInlineChatNameMarker(text);
  const chat = findChatById(chatId);
  if (!chat) {
    return { text: parsed.cleaned || String(text || '') };
  }
  if (shouldInlineNameChatResponse(chat)) {
    const validTitle = Boolean(parsed.title);
    if (validTitle) {
      chat.name = makeUniqueChatName(parsed.title, chatId, parsed.title);
      // The model's own marker title is final — don't let smart-rename override it.
      chat.autoNamed = false;
      pushDebugTrace('inline_namer_applied', {
        chatId: String(chatId || ''),
        title: chat.name,
      });
    } else {
      chat.name = deriveFallbackChatName(chat, text);
      chat.autoNamed = true; // weak fallback — let smart-rename improve it
      pushDebugTrace('inline_namer_fallback', {
        chatId: String(chatId || ''),
        reason: 'marker_missing_or_invalid',
        title: chat.name,
      });
    }
    chat.isNaming = false;
    chat.updatedAt = nowTs();
    saveChats();
    renderHistory();
  }
  return { text: parsed.cleaned || String(text || '') };
}

function extractSmartChatTitle(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return '';
  const parsed = extractFirstJsonObject(raw);
  const rawTitle = parsed && typeof parsed.title === 'string'
    ? parsed.title
    : raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .split('\n')
      .map((line) => String(line || '').trim())
      .find(Boolean);
  let title = sanitizeAutoTitle(rawTitle || '');
  title = title.replace(/\b(Chat|Conversation|User Request)\b/gi, '').replace(/\s+/g, ' ').trim();
  title = sanitizeAutoTitle(title);
  if (!title) return '';
  if (/^(New|Untitled|Title|Chat|Conversation)$/i.test(title)) return '';
  if (/^(We Need|The User|I Need|Need To|Generate A|Create A Concise)\b/i.test(title)) return '';
  return title;
}

function deriveChatTitleFromFirstUserMessage(chat) {
  const thread = chat ? getChatActiveThread(chat) : null;
  const msgs = thread && Array.isArray(thread.messages) ? thread.messages : [];
  const firstUser = msgs.find((m) => m && m.role === 'user' && String(m.text || '').trim());
  return firstUser ? sanitizeUserRequestTitle(String(firstUser.text || '')) : '';
}

function settleSmartChatTitleFallback(chatId, reason = 'fallback', assistantText = '') {
  const key = String(chatId || '');
  const chat = findChatById(key);
  if (!chat || chat.customName || !chat.isNaming) return false;
  // When the smart (remote) namer fails, don't leave the chat as "New Chat" —
  // derive a real title from the first user message deterministically.
  const derived = deriveChatTitleFromFirstUserMessage(chat);
  chat.name = derived ? makeUniqueChatName(derived, key, derived) : 'New Chat';
  chat.isNaming = false;
  chat.autoNamed = false;
  saveChats();
  renderHistory();
  pushDebugTrace('smart_chat_title_fallback', {
    chatId: key,
    reason: String(reason || 'fallback'),
    title: chat.name,
  });
  return true;
}

function scheduleSmartChatRename(chatId) {
  const key = String(chatId || '');
  if (!key || smartTitleRenamePending.has(key)) return;
  const chat = findChatById(key);
  // Self-heal a chat left stuck on "New Chat" by an earlier failed naming attempt
  // (e.g. the remote namer erred / was out of credits): name it deterministically
  // from the first user message — no remote call.
  if (chat && !chat.customName && chat.smartTitleAttempted
    && String(chat.name || '').trim().toLowerCase() === 'new chat') {
    const derived = deriveChatTitleFromFirstUserMessage(chat);
    if (derived) {
      chat.name = makeUniqueChatName(derived, key, derived);
      chat.isNaming = false;
      chat.autoNamed = false;
      saveChats();
      renderHistory();
      pushDebugTrace('smart_chat_title_healed', { chatId: key, title: chat.name });
    }
    return;
  }
  const needsGeneratedTitle = Boolean(chat && (chat.isNaming || chat.autoNamed));
  if (!chat || chat.customName || !needsGeneratedTitle || chat.smartTitleAttempted) {
    pushDebugTrace('smart_chat_title_skipped', {
      chatId: key,
      reason: !chat ? 'missing_chat' : chat.customName ? 'custom_name' : !needsGeneratedTitle ? 'already_named' : 'already_attempted',
    });
    return;
  }
  const activeThread = getChatActiveThread(chat);
  const messages = activeThread && Array.isArray(activeThread.messages) ? activeThread.messages : [];
  const firstUser = messages.find((msg) => msg && msg.role === 'user' && String(msg.text || '').trim());
  const firstAssistant = messages.find((msg) => msg && msg.role === 'ai' && String(msg.text || '').trim());
  const aiCount = messages.filter((msg) => msg && msg.role === 'ai' && String(msg.text || '').trim()).length;
  if (!firstUser || !firstAssistant || aiCount !== 1 || !remoteProvidersEnabled) {
    pushDebugTrace('smart_chat_title_skipped', {
      chatId: key,
      reason: !remoteProvidersEnabled ? 'remote_disabled' : !firstUser ? 'missing_user' : !firstAssistant ? 'missing_assistant' : 'not_first_assistant',
      aiCount: String(aiCount),
    });
    if (!remoteProvidersEnabled || !firstAssistant) {
      settleSmartChatTitleFallback(key, !remoteProvidersEnabled ? 'remote_disabled' : 'missing_assistant');
    }
    return;
  }

  chat.smartTitleAttempted = true;
  saveChats();
  smartTitleRenamePending.add(key);
  pushDebugTrace('smart_chat_title_started', {
    chatId: key,
    currentTitle: String(chat.name || ''),
  });

  window.setTimeout(() => {
    void (async () => {
      try {
        const latestChat = findChatById(key);
        if (!latestChat || latestChat.customName || (!latestChat.isNaming && !latestChat.autoNamed)) return;
        const prompt = [
          'Generate a concise sidebar title for this chat.',
          '',
          'Rules:',
          '- 3 to 6 words',
          '- Same language as the chat',
          '- Descriptive, not clickbait',
          '- No quotes, markdown, or trailing punctuation',
          '- Do not use the words chat, conversation, or user',
          '- Return only valid JSON in this format:',
          '{"title":"..."}',
          '',
          'Examples:',
          'User: hello',
          'Assistant: Hello! How can I help you today?',
          'Output: {"title":"Greeting Exchange"}',
          '',
          'User: how are you doing?',
          'Assistant: Doing well, thanks for asking.',
          'Output: {"title":"Casual Check-in"}',
          '',
          'User: what can you do?',
          'Assistant: I can help with coding, debugging, architecture, documentation, and technical questions.',
          'Output: {"title":"Assistant Capabilities"}',
          '',
          'User: Create a desktop-style web app UI that looks like a modern operating system home screen.',
          'Assistant: Here is an interactive desktop-style web app UI.',
          'Output: {"title":"Desktop OS Interface"}',
          '',
          'Chat:',
          `User: ${String(firstUser.text || '').trim().slice(0, 1200)}`,
          `Assistant: ${String(firstAssistant.text || '').trim().slice(0, 1200)}`,
        ].join('\n');
        const result = await requestRemoteTextCompletionForCapability('chat.reply', prompt, 40, { preferStreaming: true });
        const nextTitle = extractSmartChatTitle(result && result.ok ? result.output : '');
        const current = String(latestChat.name || '').trim();
        if (!nextTitle) {
          pushDebugTrace('smart_chat_title_failed', {
            chatId: key,
            error: result && result.message ? String(result.message) : 'empty_or_invalid_title',
            rawPreview: debugPreview(String(result && result.output ? result.output : ''), 300),
            ok: String(Boolean(result && result.ok)),
            provider: String((result && result.provider) || ''),
            model: String((result && result.model) || ''),
          });
          settleSmartChatTitleFallback(key, 'empty_or_invalid_title', String(firstAssistant.text || ''));
          return;
        }
        if (nextTitle.toLowerCase() === current.toLowerCase()) {
          pushDebugTrace('smart_chat_title_skipped', {
            chatId: key,
            reason: 'same_title',
            title: nextTitle,
          });
          latestChat.isNaming = false;
          latestChat.autoNamed = false;
          saveChats();
          renderHistory();
          return;
        }
        latestChat.name = makeUniqueChatName(nextTitle, key, nextTitle);
        latestChat.isNaming = false;
        latestChat.autoNamed = false;
        saveChats();
        renderHistory();
        pushDebugTrace('smart_chat_title_applied', {
          chatId: key,
          title: latestChat.name,
          provider: String((result && result.provider) || ''),
          model: String((result && result.model) || ''),
        });
      } catch (err) {
        pushDebugTrace('smart_chat_title_failed', {
          chatId: key,
          error: String(err && err.message ? err.message : err || 'unknown error'),
        });
        settleSmartChatTitleFallback(key, 'exception', String(firstAssistant.text || ''));
      } finally {
        smartTitleRenamePending.delete(key);
      }
    })();
  }, 0);
}

function buildPromptWithInputAugments(basePrompt) {
  const base = String(basePrompt || '').trim();
  const sections = [];
  if (pendingAttachments.length > 0) {
    const chunks = pendingAttachments.map((item, index) => {
      const heading = `Attachment ${index + 1}: ${item.name} (${formatBytes(item.size || 0)})`;
      if (item.kind === 'text' && item.content) {
        return `${heading}\n${item.note ? `${item.note}\n` : ''}---\n${item.content}`;
      }
      return `${heading}\n${item.note || 'File attached as metadata only.'}`;
    });
    sections.push(`[ATTACHMENTS]\n${chunks.join('\n\n')}`);
  }
  if (sections.length === 0) return base;
  return `${base}\n\n${sections.join('\n\n')}`;
}

function toggleCanvasMode() {
  if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
  setCanvasMode(!canvasModeEnabled);
}

function closeCanvasDock() {
  canvasDockOpen = false;
  setCanvasMode(false);
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) { }

  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch (_) {
    return false;
  }
}

function copyCheckSvg() {
  return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
}

function applyCopyFeedback(btn, copied, baseTitle) {
  if (!btn) return;
  const title = String(baseTitle || 'Copy');
  if (!btn.dataset.copyBaseIcon) {
    btn.dataset.copyBaseIcon = btn.innerHTML;
  }
  if (btn._copyResetTimer) {
    clearTimeout(btn._copyResetTimer);
    btn._copyResetTimer = null;
  }

  if (copied) {
    btn.title = 'Copied';
    btn.innerHTML = copyCheckSvg();
    btn._copyResetTimer = setTimeout(() => {
      btn.title = title;
      if (btn.dataset.copyBaseIcon) {
        btn.innerHTML = btn.dataset.copyBaseIcon;
      }
      btn._copyResetTimer = null;
    }, 1400);
    return;
  }

  btn.title = 'Copy failed';
  btn._copyResetTimer = setTimeout(() => {
    btn.title = title;
    btn._copyResetTimer = null;
  }, 1200);
}

function setCanvasPanelContent(content, name = '') {
  const text = String(content || '');
  latestCanvasName = String(name || '').trim();
  if (canvasTitle) {
    canvasTitle.textContent = latestCanvasName ? `Canvas • ${latestCanvasName}` : 'Canvas Editor';
  }
  if (canvasEditor) {
    canvasEditor.value = text;
    canvasEditor.scrollTop = 0;
  }
  renderMiddleView();
}

function syncCanvasPanelFromArtifacts() {
  const latest = getCanvasArtifactsForChat(activeChatId)
    .filter((item) => typeof item.content === 'string' && item.content.trim())
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0];
  if (!latest) {
    setCanvasPanelContent('', '');
    return;
  }
  setCanvasPanelContent(latest.content, latest.name);
}

if (canvasCopyBtn) {
  canvasCopyBtn.addEventListener('click', async () => {
    const text = canvasEditor ? canvasEditor.value : '';
    const copied = await copyTextToClipboard(text);
    applyCopyFeedback(canvasCopyBtn, copied, 'Copy canvas');
  });
}
if (canvasCloseBtn) {
  canvasCloseBtn.addEventListener('click', () => {
    closeCanvasDock();
  });
}
if (composerConfirmDismissBtn) {
  composerConfirmDismissBtn.addEventListener('click', () => {
    dismissComposerPermission();
  });
}
if (composerConfirmSubmitBtn) {
  composerConfirmSubmitBtn.addEventListener('click', () => {
    submitComposerPermissionSelection();
  });
}
if (artifactCopyBtn) {
  artifactCopyBtn.addEventListener('click', async () => {
    const text = artifactEditor ? artifactEditor.value : '';
    const copied = await copyTextToClipboard(text);
    applyCopyFeedback(artifactCopyBtn, copied, 'Copy artifact');
  });
}
if (artifactOpenChatBtn) {
  artifactOpenChatBtn.addEventListener('click', () => {
    const chatId = artifactOpenChatBtn.dataset.chatId || '';
    if (!chatId || !findChatById(chatId)) return;
    loadHistory(chatId);
  });
}

function saveAuthStore() {
  try {
    localStorage.setItem(authStorageKey, JSON.stringify(authStore));
  } catch (_) { }
}

function loadAuthStore() {
  authStore = { users: [], currentUser: null };
  try {
    const raw = localStorage.getItem(authStorageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.users)) return;
    authStore.users = parsed.users
      .filter((u) => u && typeof u.username === 'string' &&
        typeof u.salt === 'string' && typeof u.passwordHash === 'string')
      .slice(0, 100)
      .map((u) => ({
        username: normalizeUsername(u.username),
        usernameKey: usernameKey(u.usernameKey || u.username),
        salt: String(u.salt),
        passwordHash: String(u.passwordHash),
        createdAt: Number(u.createdAt) || nowTs(),
      }))
      .filter((u) => u.username.length > 0 && u.usernameKey.length > 0);
    if (typeof parsed.currentUser === 'string' && findUserByKey(usernameKey(parsed.currentUser))) {
      authStore.currentUser = usernameKey(parsed.currentUser);
    }
  } catch (_) { }
}

function updateLoginUi() {
  const user = currentAuthUser();
  if (user) {
    if (loginBtnText) loginBtnText.textContent = 'Settings';
    if (loginSubText) loginSubText.textContent = '';
    if (accountPopoverName) accountPopoverName.textContent = user.username;
    if (accountLogoutText) accountLogoutText.textContent = 'Log out';
    if (avatarBadge) {
      const initial = (user.username || 'U').trim().charAt(0).toUpperCase() || 'U';
      avatarBadge.textContent = initial;
      avatarBadge.title = `@${user.username}`;
    }
  } else {
    if (loginBtnText) loginBtnText.textContent = 'Settings';
    if (loginSubText) loginSubText.textContent = '';
    if (accountPopoverName) accountPopoverName.textContent = 'Guest';
    if (accountLogoutText) accountLogoutText.textContent = 'Log in';
    if (avatarBadge) {
      avatarBadge.textContent = 'U';
      avatarBadge.title = 'Guest';
    }
  }
}

function moveGlobalControlsIntoSidebar() {
  if (sidebarBottomActions) sidebarBottomActions.innerHTML = '';
  if (accountPopover && accountPopover.parentElement !== document.body) {
    document.body.appendChild(accountPopover);
  }
}

function closeAccountPopover() {
  if (!accountPopover) return;
  accountPopover.classList.remove('open');
  accountPopover.setAttribute('aria-hidden', 'true');
  accountPopover.style.left = '';
  accountPopover.style.bottom = '';
}

function toggleAccountPopover() {
  if (!accountPopover) return;
  const isOpen = accountPopover.classList.contains('open');
  if (!isOpen && loginBtn) {
    const rect = loginBtn.getBoundingClientRect();
    accountPopover.style.left = `${Math.max(10, rect.left)}px`;
    const popoverWidth = Math.min(272, window.innerWidth - 24);
    const maxLeft = Math.max(10, window.innerWidth - popoverWidth - 10);
    accountPopover.style.left = `${Math.min(Math.max(10, rect.left), maxLeft)}px`;
    accountPopover.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 12)}px`;
  }
  accountPopover.classList.toggle('open', !isOpen);
  accountPopover.setAttribute('aria-hidden', isOpen ? 'true' : 'false');
}

function setAuthNote(message, kind = 'error') {
  if (!authNote) return;
  const text = String(message || '').trim();
  if (!text) {
    authNote.textContent = '';
    authNote.classList.remove('visible', 'auth-info');
    return;
  }
  authNote.textContent = text;
  authNote.classList.add('visible');
  authNote.classList.toggle('auth-info', kind === 'info');
}

function setAuthMode(mode) {
  let nextMode = mode;
  const user = currentAuthUser();
  if (nextMode === 'account' && !user) {
    nextMode = 'login';
  }
  authMode = nextMode;

  const accountMode = authMode === 'account';
  const signupMode = authMode === 'signup';
  const loginMode = authMode === 'login';

  if (authTitle) {
    authTitle.textContent = accountMode ? 'Account' : 'Account Access';
  }
  if (authSwitch) authSwitch.style.display = accountMode ? 'none' : 'flex';
  if (authLoginTab) authLoginTab.classList.toggle('active', loginMode);
  if (authSignupTab) authSignupTab.classList.toggle('active', signupMode);

  if (authUserWrap) authUserWrap.style.display = 'block';
  if (authPassWrap) authPassWrap.style.display = accountMode ? 'none' : 'block';
  if (authConfirmWrap) authConfirmWrap.style.display = signupMode ? 'block' : 'none';
  if (authUserInput) authUserInput.disabled = accountMode;
  if (authActionBtn) {
    authActionBtn.style.display = accountMode ? 'none' : 'inline-flex';
    authActionBtn.textContent = signupMode ? 'Create Account' : 'Log In';
  }
  if (authLogoutBtn) authLogoutBtn.style.display = accountMode ? 'inline-flex' : 'none';

  if (accountMode && user) {
    if (authUserInput) authUserInput.value = user.username;
    if (authPassInput) authPassInput.value = '';
    if (authConfirmInput) authConfirmInput.value = '';
    setAuthNote(`Signed in locally as @${user.username}`, 'info');
  } else {
    if (authPassInput) authPassInput.value = '';
    if (authConfirmInput) authConfirmInput.value = '';
    setAuthNote('');
  }
}

function openAuthModal(mode = 'login') {
  if (!authBackdrop) return;
  closeAccountPopover();
  setAuthMode(mode);
  authBackdrop.classList.add('open');
  authBackdrop.setAttribute('aria-hidden', 'false');
  if (authMode === 'account') {
    setTimeout(() => authLogoutBtn && authLogoutBtn.focus(), 0);
  } else {
    setTimeout(() => authUserInput && authUserInput.focus(), 0);
  }
}

function closeAuthModal() {
  if (!authBackdrop) return;
  authBackdrop.classList.remove('open');
  authBackdrop.setAttribute('aria-hidden', 'true');
  setAuthNote('');
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return `${value.toFixed(0)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size.toFixed(2)} ${units[i]}`;
}

function loadAppSettings() {
  appSettings = {
    inferenceProvider: 'local',
    huggingFaceToken: '',
    huggingFaceModel: 'Qwen/Qwen2.5-Coder-32B-Instruct:fastest',
    customOpenAiApiKey: '',
    customOpenAiModel: 'google/gemma-4-E2B-it',
    customOpenAiEndpoint: '',
    openAiApiKey: '',
    openAiModel: 'gpt-5.4',
    anthropicApiKey: '',
    anthropicModel: 'claude-opus-4-1-20250805',
    geminiApiKey: '',
    geminiModel: 'gemini-2.5-pro',
    deepseekApiKey: '',
    deepseekModel: 'deepseek-chat',
    veniceApiKey: '',
    veniceModel: 'venice-uncensored-1-2',
    workMode: 'coding',
    modelUrl: '',
    keepModelOnUpdate: true,
    debugTraceEnabled: false,
  };
  try {
    const raw = localStorage.getItem(settingsStorageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    if (typeof parsed.inferenceProvider === 'string') {
      const provider = parsed.inferenceProvider.trim().toLowerCase();
      appSettings.inferenceProvider = Object.prototype.hasOwnProperty.call(inferenceProviderDefs, provider)
        ? provider
        : 'local';
    }
    if (typeof parsed.workMode === 'string') {
      const workMode = parsed.workMode.trim().toLowerCase();
      appSettings.workMode = workMode === 'everyday' ? 'everyday' : 'coding';
    }
    if (typeof parsed.huggingFaceToken === 'string') appSettings.huggingFaceToken = parsed.huggingFaceToken.trim();
    if (typeof parsed.huggingFaceModel === 'string' && parsed.huggingFaceModel.trim()) {
      appSettings.huggingFaceModel = parsed.huggingFaceModel.trim();
    }
    if (typeof parsed.customOpenAiApiKey === 'string') appSettings.customOpenAiApiKey = parsed.customOpenAiApiKey.trim();
    if (typeof parsed.customOpenAiModel === 'string' && parsed.customOpenAiModel.trim()) {
      appSettings.customOpenAiModel = parsed.customOpenAiModel.trim();
    }
    if (typeof parsed.customOpenAiEndpoint === 'string') appSettings.customOpenAiEndpoint = parsed.customOpenAiEndpoint.trim();
    if (typeof parsed.openAiApiKey === 'string') appSettings.openAiApiKey = parsed.openAiApiKey.trim();
    if (typeof parsed.openAiModel === 'string' && parsed.openAiModel.trim()) {
      appSettings.openAiModel = parsed.openAiModel.trim();
    }
    if (typeof parsed.anthropicApiKey === 'string') appSettings.anthropicApiKey = parsed.anthropicApiKey.trim();
    if (typeof parsed.anthropicModel === 'string' && parsed.anthropicModel.trim()) {
      appSettings.anthropicModel = parsed.anthropicModel.trim();
    }
    if (typeof parsed.geminiApiKey === 'string') appSettings.geminiApiKey = parsed.geminiApiKey.trim();
    if (typeof parsed.geminiModel === 'string' && parsed.geminiModel.trim()) {
      appSettings.geminiModel = parsed.geminiModel.trim();
    }
    if (typeof parsed.deepseekApiKey === 'string') appSettings.deepseekApiKey = parsed.deepseekApiKey.trim();
    if (typeof parsed.deepseekModel === 'string' && parsed.deepseekModel.trim()) {
      appSettings.deepseekModel = parsed.deepseekModel.trim();
    }
    if (typeof parsed.veniceApiKey === 'string') appSettings.veniceApiKey = parsed.veniceApiKey.trim();
    if (typeof parsed.veniceModel === 'string' && parsed.veniceModel.trim()) {
      appSettings.veniceModel = parsed.veniceModel.trim();
    }
    if (typeof parsed.modelUrl === 'string') appSettings.modelUrl = parsed.modelUrl.trim();
    if (typeof parsed.keepModelOnUpdate === 'boolean') appSettings.keepModelOnUpdate = parsed.keepModelOnUpdate;
    if (typeof parsed.debugTraceEnabled === 'boolean') appSettings.debugTraceEnabled = parsed.debugTraceEnabled;
  } catch (_) { }
}

function saveAppSettings() {
  try {
    localStorage.setItem(settingsStorageKey, JSON.stringify(appSettings));
  } catch (_) { }
  if (typeof updateTokenRing === 'function') updateTokenRing();
}

function getSelectedInferenceProvider() {
  const raw = String(appSettings && appSettings.inferenceProvider ? appSettings.inferenceProvider : 'local').trim().toLowerCase();
  if (!remoteProvidersEnabled && raw !== 'local') return 'local';
  return Object.prototype.hasOwnProperty.call(inferenceProviderDefs, raw) ? raw : 'local';
}

// Model-aware output budget for one file-generation call. Local: reserve room for
// the prompt within the local context window. Remote: use the provider's large
// ceiling instead of the legacy flat 5000. Continuation stitches any overflow.
function getAgentFileOutputBudget() {
  const provider = getSelectedInferenceProvider();
  if (provider === 'local') {
    return Math.max(1024, Math.min(agentFileContentMaxTokens, Math.floor(agentLocalContextTokens * 0.5)));
  }
  return agentFileOutputCeilings[provider] || agentFileContentMaxTokens;
}

// Window-driven for every provider. Local gets a lower cap for prefill speed;
// unknown models (e.g. custom HF) default conservatively since the window is unconfirmed.
function getAgentExpandedReadChars() {
  const provider = getSelectedInferenceProvider();
  const ctx = getModelContextWindow();
  if (provider === 'local') {
    const localCtx = ctx > 0 ? ctx : 32768;
    return Math.max(agentMaxToolOutputChars, Math.min(24000, Math.floor(localCtx * 0.75)));
  }
  if (ctx <= 0) return Math.max(agentMaxToolOutputChars, 16000);
  return Math.max(agentMaxToolOutputChars, Math.min(60000, Math.floor(ctx * 1.4)));
}

// History/context char budget for assembling a chat prompt. The local GGUF runs at
// ~8192 tokens and token-dense content (JSON/code ≈ 2–2.5 chars/token) can overflow
// even a generous char budget — so keep the local prompt well under the window to
// leave room for the response. Remote providers have large windows; keep the default.
function getChatPromptContextBudgetChars() {
  // Local runs at a 32K-token window (see --ctx-size). Use a generous char budget so
  // chats remember a lot, while still leaving headroom so dense content can't exceed
  // the window — older turns are trimmed automatically rather than overflowing.
  return getSelectedInferenceProvider() === 'local' ? 40000 : 24576;
}

function isRemoteInferenceProviderEnabled() {
  return remoteProvidersEnabled && getSelectedInferenceProvider() !== 'local';
}

const workerCapabilityLabels = {
  'chat.reply': 'Chat',
  'agent.plan': 'Plan',
  'agent.writeFile': 'Write',
  'agent.editFile': 'Edit',
  'agent.complete': 'Complete',
};

const coreInferenceCapabilities = ['chat.reply', 'agent.plan', 'agent.writeFile', 'agent.editFile', 'agent.complete'];

function getWorkerCapabilityLabel(capability) {
  const key = String(capability || '').trim();
  return workerCapabilityLabels[key] || key;
}

function getConfiguredInferenceWorkers() {
  const selectedProvider = getSelectedInferenceProvider();
  const workers = [{
    id: 'local-runtime',
    type: 'local-inference',
    provider: 'local',
    label: 'Local Runtime',
    detail: nativeBridge.available() ? 'Native local model runtime' : 'Native bridge unavailable',
    capabilities: coreInferenceCapabilities.slice(),
    enabled: nativeBridge.available(),
    health: nativeBridge.available() ? 'ready' : 'offline',
    priority: selectedProvider === 'local' ? 100 : 40,
    costClass: 'local',
    latencyClass: 'device',
  }];

  if (!remoteProvidersEnabled) return workers;

  Object.keys(inferenceProviderDefs).forEach((provider) => {
    if (provider === 'local') return;
    const def = getInferenceProviderDef(provider);
    const apiKey = getProviderApiKey(provider);
    const model = getProviderModel(provider);
    const endpoint = getProviderEndpoint(provider);
    const hasConfig = Boolean(apiKey && model && (def.protocol === 'anthropic' || endpoint));
    workers.push({
      id: `provider-${provider}`,
      type: 'hosted-provider',
      provider,
      label: def.label || provider,
      detail: hasConfig ? model : 'Missing API key, model, or endpoint',
      capabilities: coreInferenceCapabilities.slice(),
      enabled: hasConfig,
      health: hasConfig ? 'ready' : 'needs setup',
      priority: selectedProvider === provider ? 100 : 55,
      costClass: 'provider',
      latencyClass: 'network',
    });
  });

  return workers;
}

function selectWorkerForJob(capability, options = {}) {
  const key = String(capability || '').trim();
  const selectedProvider = getSelectedInferenceProvider();
  const allowLocal = options.allowLocal !== false;
  const allowRemote = options.allowRemote !== false;
  const workers = getConfiguredInferenceWorkers()
    .filter((worker) => worker && worker.enabled)
    .filter((worker) => Array.isArray(worker.capabilities) && worker.capabilities.includes(key))
    .filter((worker) => (worker.provider === 'local' ? allowLocal : allowRemote));
  if (workers.length === 0) return null;
  workers.sort((a, b) => {
    const aSelected = a.provider === selectedProvider ? 1 : 0;
    const bSelected = b.provider === selectedProvider ? 1 : 0;
    if (aSelected !== bSelected) return bSelected - aSelected;
    return (Number(b.priority) || 0) - (Number(a.priority) || 0);
  });
  return workers[0];
}

function renderSettingsWorkerList() {
  if (!settingsWorkerList) return;
  const workers = getConfiguredInferenceWorkers();
  if (workers.length === 0) {
    settingsWorkerList.innerHTML = '<div class="settings-note-block">No workers are configured.</div>';
    return;
  }
  settingsWorkerList.innerHTML = '';
  workers.forEach((worker) => {
    const card = document.createElement('div');
    card.className = 'settings-worker-card';
    card.classList.toggle('disabled', !worker.enabled);
    const statusClass = worker.enabled ? 'ready' : 'offline';
    const caps = Array.isArray(worker.capabilities)
      ? worker.capabilities.map((item) => `<span>${escapeHtml(getWorkerCapabilityLabel(item))}</span>`).join('')
      : '';
    card.innerHTML = [
      '<div class="settings-worker-main">',
      `<div class="settings-worker-title">${escapeHtml(worker.label || worker.id)}</div>`,
      `<div class="settings-worker-detail">${escapeHtml(worker.detail || '')}</div>`,
      `<div class="settings-worker-caps">${caps}</div>`,
      '</div>',
      `<div class="settings-worker-status ${statusClass}">${escapeHtml(worker.health || '')}</div>`,
    ].join('');
    settingsWorkerList.appendChild(card);
  });
}

function getDebugMessageHistoryTotal(chatId) {
  const chat = findChatById(chatId);
  if (!chat || !Array.isArray(chat.messages)) return 0;
  return chat.messages.filter((msg) => msg && (msg.role === 'user' || msg.role === 'ai')).length;
}

function getInferenceProviderDef(provider) {
  const key = String(provider || '').trim().toLowerCase();
  return inferenceProviderDefs[key] || inferenceProviderDefs.local;
}

function getProviderApiKey(provider) {
  const def = getInferenceProviderDef(provider);
  if (!def || !def.keyField) return '';
  return String(appSettings && appSettings[def.keyField] ? appSettings[def.keyField] : '').trim();
}

function getProviderModel(provider) {
  const def = getInferenceProviderDef(provider);
  if (!def || !def.modelField) return '';
  const value = String(appSettings && appSettings[def.modelField] ? appSettings[def.modelField] : '').trim();
  return value || String(def.defaultModel || '').trim();
}

function getProviderEndpoint(provider) {
  const def = getInferenceProviderDef(provider);
  if (!def) return '';
  if (def.endpointField) {
    const value = String(appSettings && appSettings[def.endpointField] ? appSettings[def.endpointField] : '').trim();
    const endpoint = value || String(def.defaultEndpoint || def.endpointUrl || '').trim();
    return normalizeOpenAiCompatibleEndpoint(endpoint);
  }
  return normalizeOpenAiCompatibleEndpoint(String(def.endpointUrl || '').trim());
}

function normalizeOpenAiCompatibleEndpoint(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return '';
  if (/\/chat\/completions\/?$/i.test(input)) {
    return input.replace(/\/+$/, '');
  }
  if (/\/v1\/?$/i.test(input) || /\/sync\/v1\/?$/i.test(input)) {
    return `${input.replace(/\/+$/, '')}/chat/completions`;
  }
  return input.replace(/\/+$/, '');
}

function getOpenAiCompatibleAuthHeader(provider, apiKey, endpointUrl = '') {
  const def = getInferenceProviderDef(provider);
  const token = String(apiKey || '').trim();
  if (!token) return '';
  const normalizedEndpoint = String(endpointUrl || '').trim().toLowerCase();
  if (String(def && def.authScheme || '').toLowerCase() === 'api-key'
    || /(^https?:\/\/)?([a-z0-9-]+\.)*baseten\.co(\/|$)/i.test(normalizedEndpoint)) {
    return `Api-Key ${token}`;
  }
  return `Bearer ${token}`;
}

// Map raw provider HTTP errors to plain-language messages; raw detail stays in
// the debug trace via the generic branch only.
// On a 429, the provider tells us when it's safe to retry. Prefer that over a
// blind guess. Best-effort: a cross-origin fetch can only read these headers if
// the provider sends Access-Control-Expose-Headers, so callers must fall back.
// Returns a wait in ms (capped), or 0 when no usable hint is present.
function parseRateLimitRetryMs(response) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return 0;
  const cap = 60000;
  try {
    const ra = response.headers.get('retry-after');
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs)) return Math.max(0, Math.min(secs * 1000, cap));
      const when = Date.parse(ra);
      if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), cap));
    }
    const reset = response.headers.get('x-ratelimit-reset-requests')
      || response.headers.get('x-ratelimit-reset-tokens');
    if (reset) {
      const n = Number(reset);
      if (Number.isFinite(n)) {
        // Either a duration in seconds or an absolute unix-seconds timestamp.
        const ms = n > 1e6 ? (n * 1000 - Date.now()) : n * 1000;
        if (ms > 0) return Math.min(ms, cap);
      }
    }
  } catch (_) { }
  return 0;
}

function humanizeProviderErrorMessage(label, status, rawBody = '') {
  const name = String(label || 'The AI provider').replace(/\s*Test$/i, '').trim() || 'The AI provider';
  let detail = String(rawBody || '').trim();
  try {
    const parsed = JSON.parse(detail);
    const inner = parsed && (parsed.error || parsed.message);
    detail = String((inner && (inner.message || inner)) || detail);
  } catch (_) { }
  detail = detail.replace(/\s+/g, ' ').slice(0, 220);
  const code = Number(status) || 0;
  const lower = detail.toLowerCase();
  if (code === 402 || /credit|quota exceeded|billing|payment required|subscribe to pro/.test(lower)) {
    return `${name} says this account is out of credits. Top up the account (or switch the provider/model in Settings), then try again.`;
  }
  if (code === 401 || code === 403) {
    return `${name} rejected the API key. Open Settings and check the ${name} key.`;
  }
  if (code === 404 || /model.{0,20}(not found|does not exist|not supported)/.test(lower)) {
    return `${name} doesn't recognize the selected model. Pick a different model in Settings.`;
  }
  if (code === 429) {
    return `${name} is rate-limiting requests (you've hit your plan's per-minute cap — large models like the 480B coder allow ~20/min). Wait a minute, or switch to a lighter/faster model, then try again.`;
  }
  if (code >= 500) {
    return `${name} is having a temporary problem on its side (${code}). Try again in a bit.`;
  }
  return `${name} couldn't complete the request${code ? ` (${code})` : ''}${detail ? ` — ${detail}` : ''}. Try again, or switch the provider/model in Settings.`;
}

function humanizeAssistantErrorText(text) {
  const value = String(text || '');
  const match = value.match(/^(.+?) request failed \((\d{3})\):\s*([\s\S]*)$/);
  if (match) return humanizeProviderErrorMessage(match[1], Number(match[2]), match[3]);
  return value;
}

// Control the model's native reasoning by the UI "Think" toggle, per provider.
// thinkActive=true  -> leave reasoning on (it streams into the Thoughts UI).
// thinkActive=false -> turn it OFF at the API level (no wasted tokens, no leaked
//   <thinking>, no empty-output when a model puts its whole reply in think tags).
// Each provider exposes a different switch; unknown providers are left as-is.
function applyThinkingMode(provider, req, thinkActive) {
  if (!req || typeof req !== 'object' || thinkActive) return req;
  const p = String(provider || '').toLowerCase();
  if (p === 'deepseek') {
    // api-docs.deepseek.com/guides/thinking_mode
    req.thinking = { type: 'disabled' };
  } else if (p === 'venice') {
    // docs.venice.ai — disable_thinking turns reasoning off on supported models AND
    // strips <think> blocks; strip_thinking_response covers legacy <think> output.
    req.venice_parameters = Object.assign({}, req.venice_parameters, {
      disable_thinking: true,
      strip_thinking_response: true,
    });
  }
  return req;
}

function shouldUseNativeCustomOpenAiRelay(provider) {
  if (!remoteProvidersEnabled) return false;
  return String(provider || '').trim().toLowerCase() === 'customopenai'
    && nativeBridge.available()
    && document.documentElement.classList.contains('platform-mac');
}

// Provider picker is trimmed to Local + DeepSeek + Venice (Venice proxies the
// other companies' models anyway). The other provider defs/code are kept, just
// hidden — flip a name out of this set to re-enable it.
const HIDDEN_INFERENCE_PROVIDERS = new Set(['huggingface', 'customopenai', 'openai', 'anthropic', 'gemini']);
function syncInferenceProviderOptions() {
  if (!settingsProviderSelect) return;
  // Remove hidden providers outright. A native macOS <select> ignores option.hidden
  // and just renders hidden/disabled options greyed-out, so they must leave the DOM.
  Array.from(settingsProviderSelect.options || []).forEach((option) => {
    const value = String(option && option.value ? option.value : '').trim().toLowerCase();
    if (!value || value === 'local') return;
    if (HIDDEN_INFERENCE_PROVIDERS.has(value) || !remoteProvidersEnabled) {
      option.remove();
    }
  });
  const current = String(appSettings.inferenceProvider || '').trim().toLowerCase();
  if (!remoteProvidersEnabled) {
    settingsProviderSelect.value = 'local';
    appSettings.inferenceProvider = 'local';
  } else if (HIDDEN_INFERENCE_PROVIDERS.has(current)) {
    // A previously-selected, now-hidden provider falls back to Venice.
    appSettings.inferenceProvider = 'venice';
    settingsProviderSelect.value = 'venice';
  }
}

function getProviderPresetValue(provider, modelId) {
  const cleanModel = String(modelId || '').trim();
  const presets = Array.isArray(inferenceProviderModelPresets[provider]) ? inferenceProviderModelPresets[provider] : [];
  return presets.includes(cleanModel) ? cleanModel : '__custom__';
}

function getSettingsSectionMeta(section) {
  const key = String(section || '').trim().toLowerCase();
  if (key === 'models') {
    return {
      title: 'Models & Inference',
      subtitle: 'Choose where inference runs and tune provider-specific settings.',
    };
  }
  if (key === 'workers') {
    return {
      title: 'Workers',
      subtitle: 'Route AI.EXE jobs through local and provider workers with visible capabilities and health.',
    };
  }
  if (key === 'personalization') {
    return {
      title: 'Personalization',
      subtitle: 'Reserved for reply style, themes, layout density, and UI preferences.',
    };
  }
  if (key === 'advanced') {
    return {
      title: 'Advanced',
      subtitle: 'Verification, maintenance, and diagnostics for the local runtime.',
    };
  }
  return {
    title: 'General',
    subtitle: 'Core runtime behavior and day-to-day defaults.',
  };
}

function syncSettingsWorkModeUi() {
  const workMode = String(appSettings && appSettings.workMode ? appSettings.workMode : 'coding').trim().toLowerCase() === 'everyday'
    ? 'everyday'
    : 'coding';
  if (settingsWorkModeCoding) settingsWorkModeCoding.checked = workMode === 'coding';
  if (settingsWorkModeEveryday) settingsWorkModeEveryday.checked = workMode === 'everyday';
  if (settingsWorkModeCodingCard) settingsWorkModeCodingCard.classList.toggle('active', workMode === 'coding');
  if (settingsWorkModeEverydayCard) settingsWorkModeEverydayCard.classList.toggle('active', workMode === 'everyday');
}

function openSettingsSection(section) {
  const key = String(section || 'general').trim().toLowerCase();
  settingsNavButtons.forEach((btn) => {
    btn.classList.toggle('active', String(btn.dataset.settingsSection || '').trim().toLowerCase() === key);
  });
  settingsPanes.forEach((pane) => {
    pane.classList.toggle('active', String(pane.dataset.settingsPane || '').trim().toLowerCase() === key);
  });
  const meta = getSettingsSectionMeta(key);
  if (settingsViewTitle) settingsViewTitle.textContent = meta.title;
  if (settingsViewSubtitle) settingsViewSubtitle.textContent = meta.subtitle;
}

// Model IDs differ per provider/account and go stale fast, so fetch the real list
// from the provider's /models endpoint with the user's key. The static presets are
// only a fallback. Works for OpenAI-compatible providers (chat/completions -> models).
const liveProviderModels = {};
// Per-provider uncensored fallback target, chosen from Venice's own trait metadata
// (model_spec.traits includes 'most_uncensored') — never by guessing the model name.
const liveProviderUncensored = {};
let lastPresetProvider = '';
async function refreshProviderModelList(provider) {
  const def = getInferenceProviderDef(provider);
  const key = getProviderApiKey(provider);
  if (!def || !key) return false;
  const chatUrl = getProviderEndpoint(provider) || String(def.endpointUrl || '');
  const modelsUrl = chatUrl.replace(/\/chat\/completions\/?(\?.*)?$/i, '/models');
  if (!modelsUrl || modelsUrl === chatUrl) return false; // non-OpenAI shape (e.g. anthropic /messages)
  try {
    const res = await fetch(modelsUrl, { headers: { Authorization: `Bearer ${key}` } });
    if (!res || !res.ok) return false;
    const data = await res.json();
    const list = Array.isArray(data && data.data) ? data.data : [];
    const ids = list
      .filter((m) => !m || m.type == null || String(m.type).toLowerCase() === 'text')
      .map((m) => String(m && m.id ? m.id : '').trim())
      .filter(Boolean)
      .sort();
    if (!ids.length) return false;
    liveProviderModels[provider] = ids;
    // Capture the provider-designated uncensored model for the refusal fallback.
    // Prefer the trait the provider itself assigns; refine by coding capability when
    // several carry it, so an agent/code refusal escalates to the most capable one.
    const traitOf = (m) => {
      const t = m && m.model_spec && m.model_spec.traits;
      if (Array.isArray(t)) return t.map((x) => String(x).toLowerCase());
      if (t && typeof t === 'object') return Object.keys(t).map((x) => String(x).toLowerCase());
      return [];
    };
    const uncensored = list.filter((m) => traitOf(m).includes('most_uncensored'));
    if (uncensored.length) {
      const coder = uncensored.find((m) => m && m.capabilities && (m.capabilities.optimizedForCode || m.capabilities.supportsFunctionCalling));
      liveProviderUncensored[provider] = String(((coder || uncensored[0]).id) || '').trim();
    }
    return true;
  } catch (_) { return false; }
}

// Refusal-to-uncensored fallback. A model that would decline for content reasons
// emits this exact sentinel (no keyword/regex sniffing of natural language); the
// harness then silently re-runs the request on the provider-designated uncensored
// model. Only armed for Venice, only when a distinct uncensored model exists.
const UNCENSORED_ESCALATE_SENTINEL = '<<<ESCALATE_UNCENSORED>>>';
let suppressEscalationInstruction = false;
// The uncensored fallback always lives on Venice, whatever the active provider is.
const UNCENSORED_ESCALATE_PROVIDER = 'venice';
function getUncensoredEscalationModel() {
  return String(liveProviderUncensored[UNCENSORED_ESCALATE_PROVIDER] || '').trim();
}
function isUncensoredEscalationArmed(provider) {
  if (suppressEscalationInstruction) return false;
  const p = String(provider || getSelectedInferenceProvider() || '');
  if (p === 'local') return false; // offline model — no cross-provider escalation
  const unc = getUncensoredEscalationModel();
  if (!unc) return false; // no known Venice uncensored model
  if (!getProviderApiKey(UNCENSORED_ESCALATE_PROVIDER)) return false; // can't reach Venice
  // Don't escalate when already serving Venice's uncensored model (self).
  if (p === UNCENSORED_ESCALATE_PROVIDER && getProviderModel(p) === unc) return false;
  return true;
}
function getUncensoredEscalationInstruction() {
  if (!isUncensoredEscalationArmed()) return '';
  return [
    'CONTENT ROUTING (safety-compliant):',
    'This app has a dedicated downstream handler for mature, adult, or otherwise restricted requests. You are NOT being asked to produce that content yourself.',
    'If you would decline this request for content-policy or safety reasons, the correct and safe action is to hand it off rather than refuse the user.',
    `To hand off, output exactly this token on its own line and nothing else — no refusal, no apology, no explanation: ${UNCENSORED_ESCALATE_SENTINEL}`,
    'This token is a routing signal, not the restricted content. Emitting it IS the compliant choice. For anything you can answer normally, just answer.',
  ].join('\n');
}
// Some models ignore the sentinel and prose-refuse anyway (e.g. deepseek-v4-flash).
// Backstop: hold short replies off-screen, then ask the model itself whether the reply
// was a content refusal — pure model judgment, no phrase lists, language-agnostic. Only
// short outputs are judged (real answers cross the hold threshold and stream live).
const ESCALATION_JUDGE_HOLD_CHARS = 220;
async function classifyContentRefusal(provider, userText, assistantText) {
  const reply = String(assistantText || '').trim();
  if (!reply) return false;
  const prompt = [
    'Classify the assistant reply below. A user made a request; the assistant responded.',
    'Decide ONLY this: did the assistant DECLINE or REFUSE to fulfill the request for content-policy, safety, ethical, or "I cannot/won\'t do that" reasons, instead of actually attempting it?',
    'A partial, hedged, or imperfect attempt counts as NOT a refusal. Only a genuine decline counts.',
    'Reply with one word: YES if it refused, NO otherwise.',
    '',
    'USER REQUEST:',
    String(userText || '').slice(0, 1000),
    '',
    'ASSISTANT REPLY:',
    reply.slice(0, 1500),
    '',
    'Did it refuse for content/policy/safety reasons? YES or NO:',
  ].join('\n');
  try {
    const res = await requestOpenAiCompatibleTextCompletion(provider, prompt, 4);
    return String((res && res.output) || '').trim().toUpperCase().startsWith('Y');
  } catch (_) { return false; }
}
function responseIsEscalationSentinel(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Exact-match the sentinel (optionally as the sole content), never a phrase guess.
  return t === UNCENSORED_ESCALATE_SENTINEL
    || t.replace(/[`*_>\s]+/g, '') === UNCENSORED_ESCALATE_SENTINEL.replace(/\s+/g, '');
}

function populateProviderPresetOptions(provider, modelId) {
  if (!settingsApiModelPreset) return;
  lastPresetProvider = provider;
  const live = Array.isArray(liveProviderModels[provider]) ? liveProviderModels[provider] : null;
  const presets = (live && live.length)
    ? live
    : (Array.isArray(inferenceProviderModelPresets[provider]) ? inferenceProviderModelPresets[provider] : []);
  settingsApiModelPreset.innerHTML = '';
  presets.forEach((preset) => {
    const opt = document.createElement('option');
    opt.value = preset;
    opt.textContent = preset;
    settingsApiModelPreset.appendChild(opt);
  });
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = 'Custom model ID';
  settingsApiModelPreset.appendChild(customOpt);
  settingsApiModelPreset.value = getProviderPresetValue(provider, modelId);
  // No live list yet but we have a key — fetch the real models and repopulate.
  if (!live && getProviderApiKey(provider)) {
    refreshProviderModelList(provider).then((ok) => {
      if (ok && lastPresetProvider === provider) populateProviderPresetOptions(provider, getProviderModel(provider));
    });
  }
}

function populateRemoteProviderFields(provider) {
  const def = getInferenceProviderDef(provider);
  const currentModel = getProviderModel(provider);
  const currentEndpoint = getProviderEndpoint(provider);
  if (settingsApiKeyLabel) settingsApiKeyLabel.textContent = def.keyLabel || 'API Key';
  if (settingsApiKeyInput) {
    settingsApiKeyInput.placeholder = def.keyPlaceholder || 'sk-...';
    settingsApiKeyInput.value = getProviderApiKey(provider);
    // Re-mask when the field is repopulated so a revealed key never lingers.
    settingsApiKeyInput.type = 'password';
    if (settingsApiKeyToggle) {
      settingsApiKeyToggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
      settingsApiKeyToggle.setAttribute('aria-pressed', 'false');
      settingsApiKeyToggle.setAttribute('aria-label', 'Show API key');
    }
  }
  if (settingsApiEndpointWrap) {
    settingsApiEndpointWrap.style.display = def.endpointField ? 'block' : 'none';
  }
  if (settingsApiEndpointLabel) {
    settingsApiEndpointLabel.textContent = def.endpointLabel || 'Endpoint URL';
  }
  if (settingsApiEndpointInput) {
    settingsApiEndpointInput.placeholder = def.endpointPlaceholder || 'https://example.com/v1/chat/completions';
    settingsApiEndpointInput.value = def.endpointField ? currentEndpoint : '';
  }
  if (settingsApiModelInput) {
    settingsApiModelInput.placeholder = def.modelPlaceholder || 'model-id';
    settingsApiModelInput.value = currentModel;
  }
  populateProviderPresetOptions(provider, currentModel);
  if (settingsProviderHelp) {
    settingsProviderHelp.textContent = def.helpText || '';
  }
}

function syncSettingsProviderUi() {
  syncInferenceProviderOptions();
  const provider = settingsProviderSelect ? String(settingsProviderSelect.value || 'local').trim().toLowerCase() : 'local';
  const isRemote = remoteProvidersEnabled && provider !== 'local';
  if (settingsRemoteFieldsWrap) {
    settingsRemoteFieldsWrap.style.display = isRemote ? 'grid' : 'none';
  }
  if (settingsModelUrlInput) {
    settingsModelUrlInput.disabled = Boolean(isRemote);
  }
  if (settingsModelUrlWrap) {
    settingsModelUrlWrap.style.opacity = isRemote ? '0.55' : '1';
  }
  if (isRemote) {
    populateRemoteProviderFields(provider);
  } else if (settingsProviderHelp) {
    settingsProviderHelp.textContent = remoteProvidersEnabled ? '' : 'This release is offline-only. Hosted API providers are disabled.';
  }
  renderSettingsWorkerList();
}

function debugPreview(value, maxLen = 99999) {
  if (value === null || typeof value === 'undefined') return '';
  const text = String(value).replace(/\r/g, '');
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)} ...[+${text.length - maxLen} chars]`;
}

function pushDebugTrace(kind, payload = {}) {
  const entry = {
    ts: new Date().toISOString(),
    kind: String(kind || 'trace'),
    ...payload,
  };
  debugTraceEntries.push(entry);
  if (debugTraceEntries.length > debugTraceMaxEntries) {
    debugTraceEntries = debugTraceEntries.slice(debugTraceEntries.length - debugTraceMaxEntries);
  }
  return entry;
}

function clearDebugTraceEntries() {
  debugTraceEntries = [];
}

let persistedDebugLogQueue = Promise.resolve();

function clipDebugText(value, maxLen = 24000) {
  const text = String(value || '').replace(/\r/g, '');
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n...[truncated ${text.length - maxLen} chars]`;
}

function sanitizeDebugValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return clipDebugText(value, 24000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[depth-limited]';
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizeDebugValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).slice(0, 80).forEach((key) => {
      out[key] = sanitizeDebugValue(value[key], depth + 1);
    });
    return out;
  }
  return String(value);
}

function shouldPersistDebugEntry(kind) {
  const key = String(kind || '').toLowerCase();
  return Boolean(appSettings.debugTraceEnabled)
    || key.startsWith('request_')
    || key.startsWith('agent_')
    || key.startsWith('workspace_')
    || key.startsWith('preflight_')
    || key.endsWith('_error');
}

function getCurrentDebugModelInfo() {
  const provider = getSelectedInferenceProvider();
  if (provider && provider !== 'local') {
    return {
      provider,
      model: String(getProviderModel(provider) || ''),
    };
  }
  return {
    provider: 'local',
    model: String(appSettings.modelUrl || ''),
  };
}

function getWorkspaceDebugSnapshot() {
  const rootNode = workspaceTreeState.get('/') || null;
  const rootEntries = rootNode && Array.isArray(rootNode.children)
    ? rootNode.children.slice(0, 60).map((entry) => ({
      kind: String(entry && entry.kind ? entry.kind : ''),
      path: normalizeWorkspacePath(entry && entry.path ? entry.path : ''),
      name: String(entry && entry.name ? entry.name : ''),
      childCount: Number(entry && entry.childCount) || 0,
      sizeBytes: Number(entry && entry.sizeBytes) || 0,
    }))
    : [];
  return {
    workspaceRootName: String(workspaceRootName || ''),
    currentPath: normalizeWorkspacePath(workspaceCurrentPath || '/'),
    currentKind: workspaceCurrentKind === 'file' ? 'file' : 'folder',
    selectedPaths: Array.from(workspaceSelectedPaths || []).map((item) => normalizeWorkspacePath(item)),
    rootLoaded: Boolean(rootNode && rootNode.loaded),
    rootEntryCount: rootEntries.length,
    rootEntries,
  };
}

function getChatDebugSnapshot(chatId, maxMessages = 18) {
  const chat = findChatById(chatId);
  if (!chat || !Array.isArray(chat.messages)) return [];
  return chat.messages
    .slice(-Math.max(1, Number(maxMessages) || 18))
    .map((msg) => ({
      role: String(msg && msg.role ? msg.role : ''),
      ts: Number(msg && msg.ts) || 0,
      text: clipDebugText(msg && msg.text ? msg.text : '', 12000),
    }));
}

function chatHasPriorAgentWorkspaceWork(chatId) {
  const chat = findChatById(chatId);
  if (!chat || !Array.isArray(chat.messages)) return false;
  return chat.messages.some((message) => (
    message
    && message.role === 'ai'
    && (
      message.agentMeta
      || (Array.isArray(message.agentActivities) && message.agentActivities.length > 0)
    )
  ));
}

function persistDebugEntry(channel, entry) {
  if (!nativeBridge.available() || !shouldPersistDebugEntry(entry && entry.kind)) {
    return;
  }
  const payload = sanitizeDebugValue(entry);
  persistedDebugLogQueue = persistedDebugLogQueue
    .catch(() => undefined)
    .then(() => nativeBridge.invoke('appendDebugLog', {
      channel: String(channel || 'debug_trace'),
      entry: JSON.stringify(payload),
    }))
    .catch(() => undefined);
}

function recordDebugTrace(kind, previewPayload = {}, fullPayload = null) {
  const previewEntry = pushDebugTrace(kind, previewPayload);
  const entry = {
    ts: previewEntry.ts,
    kind: previewEntry.kind,
    ...((fullPayload && typeof fullPayload === 'object') ? fullPayload : previewPayload),
  };
  persistDebugEntry('debug_trace', entry);
  return previewEntry;
}

function pushDictationTrace(kind, payload = {}) {
  pushDebugTrace(`dictation_${String(kind || 'trace')}`, {
    chatId: String(activeChatId || ''),
    speechActive: Boolean(speechRecognitionActive),
    transcriptPending: Boolean(String(pendingDictationTranscript || '').trim()),
    applyPending: Boolean(dictationApplyPending),
    inFlight: Boolean(dictationTranscriptInFlight),
    ...payload,
  });
}

function dumpDebugTrace(limit = 12, chatId = '') {
  const take = Math.max(1, Math.min(80, Number(limit) || 12));
  const scopedId = String(chatId || '').trim();
  const rows = (scopedId
    ? debugTraceEntries.filter((entry) => String(entry && entry.chatId ? entry.chatId : '') === scopedId)
    : debugTraceEntries
  ).slice(-take);
  if (rows.length === 0) {
    return scopedId
      ? `Debug trace is empty for chat ${scopedId}.`
      : 'Debug trace is empty.';
  }
  const blocks = rows.map((entry, idx) => {
    const parts = [
      `#${idx + 1} ${entry.ts} [${entry.kind}]`,
    ];
    Object.keys(entry).forEach((k) => {
      if (k === 'ts' || k === 'kind') return;
      parts.push(`${k}: ${debugPreview(entry[k], 1200)}`);
    });
    return parts.join('\n');
  });
  return blocks.join('\n\n');
}

function setSettingsNote(text, kind = 'error') {
  const clean = String(text || '').trim();
  if (settingsNote) {
    settingsNote.textContent = '';
    settingsNote.classList.remove('visible', 'auth-info');
  }
  if (!clean) return;
  showAppNotification({
    title: kind === 'info'
      ? (/^settings saved\b/i.test(clean) ? 'Settings saved' : 'Update complete')
      : 'Action needed',
    message: clean,
    kind: kind === 'info' ? 'success' : 'error',
  });
}

function saveSettingsFromUi(options = {}) {
  const provider = settingsProviderSelect
    ? String(settingsProviderSelect.value || 'local').trim().toLowerCase()
    : 'local';
  appSettings.inferenceProvider = remoteProvidersEnabled && Object.prototype.hasOwnProperty.call(inferenceProviderDefs, provider)
    ? provider
    : 'local';
  appSettings.workMode = settingsWorkModeEveryday && settingsWorkModeEveryday.checked ? 'everyday' : 'coding';
  const providerDef = getInferenceProviderDef(appSettings.inferenceProvider);
  if (appSettings.inferenceProvider !== 'local' && providerDef.keyField && providerDef.modelField) {
    appSettings[providerDef.keyField] = settingsApiKeyInput ? settingsApiKeyInput.value.trim() : '';
    appSettings[providerDef.modelField] = settingsApiModelInput && settingsApiModelInput.value.trim()
      ? settingsApiModelInput.value.trim()
      : String(providerDef.defaultModel || '');
    if (providerDef.endpointField) {
      appSettings[providerDef.endpointField] = settingsApiEndpointInput && settingsApiEndpointInput.value.trim()
        ? settingsApiEndpointInput.value.trim()
        : String(providerDef.defaultEndpoint || '');
    }
  }
  appSettings.modelUrl = settingsModelUrlInput ? settingsModelUrlInput.value.trim() : '';
  appSettings.keepModelOnUpdate = Boolean(settingsKeepModelChk && settingsKeepModelChk.checked);
  appSettings.debugTraceEnabled = Boolean(settingsDebugTraceChk && settingsDebugTraceChk.checked);
  saveAppSettings();
  updateModelSetupBanner(); // a freshly-added API key should hide the setup banner
  if (options.toast) {
    setSettingsNote(
      appSettings.inferenceProvider === 'local'
        ? 'Settings saved locally.'
        : `Settings saved locally. ${providerDef.label} is active.`,
      'info'
    );
  }
}

function scheduleSettingsAutosave(delay = 420) {
  if (settingsAutosaveTimer) clearTimeout(settingsAutosaveTimer);
  settingsAutosaveTimer = setTimeout(() => {
    settingsAutosaveTimer = 0;
    saveSettingsFromUi({ toast: false });
  }, delay);
}

function setButtonLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.prevDisabled) {
      btn.dataset.prevDisabled = btn.disabled ? '1' : '0';
    }
    btn.classList.add('loading');
    btn.disabled = true;
    return;
  }
  btn.classList.remove('loading');
  const prev = btn.dataset.prevDisabled === '1';
  btn.disabled = prev;
  delete btn.dataset.prevDisabled;
}

// Cancel-mode and composer lockout apply only in the chat that owns the run
// (loadingHere); Continue stays globally gated.
function setSendLoading(loading, loadingHere = loading) {
  if (!sendBtn) return;
  sendBtn.classList.toggle('loading', loadingHere);
  sendBtn.classList.toggle('cancel-mode', loadingHere);
  sendBtn.title = loadingHere ? 'Stop generation' : (loading ? 'Another chat is still responding' : 'Send');
  sendBtn.setAttribute('aria-label', loadingHere ? 'Stop generation' : 'Send message');
  sendBtn.disabled = false;
  if (continueBtn) {
    continueBtn.disabled = loading;
  }
  if (canvasBtn) {
    canvasBtn.disabled = loadingHere;
  }
  if (attachBtn) {
    attachBtn.disabled = loadingHere;
  }
  if (agentBtn) {
    agentBtn.disabled = loadingHere;
  }
  if (thinkBtn) {
    thinkBtn.disabled = loadingHere;
  }
  if (contextBtn) {
    contextBtn.disabled = loadingHere;
  }
  if (composerPlusBtn) {
    composerPlusBtn.disabled = loadingHere;
  }
  if (menuCanvasBtn) {
    menuCanvasBtn.disabled = loadingHere;
  }
  if (menuAttachBtn) {
    menuAttachBtn.disabled = loadingHere;
  }
  if (menuAgentBtn) {
    menuAgentBtn.disabled = loadingHere;
  }
  if (menuThinkBtn) {
    menuThinkBtn.disabled = loadingHere;
  }
  if (menuContextBtn) {
    menuContextBtn.disabled = loadingHere;
  }
  if (micBtn) {
    micBtn.disabled = loadingHere;
  }
  if (dictationCancelBtn) {
    dictationCancelBtn.disabled = loadingHere;
  }
  if (dictationApplyBtn) {
    dictationApplyBtn.disabled = loadingHere;
  }
  if (loadingHere && composerMenuOpen) {
    setComposerMenuOpen(false);
  }
  updateContinueButtonVisibility();
}

function isCurrentViewInferenceChat() {
  const token = activeInferenceRequest;
  if (token && !token.cancelled && !token.done && !token.finalizing) {
    const requestChatId = String(token.chatId || '');
    if (!requestChatId) return false;
    return Boolean(!inNewChatMode && middleViewMode === 'chat' && activeChatId === requestChatId);
  }
  // Between agent inference calls there is no live token — use the run owner so
  // a different chat being viewed is not mistaken for the running one.
  if (pendingInferenceCount > 0 && isAgentElapsedTimerActive() && agentRunChatId) {
    return Boolean(!inNewChatMode && middleViewMode === 'chat' && String(activeChatId || '') === agentRunChatId);
  }
  // Pre-stream window: request is counted, token may not be attached yet.
  return Boolean(pendingInferenceCount > 0 && !inNewChatMode && middleViewMode === 'chat' && activeChatId);
}

function syncLiveInferenceUiState() {
  if (activeStreamRow && !activeStreamRow.isConnected) {
    activeStreamRow = null;
  }

  const operationRunning = Boolean(pendingInferenceCount > 0);
  const loadingHere = Boolean(operationRunning && isCurrentViewInferenceChat());
  setSendLoading(operationRunning, loadingHere);
  renderHistory();

  const hasTyping = Boolean(document.getElementById('typingIndicator'));
  if (loadingHere && !activeStreamRow) {
    const token = getRunningChatOperationToken();
    const activeChatKey = String(activeChatId || '');
    const hasBufferedLiveOutput = Boolean(
      token
      && String(token.chatId || '') === activeChatKey
      && (
        String(activeStreamRawText || '').trim()
        || (activeAgentStreamState && String(activeAgentStreamState.chatId || '') === activeChatKey)
      )
    );
    if (hasBufferedLiveOutput) {
      createLiveAssistantRow(activeChatKey);
      renderLiveStreamNow();
      return;
    }
    if (!hasTyping) {
      const startedAt = Number(
        thinkingStartedByChatId.get(String(activeChatId || ''))
        || (activeInferenceRequest ? Number(activeInferenceRequest.startedAt || 0) : 0)
        || 0
      );
      showTypingIndicator(activeChatId || '', startedAt);
    }
    return;
  }
  if (hasTyping) {
    clearTypingIndicator();
  }
}

function beginInferenceRequest() {
  pendingInferenceCount += 1;
  syncLiveInferenceUiState();
}

function endInferenceRequest() {
  pendingInferenceCount = Math.max(0, pendingInferenceCount - 1);
  syncLiveInferenceUiState();
  if (pendingInferenceCount === 0) {
    notifyInferenceIdle();
    if (queuedSends.length) window.setTimeout(dispatchNextQueuedSend, 50);
  }
  if (pendingInferenceCount === 0 && !activeStreamRow) {
    clearTypingIndicator();
  }
}

function notifyInferenceIdle() {
  if (pendingInferenceCount > 0 || inferenceIdleResolvers.length === 0) return;
  const waiting = inferenceIdleResolvers.splice(0);
  waiting.forEach((resolve) => {
    try { resolve(true); } catch (_) { }
  });
}

function isInferenceActive(token) {
  return Boolean(token && !token.cancelled && activeInferenceRequest === token);
}

function completeInferenceRequest(token) {
  if (!token || token.done) return;
  token.done = true;
  thinkingStartedByChatId.delete(String(token.chatId || ''));
  if (activeInferenceRequest === token) {
    activeInferenceRequest = null;
  }
  endInferenceRequest();
  renderHistory();
}

function commitInterruptedAgentRun(chatId, reason = 'Agent was interrupted before finishing.', snapshot = null) {
  // Use the passed snapshot when provided — the global activeAgentStreamState may
  // already be nulled (consumeLiveAssistantText resets it during cancel), which
  // used to make this bail and wipe the whole run from the chat.
  const state = snapshot || activeAgentStreamState;
  if (!state || String(state.chatId || '') !== String(chatId || '')) return false;
  const interruptedActivities = cloneAgentActivities(state.activities || []);
  if (!interruptedActivities.length) return false;
  mergeAgentActivityIntoList(interruptedActivities, {
    kind: 'error',
    title: 'Interrupted',
    detail: reason,
    status: 'error',
  });
  const startedAt = (state && state.startedAt) || Date.now();
  commitAssistantMessage(String(chatId || ''), reason, reason, {
    agentActivities: interruptedActivities,
    agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
    forceNeedsContinue: true,
  });
  pushDebugTrace('interrupted_agent_committed', {
    chatId: String(chatId || ''),
    activityCount: String(interruptedActivities.length),
  });
  return true;
}

// Stop the in-flight generation (stream + fetch) without the full cancel teardown —
// for when the loop abandons an await on timeout but the inference keeps running.
function abortInFlightInference(reason = 'abandoned') {
  const token = activeInferenceRequest;
  if (!token) return false;
  if (token.streamId) {
    try { nativeBridge.cancelStream(token.streamId); } catch (_) { }
  }
  if (token.abortController) {
    try { token.abortController.abort(); } catch (_) { }
  }
  abortAllInFlightInferenceControllers(reason);
  pushDebugTrace('inference_aborted', {
    chatId: String(token.chatId || ''),
    streamId: String(token.streamId || ''),
    reason: String(reason || ''),
  });
  return true;
}

// Stall watchdog for chat/inspect streaming: if no delta for idleMs while pending,
// abort the dead stream and resolve { _stalled: true } so the caller retries/fails.
function awaitChatStreamWithStallGuard(streamPromise, requestToken, idleMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let lastCount = Number(requestToken && requestToken.deltaCount) || 0;
    let lastActivityAt = Date.now();
    const settle = (fn, val) => { if (done) return; done = true; clearInterval(iv); fn(val); };
    const iv = setInterval(() => {
      if (done) return;
      const c = Number(requestToken && requestToken.deltaCount) || 0;
      if (c > lastCount) { lastCount = c; lastActivityAt = Date.now(); }
      if (Date.now() - lastActivityAt >= idleMs) {
        try { if (requestToken && requestToken.streamId) nativeBridge.cancelStream(requestToken.streamId); } catch (_) { }
        try { if (requestToken && requestToken.abortController) requestToken.abortController.abort(); } catch (_) { }
        settle(resolve, { _stalled: true });
      }
    }, 3000);
    streamPromise.then((r) => settle(resolve, r), (e) => settle(reject, e));
  });
}

function cancelActiveInference() {
  const token = activeInferenceRequest;
  if (!token || token.cancelled) return;
  token.cancelled = true;
  setChatAutoContinuing(String(token.chatId || ''), false);
  pushDebugTrace('request_cancelled', {
    chatId: String(token.chatId || ''),
    streamId: String(token.streamId || ''),
    deltaCount: String(token.deltaCount || 0),
    rawStreamPreview: debugPreview(token.streamRaw || '', 1200),
  });
  if (token.streamId) {
    nativeBridge.cancelStream(token.streamId);
  }
  if (token.abortController) {
    try {
      token.abortController.abort();
    } catch (_) { }
  }
  abortAllInFlightInferenceControllers('user_cancelled');
  clearTypingIndicator();
  const activeAgentState = activeAgentStreamState && String(activeAgentStreamState.chatId || '') === String(token.chatId || '')
    ? {
      chatId: String(activeAgentStreamState.chatId || ''),
      statusText: String(activeAgentStreamState.statusText || ''),
      activities: cloneAgentActivities(activeAgentStreamState.activities || []),
      startedAt: Number(activeAgentStreamState.startedAt) || Date.now(),
    }
    : null;
  const partialRaw = consumeLiveAssistantText();
  cancelLiveStreamRender();
  let partialText = sanitizeAssistantText(partialRaw);
  if (activeAgentState && Array.isArray(activeAgentState.activities) && activeAgentState.activities.length > 0) {
    commitInterruptedAgentRun(String(token.chatId || ''), 'Agent was interrupted before finishing.', activeAgentState);
    pushDebugTrace('request_cancelled_agent_committed', {
      chatId: String(token.chatId || ''),
      activityCount: String(activeAgentState.activities.length),
    });
  } else if (partialText && !isArtifactOnlyResponse(partialText)) {
    const named = applyInlineChatNameFromResponse(String(token.chatId || ''), partialRaw);
    partialText = sanitizeAssistantText(named.text);
    commitAssistantMessage(String(token.chatId || ''), partialText, named.text || partialRaw);
    pushDebugTrace('request_cancelled_partial_committed', {
      chatId: String(token.chatId || ''),
      preview: debugPreview(partialText, 600),
    });
  }
  resolveChatNamingFallback(String(token.chatId || ''), 'New Chat');
  setThinkingStatus('Cancelled');
  completeInferenceRequest(token);
  // Refresh the tree so a cancel doesn't leave the explorer on its loading skeleton.
  try { void refreshWorkspaceTree(true); } catch (_) { /* best-effort */ }
  setTimeout(() => {
    if (pendingInferenceCount === 0) {
      setThinkingStatus('');
    }
  }, 900);
}

function parseChatMlPromptMessages(promptText) {
  const src = String(promptText || '');
  if (!src.trim()) return [];
  const items = [];
  const pattern = /<\|im_start\|>(system|user|assistant)\n([\s\S]*?)(?:\n<\|im_end\|>|$)/g;
  let match = null;
  while ((match = pattern.exec(src)) !== null) {
    const role = String(match[1] || '').trim();
    const content = String(match[2] || '').trim();
    if (!role || !content) continue;
    items.push({ role, content });
  }
  return items;
}

function buildApiMessagePayloadFromPrompt(promptText) {
  const parsed = parseChatMlPromptMessages(promptText);
  const systemParts = [];
  const messages = [];
  parsed.forEach((entry) => {
    if (!entry || !entry.role || !entry.content) return;
    if (entry.role === 'system') {
      systemParts.push(entry.content);
      return;
    }
    if (entry.role === 'user' || entry.role === 'assistant') {
      messages.push({
        role: entry.role,
        content: entry.content,
      });
    }
  });
  if (messages.length === 0) {
    messages.push({ role: 'user', content: String(promptText || '').trim() });
  }
  return {
    system: systemParts.join('\n\n').trim(),
    messages,
  };
}

function extractOpenAiCompatibleMessageText(payload) {
  const choices = Array.isArray(payload && payload.choices) ? payload.choices : [];
  const first = choices[0] || {};
  const message = first && first.message ? first.message : {};
  const content = message && message.content;
  const extractTextPart = (item) => {
    if (!item) return '';
    if (typeof item === 'string') return item;
    if (typeof item.text === 'string') return item.text;
    if (typeof item.content === 'string' && String(item.type || '').toLowerCase() === 'text') return item.content;
    if (typeof item.value === 'string' && /text/i.test(String(item.type || ''))) return item.value;
    if (typeof item.output_text === 'string') return item.output_text;
    if (item.text && typeof item.text.value === 'string') return item.text.value;
    return '';
  };
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map(extractTextPart)
      .filter(Boolean)
      .join('');
  }
  if (Array.isArray(first && first.content)) {
    return first.content
      .map(extractTextPart)
      .filter(Boolean)
      .join('');
  }
  if (typeof first && typeof first.text === 'string') {
    return first.text;
  }
  return '';
}

async function requestNativeOpenAiCompatibleCompletion(provider, prompt, maxTokens, options = {}) {
  if (!remoteProvidersEnabled) {
    return { ok: false, message: 'Remote inference providers are disabled in this offline build.' };
  }
  const def = getInferenceProviderDef(provider);
  const apiKey = getProviderApiKey(provider);
  const model = getProviderModel(provider);
  const endpointUrl = getProviderEndpoint(provider);
  if (!apiKey) {
    return { ok: false, message: `${def.label} API key is missing in Settings.` };
  }
  if (!model) {
    return { ok: false, message: `${def.label} model is missing in Settings.` };
  }
  if (!endpointUrl) {
    return { ok: false, message: `${def.label} endpoint URL is missing in Settings.` };
  }
  if (!nativeBridge.available()) {
    return { ok: false, message: 'Native runtime bridge unavailable.' };
  }

  const payload = buildApiMessagePayloadFromPrompt(prompt);
  const req = {
    model,
    stream: false,
    messages: payload.system
      ? [{ role: 'system', content: payload.system }, ...payload.messages]
      : payload.messages,
  };
  const boundedMaxTokens = Math.max(0, Number(maxTokens) || 0);
  if (boundedMaxTokens > 0) {
    req.max_tokens = boundedMaxTokens;
  }

  const response = await nativeBridge.invoke('openAiCompatibleProxy', {
    endpointUrl,
    authHeader: getOpenAiCompatibleAuthHeader(provider, apiKey, endpointUrl),
    requestBody: JSON.stringify(req),
    timeoutMs: Number(options.timeoutMs) || 300000,
  });
  if (!response || !response.ok) {
    return {
      ok: false,
      message: (response && response.message) || `${def.label} request failed.`,
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(String(response.output || '{}'));
  } catch (_) {
    return { ok: false, message: `${def.label} returned invalid JSON.` };
  }

  const text = extractOpenAiCompatibleMessageText(parsed);
  if (!text) {
    return { ok: false, message: `${def.label} response did not include assistant text.` };
  }

  return {
    ok: true,
    output: text,
    raw: parsed,
    status: {
      lastInferenceRoute: `${provider}:${model}`,
      lastPersistentError: '',
      lastCompletionStatus: 'ok',
      lastCompletionLikelyTruncated: false,
    },
  };
}

async function streamOpenAiCompatibleChatCompletion(provider, prompt, handlers = {}, options = {}) {
  if (!remoteProvidersEnabled) {
    return { ok: false, message: 'Remote inference providers are disabled in this offline build.' };
  }
  const def = getInferenceProviderDef(provider);
  const apiKey = getProviderApiKey(provider);
  const model = String(options.modelOverride || '').trim() || getProviderModel(provider);
  const endpointUrl = getProviderEndpoint(provider);
  if (shouldUseNativeCustomOpenAiRelay(provider)) {
    if (typeof handlers.onStart === 'function') {
      handlers.onStart(`${provider}_${Date.now()}`);
    }
    const nativeRes = await requestNativeOpenAiCompatibleCompletion(provider, prompt, options.maxTokens, options);
    if (!nativeRes || !nativeRes.ok) {
      return nativeRes || { ok: false, message: `${def.label} request failed.` };
    }
    if (typeof handlers.onDelta === 'function' && nativeRes.output) {
      handlers.onDelta(nativeRes.output);
    }
    return nativeRes;
  }
  if (!apiKey) {
    return { ok: false, message: `${def.label} API key is missing in Settings.` };
  }
  if (!model) {
    return { ok: false, message: `${def.label} model is missing in Settings.` };
  }
  if (!endpointUrl) {
    return { ok: false, message: `${def.label} endpoint URL is missing in Settings.` };
  }
  const controller = options.abortController instanceof AbortController
    ? options.abortController
    : new AbortController();
  const payload = buildApiMessagePayloadFromPrompt(prompt);
  const req = {
    model,
    stream: true,
    messages: payload.system
      ? [{ role: 'system', content: payload.system }, ...payload.messages]
      : payload.messages,
  };
  const maxTokens = Math.max(0, Number(options.maxTokens) || 0);
  if (maxTokens > 0) {
    req.max_tokens = maxTokens;
  }
  // Think mode keeps the model's native reasoning on; otherwise off for speed.
  applyThinkingMode(provider, req, Boolean(options.thinkActive));
  if (typeof handlers.onStart === 'function') {
    handlers.onStart(`${provider}_${Date.now()}`);
  }
  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: getOpenAiCompatibleAuthHeader(provider, apiKey, endpointUrl),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let message = humanizeProviderErrorMessage(def.label, response.status, body || response.statusText || '');
      try {
        const parsed = JSON.parse(body || '{}');
        const code = String(parsed && parsed.error && parsed.error.code ? parsed.error.code : '').trim();
        if (code === 'model_not_supported') {
          message = `${def.label} model is not currently available through your enabled Hugging Face providers. Choose a supported preset or use a local model.`;
        }
      } catch (_) { }
      return {
        ok: false,
        httpStatus: response.status,
        retryAfterMs: response.status === 429 ? parseRateLimitRetryMs(response) : 0,
        message,
      };
    }
    if (!response.body) {
      return { ok: false, message: `${def.label} response body is empty.` };
    }
    let output = '';
    let reasoningOpen = false;
    let streamFinishReason = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const lines = String(frame || '').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const rawPayload = trimmed.slice(5).trim();
          if (!rawPayload || rawPayload === '[DONE]') continue;
          let parsed = null;
          try {
            parsed = JSON.parse(rawPayload);
          } catch (_) {
            continue;
          }
          const finishReason = parsed && Array.isArray(parsed.choices) && parsed.choices[0]
            && parsed.choices[0].finish_reason ? String(parsed.choices[0].finish_reason) : '';
          if (finishReason) streamFinishReason = finishReason;
          const deltaObj = parsed && Array.isArray(parsed.choices) && parsed.choices[0]
            ? parsed.choices[0].delta
            : null;
          // Native reasoning (deepseek-reasoner etc.) arrives in reasoning_content;
          // wrap it as <thinking> so the existing Thoughts UI renders it.
          const reasoningDelta = deltaObj && typeof deltaObj.reasoning_content === 'string'
            ? deltaObj.reasoning_content
            : '';
          if (reasoningDelta) {
            const wrapped = `${reasoningOpen ? '' : '<thinking>'}${reasoningDelta}`;
            reasoningOpen = true;
            output += wrapped;
            if (typeof handlers.onDelta === 'function') handlers.onDelta(wrapped);
            continue;
          }
          const delta = deltaObj && typeof deltaObj.content === 'string'
            ? deltaObj.content
            : parsed
              && Array.isArray(parsed.choices)
              && parsed.choices[0]
              && parsed.choices[0].message
              && typeof parsed.choices[0].message.content === 'string'
              ? parsed.choices[0].message.content
            : '';
          if (!delta) continue;
          const closing = reasoningOpen ? '</thinking>' : '';
          reasoningOpen = false;
          output += closing + delta;
          if (typeof handlers.onDelta === 'function') {
            handlers.onDelta(closing + delta);
          }
        }
      }
    }
    if (reasoningOpen) {
      output += '</thinking>';
      if (typeof handlers.onDelta === 'function') handlers.onDelta('</thinking>');
    }
    if (!output.trim()) {
      return { ok: false, message: `${def.label} streamed response was empty.` };
    }
    return {
      ok: true,
      output,
      truncated: streamFinishReason === 'length',
      status: {
        lastInferenceRoute: `${provider}:${model}`,
        lastPersistentError: '',
        lastCompletionStatus: 'ok',
        lastCompletionLikelyTruncated: false,
      },
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, cancelled: true, message: 'Cancelled by user.' };
    }
    return {
      ok: false,
      message: `${def.label} request error: ${err && err.message ? err.message : 'unknown error'}`,
    };
  }
}

async function streamAnthropicChatCompletion(prompt, handlers = {}, options = {}) {
  if (!remoteProvidersEnabled) {
    return { ok: false, message: 'Remote inference providers are disabled in this offline build.' };
  }
  const provider = 'anthropic';
  const def = getInferenceProviderDef(provider);
  const apiKey = getProviderApiKey(provider);
  const model = getProviderModel(provider);
  if (!apiKey) {
    return { ok: false, message: `${def.label} API key is missing in Settings.` };
  }
  if (!model) {
    return { ok: false, message: `${def.label} model is missing in Settings.` };
  }
  const controller = options.abortController instanceof AbortController
    ? options.abortController
    : new AbortController();
  const payload = buildApiMessagePayloadFromPrompt(prompt);
  const req = {
    model,
    system: payload.system || undefined,
    messages: payload.messages.map((entry) => ({
      role: entry.role,
      content: entry.content,
    })),
    stream: true,
    max_tokens: Math.max(256, Number(options.maxTokens) || 2048),
  };
  if (typeof handlers.onStart === 'function') {
    handlers.onStart(`anthropic_${Date.now()}`);
  }
  try {
    const response = await fetch(def.endpointUrl, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        httpStatus: response.status,
        retryAfterMs: response.status === 429 ? parseRateLimitRetryMs(response) : 0,
        message: humanizeProviderErrorMessage(def.label, response.status, body || response.statusText || ''),
      };
    }
    if (!response.body) {
      return { ok: false, message: `${def.label} response body is empty.` };
    }
    let output = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const lines = String(frame || '').split('\n');
        let eventName = '';
        let payloadText = '';
        lines.forEach((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('event:')) {
            eventName = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:')) {
            payloadText += trimmed.slice(5).trim();
          }
        });
        if (!payloadText) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(payloadText);
        } catch (_) {
          continue;
        }
        let delta = '';
        if (eventName === 'content_block_delta'
          && parsed
          && parsed.delta
          && parsed.delta.type === 'text_delta'
          && typeof parsed.delta.text === 'string') {
          delta = parsed.delta.text;
        } else if (eventName === 'content_block_start'
          && parsed
          && parsed.content_block
          && parsed.content_block.type === 'text'
          && typeof parsed.content_block.text === 'string') {
          delta = parsed.content_block.text;
        }
        if (!delta) continue;
        output += delta;
        if (typeof handlers.onDelta === 'function') {
          handlers.onDelta(delta);
        }
      }
    }
    return {
      ok: true,
      output,
      status: {
        lastInferenceRoute: `${provider}:${model}`,
        lastPersistentError: '',
        lastCompletionStatus: 'ok',
        lastCompletionLikelyTruncated: false,
      },
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, cancelled: true, message: 'Cancelled by user.' };
    }
    return {
      ok: false,
      message: `${def.label} request error: ${err && err.message ? err.message : 'unknown error'}`,
    };
  }
}

async function streamRemoteChatCompletion(provider, prompt, handlers = {}, options = {}) {
  if (provider === 'anthropic') {
    return streamAnthropicChatCompletion(prompt, handlers, options);
  }
  return streamOpenAiCompatibleChatCompletion(provider, prompt, handlers, options);
}

const agentStepFunctionSchema = {
  type: 'function',
  function: {
    name: 'agent_step',
    description: 'Return the next agent step. Include thought only when you learned something new or are changing approach.',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Optional: one short sentence for the user. Omit if nothing new to say.' },
        action: { type: 'string', enum: ['tool', 'final'] },
        message: { type: 'string', description: 'User-facing message or final answer.' },
        tool: { type: 'string', enum: ['none', 'new_project', 'list_dir', 'search_files', 'read_file', 'write_file', 'edit_file', 'validate_files', 'check_code', 'run_app', 'run_command', 'mkdir', 'move', 'delete'] },
        path: { type: 'string' },
        content: { type: 'string' },
        command: { type: 'string', description: 'For run_command: the command to run (python/pip/node/npm only), e.g. "python main.py" or "pip install -r requirements.txt".' },
        src_path: { type: 'string' },
        dst_path: { type: 'string' },
        scope: { type: 'string', description: 'Optional path prefix or specific file to restrict search_files to, e.g. /ui or /ui/agent-executor.js.' },
        offset: { type: 'number', description: 'Character offset for read_file pagination. Use when previous read was truncated.' },
        limit: { type: 'number', description: 'Max characters to read from offset. Defaults to the standard cap.' },
        start_line: { type: 'number', description: 'First line to read (1-based). Use with end_line for targeted code reads.' },
        end_line: { type: 'number', description: 'Last line to read (inclusive). Use with start_line.' },
      },
      required: ['action', 'tool'],
    },
  },
};

async function requestOpenAiCompatibleTextCompletion(provider, prompt, maxTokens, systemPrompt = '', signal = null) {
  if (!remoteProvidersEnabled) return null;
  const def = getInferenceProviderDef(provider);
  const apiKey = getProviderApiKey(provider);
  const model = getProviderModel(provider);
  const endpointUrl = getProviderEndpoint(provider);
  if (shouldUseNativeCustomOpenAiRelay(provider)) {
    return requestNativeOpenAiCompatibleCompletion(provider, prompt, maxTokens, {
      timeoutMs: 300000,
    });
  }
  if (!apiKey || !model || !endpointUrl) return null;
  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: {
        Authorization: getOpenAiCompatibleAuthHeader(provider, apiKey, endpointUrl),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(applyThinkingMode(provider, {
        model,
        messages: systemPrompt
          ? [{ role: 'system', content: String(systemPrompt) }, { role: 'user', content: String(prompt || '') }]
          : [{ role: 'user', content: String(prompt || '') }],
        max_tokens: Math.max(1, Number(maxTokens) || agentFileContentMaxTokens),
        ...(systemPrompt && def && def.supportsToolCalling ? { tools: [agentStepFunctionSchema] } : {}),
      }, false)),
    });
    if (!response.ok) {
      const status = response.status;
      const errBody = await response.json().catch(() => null);
      const errMsg = errBody && errBody.error && (errBody.error.message || errBody.error.code);
      return {
        ok: false,
        httpStatus: status,
        retryAfterMs: status === 429 ? parseRateLimitRetryMs(response) : 0,
        message: humanizeProviderErrorMessage(def && def.label, status, errMsg ? String(errMsg) : ''),
      };
    }
    const payload = await response.json().catch(() => null);
    const msg = payload && Array.isArray(payload.choices) && payload.choices[0] && payload.choices[0].message;
    // Prefer function call arguments (structured output) over plain content.
    const toolCall = msg && Array.isArray(msg.tool_calls) && msg.tool_calls[0];
    const text = (toolCall && toolCall.function && typeof toolCall.function.arguments === 'string')
      ? toolCall.function.arguments
      : (msg && typeof msg.content === 'string' ? msg.content : '');
    const choice0 = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const truncated = choice0 ? String(choice0.finish_reason || '').toLowerCase() === 'length' : false;
    return text ? { ok: true, output: text, truncated } : null;
  } catch (_) {
    return null;
  }
}

async function requestAnthropicTextCompletion(prompt, maxTokens) {
  if (!remoteProvidersEnabled) return null;
  const provider = 'anthropic';
  const def = getInferenceProviderDef(provider);
  const apiKey = getProviderApiKey(provider);
  const model = getProviderModel(provider);
  if (!apiKey || !model) return null;
  try {
    const response = await fetch(def.endpointUrl, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.max(1, Number(maxTokens) || agentFileContentMaxTokens),
        messages: [{ role: 'user', content: String(prompt || '') }],
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const blocks = Array.isArray(payload && payload.content) ? payload.content : [];
    const text = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    const truncated = String((payload && payload.stop_reason) || '').toLowerCase() === 'max_tokens';
    return text ? { ok: true, output: text, truncated } : null;
  } catch (_) {
    return null;
  }
}

async function requestSelectedRemoteTextCompletion(prompt, maxTokens, systemPrompt = '', extra = {}) {
  // Don't start/retry an agent inference once the run was cancelled.
  if (activeInferenceRequest && activeInferenceRequest.cancelled) {
    return { ok: false, cancelled: true, message: 'Cancelled.' };
  }
  const controller = (extra && extra.abortController instanceof AbortController)
    ? extra.abortController
    : new AbortController();
  inFlightInferenceControllers.add(controller);
  noteAgentInferenceStart(String(prompt || '').length + String(systemPrompt || '').length);
  let result = null;
  try {
    result = await requestRemoteTextCompletionForCapability('agent.writeFile', prompt, maxTokens, { systemPrompt, ...extra, abortController: controller });
  } finally {
    inFlightInferenceControllers.delete(controller);
    noteAgentInferenceEnd(result && result.ok ? String(result.output || '').length : 0);
  }
  return result;
}

async function requestRemoteTextCompletionForCapability(capability, prompt, maxTokens, options = {}) {
  const worker = selectWorkerForJob(capability || 'agent.writeFile', { allowLocal: false, allowRemote: true });
  if (!worker || worker.provider === 'local') return null;
  const provider = worker.provider;
  recordDebugTrace('worker_route_selected', {
    job: String(capability || 'agent.writeFile'),
    workerId: worker.id,
    workerType: worker.type,
    provider,
    model: String(getProviderModel(provider) || ''),
  }, {
    job: String(capability || 'agent.writeFile'),
    capability: String(capability || 'agent.writeFile'),
    worker,
    promptLength: String(prompt || '').length,
    maxTokens: Number(maxTokens) || 0,
  });
  if (options && options.preferStreaming) {
    const result = await streamRemoteChatCompletion(provider, prompt, {
      onDelta: typeof options.onDelta === 'function' ? options.onDelta : undefined,
    }, {
      maxTokens: Math.max(1, Number(maxTokens) || 64),
    });
    return result ? { ...result, workerId: worker.id, provider, model: getProviderModel(provider) } : result;
  }
  if (provider === 'anthropic') {
    const result = await requestAnthropicTextCompletion(prompt, maxTokens);
    return result ? { ...result, workerId: worker.id, provider, model: getProviderModel(provider) } : result;
  }
  const abortSignal = options && options.abortController instanceof AbortController ? options.abortController.signal : null;
  const result = await requestOpenAiCompatibleTextCompletion(provider, prompt, maxTokens, options && options.systemPrompt ? options.systemPrompt : '', abortSignal);
  return result ? { ...result, workerId: worker.id, provider, model: getProviderModel(provider) } : result;
}

function normalizeReplyModeDecision(text) {
  const lower = String(text || '').trim().toLowerCase();
  if (!lower) return '';
  if (/\bcanvas\b/.test(lower)) return 'canvas';
  if (/\bchat\b/.test(lower)) return 'chat';
  return '';
}

function inferReplyModeDeterministically() {
  // No keyword guessing (phrasing-dependent and brittle). The model router is
  // primary; when no model judgment is available, trust the user's explicit
  // Canvas toggle — the canvas prompt already lets the model answer
  // conversationally when the message is really a follow-up.
  return 'canvas';
}

function normalizePreflightRouteDecision(rawDecision = {}) {
  const value = rawDecision && typeof rawDecision === 'object' ? rawDecision : {};
  const route = ['chat', 'inspect', 'agent', 'confirm'].includes(String(value.route || '').toLowerCase())
    ? String(value.route).toLowerCase()
    : '';
  return {
    route: route || 'chat',
    shouldInspectWorkspace: Boolean(value.shouldInspectWorkspace),
    shouldReadFiles: Boolean(value.shouldReadFiles),
    shouldModifyFiles: Boolean(value.shouldModifyFiles),
    shouldCreateProject: Boolean(value.shouldCreateProject),
    shouldAskUser: Boolean(value.shouldAskUser),
    reason: String(value.reason || '').trim(),
    userMessage: String(value.userMessage || '').trim(),
  };
}

function extractFirstJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) { }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_) { }
  }
  return null;
}

async function invokeWorkspaceBridgeAction(action, data = {}) {
  if (!nativeBridge.available()) {
    return { ok: false, message: 'Native runtime bridge unavailable.' };
  }
  return nativeBridge.invoke(action, data);
}

// Junk/noise workspace entries that should never be shown to the model: OS metadata
// files (macOS .DS_Store etc.), AppleDouble (._*), and VCS/cache/dependency dirs that
// are never user deliverables. Hidden to save tokens and avoid irrelevant mentions.
// (The explorer UI applies its own hidden-files set in workspace-core.js.)
const IGNORED_WORKSPACE_ENTRY_NAMES = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '.Spotlight-V100', '.Trashes', '.fseventsd',
  '.git', '.svn', '.hg', '__pycache__', '.cache', 'node_modules',
]);
function isIgnoredWorkspaceEntryName(name = '') {
  const n = String(name || '').trim();
  if (!n) return false;
  if (n.startsWith('._')) return true;
  return IGNORED_WORKSPACE_ENTRY_NAMES.has(n);
}
function workspaceEntryBaseName(entry) {
  return String(
    (entry && entry.name)
      || ((entry && entry.path ? String(entry.path) : '').split('/').filter(Boolean).pop())
      || '',
  );
}

function summarizeWorkspaceListPayload(rawOutput) {
  let parsed = {};
  try {
    parsed = JSON.parse(String(rawOutput || '{}'));
  } catch (_) {
    return {
      path: '/',
      entries: [],
      summary: 'Directory listing parse failed.',
    };
  }
  const path = normalizeWorkspacePath(parsed && parsed.path ? parsed.path : '/');
  const entries = (Array.isArray(parsed && parsed.entries) ? parsed.entries : [])
    .filter((entry) => !isIgnoredWorkspaceEntryName(workspaceEntryBaseName(entry)));
  const normalizedEntries = entries.slice(0, 120).map((entry) => ({
    kind: entry && entry.kind === 'folder' ? 'folder' : 'file',
    path: normalizeWorkspacePath(entry && entry.path ? entry.path : ''),
    name: String(entry && entry.name ? entry.name : ''),
    sizeBytes: Number(entry && entry.sizeBytes) || 0,
    childCount: Number(entry && entry.childCount) || 0,
  }));
  const lines = normalizedEntries.map((entry) => (
    entry.kind === 'folder'
      ? `- [dir] ${entry.path || entry.name}/ (${entry.childCount} items)`
      : `- [file] ${entry.path || entry.name} (${entry.sizeBytes} bytes)`
  ));
  return {
    path,
    entries: normalizedEntries,
    summary: [`Directory ${path}:`, ...(lines.length ? lines : ['(empty)'])].join('\n'),
  };
}

function normalizeInspectPlanPaths(rawPaths, availableEntries = [], workspaceContext = null) {
  const entries = Array.isArray(availableEntries) ? availableEntries : [];
  const availablePaths = new Set(entries.map((entry) => normalizeWorkspacePath(entry && entry.path ? entry.path : '')));
  const selectedPath = workspaceContext && workspaceContext.currentKind === 'file'
    ? normalizeWorkspacePath(workspaceContext.currentPath || '')
    : '';
  const normalized = [];
  (Array.isArray(rawPaths) ? rawPaths : []).forEach((value) => {
    const path = normalizeWorkspacePath(value || '');
    if (!path || path === '/' || normalized.includes(path)) return;
    if (availablePaths.size === 0 || availablePaths.has(path)) {
      normalized.push(path);
    }
  });
  if (normalized.length > 0) return normalized.slice(0, 4);
  if (selectedPath && (availablePaths.size === 0 || availablePaths.has(selectedPath))) {
    return [selectedPath];
  }
  return entries
    .filter((entry) => entry && entry.kind === 'file')
    .map((entry) => normalizeWorkspacePath(entry.path || ''))
    .filter(Boolean)
    .slice(0, 3);
}

async function requestWorkspaceTurnModeDecision(chatId, latestUserMessage) {
  const workspace = getWorkspaceDebugSnapshot();
  const recentMessages = getChatDebugSnapshot(chatId, 10)
    .map((msg) => `${msg.role}: ${String(msg.text || '').slice(0, 1000)}`)
    .join('\n\n');
  const prompt = [
    'Return exactly one word: "agent", "inspect", or "chat". No prose.',
    'Choose "agent" only when this turn should actively modify files or continue implementation work.',
    'Choose "inspect" when the answer should be grounded in the currently open workspace by reading files first, but without editing them.',
    'Choose "chat" only for purely conversational turns that do not require inspecting workspace files.',
    'If a workspace already exists and the user is asking about what is already there, how to run it, whether it satisfies a request, what is missing, or to inspect/verify/explain it, return "inspect".',
    'If the user clearly wants new file edits, creation, or continued implementation work, return "agent".',
    '',
    `Workspace root: ${workspace.workspaceRootName || '(none)'}`,
    `Workspace current path: ${workspace.currentPath || '/'}`,
    `Workspace root entry count: ${Number(workspace.rootEntryCount) || 0}`,
    `Recent chat:\n${recentMessages || '(none)'}`,
    '',
    `Latest user message:\n${String(latestUserMessage || '').trim()}`,
    '',
    'Answer:',
  ].join('\n');

  const remote = await requestSelectedRemoteTextCompletion(prompt, 4);
  let decision = normalizeWorkspaceTurnModeDecision(remote && remote.ok ? remote.output : '');
  if (!decision && nativeBridge.available()) {
    const nativeRes = await nativeBridge.invoke('infer', {
      prompt,
      maxTokens: 4,
      max_tokens: 4,
    });
    decision = normalizeWorkspaceTurnModeDecision(nativeRes && nativeRes.ok ? nativeRes.output : '');
  }
  if (decision) return decision;
  return 'inspect';
}

// Model-decided preflight route. The model classifies the user's intent; the
// regex feature scoring in preflight-router.js is only a fallback for when this
// call fails. Returns the parsed structured decision or null.
async function requestPreflightRouteModelDecision(chatId, latestUserMessage, context = {}) {
  const text = String(latestUserMessage || '').trim();
  if (!text) return null;
  const recentMessages = getChatDebugSnapshot(chatId, 6)
    .map((msg) => `${msg.role}: ${String(msg.text || '').slice(0, 500)}`)
    .join('\n\n');
  const prompt = [
    'Return exactly one JSON object. No prose. No markdown.',
    'Keys: route, intent, needs_workspace, needs_file_mutation, confidence, reason',
    'route: "chat" | "inspect" | "agent"',
    'intent: "casual_chat" | "general_answer" | "workspace_question" | "create_or_build_deliverable" | "modify_existing_workspace" | "debug_existing_workspace"',
    'needs_workspace: "yes" | "no"',
    'needs_file_mutation: "yes" | "no"',
    'confidence: number from 0 to 1',
    'reason: one short sentence',
    '',
    'Rules (decide what the user wants DONE, not by keywords):',
    '- Normal conversation, explanations, rewrites, or corrections to YOUR previous answer => route="chat".',
    '- Asking PURELY to understand, explain, review, or learn how to run the OPEN workspace, with NO change wanted => route="inspect".',
    '- Asking to create, build, generate, implement, scaffold a deliverable, or to modify/fix/refactor real files => route="agent".',
    '- A pasted error message, stack trace, console/runtime error, OR a report that the open app is broken / not working / crashing / blank / "nothing happens" => route="agent", intent="debug_existing_workspace". The user wants it FIXED (and explained as you go), NOT merely diagnosed. Treat this by MEANING, not keywords — however they phrase it, a broken app or an error they pasted is a request to fix it. Use route="inspect" for an error ONLY if they explicitly ask just to understand it without changing anything.',
    '- A report that the open project or a file has something WRONG with its contents — wrong, stray, leftover, duplicated, misplaced, or unwanted content, something that "got added/injected/left in" by mistake, or a request to remove / delete / clean up / undo / take out part of a file => route="agent" (modify or debug). The user is pointing at something in the FILES to correct, not asking for conversation. Decide by meaning even when it is phrased as a calm observation ("I think you put X in the file").',
    '- Agent being ON means file-producing or file-changing requests SHOULD go to route="agent". It does NOT mean every message goes to agent.',
    '- Workspace being open means workspace questions can use route="inspect". It does NOT mean every message is about the workspace.',
    '- If the user wants something fixed, improved, restyled, redesigned, polished, or made to look/work better in the open project, that is route="agent" (modify) EVEN IF they also say "check", "look at", or describe the symptoms first. "check and fix it" = agent, not inspect. Use route="inspect" only when the user asks purely to understand/explain/diagnose with no change requested.',
    '- "build on your previous answer", "fix your explanation", "design it as a table" are route="chat" (they are about the conversation, not files).',
    '',
    'Examples:',
    'User: "hello" => {"route":"chat","intent":"casual_chat","needs_workspace":"no","needs_file_mutation":"no","confidence":0.99,"reason":"Greeting."}',
    'User: "make snake game" => {"route":"agent","intent":"create_or_build_deliverable","needs_workspace":"yes","needs_file_mutation":"yes","confidence":0.95,"reason":"User wants a runnable deliverable built."}',
    'User: "I want a playable snake thing in python" => {"route":"agent","intent":"create_or_build_deliverable","needs_workspace":"yes","needs_file_mutation":"yes","confidence":0.92,"reason":"User wants a working program created."}',
    'User: "build on your last answer" => {"route":"chat","intent":"general_answer","needs_workspace":"no","needs_file_mutation":"no","confidence":0.93,"reason":"About the conversation, not files."}',
    'User: "how do I run this?" => {"route":"inspect","intent":"workspace_question","needs_workspace":"yes","needs_file_mutation":"no","confidence":0.94,"reason":"Asking how to run the open project."}',
    'User: "fix the button in this app" => {"route":"agent","intent":"modify_existing_workspace","needs_workspace":"yes","needs_file_mutation":"yes","confidence":0.95,"reason":"Wants a real code change."}',
    'User: "the styling isn\'t perfect, can you check and fix it? the close icon is too big" => {"route":"agent","intent":"modify_existing_workspace","needs_workspace":"yes","needs_file_mutation":"yes","confidence":0.9,"reason":"Wants the styling actually fixed, not just reviewed."}',
    'User: "script.js:11 Uncaught ReferenceError: SimulationGrid is not defined" => {"route":"agent","intent":"debug_existing_workspace","needs_workspace":"yes","needs_file_mutation":"yes","confidence":0.9,"reason":"A runtime error in the open app is a request to fix it."}',
    'User: "why is the app broken? nothing happens when I click play" => {"route":"agent","intent":"debug_existing_workspace","needs_workspace":"yes","needs_file_mutation":"yes","confidence":0.88,"reason":"Reporting broken behavior — fix it, then explain."}',
    'User: "explain what this error means, do not change anything" => {"route":"inspect","intent":"workspace_question","needs_workspace":"yes","needs_file_mutation":"no","confidence":0.9,"reason":"Explicitly wants explanation only, no change."}',
    '',
    `Agent mode: ${context.agentEnabled ? 'ON' : 'OFF'}`,
    `Workspace open: ${context.workspaceOpen ? 'yes' : 'no'}${context.workspaceRootName ? ` (root: ${context.workspaceRootName})` : ''}`,
    `This chat created/owns the open workspace: ${context.chatOwnsWorkspace ? 'yes' : 'no'}`,
    `Recent chat:\n${recentMessages || '(none)'}`,
    '',
    `Latest user message:\n${text}`,
    '',
    'JSON:',
  ].join('\n');

  try {
    const remote = await requestSelectedRemoteTextCompletion(prompt, 160);
    let parsed = extractFirstJsonObject(remote && remote.ok ? remote.output : '');
    if (!parsed && nativeBridge.available()) {
      const nativeRes = await nativeBridge.invoke('infer', { prompt, maxTokens: 160, max_tokens: 160 });
      parsed = extractFirstJsonObject(nativeRes && nativeRes.ok ? nativeRes.output : '');
    }
    return parsed || null;
  } catch (_) {
    return null;
  }
}

async function requestPreflightRouteDecision(chatId, latestUserMessage, options = {}) {
  const workspaceDebugSnapshot = getWorkspaceDebugSnapshot();
  const workspaceStatusSnapshot = await requestWorkspaceStatusSnapshot();
  const workspaceHasRealRoot = Boolean(
    workspaceStatusSnapshot
    && workspaceStatusSnapshot.ok
    && String(workspaceStatusSnapshot.rootName || workspaceStatusSnapshot.rootPath || '').trim()
  );
  const workspaceHasDebugRoot = Boolean(String(workspaceDebugSnapshot.workspaceRootName || '').trim());
  const workspace = workspaceHasRealRoot
    ? {
      ...workspaceDebugSnapshot,
      workspaceRootName: String(workspaceStatusSnapshot.rootName || workspaceDebugSnapshot.workspaceRootName || '').trim(),
      currentPath: normalizeWorkspacePath(workspaceStatusSnapshot.currentPath || workspaceDebugSnapshot.currentPath || '/'),
    }
    : workspaceHasDebugRoot
    ? workspaceDebugSnapshot
    : {
      ...workspaceDebugSnapshot,
      workspaceRootName: '',
      currentPath: '/',
      currentKind: 'folder',
      rootLoaded: false,
      rootEntryCount: 0,
      rootEntries: [],
    };
  const agentEnabled = Boolean(options && options.agentEnabled);
  const chatOwnsWorkspace = chatHasPriorAgentWorkspaceWork(chatId);
  const workspaceOpen = Boolean(
    String(workspace.workspaceRootName || '').trim()
    || normalizeWorkspacePath(workspace.currentPath || '/') !== '/'
  );
  // Provider-aware routing: the model-route classification is a SEPARATE inference
  // call. On a remote provider it's cheap and worth it (model-primary routing). On
  // the LOCAL model it would double every turn's latency (route call + response
  // call), so skip it and let the deterministic router handle local routing. Remote
  // gets the model's judgment; local gets speed.
  const useModelRouting = getSelectedInferenceProvider() !== 'local';
  const modelDecision = useModelRouting
    ? await requestPreflightRouteModelDecision(chatId, latestUserMessage, {
      agentEnabled,
      workspaceOpen,
      workspaceRootName: workspace.workspaceRootName || '',
      chatOwnsWorkspace,
    })
    : null;
  const advisoryDecision = normalizePreflightRouteDecision({
    route: (modelDecision && ['chat', 'inspect', 'agent'].includes(String(modelDecision.route || '').toLowerCase()))
      ? String(modelDecision.route).toLowerCase()
      : 'chat',
  });
  const router = window.AIExePreflightRouter && typeof window.AIExePreflightRouter.evaluate === 'function'
    ? window.AIExePreflightRouter
    : null;
  if (!router) {
    return advisoryDecision;
  }
  const evaluated = router.evaluate({
    advisoryDecision,
    modelDecision,
    latestUserMessage,
    workspace,
    agentEnabled,
    normalizeWorkspacePath,
    chatOwnsWorkspace,
  });
  const decision = normalizePreflightRouteDecision(evaluated && evaluated.decision ? evaluated.decision : advisoryDecision);
  const sameChatWorkspaceFollowup = Boolean(chatHasPriorAgentWorkspaceWork(chatId) && workspace.workspaceRootName);
  const buildIntent = String((modelDecision && modelDecision.intent) || decision.intent || '').toLowerCase();
  // A genuinely NEW deliverable requested in a chat that already owns a project is
  // ambiguous (build it fresh vs add to the current one). Ask — don't silently force
  // the existing workspace to be rewritten into a different app, and don't suppress
  // the confirm as a "follow-up". (modify_existing_workspace IS a follow-up; this isn't.)
  if (agentEnabled && sameChatWorkspaceFollowup && decision.route === 'agent'
    && buildIntent === 'create_or_build_deliverable'
    && !(options && options.skipNewProjectConfirmation)) {
    decision.route = 'confirm';
    decision.shouldAskUser = true;
    decision.shouldCreateProject = true;
    decision.shouldModifyFiles = false;
    decision.reason = 'A new build was requested while this chat already owns a project — confirm new vs current.';
    decision.userMessage = `I already have "${workspace.workspaceRootName}" open. Do you want me to keep using that project, or create a new one for this request?`;
    if (evaluated && evaluated.debug) {
      evaluated.debug.finalRoute = 'confirm';
      evaluated.debug.overridden = true;
      evaluated.debug.overrideReason = decision.reason;
    }
  }
  if (sameChatWorkspaceFollowup && decision.route === 'confirm' && !decision.shouldCreateProject
    && buildIntent !== 'create_or_build_deliverable') {
    decision.route = agentEnabled ? 'agent' : 'chat';
    decision.shouldAskUser = false;
    decision.shouldCreateProject = false;
    decision.shouldModifyFiles = agentEnabled;
    decision.reason = agentEnabled
      ? 'Same-chat follow-up in an existing workspace should continue in Agent mode without asking project scope again.'
      : 'Agent mode is disabled, so the same-chat workspace follow-up stays in chat.';
    decision.userMessage = '';
    if (evaluated && evaluated.debug) {
      evaluated.debug.finalRoute = decision.route;
      evaluated.debug.overridden = true;
      evaluated.debug.overrideReason = decision.reason;
      evaluated.debug.signals = Object.assign({}, evaluated.debug.signals || {}, {
        sameChatWorkspaceFollowup,
      });
    }
  }
  if (evaluated && evaluated.debug) {
    decision._debug = evaluated.debug;
    decision._debug.workspaceInput = {
      debugSnapshot: workspaceDebugSnapshot,
      statusSnapshot: workspaceStatusSnapshot,
      normalizedWorkspace: workspace,
    };
  }
  return decision;
}

async function requestWorkspaceInspectPlan(chatId, latestUserMessage, listSummary) {
  const workspace = getWorkspaceDebugSnapshot();
  const recentMessages = getChatDebugSnapshot(chatId, 8)
    .map((msg) => `${msg.role}: ${String(msg.text || '').slice(0, 600)}`)
    .join('\n\n');
  const prompt = [
    'Return exactly one JSON object. No prose.',
    'Keys: paths, reason',
    'paths must be an array of 1 to 4 file paths from DIRECTORY_LIST that should be read before answering the user.',
    'Choose the minimum set of files needed to answer accurately.',
    'Prefer the currently selected file when relevant.',
    'Do not include directories.',
    '',
    `Workspace root: ${workspace.workspaceRootName || '(none)'}`,
    `Current selection: ${workspace.currentPath || '/'} (${workspace.currentKind || 'folder'})`,
    `Recent chat:\n${recentMessages || '(none)'}`,
    '',
    `Latest user message:\n${String(latestUserMessage || '').trim()}`,
    '',
    `DIRECTORY_LIST:\n${String(listSummary || '(none)')}`,
    '',
    'JSON:',
  ].join('\n');

  const remote = await requestSelectedRemoteTextCompletion(prompt, 220);
  let parsed = extractFirstJsonObject(remote && remote.ok ? remote.output : '');
  if (!parsed && nativeBridge.available()) {
    const nativeRes = await nativeBridge.invoke('infer', {
      prompt,
      maxTokens: 220,
      max_tokens: 220,
    });
    parsed = extractFirstJsonObject(nativeRes && nativeRes.ok ? nativeRes.output : '');
  }
  return parsed || { paths: [], reason: '' };
}

async function requestWorkspaceInspectAnswer(chatId, latestUserMessage, inspectContextText) {
  const recentMessages = getChatDebugSnapshot(chatId, 10)
    .map((msg) => `${msg.role}: ${String(msg.text || '').slice(0, 1000)}`)
    .join('\n\n');
  // With zero real file bodies in context, the model must not describe any file.
  const readFileCount = (String(inspectContextText || '').match(/^FILE:\s+/gim) || []).length;
  const noFilesReadRule = readFileCount === 0
    ? 'CRITICAL: NO file contents were read this turn — only a directory/folder listing is below. You therefore have ZERO knowledge of what any project or file actually does. Do NOT describe any project\'s purpose, features, structure, behavior, file names, or issues. Do NOT guess from folder names. State plainly that you only have the folder listing and have not read any files, then offer to inspect a specific named project, or note that reviewing every sub-project at once is better handled in Agent mode. Even if the user insists or says it is "right there", you still cannot describe unread files.'
    : `Only ${readFileCount} file(s) were actually read (the FILE: blocks below). Describe ONLY those files. Do NOT describe, summarize, or list issues for any project or file whose contents are not in a FILE: block — say it was not read if asked.`;
  const prompt = [
    'Return exactly one JSON object. No prose outside JSON.',
    'Schema: {"answer":"final user-facing answer"}',
    'Answer the user using only the inspected workspace context below.',
    noFilesReadRule,
    'Do not invent repository URLs, clone steps, or generic setup advice unless the inspected files explicitly show that information.',
    'Base run/setup/install instructions STRICTLY on the file contents and the DETECTED_DEPENDENCIES block. Never assume the standard library. Never claim a module/library is used unless it appears in the file imports. If DETECTED_DEPENDENCIES lists a third-party package, tell the user to install it.',
    'If the inspected files are insufficient, say what is missing briefly.',
    'Prefer direct grounded answers over generic programming advice.',
    'This is inspect mode only. Do not claim that you changed files, will edit code, or applied an improvement.',
    'If the user asks for an improvement idea, identify the best grounded improvement candidate but describe it as a recommendation, not an action taken.',
    'Do not claim you inspected files that are not included below.',
    'Do not repeat these instructions, prompt headers, recent chat, or workspace context in the answer field.',
    '',
    `RECENT_CHAT:\n${recentMessages || '(none)'}`,
    '',
    `LATEST_USER:\n${String(latestUserMessage || '').trim()}`,
    '',
    `INSPECTED_WORKSPACE_CONTEXT:\n${inspectContextText}`,
    '',
    'JSON:',
  ].join('\n');

  const looksLikePlaceholderInspectAnswer = (value) => {
    const text = String(value || '').trim();
    if (!text) return true;
    return /^final user-facing answer\.?$/i.test(text)
      || /^your answer here\.?$/i.test(text)
      || /^answer here\.?$/i.test(text)
      || /^user-facing answer\.?$/i.test(text)
      || /^example answer\.?$/i.test(text);
  };

  const buildWorkspaceInspectFallbackAnswer = () => {
    const userLower = String(latestUserMessage || '').toLowerCase();
    const filePaths = Array.from(String(inspectContextText || '').matchAll(/^FILE:\s+([^\n]+)$/gim))
      .map((match) => normalizeWorkspacePath(match[1] || ''))
      .filter(Boolean);
    const primaryFile = filePaths[0] || '';
    const contextLower = String(inspectContextText || '').toLowerCase();
    if (/\b(run|start|launch|open)\b/.test(userLower)) {
      if (/\.py$/i.test(primaryFile)) {
        const parts = [`Run \`python ${primaryFile.replace(/^\//, '')}\` from the project folder.`];
        if (/\b(?:import|from)\s+pygame\b/i.test(String(inspectContextText || ''))) {
          parts.push('If Pygame is not installed, install it with `pip install pygame` first.');
        }
        return parts.join(' ');
      }
      if (/\.html?$/i.test(primaryFile)) {
        return `Open \`${primaryFile.replace(/^\//, '')}\` in a browser from the project folder.`;
      }
      if (/package\.json/i.test(contextLower)) {
        return 'I can see the project files, but I need to inspect `package.json` or the README to confirm the exact run command.';
      }
    }
    if (primaryFile) {
      return `I inspected \`${primaryFile.replace(/^\//, '')}\`, but I need a bit more project context to give a precise answer.`;
    }
    return 'I inspected the current workspace, but the available files were not enough to answer precisely.';
  };

  const extractWorkspaceInspectAnswer = (rawText) => {
    const raw = String(rawText || '').trim();
    if (!raw) return '';
    const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const decodeJsonStringLiteral = (value) => {
      const text = String(value || '').trim();
      if (!text) return '';
      try {
        return JSON.parse(`"${text
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\r/g, '\\r')
          .replace(/\n/g, '\\n')}"`);
      } catch (_) {
        return text
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    };
    const sanitizeWorkspaceInspectCandidate = (value) => String(value || '')
      .split('\n')
      .filter((line) => {
        const t = String(line || '').trim();
        if (!t) return true;
        if (/^```(?:json)?$/i.test(t)) return false;
        if (/^Schema\b/i.test(t)) return false;
        if (/^Answer the user\b/i.test(t)) return false;
        if (/^Do not\b/i.test(t)) return false;
        if (/^If the inspected files\b/i.test(t)) return false;
        if (/^Prefer direct\b/i.test(t)) return false;
        if (/^(RECENT_CHAT|LATEST_USER|INSPECTED_WORKSPACE_CONTEXT|ANSWER|JSON):/i.test(t)) return false;
        if (/^\[\[CHAT_NAME:/i.test(t)) return false;
        if (/\(\s*truncated\s*\)/i.test(t) && /^(do not|if the inspected|prefer direct|recent_chat|latest_user|inspected_workspace_context)/i.test(t)) return false;
        if (/^(user|assistant|system):/i.test(t) && t.length < 220) return false;
        return true;
      })
      .join('\n')
      .replace(/^final user-facing answer"?\}?\s*\n*/gim, '')
      .replace(/^(?:Do not|If the inspected files|Prefer direct|RECENT_CHAT:|LATEST_USER:|INSPECTED_WORKSPACE_CONTEXT:)[^\n]*\n?/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const parsed = extractFirstJsonObject(unfenced);
    if (parsed && typeof parsed.answer === 'string' && String(parsed.answer || '').trim()) {
      const parsedAnswer = sanitizeWorkspaceInspectCandidate(parsed.answer || '');
      if (!looksLikePlaceholderInspectAnswer(parsedAnswer)) {
        return parsedAnswer;
      }
    }
    const answerFieldMatches = Array.from(unfenced.matchAll(/"answer"\s*:\s*"([\s\S]*?)"\s*}?/gi));
    for (let index = answerFieldMatches.length - 1; index >= 0; index -= 1) {
      const match = answerFieldMatches[index];
      if (!match || !match[1]) continue;
      const decodedAnswer = sanitizeWorkspaceInspectCandidate(decodeJsonStringLiteral(match[1]));
      if (!looksLikePlaceholderInspectAnswer(decodedAnswer)) {
        return decodedAnswer;
      }
    }
    const cleaned = sanitizeWorkspaceInspectCandidate(unfenced);
    if (!looksLikePlaceholderInspectAnswer(cleaned)) {
      return cleaned;
    }
    return '';
  };

  const provider = getSelectedInferenceProvider();
  if (provider !== 'local') {
    const remote = await requestSelectedRemoteTextCompletion(prompt, 700);
    if (remote && remote.ok && String(remote.output || '').trim()) {
      const extracted = extractWorkspaceInspectAnswer(remote.output || '');
      if (extracted) {
        return { ok: true, output: extracted, mode: 'remote' };
      }
    }
  }
  if (nativeBridge.available()) {
    const nativeRes = await nativeBridge.invoke('infer', {
      prompt,
      maxTokens: 700,
      max_tokens: 700,
    });
    if (nativeRes && nativeRes.ok && String(nativeRes.output || '').trim()) {
      const extracted = extractWorkspaceInspectAnswer(nativeRes.output || '');
      if (extracted) {
        return { ok: true, output: extracted, mode: 'local' };
      }
      return { ok: true, output: buildWorkspaceInspectFallbackAnswer(), mode: 'local-fallback' };
    }
    return nativeRes || { ok: false, message: 'Workspace inspection answer failed.' };
  }
  return { ok: false, message: 'No available inference path for workspace inspection.' };
}

// Deterministically parse dependencies from inspected files so the inspect-answer
// model can't hallucinate the wrong stack (e.g. claim a pygame game "uses turtle,
// no install needed"). Mechanical extraction only — anchors the model in fact.
const THIRD_PARTY_PY_MODULES = new Set([
  'pygame', 'numpy', 'pandas', 'requests', 'flask', 'django', 'fastapi', 'pil', 'pillow',
  'matplotlib', 'scipy', 'torch', 'tensorflow', 'pydantic', 'sqlalchemy', 'aiohttp', 'bs4',
  'selenium', 'openai', 'anthropic', 'rich', 'typer', 'click', 'pytest', 'yaml', 'dotenv',
]);
function summarizeInspectedDependencies(inspectedFiles = []) {
  const lines = [];
  for (const file of (Array.isArray(inspectedFiles) ? inspectedFiles : [])) {
    const path = String(file && file.path || '');
    const content = String(file && file.content || '');
    if (/\.py$/i.test(path)) {
      const mods = new Set();
      for (const m of content.matchAll(/^\s*import\s+([a-zA-Z0-9_]+)/gm)) mods.add(m[1]);
      for (const m of content.matchAll(/^\s*from\s+([a-zA-Z0-9_]+)\s+import/gm)) mods.add(m[1]);
      if (!mods.size) continue;
      const thirdParty = [...mods].filter((m) => THIRD_PARTY_PY_MODULES.has(String(m).toLowerCase()));
      const parts = [`${path}: imports ${[...mods].join(', ')}.`];
      parts.push(thirdParty.length
        ? `Third-party (MUST be installed): ${thirdParty.join(', ')} — run \`pip install ${thirdParty.join(' ')}\`.`
        : 'All imports are Python standard library (no pip install needed).');
      lines.push(parts.join(' '));
    } else if (/\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(path)) {
      const pkgs = new Set();
      for (const m of content.matchAll(/require\(\s*['"]([^'".][^'"]*)['"]\s*\)/g)) pkgs.add(String(m[1]).split('/')[0]);
      for (const m of content.matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)) pkgs.add(String(m[1]).split('/')[0]);
      const ext = [...pkgs].filter(Boolean);
      if (ext.length) lines.push(`${path}: imports npm packages ${ext.join(', ')} — install with \`npm install ${ext.join(' ')}\`.`);
    }
  }
  return lines.length
    ? `DETECTED_DEPENDENCIES (parsed directly from the files — treat as ground truth, do NOT contradict):\n${lines.map((l) => `- ${l}`).join('\n')}`
    : '';
}

async function performWorkspaceInspectReply(chatId, promptText, requestToken, onProgress = null) {
  const reportProgress = (text) => {
    if (typeof onProgress === 'function') {
      onProgress(String(text || '').trim());
    }
  };

  const workspaceContext = getWorkspaceContext();
  const listPath = workspaceContext.currentKind === 'folder'
    ? normalizeWorkspacePath(workspaceContext.currentPath || '/')
    : parentWorkspacePath(workspaceContext.currentPath || '/');
  reportProgress(`Inspecting ${listPath || '/'}...`);
  const listResponse = await invokeWorkspaceBridgeAction('workspaceList', { path: listPath || '/' });
  if (!listResponse || !listResponse.ok) {
    return { ok: false, message: (listResponse && listResponse.message) || 'Failed to inspect workspace.' };
  }
  const listInfo = summarizeWorkspaceListPayload(listResponse.output || '');
  // Work-panel rows so inspect shows which files it actually read.
  const activities = [{
    kind: 'list', title: 'Inspected', detail: listPath || '/',
    openPath: listPath || '', openKind: 'folder', status: 'done', ts: Date.now(),
  }];
  reportProgress('Choosing relevant files...');
  const plan = await requestWorkspaceInspectPlan(chatId, promptText, listInfo.summary);
  const selectedPaths = normalizeInspectPlanPaths(plan && plan.paths, listInfo.entries, workspaceContext);
  const inspectedFiles = [];
  for (const path of selectedPaths) {
    reportProgress(`Reading ${path}...`);
    const readResponse = await invokeWorkspaceBridgeAction('workspaceReadFile', { path });
    const readOk = Boolean(readResponse && readResponse.ok);
    activities.push({
      kind: 'read', title: readOk ? 'Read' : 'Read failed', detail: path,
      openPath: path, openKind: 'file', status: readOk ? 'done' : 'error', ts: Date.now(),
    });
    if (!readOk) continue;
    inspectedFiles.push({
      path,
      content: clipDebugText(String(readResponse.output || ''), 18000),
    });
  }
  const dependencySummary = summarizeInspectedDependencies(inspectedFiles);
  const inspectContextText = [
    listInfo.summary,
    dependencySummary,
    '',
    ...inspectedFiles.map((file) => `FILE: ${file.path}\n${file.content}`),
  ].filter(Boolean).join('\n\n');
  reportProgress('Preparing grounded answer...');
  recordDebugTrace('workspace_inspect_context', {
    chatId: String(chatId || ''),
    inspectedCount: String(inspectedFiles.length),
    selectedPathsPreview: debugPreview(selectedPaths.join(' | '), 300),
  }, {
    chatId: String(chatId || ''),
    plan,
    selectedPaths,
    workspace: getWorkspaceDebugSnapshot(),
    inspectContextText,
  });
  reportProgress('Writing answer...');
  const answer = await requestWorkspaceInspectAnswer(chatId, promptText, inspectContextText);
  if (!answer || !answer.ok) {
    return { ok: false, message: (answer && answer.message) || 'Failed to answer from inspected workspace.' };
  }
  return {
    ok: true,
    output: String(answer.output || ''),
    inspectedFiles,
    selectedPaths,
    inspectContextText,
    answerMode: answer.mode || '',
    activities,
  };
}

async function requestReplyModeDecision(chatId, latestUserMessage) {
  const chat = findChatById(chatId);
  const recent = chat && Array.isArray(chat.messages)
    ? chat.messages
      .filter((msg) => msg && (msg.role === 'user' || msg.role === 'ai') && String(msg.text || '').trim())
      .slice(-6)
    : [];
  const history = recent.map((msg, index) => {
    const role = msg.role === 'ai' ? 'assistant' : 'user';
    const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    const canvasFlag = msg.role === 'ai' && /<AIcanvas[\s>]/i.test(String(msg.text || '')) ? ' canvas=yes' : '';
    return `${index + 1}. ${role}${canvasFlag}: ${text}`;
  }).join('\n');
  const prompt = [
    'Decide the response mode for the next assistant turn.',
    'Return exactly one word: CANVAS or CHAT.',
    'The user enabled Canvas mode in the app UI, so they EXPECT deliverables as canvas artifacts.',
    'Choose CANVAS whenever the user asks you to write, create, draft, or produce content of any kind (story, document, essay, code, plan, email, poem, list, etc.), including with typos.',
    'Choose CHAT only for conversation: greetings, questions, verification, clarification, or discussion about existing content.',
    'When in doubt about a request that produces new content, choose CANVAS.',
    '',
    'RECENT_CHAT:',
    history || '(none)',
    '',
    'LATEST_USER:',
    String(latestUserMessage || '').trim(),
    '',
    'MODE:',
  ].join('\n');

  const deterministic = inferReplyModeDeterministically(latestUserMessage);
  const remote = await requestSelectedRemoteTextCompletion(prompt, 8);
  let decision = normalizeReplyModeDecision(remote && remote.ok ? remote.output : '');
  if (decision) return decision;

  if (remoteProvidersEnabled && nativeBridge.available()) {
    const res = await nativeBridge.invoke('infer', {
      prompt,
      maxTokens: 8,
      max_tokens: 8,
    });
    decision = normalizeReplyModeDecision(res && res.ok ? res.output : '');
    if (decision) return decision;
  }

  return deterministic;
}

// Transient note in the composer status slot (the agent timer never paints over
// other chats, so this stays readable there).
let composerNoticeTimer = 0;
function showComposerNotice(text, ms = 4000) {
  const note = String(text || '').trim();
  if (!note) return;
  setThinkingStatus(note);
  if (composerNoticeTimer) clearTimeout(composerNoticeTimer);
  composerNoticeTimer = window.setTimeout(() => {
    composerNoticeTimer = 0;
    if (thinkingStatus && thinkingStatus.textContent === note) setThinkingStatus('');
  }, ms);
}

function handleSendButtonClick() {
  // Stop only the run the user is looking at; sends from other chats queue.
  if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) {
    cancelActiveInference();
    return;
  }
  sendMessage();
}

function setSettingsLoading(loading) {
  [settingsModelPath, settingsModelHash, settingsBackendStatus].forEach((el) => {
    if (!el) return;
    el.classList.toggle('loading', loading);
  });
  [settingsImportBtn, settingsDebugDumpBtn, settingsVerifyBtn, settingsSaveBtn].forEach((btn) => {
    if (btn) btn.disabled = loading;
  });
}

async function waitForUiPaint() {
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

async function ensureMinLoading(startedAtMs, minMs = 240) {
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const elapsed = now - startedAtMs;
  if (elapsed < minMs) {
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(minMs - elapsed)));
  }
}

function isLikelyIncompleteResponse(text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  if (/^<?DONE>?$/i.test(clean)) return false;

  const fences = (clean.match(/```/g) || []).length;
  if (fences % 2 !== 0) return true;

  // Ends mid-clause or with an open bracket/separator -> genuinely incomplete.
  if (/[,:;(\[{]$/.test(clean)) return true;
  // A trailing quote or backtick means "incomplete" ONLY when it is UNbalanced (an
  // open string / code span). A balanced closing " or ` is a normal ending — treating
  // it as truncated was firing a wasteful second generation (auto-continue) on
  // complete answers that simply ended in a quoted phrase or `code`.
  if (clean.endsWith('"') && (clean.match(/"/g) || []).length % 2 !== 0) return true;
  if (clean.endsWith('`') && (clean.match(/`/g) || []).length % 2 !== 0) return true;
  if (!/[.!?'"`)\]}]$/.test(clean) && !/[\p{Extended_Pictographic}\p{Emoji_Presentation}]$/u.test(clean) && clean.length >= 320) return true;
  return false;
}

function isRepetitiveEnumeratedOutput(text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  const lines = clean.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 8) return false;

  const numbered = [];
  for (const line of lines) {
    const match = line.match(/^(\d+)\.\s+(.+)$/);
    if (!match) continue;
    numbered.push({
      index: Number(match[1]),
      body: String(match[2] || '').trim(),
    });
  }
  if (numbered.length < 8) return false;

  let monotonic = true;
  for (let i = 1; i < numbered.length; i += 1) {
    if (numbered[i].index !== numbered[i - 1].index + 1) {
      monotonic = false;
      break;
    }
  }
  if (!monotonic) return false;

  const counts = new Map();
  for (const entry of numbered) {
    const key = entry.body.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let dominant = 0;
  for (const count of counts.values()) {
    dominant = Math.max(dominant, count);
  }
  return dominant >= Math.max(6, Math.floor(numbered.length * 0.7));
}

function isLikelyTruncatedStatus(status) {
  if (!status || typeof status !== 'object') return false;
  if (status.lastCompletionLikelyTruncated === true) return true;
  return String(status.lastCompletionStatus || '').trim().toLowerCase() === 'likely_truncated';
}

function isChatAutoContinuing(chatId) {
  const key = String(chatId || '');
  return Boolean(key && autoContinuingChatIds.has(key));
}

function setChatAutoContinuing(chatId, active) {
  const key = String(chatId || '');
  if (!key) return;
  if (active) {
    autoContinuingChatIds.add(key);
  } else {
    autoContinuingChatIds.delete(key);
  }
  if (activeChatId === key) {
    updateContinueButtonVisibility();
  }
}

function findLastAssistantMessage(chat) {
  if (!chat || !Array.isArray(chat.messages)) return null;
  for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
    const msg = chat.messages[i];
    if (msg && msg.role === 'ai' && typeof msg.text === 'string') {
      return msg;
    }
  }
  return null;
}

// A bare "retry / try again / continue / finish it" carries no build
// instructions on its own. Detect those so we can resume the original task.
function isBareAgentResumeRequest(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[\s.!]+$/g, '');
  if (!t) return false;
  return /^(?:(?:ok(?:ay)?|yes|yeah|yep|sure|please|pls|now|just|then|so|and|can you|could you)\s+)*(?:retry|retry it|try again|try it again|try once more|once more|redo|redo it|do it again|again|continue|continue building|keep going|carry on|go on|go ahead|proceed|resume|finish|finish it|finish up|finish the project|finish building|complete it|complete the project)$/.test(t);
}

function lastAssistantLooksIncompleteAgentRun(chat) {
  if (chat && chat.needsContinue) return true;
  const msg = findLastAssistantMessage(chat);
  const text = String(msg && msg.text ? msg.text : '');
  if (!text) return false;
  return /did not pass the project quality check|continue or retry without losing|left in its current state|hit an error before finishing|timed out before finishing|returned an invalid planning step|could not complete all tool steps|continue from the current (?:project|workspace) state|to build phase \d/i.test(text);
}

// When the user just says "retry"/"continue" after an interrupted agent build,
// re-run the ORIGINAL task (recovered from history) instead of the resume word —
// otherwise the planner sees a contentless "retry" and finalizes as a no-op.
function resolveAgentResumeTaskText(chatId, promptText) {
  const raw = String(promptText || '');
  if (!isBareAgentResumeRequest(raw)) return raw;
  const chat = findChatById(chatId);
  if (!chat || !Array.isArray(chat.messages) || !lastAssistantLooksIncompleteAgentRun(chat)) return raw;
  for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
    const msg = chat.messages[i];
    if (!msg || msg.role !== 'user') continue;
    const candidate = String(msg.text || '').trim();
    if (!candidate || candidate.length < 8 || isBareAgentResumeRequest(candidate)) continue;
    recordDebugTrace('agent_resume_task_recovered', {
      chatId: String(chatId || ''),
      resumeWordPreview: debugPreview(raw, 60),
      recoveredTaskPreview: debugPreview(candidate, 220),
    }, { chatId: String(chatId || ''), resumeWord: raw, recoveredTask: candidate });
    return candidate;
  }
  return raw;
}

function findContinuationOverlap(leftText, rightText, minProbe = 24, maxProbe = 480) {
  const left = String(leftText || '');
  const right = String(rightText || '');
  const maxLen = Math.min(left.length, right.length, Math.max(minProbe, maxProbe));
  for (let len = maxLen; len >= minProbe; len -= 1) {
    if (left.slice(-len) === right.slice(0, len)) {
      return len;
    }
  }
  return 0;
}

function mergeAssistantContinuationText(previousText, nextText) {
  const previous = String(previousText || '');
  const incoming = String(nextText || '');
  const trimmedIncoming = incoming.trim();
  if (!trimmedIncoming || /^<?DONE>?$/i.test(trimmedIncoming)) {
    return previous;
  }
  if (!previous) {
    return trimmedIncoming;
  }
  const overlap = findContinuationOverlap(previous, incoming);
  return overlap > 0 ? `${previous}${incoming.slice(overlap)}` : `${previous}${incoming}`;
}

function updateLastAssistantMessage(chatId, text, options = {}) {
  const chat = findChatById(chatId);
  if (!chat) return null;
  const lastAssistant = findLastAssistantMessage(chat);
  if (!lastAssistant) {
    return appendMessageToChat(chatId, 'ai', text, 0, options);
  }
  const merged = mergeAssistantContinuationText(lastAssistant.text, text).trim();
  lastAssistant.text = merged || String(lastAssistant.text || '').trim();
  if (typeof options.thinking === 'string' && options.thinking.trim()) {
    lastAssistant.thinking = mergeAssistantContinuationText(lastAssistant.thinking, options.thinking).trim();
  }
  if (options.thinkingMeta && typeof options.thinkingMeta === 'object') {
    lastAssistant.thinkingMeta = {
      startedAt: Number(options.thinkingMeta.startedAt) || 0,
      completedAt: Number(options.thinkingMeta.completedAt) || 0,
    };
  }
  if (Array.isArray(options.agentActivities) && options.agentActivities.length > 0) {
    lastAssistant.agentActivities = cloneAgentActivities(options.agentActivities);
  }
  if (options.agentMeta) {
    lastAssistant.agentMeta = cloneAgentMeta(options.agentMeta);
  }
  chat.updatedAt = nowTs();
  if (typeof options.forceNeedsContinue === 'boolean') {
    chat.needsContinue = options.forceNeedsContinue;
  } else {
    chat.needsContinue = isLikelyIncompleteResponse(lastAssistant.text);
  }
  saveChats();
  renderHistory();
  renderSidebarCounts();
  updateContinueButtonVisibility();
  if (activeChatId === chatId) {
    renderActiveChat();
  }
  return lastAssistant;
}

function findChatMessage(chatId, messageTs, role = '') {
  const chat = findChatById(chatId);
  const activeThread = chat ? getChatActiveThread(chat) : null;
  if (!chat || !activeThread || !Array.isArray(activeThread.messages)) return null;
  const targetTs = Number(messageTs) || 0;
  if (!targetTs) return null;
  return activeThread.messages.find((msg) =>
    msg
    && Number(msg.ts) === targetTs
    && (!role || String(msg.role || '') === String(role))
  ) || null;
}

function updateAssistantAgentMeta(chatId, messageTs, updater, options = {}) {
  const chat = findChatById(chatId);
  const message = findChatMessage(chatId, messageTs, 'ai');
  if (!chat || !message || typeof updater !== 'function') return false;
  const nextMeta = normalizeAgentMeta(updater(cloneAgentMeta(message.agentMeta)));
  if (!nextMeta) return false;
  message.agentMeta = nextMeta;
  chat.updatedAt = nowTs();
  saveChats();
  if (options.rerender !== false) {
    renderHistory();
    renderSidebarCounts();
    if (activeChatId === chatId) {
      renderActiveChat();
    }
  }
  return true;
}

// Workspace events (reverts/re-applies) surfaced to the agent's next run.
function appendAgentWorkspaceNote(chatId, text) {
  const chat = findChatById(chatId);
  const note = String(text || '').trim();
  if (!chat || !note) return;
  if (!Array.isArray(chat.agentWorkspaceNotes)) chat.agentWorkspaceNotes = [];
  chat.agentWorkspaceNotes.push({ ts: nowTs(), text: note });
  if (chat.agentWorkspaceNotes.length > 8) chat.agentWorkspaceNotes = chat.agentWorkspaceNotes.slice(-8);
  saveChats();
}

function getAgentWorkspaceNotesText(chatId) {
  const chat = findChatById(chatId);
  const notes = chat && Array.isArray(chat.agentWorkspaceNotes) ? chat.agentWorkspaceNotes.slice(-4) : [];
  if (!notes.length) return '';
  return `WORKSPACE EVENTS (authoritative — the current files on disk already reflect these):\n${notes.map((note) => `- ${note.text}`).join('\n')}`;
}

// Revert (or re-apply) every file change a completed agent response made.
// Reverting restores each touched file's pre-run snapshot (created files are
// trashed) after capturing the current contents so the action is reversible.
async function revertAgentMessageEdits(chatId, messageTs) {
  const message = findChatMessage(chatId, messageTs, 'ai');
  const meta = message && message.agentMeta;
  const revert = meta && meta.revert;
  if (!revert || !Array.isArray(revert.files) || !revert.files.length) return false;
  const reverting = meta.reverted !== true;
  const touched = [];
  if (reverting) {
    const restored = [];
    for (const file of revert.files) {
      try {
        const res = await invokeWorkspaceAction('workspaceReadFile', { path: file.path });
        if (res && res.ok) restored.push({ path: file.path, existedBefore: true, content: String(res.output || '') });
      } catch (_) { }
    }
    for (const file of revert.files) {
      try {
        if (file.existedBefore) {
          const res = await invokeWorkspaceAction('workspaceWriteFile', { path: file.path, content: file.content });
          if (res && res.ok) {
            touched.push(file.path);
            syncFileTabFromWorkspaceWrite(file.path, file.content, workspaceBaseName(file.path));
          }
        } else {
          const res = await invokeWorkspaceAction('workspaceTrash', { path: file.path });
          if (res && res.ok) {
            touched.push(file.path);
            if (typeof removeWorkspaceTab === 'function') removeWorkspaceTab(file.path);
          }
        }
      } catch (_) { }
    }
    updateAssistantAgentMeta(chatId, messageTs, (current) => ({
      ...(current || {}),
      revert: { ...revert, restored },
      reverted: true,
    }));
    appendAgentWorkspaceNote(chatId, `The user REVERTED all edits from the assistant response at ${new Date(messageTs).toLocaleString()} — these files were restored to their pre-response state: ${(touched.length ? touched : revert.files.map((file) => file.path)).join(', ')}. Treat the current file contents as the source of truth; do not re-apply those edits unless explicitly asked.`);
  } else {
    for (const file of (revert.restored || [])) {
      try {
        const res = await invokeWorkspaceAction('workspaceWriteFile', { path: file.path, content: file.content });
        if (res && res.ok) {
          touched.push(file.path);
          syncFileTabFromWorkspaceWrite(file.path, file.content, workspaceBaseName(file.path));
        }
      } catch (_) { }
    }
    updateAssistantAgentMeta(chatId, messageTs, (current) => ({
      ...(current || {}),
      reverted: false,
    }));
    appendAgentWorkspaceNote(chatId, `The user RE-APPLIED the previously reverted edits from the assistant response at ${new Date(messageTs).toLocaleString()} (files: ${touched.join(', ')}).`);
  }
  recordDebugTrace('agent_edits_reverted', {
    chatId: String(chatId || ''),
    messageTs: String(messageTs),
    mode: reverting ? 'revert' : 'restore',
    files: String(touched.length),
  }, { chatId, messageTs, mode: reverting ? 'revert' : 'restore', files: touched });
  await refreshWorkspaceTree(true);
  return true;
}

// Offline smoke run: load the generated app in a hidden sandboxed iframe with
// linked CSS/JS inlined and an injected error hook; return real runtime errors
// (window.onerror / unhandled rejections / console.error) from startup.
async function runWorkspaceAppSmokeTest(htmlPath) {
  const normalized = normalizeWorkspacePath(htmlPath || '/index.html');
  const htmlRes = await invokeWorkspaceAction('workspaceReadFile', { path: normalized });
  if (!htmlRes || !htmlRes.ok) return { ok: false, message: `could not read ${normalized}` };
  let html = String(htmlRes.output || '');
  const baseDir = parentWorkspacePath(normalized) || '/';
  const resolveRef = (ref) => {
    let r = String(ref || '').trim();
    if (!r || /^(?:https?:|data:|\/\/|#)/i.test(r)) return '';
    if (r.startsWith('/')) return normalizeWorkspacePath(r);
    let dir = baseDir;
    while (r.startsWith('../')) { r = r.slice(3); dir = parentWorkspacePath(dir) || '/'; }
    if (r.startsWith('./')) r = r.slice(2);
    return normalizeWorkspacePath(`${dir === '/' ? '' : dir}/${r}`);
  };
  const inlineAsset = async (ref) => {
    const path = resolveRef(ref);
    if (!path) return null;
    const res = await invokeWorkspaceAction('workspaceReadFile', { path });
    return res && res.ok ? String(res.output || '').replace(/<\/script/gi, '<\\/script') : null;
  };
  for (const match of [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi)]) {
    const css = await inlineAsset(match[1]);
    if (css != null) html = html.replace(match[0], `<style>\n${css}\n</style>`);
  }
  // ES modules don't load when the page is opened from file:// (offline) and become
  // syntax errors once inlined — detect them so we can report a fixable cause instead
  // of a wall of opaque "Script error" entries.
  let usesEsModules = /<script\b[^>]*type=["']module["']/i.test(html);
  for (const match of [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi)]) {
    const js = await inlineAsset(match[1]);
    if (js != null) {
      if (/^[ \t]*import\s+[^(]/m.test(js) || /^[ \t]*export\b/m.test(js)) usesEsModules = true;
      html = html.replace(match[0], `<script>\n${js}\n</script>`);
    }
  }
  const hook = `<script>(function(){var send=function(t){try{parent.postMessage({__aiexeSmoke:true,text:String(t).slice(0,400)},'*');}catch(e){}};
window.onerror=function(m,s,l,c){send(m+' ('+(s||'inline')+':'+(l||0)+':'+(c||0)+')');};
window.addEventListener('unhandledrejection',function(e){send('Unhandled promise rejection: '+((e.reason&&e.reason.message)||e.reason));});
var ce=console.error;console.error=function(){send(Array.prototype.slice.call(arguments).map(String).join(' '));try{ce.apply(console,arguments);}catch(e){}};
try{window.localStorage&&window.localStorage.length;}catch(e){var mem={};try{Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:function(k){return k in mem?mem[k]:null;},setItem:function(k,v){mem[k]=String(v);},removeItem:function(k){delete mem[k];},clear:function(){mem={};},key:function(i){return Object.keys(mem)[i]||null;},get length(){return Object.keys(mem).length;}}});}catch(e2){}}
window.addEventListener('load',function(){setTimeout(function(){try{parent.postMessage({__aiexeSmokeDone:true},'*');}catch(e){}},400);});
})();</script>`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${hook}`) : `${hook}\n${html}`;
  return new Promise((resolve) => {
    const errors = [];
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:800px;height:600px;visibility:hidden;';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      try { iframe.remove(); } catch (_) { }
      // A module-based page can't even load offline, so surface that single fixable
      // cause instead of the cascade of opaque "Script error" entries it produces.
      const reportedErrors = usesEsModules
        ? ['Uses ES module import/export, which does NOT load when the page is opened from file:// (offline) — this breaks the whole app. Convert the scripts to classic <script src="..."> files with no import/export (expose shared values on window), then run again.']
        : errors.slice(0, 12);
      resolve({ ok: true, errors: reportedErrors, htmlPath: normalized });
    };
    const onMessage = (event) => {
      const data = event && event.data;
      if (!data || typeof data !== 'object') return;
      if (data.__aiexeSmoke && typeof data.text === 'string') errors.push(data.text);
      if (data.__aiexeSmokeDone) window.setTimeout(finish, 150);
    };
    window.addEventListener('message', onMessage);
    document.body.appendChild(iframe);
    iframe.srcdoc = html;
    window.setTimeout(finish, 3000);
  });
}

function buildContinuationPrompt(chatId) {
  const chat = findChatById(chatId);
  const tail = String(findLastAssistantMessage(chat)?.text || '').slice(-continuationTailChars);
  return [
    'Continue the previous assistant response from exactly where it stopped.',
    'Do not restart, summarize, repeat completed text, add a new greeting, or add a new chat title marker.',
    'Preserve existing formatting, numbering, bullet lists, code fences, and math notation.',
    'If the previous response is already complete, output exactly: <DONE>',
    '',
    '<LAST_ASSISTANT_TAIL>',
    tail,
    '</LAST_ASSISTANT_TAIL>',
  ].join('\n');
}

function shouldAutoContinueResponse(chatId, text, status, options = {}) {
  if (canvasModeEnabled) return false;
  if ((Number(options.autoContinuationRemaining) || 0) <= 0) return false;
  if (!findChatById(chatId)) return false;
  if (isRepetitiveEnumeratedOutput(text)) return false;
  const clean = String(text || '').trim();
  if (!clean || /^<?DONE>?$/i.test(clean)) return false;
  return isLikelyTruncatedStatus(status) && isLikelyIncompleteResponse(clean);
}

function updateContinueButtonVisibility() {
  if (!continueBtn) return;
  const chat = getActiveChat();
  const show = Boolean(chat
    && chat.needsContinue
    && pendingInferenceCount === 0
    && !inNewChatMode
    && !isChatAutoContinuing(chat.id));
  continueBtn.classList.toggle('hidden', !show);
  continueBtn.disabled = !show;
  syncComposerLayoutState();
}

// True when a remote provider is configured with an API key (so the app can run
// online even without a local model). Used to gate the model-setup banner.
function hasUsableRemoteProvider() {
  try {
    const candidates = ['venice', 'deepseek', getSelectedInferenceProvider()];
    return candidates.some((p) => p && p !== 'local'
      && String(getProviderApiKey(p) || '').trim().length > 0);
  } catch (_) { return false; }
}

// Banner "Add API Key" action — open Settings on the Models & Inference section.
function openApiKeySettings() {
  Promise.resolve(openSettingsModal())
    .then(() => openSettingsSection('models'))
    .catch(() => {});
}

// Setup banner shows only when neither a local model nor a remote key is available.
// Re-callable so adding an API key in Settings hides it immediately.
let lastModelLoaded = false;
function updateModelSetupBanner() {
  const showBanner = !lastModelLoaded && !hasUsableRemoteProvider();
  const bannerEl = document.getElementById('modelSetupBanner');
  if (bannerEl) bannerEl.style.display = showBanner ? 'block' : 'none';
  const tmplBanner = document.querySelector('#emptyState .model-setup-banner');
  if (tmplBanner) {
    tmplBanner.style.display = showBanner ? 'block' : 'none';
    emptyStateTemplate = (document.getElementById('emptyState') || { outerHTML: '' }).outerHTML;
  }
}

function applyRuntimeStatus(status) {
  if (!status || typeof status !== 'object') return;
  const modelPathText = status.modelPath || '(unavailable)';
  const modelHashText = status.modelSha256 || (status.modelExists ? 'checksum unavailable' : 'model not found');
  const backendLine = status.backendConfigured
    ? `Configured (${status.backendVersion || 'unknown'})`
    : `Not configured${status.backendSelfTest ? `: ${status.backendSelfTest}` : ''}`;
  const modelLine = status.modelLoaded
    ? `Loaded • ${formatBytes(status.modelSizeBytes)}`
    : `Not loaded${status.lastError ? `: ${status.lastError}` : ''}`;

  if (settingsModelPath) settingsModelPath.textContent = modelPathText;
  if (settingsModelHash) settingsModelHash.textContent = modelHashText;
  if (settingsBackendStatus) settingsBackendStatus.textContent = `${backendLine}\n${modelLine}`;

  lastModelLoaded = Boolean(status.modelLoaded);
  updateModelSetupBanner();
  // NOTE: do NOT derive the workspace root from the runtime status here. Its
  // rootPath is the app/runtime directory (cfg_.root), not the open project — and
  // copying it on every poll re-opened a project the user had just closed. The
  // workspace root is owned solely by applyWorkspaceStatusSnapshot.
}

async function fetchRuntimeStatus(action = 'status') {
  if (!nativeBridge.available()) {
    applyRuntimeStatus({
      modelPath: '/data/model/model.gguf',
      modelExists: false,
      modelLoaded: false,
      modelSizeBytes: 0,
      modelSha256: '',
      backendConfigured: false,
      backendVersion: 'unknown',
      backendSelfTest: 'native bridge unavailable',
      lastError: 'Open the desktop app host to use native runtime actions.',
    });
    return { ok: false, message: 'Native runtime bridge unavailable.' };
  }
  const response = await nativeBridge.invoke(action);
  if (response && response.status) {
    applyRuntimeStatus(response.status);
  }
  return response || { ok: false, message: 'No response from runtime.' };
}

async function openSettingsModal() {
  if (!settingsBackdrop) return;
  loadAppSettings();
  syncInferenceProviderOptions();
  if (settingsProviderSelect) settingsProviderSelect.value = getSelectedInferenceProvider();
  if (settingsModelUrlInput) settingsModelUrlInput.value = appSettings.modelUrl;
  if (settingsKeepModelChk) settingsKeepModelChk.checked = appSettings.keepModelOnUpdate;
  if (settingsDebugTraceChk) settingsDebugTraceChk.checked = appSettings.debugTraceEnabled;
  syncSettingsWorkModeUi();
  syncSettingsProviderUi();
  renderSettingsWorkerList();
  openSettingsSection('general');
  setSettingsNote('');
  settingsBackdrop.classList.add('open');
  settingsBackdrop.setAttribute('aria-hidden', 'false');
  setTimeout(() => settingsCloseBtn && settingsCloseBtn.focus(), 0);
  setSettingsLoading(true);
  await waitForUiPaint();
  try {
    const status = await fetchRuntimeStatus('status');
    if (status && !status.ok && status.message) {
      setSettingsNote(status.message, 'info');
    }
  } finally {
    setSettingsLoading(false);
  }
}

function closeSettingsModal() {
  if (!settingsBackdrop) return;
  settingsBackdrop.classList.remove('open');
  settingsBackdrop.setAttribute('aria-hidden', 'true');
  setSettingsLoading(false);
  setButtonLoading(settingsImportBtn, false);
  setButtonLoading(settingsDebugDumpBtn, false);
  setButtonLoading(settingsVerifyBtn, false);
  setButtonLoading(settingsSaveBtn, false);
  setSettingsNote('');
}

function refreshWorkspaceForCurrentUser() {
  clearTypingIndicator();
  cancelLiveStreamRender();
  activeStreamRawText = '';
  activeStreamText = '';
  if (activeStreamRow && activeStreamRow.parentNode) {
    activeStreamRow.remove();
    activeStreamRow = null;
  }
  if (typingTimer) {
    clearTimeout(typingTimer);
    typingTimer = null;
  }
  pendingInferenceCount = 0;
  thinkingStartedByChatId.clear();
  notifyInferenceIdle();
  setSendLoading(false);
  setCanvasMode(false);
  canvasDockOpen = false;
  pendingManualContext = '';
  pendingAttachments = [];
  pendingNewChatAttachments = [];
  middleViewMode = 'chat';
  artifactDetailKey = '';
  workspaceTreeState.clear();
  workspaceSelectedPaths.clear();
  workspaceDraft = null;
  workspaceDraftFocusId = 0;
  workspaceRenameDraft = null;
  workspaceRenameFocusId = 0;
  openFileTabs = [];
  activeTabId = 'chat';
  fileTabsRestoreToken += 1;
  renderTabBar();
  if (chatArea) chatArea.style.display = 'flex';
  if (fileViewer) fileViewer.classList.add('hidden');

  loadStoredChats();
  loadStoredArtifacts();
  loadStoredWorkspace();
  renderHistory();
  renderSidebarCounts();
  renderActiveChat();
  renderArtifacts();
  syncCanvasPanelFromArtifacts();
  syncSidebarNavState();
  syncInputAugmentState();

  if (!currentAuthUser()) {
    closeChatActionModal();
    if (newChatBtn) newChatBtn.classList.remove('active');
    if (artifactsBtn) artifactsBtn.classList.remove('active');
    if (codeBtn) codeBtn.classList.remove('active');
    if (mainInput) {
      mainInput.value = '';
      mainInput.style.height = 'auto';
    }
    if (projInput) projInput.value = '';
    const cc = document.getElementById('charCount');
    if (cc) cc.textContent = '0 / ∞';
    updateTokenRing();
  }
  updateContinueButtonVisibility();
  void loadStoredFileTabs(fileTabsRestoreToken);
  void syncWorkspaceStateFromNative('refresh_workspace_for_user', { render: true, log: true });
}

async function handleAuthAction() {
  if (authMode !== 'login' && authMode !== 'signup') {
    return;
  }

  const username = normalizeUsername(authUserInput ? authUserInput.value : '');
  const key = usernameKey(username);
  const password = authPassInput ? authPassInput.value : '';
  const confirm = authConfirmInput ? authConfirmInput.value : '';

  if (!/^[A-Za-z0-9._-]{3,24}$/.test(username)) {
    setAuthNote('Username must be 3-24 chars (letters, numbers, ., _, -).');
    return;
  }
  if (password.length < 6) {
    setAuthNote('Password must be at least 6 characters.');
    return;
  }

  if (authMode === 'signup') {
    if (confirm !== password) {
      setAuthNote('Password confirmation does not match.');
      return;
    }
    if (findUserByKey(key)) {
      setAuthNote('Username already exists. Choose another one.');
      return;
    }

    const salt = randomSaltHex(16);
    const passwordHash = await hashPassword(password, salt);
    authStore.users.push({
      username,
      usernameKey: key,
      salt,
      passwordHash,
      createdAt: nowTs(),
    });
    authStore.currentUser = key;
    saveAuthStore();
    updateLoginUi();
    refreshWorkspaceForCurrentUser();
    closeAuthModal();
    return;
  }

  const user = findUserByKey(key);
  if (!user) {
    setAuthNote('Account not found. Sign up first.');
    return;
  }
  const passwordHash = await hashPassword(password, user.salt);
  if (passwordHash !== user.passwordHash) {
    setAuthNote('Invalid password.');
    return;
  }

  authStore.currentUser = user.usernameKey;
  saveAuthStore();
  updateLoginUi();
  refreshWorkspaceForCurrentUser();
  closeAuthModal();
}

function handleLogout() {
  authStore.currentUser = null;
  saveAuthStore();
  updateLoginUi();
  refreshWorkspaceForCurrentUser();
  closeAuthModal();
}

function sortChatsInPlace() {
  chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function findChatById(chatId) {
  const chat = chats.find((c) => c.id === chatId) || null;
  if (chat) ensureChatThreadState(chat);
  return chat;
}

function getActiveChat() {
  return findChatById(activeChatId);
}

function getGeneratedCodeCount() {
  return getCodeArtifacts().length;
}

function extractCanvasBlocksFromReply(text) {
  const payloads = [];
  const rawText = String(text || '');
  const stripJsonFences = (value) => String(value || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  // Parse NAME/FORMAT header lines from canvas body (e.g. "NAME: Title\nFORMAT: text\n---\ncontent")
  const parseCanvasBody = (body) => {
    const raw = String(body || '')
      .replace(/\[\[\s*CHAT_NAME\s*:\s*[^\]\n]{1,90}\s*\]\]\s*\n?/gi, '')
      .trim();
    if (!raw) return null;
    let name = '';
    let format = 'text';
    let content = raw;
    const lines = raw.split('\n');
    let headerEnd = 0;
    for (let i = 0; i < Math.min(lines.length, 4); i++) {
      const nameMatch = lines[i].match(/^NAME\s*:\s*(.+)$/i);
      const fmtMatch = lines[i].match(/^FORMAT\s*:\s*(\w+)$/i);
      const sepMatch = /^---+$/.test(lines[i].trim());
      if (nameMatch) { name = nameMatch[1].trim(); headerEnd = i + 1; }
      else if (fmtMatch) { format = fmtMatch[1].trim().toLowerCase() === 'code' ? 'code' : 'text'; headerEnd = i + 1; }
      else if (sepMatch) { headerEnd = i + 1; break; }
      else if (i > 0) break;
    }
    content = lines.slice(headerEnd).join('\n').trim() || raw;
    return { content, name, format };
  };
  let displayText = rawText;
  // Try JSON envelope first (kept as fallback in case a capable model uses it)
  displayText = displayText.replace(/<AIcanvasJSON>([\s\S]*?)<\/AIcanvasJSON>/gi, (_, body) => {
    const rawJson = stripJsonFences(body);
    if (!rawJson) return '\n';
    try {
      const parsed = JSON.parse(rawJson);
      const content = String((parsed && parsed.content) || '').trim();
      const name = String((parsed && parsed.name) || '').trim();
      const format = String((parsed && parsed.format) || '').trim().toLowerCase();
      if (content) {
        payloads.push({ content, name, format: (format === 'code' ? 'code' : 'text') });
      }
    } catch (_) { }
    return '\n';
  });
  // Strip <thinking> from display (kept in raw for debug, hidden from chat)
  displayText = displayText.replace(/<thinking>([\s\S]*?)<\/thinking>/gi, '');
  // Primary format: <AIcanvas title="..." type="..."> with optional NAME/FORMAT header lines
  displayText = displayText.replace(/<AIcanvas([^>]*)>([\s\S]*?)<\/AIcanvas>/gi, (_, attrs, body) => {
    const parsed = parseCanvasBody(body);
    if (!parsed) return '';
    // Extract title and type from tag attributes (override header if present)
    const titleMatch = String(attrs || '').match(/title="([^"]*)"/i);
    const typeMatch = String(attrs || '').match(/type="([^"]*)"/i);
    if (titleMatch && titleMatch[1].trim() && !parsed.name) parsed.name = titleMatch[1].trim();
    if (typeMatch && typeMatch[1].trim()) parsed.format = typeMatch[1].trim().toLowerCase() === 'code' ? 'code' : 'text';
    payloads.push(parsed);
    return '\n';
  });
  let safeDisplay = displayText
    .replace(/<\/?AIcanvasJSON[^>]*>/gi, '')
    .replace(/<\/?AIcanvas[^>]*>/gi, '')
    .replace(/<(?:\/)?AIcan[^>]*$/i, '');

  if (payloads.length === 0 && canvasModeEnabled) {
    const malformedCanvas = rawText.trim();
    if (/^(?:<canvas>|canvas\s*[>:])/i.test(malformedCanvas) || /<\/canvas>\s*$/i.test(malformedCanvas)) {
      const recovered = malformedCanvas
        .replace(/^<canvas>\s*/i, '')
        .replace(/^canvas\s*[>:]\s*/i, '')
        .replace(/<\/canvas>\s*$/i, '')
        .trim();
      if (recovered) {
        payloads.push({ content: recovered, name: '', format: 'text' });
        safeDisplay = '';
      }
    }
  }
  return {
    payloads,
    displayText: safeDisplay.replace(/\n{3,}/g, '\n\n').trim(),
  };
}

function hasNonEmptyCanvasPayload(text) {
  const parsed = extractCanvasBlocksFromReply(text);
  return Array.isArray(parsed.payloads) && parsed.payloads.length > 0;
}

function inferCanvasNameFromText(text) {
  const words = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
    .join(' ');
  return words ? words.replace(/[^\w\s.-]/g, '').trim() : 'Canvas Output';
}

function firstSentence(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const m = clean.match(/^(.+?[.!?])(?:\s|$)/);
  if (m && m[1]) return m[1].trim();
  return clean.length > 160 ? `${clean.slice(0, 160).trim()}...` : clean;
}

function sentenceCount(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 0;
  const parts = clean.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length;
}

function extractMetaLinesFromCanvasPayloads(payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return { intro: '', outro: '' };
  }
  const first = payloads[0];
  if (!first || String(first.format || 'text').toLowerCase() === 'code') {
    return { intro: '', outro: '' };
  }
  let intro = '';
  let outro = '';
  const content = String(first.content || '');
  const lines = content.split('\n');
  const nonEmpty = lines.map((line, idx) => ({ line: String(line || ''), idx }))
    .filter((item) => item.line.trim().length > 0);
  if (nonEmpty.length === 0) {
    return { intro: '', outro: '' };
  }

  const isMetaLine = (line) => {
    const t = String(line || '').trim();
    if (!t) return false;
    if (t.length > 140) return false;
    return /^(i('| a)m|i'll|i will|let me|creating|working on|all done|done|completed|created|want me|would you like|need another|need me)/i.test(t);
  };

  const firstLine = nonEmpty[0].line.trim();
  if (isMetaLine(firstLine)) {
    intro = firstLine;
    lines[nonEmpty[0].idx] = '';
  }

  const nowNonEmpty = lines.map((line, idx) => ({ line: String(line || ''), idx }))
    .filter((item) => item.line.trim().length > 0);
  if (nowNonEmpty.length > 0) {
    const lastLine = nowNonEmpty[nowNonEmpty.length - 1].line.trim();
    if (isMetaLine(lastLine) || /\?$/.test(lastLine)) {
      outro = lastLine;
      lines[nowNonEmpty[nowNonEmpty.length - 1].idx] = '';
    }
  }

  if (intro || outro) {
    first.content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return { intro, outro };
}

function buildCanvasChatSummary(displayText, payloads) {
  const firstPayload = Array.isArray(payloads) && payloads.length > 0 ? payloads[0] : null;
  const normalizeForCompare = (value) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const payloadBody = normalizeForCompare(firstPayload && firstPayload.content ? firstPayload.content : '');
  const rawDisplay = String(displayText || '')
    .split(/\n{2,}/)
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .filter((part) => {
      const normalized = normalizeForCompare(part);
      if (!normalized) return false;
      if (normalized.length < 80) return true;
      if (!payloadBody) return true;
      return !payloadBody.includes(normalized);
    })
    .join('\n\n')
    .trim();
  const canvasName = String(firstPayload && firstPayload.name ? firstPayload.name : '').trim();
  const type = String(firstPayload && firstPayload.format ? firstPayload.format : 'text').toLowerCase() === 'code' ? 'code' : 'canvas';
  const titleChunk = canvasName ? ` "${canvasName}"` : '';
  const fallback = type === 'code'
    ? `Code artifact${titleChunk} created.`
    : `Canvas artifact${titleChunk} created.`;

  if (!rawDisplay) {
    return { text: fallback, followUp: '' };
  }

  const parts = rawDisplay
    .split(/\n{2,}/)
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  if (parts.length > 1) {
    return {
      text: parts[0] || fallback,
      followUp: parts.slice(1).join('\n\n').trim(),
    };
  }

  return {
    text: rawDisplay || fallback,
    followUp: '',
  };
}

function extractCodeBlocksFromText(text) {
  const blocks = [];
  const raw = String(text || '');
  const re = /```([a-zA-Z0-9_+\-]*)\n?([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const language = String(match[1] || '').trim().toLowerCase();
    const content = String(match[2] || '').replace(/\n$/, '').trim();
    if (!content) continue;
    blocks.push({ language, content });
  }
  if (blocks.length > 0) return blocks;

  const extractImplicitBlock = () => {
    const htmlDocMatch =
      raw.match(/(?:^|\n)(?:html\s*\n+)?(<!DOCTYPE html[\s\S]*?<\/html>)/i)
      || raw.match(/(?:^|\n)(?:html\s*\n+)?(<html[\s\S]*?<\/html>)/i);
    if (htmlDocMatch && htmlDocMatch[1]) {
      return {
        language: 'html',
        content: String(htmlDocMatch[1] || '').trim(),
      };
    }

    const labeledMatch = raw.match(/(?:^|\n)(html|css|javascript|js|typescript|ts|jsx|tsx|python|py|json|sql|bash|sh|zsh)\s*\n+([\s\S]+)/i);
    if (!labeledMatch) return null;
    const language = String(labeledMatch[1] || '').trim().toLowerCase();
    const candidate = String(labeledMatch[2] || '');
    const lines = candidate.split('\n');
    const collected = [];
    let sawCode = false;
    let blankRun = 0;

    const isLikelyCodeLine = (line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return false;
      if (language === 'html') {
        return /^(<!DOCTYPE|<!--|<\/?[a-zA-Z][^>]*>|[a-zA-Z-]+="[^"]*"|[a-zA-Z-]+='[^']*')/.test(trimmed);
      }
      if (language === 'css') {
        return /^[.#@a-zA-Z][^{]*\{?$/.test(trimmed) || /^[a-z-]+\s*:\s*[^;]+;?$/.test(trimmed) || trimmed === '}';
      }
      if (['js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx'].includes(language)) {
        return /^(const|let|var|function|class|import|export|return|if\s*\(|for\s*\(|while\s*\(|document\.|window\.|async\s+function)/.test(trimmed)
          || /[;{}]$/.test(trimmed)
          || /^<\/?[A-Za-z]/.test(trimmed);
      }
      if (['py', 'python'].includes(language)) {
        return /^(def|class|import|from|if |elif |else:|for |while |return|print\(|@|[A-Za-z_][\w]*\s*=)/.test(trimmed)
          || trimmed.endsWith(':');
      }
      if (language === 'json') {
        return /^[\[{]/.test(trimmed) || /^[\]}],?$/.test(trimmed) || /^".*":/.test(trimmed);
      }
      if (language === 'sql') {
        return /^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH|FROM|WHERE|JOIN|ORDER BY|GROUP BY)/i.test(trimmed)
          || trimmed.endsWith(';');
      }
      if (['bash', 'sh', 'zsh'].includes(language)) {
        return /^(#!\/|[A-Za-z_][\w]*=|echo\b|if\b|for\b|while\b|case\b|function\b|npm\b|node\b|python\b|cd\b|ls\b|mkdir\b|rm\b|cp\b|mv\b)/.test(trimmed);
      }
      return false;
    };

    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!sawCode) {
        if (!trimmed) continue;
        if (!isLikelyCodeLine(line)) continue;
        sawCode = true;
        blankRun = 0;
        collected.push(line);
        continue;
      }
      if (!trimmed) {
        blankRun += 1;
        if (blankRun > 1) break;
        collected.push('');
        continue;
      }
      if (!isLikelyCodeLine(line)) break;
      blankRun = 0;
      collected.push(line);
    }

    const content = collected.join('\n').trim();
    if (!content) return null;
    return { language, content };
  };

  const implicitBlock = extractImplicitBlock();
  if (implicitBlock) {
    blocks.push(implicitBlock);
  }
  return blocks;
}

function estimateTextBytes(text) {
  const value = String(text || '');
  try {
    if (window.TextEncoder) {
      return new TextEncoder().encode(value).length;
    }
  } catch (_) { }
  return value.length;
}

function addCanvasArtifacts(chatId, payloads, messageTs = 0) {
  const added = [];
  if (!Array.isArray(payloads) || payloads.length === 0) return added;
  const sanitizeName = (value) => {
    let out = String(value || '').trim();
    if (!out) return '';
    out = out.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!out) return '';
    if (out.length > 64) out = `${out.slice(0, 64).trim()}...`;
    return out;
  };
  const makeUniqueName = (base) => {
    const wanted = sanitizeName(base) || '';
    if (!wanted) return '';
    const names = new Set(artifacts.map((item) => String(item && item.name ? item.name : '')));
    if (!names.has(wanted)) return wanted;
    let idx = 2;
    while (idx < 9999) {
      const next = `${wanted} (${idx})`;
      if (!names.has(next)) return next;
      idx += 1;
    }
    return `${wanted}-${nowTs()}`;
  };
  payloads.forEach((payload) => {
    const isObj = payload && typeof payload === 'object';
    const body = String(isObj ? payload.content : payload || '').trim();
    if (!body) return;
    const nextIndex = artifacts.length + 1;
    const rawName = isObj ? payload.name : '';
    const format = String(isObj ? payload.format : 'text').toLowerCase() === 'code' ? 'code' : 'text';
    const fallbackName = format === 'code' ? `canvas_code_${nextIndex}` : `canvas_text_${nextIndex}`;
    const name = makeUniqueName(rawName) || fallbackName;
    const content = body.slice(0, maxArtifactContentChars);
    const bytes = estimateTextBytes(body);
    artifacts.push({
      name,
      size: formatBytes(bytes),
      createdAt: nowTs(),
      type: 'canvas',
      chatId: String(chatId || ''),
      messageTs: Number(messageTs) || 0,
      canvasFormat: format,
      content,
      truncated: body.length > content.length,
    });
    added.push({ name, content });
  });
  saveArtifacts();
  renderArtifacts();
  if (added.length > 0) {
    const latest = added[added.length - 1];
    setCanvasPanelContent(latest.content, latest.name);
  }
  return added;
}

function addCodeArtifacts(chatId, text, messageTs = 0) {
  const chatKey = String(chatId || '');
  const ts = Number(messageTs) || 0;
  const blocks = extractCodeBlocksFromText(text);
  if (!chatKey || !ts || blocks.length === 0) return [];

  artifacts = artifacts.filter((item) => !(item && item.type === 'code' && String(item.chatId || '') === chatKey && Number(item.messageTs) === ts));

  const added = [];
  const extByLang = {
    js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts', jsx: 'jsx', tsx: 'tsx',
    py: 'py', python: 'py', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', c: 'c',
    cs: 'cs', java: 'java', go: 'go', rs: 'rs', rust: 'rs',
    php: 'php', rb: 'rb', ruby: 'rb', sh: 'sh', bash: 'sh', zsh: 'sh',
    sql: 'sql', html: 'html', css: 'css', json: 'json', yaml: 'yml', yml: 'yml',
    md: 'md', markdown: 'md',
  };

  blocks.forEach((block, index) => {
    const language = String(block.language || '').toLowerCase();
    const ext = extByLang[language] || 'txt';
    const nextIndex = artifacts.length + 1;
    const name = `code_${nextIndex}_${index + 1}.${ext}`;
    const body = String(block.content || '').trim();
    const content = body.slice(0, maxArtifactContentChars);
    artifacts.push({
      name,
      size: formatBytes(estimateTextBytes(body)),
      createdAt: nowTs(),
      type: 'code',
      chatId: chatKey,
      messageTs: ts,
      language,
      content,
      truncated: body.length > content.length,
    });
    added.push(name);
  });

  saveArtifacts();
  renderArtifacts();
  return added;
}

function commitAssistantMessage(chatId, text, rawTextForArtifacts = '', options = {}) {
  const sourceForArtifacts = String(rawTextForArtifacts || text || '');
  const thinkingState = buildThinkingState(sourceForArtifacts);
  const parsed = extractCanvasBlocksFromReply(sourceForArtifacts);
  // Only canvas-wrap plain text when this turn actually resolved to canvas;
  // a turn soft-routed to chat must display as chat.
  const canvasWrapAllowed = typeof options.canvasModeResolved === 'boolean'
    ? options.canvasModeResolved
    : canvasModeEnabled;
  if (canvasWrapAllowed && parsed.payloads.length === 0) {
    const fallbackBody = String(parsed.displayText || text || '').trim();
    if (fallbackBody) {
      parsed.payloads.push({
        content: fallbackBody,
        name: inferCanvasNameFromText(fallbackBody),
        format: 'text',
      });
      parsed.displayText = firstSentence(fallbackBody) || 'Canvas created. Open details below.';
    }
  }
  const hasCanvasPayload = parsed.payloads.length > 0;
  if (hasCanvasPayload && !String(parsed.displayText || '').trim()) {
    const lifted = extractMetaLinesFromCanvasPayloads(parsed.payloads);
    parsed.displayText = [lifted.intro, lifted.outro].filter(Boolean).join('\n\n').trim();
  }
  const canvasFollowMarker = '<<AIEXE_CANVAS_FOLLOWUP>>';
  const display = hasCanvasPayload
    ? (() => {
      const summary = buildCanvasChatSummary(parsed.displayText, parsed.payloads);
      const follow = String(summary.followUp || '').trim();
      return follow ? `${String(summary.text || '').trim()}\n${canvasFollowMarker}${follow}` : String(summary.text || '').trim();
    })()
    : String(text || parsed.displayText || '').trim();
  let appendedMessage = null;
  const showDisplayInChat = Boolean(display);
  const forceNeedsContinue = typeof options.forceNeedsContinue === 'boolean'
    ? options.forceNeedsContinue
    : undefined;
  if (showDisplayInChat) {
    appendedMessage = options.appendToLastAssistant && !hasCanvasPayload
      ? updateLastAssistantMessage(chatId, display, {
        forceNeedsContinue,
        thinking: thinkingState.text,
        thinkingMeta: options.thinkingMeta,
        agentActivities: options.agentActivities,
        agentMeta: options.agentMeta,
      })
      : appendMessageToChat(chatId, 'ai', display, 0, {
        forceNeedsContinue,
        thinking: thinkingState.text,
        thinkingMeta: options.thinkingMeta,
        agentActivities: options.agentActivities,
        agentMeta: options.agentMeta,
      });
  } else if (parsed.payloads.length > 0) {
    appendedMessage = appendMessageToChat(chatId, 'ai', 'Artifact created. Open details below.', 0, {
      forceNeedsContinue: false,
      thinking: thinkingState.text,
      thinkingMeta: options.thinkingMeta,
      agentActivities: options.agentActivities,
      agentMeta: options.agentMeta,
    });
  } else {
    appendedMessage = appendErrorMessageToChat(chatId, 'Offline inference backend returned empty output.', 0);
  }
  resolveChatNamingFallback(chatId, 'New Chat');
  const messageTs = appendedMessage ? Number(appendedMessage.ts) || nowTs() : nowTs();
  let addedAnyArtifacts = false;
  if (parsed.payloads.length > 0) {
    const addedCanvas = addCanvasArtifacts(chatId, parsed.payloads, messageTs);
    if (addedCanvas.length > 0) addedAnyArtifacts = true;
  }
  if (showDisplayInChat) {
    const addedCode = addCodeArtifacts(chatId, sourceForArtifacts, messageTs);
    if (addedCode.length > 0) addedAnyArtifacts = true;
  }
  if (addedAnyArtifacts) {
    renderSidebarCounts();
    if (activeChatId === chatId && !inNewChatMode) {
      renderActiveChat();
    }
  }
}

function renderSidebarCounts() {
  if (chatShell && typeof chatShell.renderSidebarCounts === 'function') {
    return chatShell.renderSidebarCounts();
  }
  return undefined;
}

function syncSidebarNavState() {
  if (chatShell && typeof chatShell.syncSidebarNavState === 'function') {
    return chatShell.syncSidebarNavState();
  }
  return undefined;
}

function formatHistoryTime(tsMillis) {
  const ts = Number(tsMillis) || Date.now();
  let deltaSec = Math.floor((Date.now() - ts) / 1000);
  if (!Number.isFinite(deltaSec) || deltaSec < 0) deltaSec = 0;
  if (deltaSec < 60) return 'now';

  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m`;

  const deltaHour = Math.floor(deltaMin / 60);
  if (deltaHour < 24) return `${deltaHour}h`;

  const deltaDay = Math.floor(deltaHour / 24);
  if (deltaDay < 30) return `${deltaDay}d`;

  const deltaMonth = Math.floor(deltaDay / 30);
  if (deltaMonth < 12) return `${deltaMonth}mo`;

  const deltaYear = Math.floor(deltaDay / 365);
  return `${Math.max(1, deltaYear)}y`;
}

function formatMessageClockTime(tsMillis) {
  const ts = Number(tsMillis) || Date.now();
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatMessageFullTime(tsMillis) {
  const ts = Number(tsMillis) || Date.now();
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function getRunningChatOperationToken() {
  const token = activeInferenceRequest;
  if (!token || token.cancelled || token.done || token.finalizing) return null;
  return token;
}

function isChatOperationRunning(chatId) {
  const token = getRunningChatOperationToken();
  return Boolean(token && String(token.chatId || '') === String(chatId || ''));
}

function isChatOperationVisibleHere(chatId) {
  return Boolean(
    !inNewChatMode
    && middleViewMode === 'chat'
    && String(activeChatId || '') === String(chatId || '')
  );
}

function ensureNotificationContainer() {
  if (notificationContainer && notificationContainer.isConnected) return notificationContainer;
  notificationContainer = document.createElement('div');
  notificationContainer.className = 'app-toast-stack';
  document.body.appendChild(notificationContainer);
  return notificationContainer;
}

function showAppNotification(options = {}) {
  const text = String(options.message || '').trim();
  if (!text) return null;
  const stack = ensureNotificationContainer();
  const kind = ['success', 'error', 'warning', 'info'].includes(String(options.kind || ''))
    ? String(options.kind)
    : 'info';
  const title = String(options.title || (
    kind === 'success' ? 'Success'
      : kind === 'error' ? 'Something went wrong'
        : kind === 'warning' ? 'Check this'
          : 'Notice'
  )).trim();
  const duration = Number.isFinite(Number(options.durationMs)) ? Math.max(1200, Number(options.durationMs)) : 4600;
  const toast = document.createElement('div');
  toast.className = `app-toast ${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  toast.innerHTML = `
    <div class="app-toast-icon" aria-hidden="true">${kind === 'success' ? '✓' : kind === 'error' ? '!' : kind === 'warning' ? '!' : 'i'}</div>
    <div class="app-toast-copy">
      <div class="app-toast-title">${escapeHtml(title)}</div>
      <div class="app-toast-body">${escapeHtml(text)}</div>
    </div>
    <button class="app-toast-close" type="button" aria-label="Close notification">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <path d="M18 6 6 18"></path>
        <path d="m6 6 12 12"></path>
      </svg>
    </button>
  `;
  let closeTimer = 0;
  const close = () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = 0;
    }
    if (!toast.isConnected) return;
    toast.classList.remove('open');
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 180);
  };
  const scheduleClose = (delay = duration) => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(close, delay);
  };
  const closeBtn = toast.querySelector('.app-toast-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      close();
    });
  }
  if (typeof options.onClick === 'function') {
    toast.classList.add('clickable');
    toast.addEventListener('click', (event) => {
      if (event.target && event.target.closest && event.target.closest('.app-toast-close')) return;
      options.onClick();
      close();
    });
  }
  toast.addEventListener('mouseenter', () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = 0;
    }
  });
  toast.addEventListener('mouseleave', () => scheduleClose(2200));
  toast.addEventListener('focusin', () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = 0;
    }
  });
  toast.addEventListener('focusout', () => scheduleClose(2200));
  stack.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add('open');
  });
  scheduleClose();
  return toast;
}

function showChatCompletionNotification(chatId, message) {
  const text = String(message || '').trim();
  if (!text) return;
  showAppNotification({
    title: 'Operation finished',
    message: text,
    kind: 'success',
    durationMs: 4800,
    onClick: () => {
      if (String(chatId || '').trim()) {
        loadHistory(String(chatId || '').trim());
      }
    },
  });
}

const chatShell = window.AIExeChatShell && typeof window.AIExeChatShell.createChatShell === 'function'
  ? window.AIExeChatShell.createChatShell({
    artifactCountEl,
    codeCountEl,
    newChatBtn,
    artifactsBtn,
    codeBtn,
    canvasEditor,
    chatArea,
    fileViewer,
    artifactBrowser,
    canvasDock,
    histList,
    mainInput,
    currentAuthUser,
    getBrowsableArtifacts,
    getGeneratedCodeCount,
    isInNewChatMode: () => inNewChatMode,
    setInNewChatMode: (value) => { inNewChatMode = Boolean(value); },
    getMiddleViewMode: () => middleViewMode,
    getArtifactListFilter: () => artifactListFilter,
    getActiveTabId: () => activeTabId,
    setActiveTabId: (value) => { activeTabId = value; },
    isCanvasDockOpen: () => canvasDockOpen,
    isCanvasModeEnabled: () => canvasModeEnabled,
    getChats: () => chats,
    getActiveChatId: () => activeChatId,
    setActiveChatId: (value) => { activeChatId = value; },
    formatHistoryTime,
    formatTimeAgo,
    isChatOperationRunning,
    isChatOperationVisibleHere,
    openChatActionModal,
    findChatById,
    ensureChatThreadState,
    enterChatView,
    persistActiveChatId,
    renderActiveChat,
    syncInputAugmentState,
    renderArtifactBrowser,
    renderTabBar,
    updateChatScrollDownButtonVisibility,
    ensureSignedIn,
    clearDebugTraceEntries,
    setCanvasMode,
    setDeveloperAgentMode,
    setThinkMode,
    setPendingManualContext: (value) => { pendingManualContext = String(value || ''); },
    setPendingNewChatAttachments: (value) => { pendingNewChatAttachments = Array.isArray(value) ? value : []; },
    clearPendingAttachments,
    pushDebugTrace,
  })
  : null;

const workspaceCore = window.AIExeWorkspaceCore && typeof window.AIExeWorkspaceCore.createWorkspaceCore === 'function'
  ? window.AIExeWorkspaceCore.createWorkspaceCore({
    getWorkspaceRootName: () => workspaceRootName,
    getWorkspaceSelectedPaths: () => workspaceSelectedPaths,
    getWorkspaceCurrentPath: () => workspaceCurrentPath,
    getWorkspaceCurrentKind: () => workspaceCurrentKind,
    getWorkspaceDragExpandTimers: () => workspaceDragExpandTimers,
    nativeBridge,
    applyRuntimeStatus,
    nowTs,
    formatBytes,
    getWorkspaceTreeState: () => workspaceTreeState,
    getWorkspaceRefreshTimer: () => workspaceRefreshTimer,
    setWorkspaceRefreshTimer: (value) => { workspaceRefreshTimer = Number(value) || 0; },
    setWorkspaceCurrentPath: (value) => { workspaceCurrentPath = value; },
    setWorkspaceCurrentKind: (value) => { workspaceCurrentKind = value; },
    saveWorkspaceState,
    updateWorkspaceHeaderUi,
    closeExplorerMenus,
    clearWorkspaceDrafts: () => {
      workspaceDraft = null;
      workspaceDraftFocusId = 0;
      workspaceRenameDraft = null;
      workspaceRenameFocusId = 0;
    },
    renderArtifacts,
    refreshWorkspaceTree: (...args) => refreshWorkspaceTree(...args),
    refreshOpenFileTabsFromWorkspace: (...args) => refreshOpenFileTabsFromWorkspace(...args),
  })
  : null;
const {
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
} = workspaceCore || {};
const workspaceActions = window.AIExeWorkspaceActions && typeof window.AIExeWorkspaceActions.createWorkspaceActions === 'function'
  ? window.AIExeWorkspaceActions.createWorkspaceActions({
    nowTs,
    ensureSignedIn,
    nativeBridge,
    workspaceImportInput,
    workspaceImportFolderInput,
    closeExplorerMenus,
    saveWorkspaceRootPath,
    getWorkspaceCurrentPath: () => workspaceCurrentPath,
    getWorkspaceCurrentKind: () => workspaceCurrentKind,
    setWorkspaceCurrentPath: (value) => { workspaceCurrentPath = normalizeWorkspacePath(value || '/'); },
    setWorkspaceCurrentKind: (value) => { workspaceCurrentKind = value === 'file' ? 'file' : 'folder'; },
    getWorkspaceRootName: () => workspaceRootName,
    setWorkspaceRootName: (value) => { workspaceRootName = String(value || ''); },
    getWorkspaceDraft: () => workspaceDraft,
    setWorkspaceDraft: (value) => { workspaceDraft = value; },
    getWorkspaceDraftFocusId: () => workspaceDraftFocusId,
    // IDs are strings (draft_…/rename_…); keep them as-is. Coercing with Number()
    // turned every id into 0, so the renderer's focus guard never matched and the
    // new-item name was never auto-focused/selected.
    setWorkspaceDraftFocusId: (value) => { workspaceDraftFocusId = value || 0; },
    getWorkspaceRenameDraft: () => workspaceRenameDraft,
    setWorkspaceRenameDraft: (value) => { workspaceRenameDraft = value; },
    getWorkspaceRenameFocusId: () => workspaceRenameFocusId,
    setWorkspaceRenameFocusId: (value) => { workspaceRenameFocusId = value || 0; },
    getWorkspaceSelectedPaths: () => workspaceSelectedPaths,
    getWorkspaceTreeState: () => workspaceTreeState,
    normalizeWorkspaceName,
    normalizeWorkspacePath,
    normalizeWorkspacePathList,
    joinWorkspacePath,
    joinWorkspaceRelativePath,
    parentWorkspacePath,
    workspaceBaseName,
    getSelectedWorkspacePathsForAction,
    clearWorkspaceDragExpandTimers,
    invokeWorkspaceAction,
    getWorkspaceNodeState,
    removeWorkspaceTreeEntry,
    loadWorkspaceChildren,
    setWorkspaceSelection,
    renderArtifacts: (...args) => renderArtifacts(...args),
    removeWorkspaceTab: (...args) => removeWorkspaceTab(...args),
    closeAllWorkspaceTabs: (...args) => closeAllWorkspaceTabs(...args),
    setWorkspaceItems: (value) => { workspaceItems = Array.isArray(value) ? value : []; },
    recordDebugTrace,
    getWorkspaceDebugSnapshot,
    applyWorkspaceStatusSnapshot,
  })
  : null;
const workspaceRenderer = window.AIExeWorkspaceRenderer && typeof window.AIExeWorkspaceRenderer.createWorkspaceRenderer === 'function'
  ? window.AIExeWorkspaceRenderer.createWorkspaceRenderer({
    nativeBridge,
    currentAuthUser,
    workspacePathLabel,
    workspaceBackBtn,
    expCloseProjectBtn,
    expDeleteSelectedBtn,
    emptyFolder,
    folderArea,
    getWorkspaceCurrentPath: () => workspaceCurrentPath,
    getWorkspaceCurrentKind: () => workspaceCurrentKind,
    getWorkspaceSelectedPaths: () => workspaceSelectedPaths,
    getSelectedWorkspacePathsForAction,
    getWorkspaceRootName: () => workspaceRootName,
    getWorkspaceRootPath: () => workspaceRootPath,
    getWorkspaceDraft: () => workspaceDraft,
    setWorkspaceDraft: (value) => { workspaceDraft = value; },
    getWorkspaceDraftFocusId: () => workspaceDraftFocusId,
    setWorkspaceDraftFocusId: (value) => { workspaceDraftFocusId = value; },
    getWorkspaceRenameDraft: () => workspaceRenameDraft,
    setWorkspaceRenameDraft: (value) => { workspaceRenameDraft = value; },
    getWorkspaceRenameFocusId: () => workspaceRenameFocusId,
    setWorkspaceRenameFocusId: (value) => { workspaceRenameFocusId = value; },
    getWorkspaceRenderToken: () => workspaceRenderToken,
    nextWorkspaceRenderToken: () => {
      workspaceRenderToken += 1;
      return workspaceRenderToken;
    },
    setWorkspaceItems: (value) => { workspaceItems = Array.isArray(value) ? value : []; },
    normalizeWorkspacePath,
    parentWorkspacePath,
    normalizeWorkspacePathList,
    getWorkspaceNodeState,
    loadWorkspaceChildren,
    setWorkspaceSelection,
    clearWorkspaceDragExpandTimers,
    getWorkspaceDragExpandTimers: () => workspaceDragExpandTimers,
    getDroppedFileSystemEntries: (...args) => getDroppedFileSystemEntries(...args),
    uploadDroppedDataTransfer: (...args) => uploadDroppedDataTransfer(...args),
    parseDraggedWorkspacePaths: (...args) => parseDraggedWorkspacePaths(...args),
    moveWorkspaceEntries: (...args) => moveWorkspaceEntries(...args),
    openFileTab,
    startWorkspaceRenamePath: (...args) => startWorkspaceRenamePath(...args),
    commitWorkspaceRenameDraft: (...args) => commitWorkspaceRenameDraft(...args),
    cancelWorkspaceRenameDraft: (...args) => cancelWorkspaceRenameDraft(...args),
    commitWorkspaceDraft: (...args) => commitWorkspaceDraft(...args),
    cancelWorkspaceDraft: (...args) => cancelWorkspaceDraft(...args),
  })
  : null;
const chatRenderer = window.AIExeChatRenderer && typeof window.AIExeChatRenderer.createChatRenderer === 'function'
  ? window.AIExeChatRenderer.createChatRenderer({
    normalizeWorkspacePath,
    nowTs,
    getActiveAgentStreamState: () => activeAgentStreamState,
    setActiveAgentStreamState: (value) => { activeAgentStreamState = value || null; },
    getWorkspaceRootName: () => workspaceRootName,
    describeAgentToolTarget: (...args) => (typeof describeAgentToolTarget === 'function' ? describeAgentToolTarget(...args) : ''),
    describeAgentToolPhase: (...args) => (typeof describeAgentToolPhase === 'function' ? describeAgentToolPhase(...args) : ''),
    guessWorkspaceTargetKind,
    isLikelyNewAgentFileTarget: (...args) => (typeof isLikelyNewAgentFileTarget === 'function' ? isLikelyNewAgentFileTarget(...args) : false),
    setWorkspaceSelection,
    openFileTab,
    workspaceBaseName,
    revealWorkspaceFileLine: (startLine, endLine, kind) => {
      if (!fileViewerApi || typeof fileViewerApi.selectFileViewerLine !== 'function') return;
      // The CodeMirror editor mounts asynchronously after a file opens; retry on a
      // short backoff until selectFileViewerLine reports it applied (CM ready).
      // startLine<=0 clears any highlight (a plain open should show nothing).
      const delays = [0, 60, 150, 300, 600, 1000];
      let attempt = 0;
      const tryReveal = () => {
        let ok = false;
        try {
          ok = fileViewerApi.selectFileViewerLine(startLine, {
            endLine: endLine || startLine, kind: kind || 'read', reveal: true,
          }) === true;
        } catch (_) {}
        if (ok || attempt >= delays.length - 1) {
          recordDebugTrace('reveal_file_line_applied', { line: String(startLine), endLine: String(endLine || ''), kind: String(kind || ''), ok: String(ok), attempt: String(attempt) });
          return;
        }
        attempt += 1;
        window.setTimeout(tryReveal, delays[attempt]);
      };
      window.setTimeout(tryReveal, delays[0]);
    },
    getWorkspaceNodeState,
    renderArtifacts: (...args) => renderArtifacts(...args),
    updateAssistantAgentMeta,
    revertAgentMessageEdits,
    renderMarkdownHtml,
    attachCodeCopyButtons,
    getArtifactsForMessage,
    makeArtifactKey,
    openArtifactDetail,
    escapeHtml,
    isEditingUserMessage,
    getEditingMessageState: () => editingMessageState,
    autoResizeInlineMessageEditor,
    updateEditingMessageDraft,
    cancelMessageEditMode,
    saveEditedUserMessage,
    applyCustomTooltip,
    makeMessageActionIcon,
    formatMessageClockTime,
    formatMessageFullTime,
    copyTextToClipboard,
    applyCopyFeedback,
    pushDebugTrace,
    buildBranchNavigator,
    editUserMessage,
    isRetryableAssistantMessage,
    retryAssistantMessage,
    findFallbackRetryAnchorTs,
    renderSidebarCounts,
    getChatArea: () => chatArea,
    currentAuthUser,
    setLastRenderedChatId: (value) => { lastRenderedChatId = String(value || ''); },
    getLastRenderedChatId: () => lastRenderedChatId,
    setCanvasMode,
    setDeveloperAgentMode,
    setThinkMode,
    setPendingManualContext: (value) => { pendingManualContext = String(value || ''); },
    setPendingAttachments: (value) => { pendingAttachments = normalizePendingAttachmentList(value); },
    setPendingNewChatAttachments: (value) => { pendingNewChatAttachments = normalizePendingAttachmentList(value); },
    getPendingNewChatAttachments: () => pendingNewChatAttachments,
    normalizePendingAttachmentList,
    emptyStateTemplate,
    setCanvasPanelContent,
    updateContinueButtonVisibility,
    updateChatScrollDownButtonVisibility,
    syncInputAugmentState,
    renderMiddleView,
    syncLiveInferenceUiState,
    getPendingPreflightConfirmation,
    submitPendingPreflightChoice,
    isInNewChatMode: () => inNewChatMode,
    getActiveChat,
    getChatAutoScrollPinned: () => chatAutoScrollPinned,
    scrollChatToBottom,
    restoreChatScrollPosition,
    getScrollBottomDistance,
    syncCanvasPanelFromArtifacts,
  })
  : null;
const chatRendererApi = chatRenderer || {};
const fileViewerModule = window.AIExeFileViewer && typeof window.AIExeFileViewer.createFileViewer === 'function'
  ? window.AIExeFileViewer.createFileViewer({
    normalizeWorkspacePath,
    workspaceBaseName,
    normalizeCodeLanguage,
    highlightCodeHtml,
    getOpenFileTabs: () => openFileTabs,
    setOpenFileTabs: (value) => { openFileTabs = Array.isArray(value) ? value : []; },
    getActiveTabId: () => activeTabId,
    setActiveTabId: (value) => { activeTabId = String(value || 'chat'); },
    getFileTabsPersistTimer: () => fileTabsPersistTimer,
    setFileTabsPersistTimer: (value) => { fileTabsPersistTimer = Number(value) || 0; },
    getFileTabsRestoreToken: () => fileTabsRestoreToken,
    getFileViewerSearchState: () => fileViewerSearchState,
    setFileViewerSearchState: (value) => {
      fileViewerSearchState = value && typeof value === 'object'
        ? value
        : { query: '', matches: [], index: -1 };
    },
    getFileViewerCodeMirror: () => fileViewerCodeMirror,
    setFileViewerCodeMirror: (value) => { fileViewerCodeMirror = value || null; },
    getSuppressFileViewerEditorChange: () => suppressFileViewerEditorChange,
    setSuppressFileViewerEditorChange: (value) => { suppressFileViewerEditorChange = Boolean(value); },
    getFileViewerCodeMirrorReady: () => fileViewerCodeMirrorReady,
    setFileViewerCodeMirrorReady: (value) => { fileViewerCodeMirrorReady = value || null; },
    getFileViewerHighlightCode: () => fileViewerHighlightCode,
    getFileViewerCmHost: () => fileViewerCmHost,
    getFileViewerGutterLines: () => fileViewerGutterLines,
    getFileViewerEditor: () => fileViewerEditor,
    getFileViewerCurrentLine: () => fileViewerCurrentLine,
    getFileViewerSearchCount: () => fileViewerSearchCount,
    getFileViewerSearchInput: () => fileViewerSearchInput,
    getFileViewerSearch: () => fileViewerSearch,
    getFileViewerHighlight: () => fileViewerHighlight,
    getFileViewerFilename: () => fvFilename,
    getFileViewerSurface: () => fileViewerSurface,
    getMiddleTabBar: () => middleTabBar,
    getTabChatEl: () => tabChatEl,
    getChatArea: () => chatArea,
    getFileViewer: () => fileViewer,
    getArtifactBrowser: () => artifactBrowser,
    fileViewerLineTopPadding: FILE_VIEWER_LINE_TOP_PADDING,
    fileViewerHighlightLimitBytes: FILE_VIEWER_HIGHLIGHT_LIMIT_BYTES,
    invokeWorkspaceAction,
    scopedStorageKey,
    fileTabsStoragePrefix,
    setMiddleViewMode: (value) => { middleViewMode = String(value || 'chat'); },
    renderMiddleView,
  })
  : null;
const fileViewerApi = fileViewerModule || {};
const markdownRenderer = window.AIExeMarkdownRenderer && typeof window.AIExeMarkdownRenderer.createMarkdownRenderer === 'function'
  ? window.AIExeMarkdownRenderer.createMarkdownRenderer({
    applyCustomTooltip,
    copyTextToClipboard,
    applyCopyFeedback,
  })
  : null;
const markdownRendererApi = markdownRenderer || {};

const promptCore = window.AIExePromptCore && typeof window.AIExePromptCore.createPromptCore === 'function'
  ? window.AIExePromptCore.createPromptCore({
    findChatById,
    currentAuthUser,
    normalizeUsername,
    isCanvasModeEnabled: () => canvasModeEnabled,
    isThinkModeEnabled: () => thinkModeEnabled,
    isAgentModeEnabled: () => developerAgentEnabled,
    getUncensoredEscalationInstruction,
    shouldInlineNameChatResponse,
  })
  : null;
const promptCoreApi = promptCore || {};
const agentDecisionGrammar = String(promptCoreApi.agentDecisionGrammar || '');
const agentPlanGrammar = String(promptCoreApi.agentPlanGrammar || '');

function getWorkspaceContext() {
  const rootNode = workspaceTreeState.get('/') || null;
  const rootEntries = rootNode && Array.isArray(rootNode.children)
    ? rootNode.children.slice(0, 60).map((entry) => ({
      kind: String(entry && entry.kind ? entry.kind : ''),
      path: normalizeWorkspacePath(entry && entry.path ? entry.path : ''),
      name: String(entry && entry.name ? entry.name : ''),
      childCount: Number(entry && entry.childCount) || 0,
      sizeBytes: Number(entry && entry.sizeBytes) || 0,
    }))
    : [];
  const rootEntryCount = rootNode && Array.isArray(rootNode.children)
    ? rootNode.children.length
    : 0;
  return {
    workspaceRootName: String(workspaceRootName || ''),
    currentPath: normalizeWorkspacePath(workspaceCurrentPath || '/'),
    currentKind: workspaceCurrentKind === 'file' ? 'file' : 'folder',
    selectedPaths: Array.from(workspaceSelectedPaths || []),
    rootLoaded: Boolean(rootNode && rootNode.loaded),
    rootEntryCount,
    rootEntries,
  };
}

function getWorkspaceStateComparison() {
  const debugSnapshot = getWorkspaceDebugSnapshot();
  const contextSnapshot = getWorkspaceContext();
  return {
    debugSnapshot,
    contextSnapshot,
    derived: {
      debugWorkspaceOpen: Boolean(
        String(debugSnapshot.workspaceRootName || '').trim()
        || Number(debugSnapshot.rootEntryCount) > 0
        || Boolean(debugSnapshot.rootLoaded)
        || normalizeWorkspacePath(debugSnapshot.currentPath || '/') !== '/'
      ),
      contextWorkspaceOpen: Boolean(
        String(contextSnapshot.workspaceRootName || '').trim()
        || Number(contextSnapshot.rootEntryCount) > 0
        || Boolean(contextSnapshot.rootLoaded)
        || normalizeWorkspacePath(contextSnapshot.currentPath || '/') !== '/'
      ),
    },
  };
}

async function requestWorkspaceStatusSnapshot() {
  try {
    const statusRes = await invokeWorkspaceAction('status', {});
    const status = statusRes && statusRes.status && typeof statusRes.status === 'object'
      ? statusRes.status
      : {};
    const rootPath = String(status.rootPath || '').trim();
    const rootName = rootPath ? rootPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '' : '';
    return {
      ok: Boolean(statusRes && statusRes.ok),
      rootPath,
      rootName,
      currentPath: normalizeWorkspacePath(status.currentPath || '/'),
      currentKind: status.currentKind === 'file' ? 'file' : 'folder',
      modelLoaded: Boolean(status.modelLoaded),
      backendReady: Boolean(status.backendReady),
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err && err.message ? err.message : err || 'workspaceStatus failed'),
    };
  }
}

function applyWorkspaceStatusSnapshot(statusSnapshot, options = {}) {
  const snapshot = statusSnapshot && typeof statusSnapshot === 'object' ? statusSnapshot : {};
  const rootPath = String(snapshot.rootPath || '').trim();
  const derivedRootName = rootPath ? rootPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '' : '';
  const canonicalRootName = String(snapshot.rootName || derivedRootName || '').trim();
  const hasRoot = Boolean(String(canonicalRootName || rootPath).trim());
  const nextPath = normalizeWorkspacePath(snapshot.currentPath || '/');
  const rootChanged = String(workspaceRootName || '').trim() !== (hasRoot ? canonicalRootName : '');
  // Background/focus polls report only native's cwd, not the user's explorer
  // selection. Adopting it here was clearing the selection every 2.5s — which
  // is why Delete reported "nothing selected" moments after a click. On those
  // syncs (preserveSelection) keep whatever the user has selected.
  const preserveSelection = Boolean(options.preserveSelection) && hasRoot && !rootChanged;
  const priorCurrentPath = normalizeWorkspacePath(workspaceCurrentPath || '/');
  const priorCurrentKind = workspaceCurrentKind === 'file' ? 'file' : 'folder';
  const priorSelectedPaths = Array.from(workspaceSelectedPaths || []);
  workspaceRootName = hasRoot ? canonicalRootName : '';
  // Absolute path of the OPEN workspace (for drag-to-browser file:// URLs); empty when closed.
  workspaceRootPath = hasRoot ? rootPath.replace(/[/\\]+$/, '') : '';
  workspaceCurrentPath = preserveSelection ? priorCurrentPath : (hasRoot ? nextPath : '/');
  workspaceCurrentKind = preserveSelection
    ? priorCurrentKind
    : (snapshot.currentKind === 'file' && hasRoot ? 'file' : 'folder');
  if (!hasRoot) {
    workspaceItems = [];
    const expandedPaths = new Set();
    workspaceTreeState.forEach((node, path) => {
      if (node && node.expanded) expandedPaths.add(normalizeWorkspacePath(path));
    });
    workspaceTreeState.clear();
    const freshRoot = getWorkspaceNodeState('/');
    freshRoot.expanded = true;
    freshRoot.loaded = false;
    expandedPaths.forEach((path) => {
      if (path && path !== '/') getWorkspaceNodeState(path).expanded = true;
    });
    workspaceSelectedPaths.clear();
    workspaceSelectedPaths.add('/');
    saveWorkspaceRootPath('');
  } else {
    if (rootChanged) {
      workspaceTreeState.clear();
      const freshRoot = getWorkspaceNodeState('/');
      freshRoot.expanded = true;
      freshRoot.loaded = false;
      workspaceItems = [];
    }
    if (preserveSelection) {
      workspaceSelectedPaths.clear();
      priorSelectedPaths.forEach((path) => workspaceSelectedPaths.add(normalizeWorkspacePath(path)));
      if (!workspaceSelectedPaths.size) workspaceSelectedPaths.add(workspaceCurrentPath || '/');
    } else {
      workspaceSelectedPaths.clear();
      workspaceSelectedPaths.add(workspaceCurrentPath || '/');
    }
    if (options.persistRootPath !== false) {
      saveWorkspaceRootPath(rootPath);
    }
  }
}

let workspaceSyncPromise = null;
let workspaceExternalRefreshPromise = null;
let workspaceExternalRefreshTimer = 0;
// Keep JS workspace state aligned with the native workspace root override.
async function syncWorkspaceStateFromNative(reason = 'manual', options = {}) {
  if (!nativeBridge.available()) return null;
  if (workspaceSyncPromise) return workspaceSyncPromise;
  workspaceSyncPromise = (async () => {
    const before = getWorkspaceStateComparison();
    const snapshot = await requestWorkspaceStatusSnapshot();
    applyWorkspaceStatusSnapshot(snapshot, options);
    const after = getWorkspaceStateComparison();
    if (options.log !== false) {
      recordDebugTrace('workspace_state_synced', {
        reason: String(reason || 'manual'),
        workspaceOpen: String(Boolean(after && after.derived && after.derived.contextWorkspaceOpen)),
        workspaceRootName: debugPreview(String((after && after.contextSnapshot && after.contextSnapshot.workspaceRootName) || ''), 120),
        workspaceCurrentPath: String((after && after.contextSnapshot && after.contextSnapshot.currentPath) || '/'),
        workspaceRootEntryCount: String(Number(after && after.contextSnapshot && after.contextSnapshot.rootEntryCount) || 0),
      }, {
        reason: String(reason || 'manual'),
        statusSnapshot: snapshot,
        before,
        after,
      });
    }
    if (options.render !== false) {
      await renderArtifacts();
    }
    return snapshot;
  })();
  try {
    return await workspaceSyncPromise;
  } finally {
    workspaceSyncPromise = null;
  }
}

// Lightweight fingerprint of every folder that is currently loaded in the tree.
// We fold in each child's kind/name/size/mtime so the signature changes whenever
// a file or folder is added, removed, renamed, moved, or edited on disk.
function workspaceTreeChangeSignature() {
  const parts = [];
  Array.from(workspaceTreeState.values())
    .filter((node) => node && node.loaded)
    .sort((a, b) => String(a.path).localeCompare(String(b.path)))
    .forEach((node) => {
      const childSig = (node.children || [])
        .map((child) => `${child.kind}:${child.name}:${child.sizeBytes || 0}:${child.updatedAt || 0}`)
        .sort()
        .join('|');
      parts.push(`${node.path}=>${childSig}`);
    });
  return parts.join('\n');
}

async function refreshWorkspaceFromExternalChange(reason = 'external_change') {
  if (!nativeBridge.available() || document.hidden || !String(workspaceRootName || '').trim()) return null;
  if (workspaceDraft || workspaceRenameDraft) return null;
  if (workspaceExternalRefreshPromise) return workspaceExternalRefreshPromise;
  workspaceExternalRefreshPromise = (async () => {
    await syncWorkspaceStateFromNative(reason, { render: false, log: false, preserveSelection: true });
    if (!String(workspaceRootName || '').trim()) {
      closeAllWorkspaceTabs();
      await renderArtifacts();
      return null;
    }
    // Re-list folders in place instead of clearing the whole tree. Because we
    // never wipe node state, every folder the user expanded stays expanded —
    // and we only re-render when the on-disk listing actually changed, which
    // removes the constant collapse/flicker the blind 2.5s poll used to cause.
    const loadedPaths = Array.from(workspaceTreeState.values())
      .filter((node) => node && node.loaded)
      .map((node) => node.path);
    if (!loadedPaths.length) {
      getWorkspaceNodeState('/').expanded = true;
      loadedPaths.push('/');
    }
    const before = workspaceTreeChangeSignature();
    for (const path of loadedPaths) {
      if (!workspaceTreeState.get(path)) continue;
      await loadWorkspaceChildren(path, true);
    }
    if (workspaceTreeChangeSignature() !== before) {
      await renderArtifacts();
    }
    await refreshOpenFileTabsFromWorkspace();
    return null;
  })();
  try {
    return await workspaceExternalRefreshPromise;
  } finally {
    workspaceExternalRefreshPromise = null;
  }
}

function startWorkspaceExternalRefreshLoop() {
  if (workspaceExternalRefreshTimer) return;
  workspaceExternalRefreshTimer = window.setInterval(() => {
    if (!document.hidden && String(workspaceRootName || '').trim()) {
      void refreshWorkspaceFromExternalChange('background_poll');
    }
  }, 2500);
}

function normalizeWorkspaceTurnModeDecision(text) {
  const lower = String(text || '').trim().toLowerCase();
  if (!lower) return '';
  if (/\bagent\b/.test(lower)) return 'agent';
  if (/\binspect\b/.test(lower)) return 'inspect';
  if (/\bchat\b/.test(lower)) return 'chat';
  return '';
}

function resetWorkspaceForNewProject() {
  workspaceTreeState.clear();
  workspaceItems = [];
  workspaceSelectedPaths.clear();
  workspaceCurrentPath = '/';
  workspaceCurrentKind = 'folder';
  artifactDetailKey = '';
  workspaceDraft = null;
  workspaceRenameDraft = null;
  workspaceDraftFocusId = 0;
  workspaceRenameFocusId = 0;
  saveWorkspaceState();
}

function isLikelyNewAgentFileTarget(toolEvents = [], path = '') {
  const normalized = normalizeWorkspacePath(path || '');
  if (!normalized || normalized === '/') return false;
  return !Array.isArray(toolEvents) || !toolEvents.some((event) => (
    event
    && event.ok
    && normalizeWorkspacePath(event.path || '') === normalized
    && ['write_file', 'edit_file', 'read_file'].includes(String(event.tool || '').toLowerCase())
  ));
}

function syncMovedFileTab(srcPath, dstPath) {
  const src = normalizeWorkspacePath(srcPath || '');
  const dst = normalizeWorkspacePath(dstPath || '');
  if (!src || !dst || src === dst) return;
  let touched = false;
  openFileTabs = (openFileTabs || []).map((tab) => {
    if (!tab || !tab.path) return tab;
    const current = normalizeWorkspacePath(tab.path);
    if (current !== src && !current.startsWith(`${src}/`)) return tab;
    touched = true;
    const nextPath = current === src ? dst : normalizeWorkspacePath(`${dst}${current.slice(src.length)}`);
    return {
      ...tab,
      path: nextPath,
      name: workspaceBaseName(nextPath) || tab.name,
    };
  });
  if (!touched) return;
  if (String(activeTabId || '') === src || String(activeTabId || '').startsWith(`${src}/`)) {
    activeTabId = String(activeTabId || '') === src
      ? dst
      : normalizeWorkspacePath(`${dst}${String(activeTabId || '').slice(src.length)}`);
  }
  persistFileTabsStateNow();
  renderTabBar();
}

function removeWorkspaceTab(path) {
  const normalized = normalizeWorkspacePath(path || '');
  if (!normalized || normalized === '/') return;
  const beforeCount = openFileTabs.length;
  openFileTabs = (openFileTabs || []).filter((tab) => {
    const current = normalizeWorkspacePath(tab && tab.path ? tab.path : '');
    return current !== normalized && !current.startsWith(`${normalized}/`);
  });
  if (openFileTabs.length === beforeCount) return;
  let activeRemoved = false;
  if (String(activeTabId || '') === normalized || String(activeTabId || '').startsWith(`${normalized}/`)) {
    activeTabId = 'chat';
    activeRemoved = true;
  }
  persistFileTabsStateNow();
  renderTabBar();
  if (activeRemoved) switchToTab('chat');
}

function closeAllWorkspaceTabs() {
  if (!Array.isArray(openFileTabs) || openFileTabs.length === 0) {
    if (activeTabId !== 'chat') switchToTab('chat');
    return;
  }
  openFileTabs = [];
  activeTabId = 'chat';
  persistFileTabsStateNow();
  renderTabBar();
  switchToTab('chat');
}

const agentCore = window.AIExeAgentCore && typeof window.AIExeAgentCore.createAgentCore === 'function'
  ? window.AIExeAgentCore.createAgentCore({
    normalizeWorkspaceName,
    normalizeWorkspacePath,
    getWorkspaceContext,
    getActiveChatId: () => activeChatId,
    chatHasPriorAgentWorkspaceWork,
    looksLikePlaceholderImplementation: (content) => /\b(todo:|coming soon|implement this|placeholder code|placeholder content)\b/i.test(String(content || '')),
  })
  : null;
const {
  deriveProjectNameFromTask,
  isAgentTaskGameLike,
  isAgentTaskSoftwareProject,
  isAgentTaskPythonRelated,
  hasReadmeRunInstructions,
  isLikelyCompleteReadme,
  isAgentBudgetTrackerTask,
  isAgentGeneratedContentTarget,
  buildAgentFileGenerationHints,
  isLikelyCompletePythonGameSource,
  parseAgentDecision,
  deriveFallbackAgentDecision,
  parseAgentEditProgram,
  applyAgentEditProgram,
  computeAgentChecklistProgress,
  renderAgentChecklist,
  parseAgentPlanPhases,
  buildAgentPlanMarkdown,
  parseAgentPlanMarkdown,
  firstUnfinishedPhaseIndex,
  buildFallbackExpectedFiles,
  shouldFallbackPlanNeedReadme,
  isExplicitReadmeOrDocsTask,
  isDocsOnlyTask,
  isExistingProjectMutationRequest,
  normalizeAgentPlanSpec,
  buildFallbackAgentPlanSpec,
} = agentCore || {};

async function requestNativeAgentPlannerInference(prompt, maxTokens, grammar = '') {
  if (!nativeBridge.available()) {
    return { ok: false, message: 'Native runtime bridge unavailable.' };
  }
  const payload = {
    prompt: String(prompt || ''),
    maxTokens: Number(maxTokens) || agentDecisionMaxTokens,
    max_tokens: Number(maxTokens) || agentDecisionMaxTokens,
  };
  if (String(grammar || '').trim()) {
    payload.grammar = String(grammar);
  }
  const res = await nativeBridge.invoke('infer', payload);
  const plannerModel = String((res && res.model) || appSettings.modelUrl || '').trim();
  return res
    ? { ...res, model: plannerModel }
    : { ok: false, message: 'No planner response from native runtime.', model: plannerModel };
}

async function requestAgentPlannerInference(prompt, maxTokens, grammar = '', systemPrompt = '') {
  noteAgentInferenceStart(String(prompt || '').length + String(systemPrompt || '').length);
  let result = null;
  try {
    result = await requestAgentPlannerInferenceInner(prompt, maxTokens, grammar, systemPrompt);
  } finally {
    noteAgentInferenceEnd(result && result.ok ? String(result.output || '').length : 0);
  }
  return result;
}

async function requestAgentPlannerInferenceInner(prompt, maxTokens, grammar = '', systemPrompt = '') {
  if (agentRuntime && typeof agentRuntime.requestExternalAgentPlanner === 'function') {
    const external = await agentRuntime.requestExternalAgentPlanner(prompt, maxTokens);
    if (external && external.ok) {
      return {
        ...external,
        model: String((external && external.model) || '').trim(),
      };
    }
  }
  const remoteProvider = isRemoteInferenceProviderEnabled() ? getSelectedInferenceProvider() : null;
  if (remoteProvider) {
    let remote = await requestSelectedRemoteTextCompletion(prompt, maxTokens, systemPrompt);
    // Only retry for transient failures (rate limit / network). Skip retry for auth/credits errors.
    const hardFail = remote && !remote.ok && remote.httpStatus && (remote.httpStatus === 401 || remote.httpStatus === 402 || remote.httpStatus === 403);
    if (remote && remote.cancelled) return { ok: false, cancelled: true, message: 'Cancelled.' };
    if ((!remote || !remote.ok) && !hardFail) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      remote = await requestSelectedRemoteTextCompletion(prompt, maxTokens, systemPrompt);
    }
    if (remote && remote.ok) {
      return {
        ok: true,
        output: String(remote.output || ''),
        model: String((remote && remote.model) || getProviderModel(remoteProvider) || '').trim(),
      };
    }
    const remoteMsg = (remote && remote.message) || `${remoteProvider} API unavailable — check your connection.`;
    // Propagate hard failures (credits/key) so the caller can stop, not degrade.
    return { ok: false, message: remoteMsg, httpStatus: (remote && remote.httpStatus) || 0, hardFail: Boolean(hardFail) };
  }
  return requestNativeAgentPlannerInference(prompt, maxTokens, grammar);
}

const agentPlanner = window.AIExeAgentPlanner && typeof window.AIExeAgentPlanner.createAgentPlanner === 'function'
  ? window.AIExeAgentPlanner.createAgentPlanner({
    normalizeWorkspacePath,
    isAgentTaskGameLike,
    hasReadmeRunInstructions,
    isLikelyCompleteReadme,
    isExplicitReadmeOrDocsTask,
    isDocsOnlyTask,
    buildFallbackAgentPlanSpec,
    buildAgentFileGenerationHints,
    loadPromptTemplate,
    renderPromptTemplate,
    buildAgentHistoryTranscript: (...args) => {
      const base = promptCoreApi.buildAgentHistoryTranscript ? promptCoreApi.buildAgentHistoryTranscript(...args) : '';
      // Surface user revert/re-apply events so the agent knows why current files
      // differ from its earlier responses.
      const notes = getAgentWorkspaceNotesText(args[0]);
      if (!notes) return base;
      return base ? `${base}\n\n${notes}` : notes;
    },
    requestAgentPlannerInference,
    getWorkspaceContext,
    deriveProjectNameFromTask,
    agentMaxSteps,
    agentMaxToolOutputChars,
    getAgentExpandedReadChars,
    agentDecisionMaxTokens,
    agentPlanGrammar,
    agentStepTimeoutMs,
    isLikelyCompletePythonGameSource,
    normalizeAgentPlanSpec,
  })
  : null;
const {
  isLikelyCompletePrimarySource,
  getLatestSuccessfulAgentSourceWrite,
  getLatestSuccessfulAgentWrite,
  hasSuccessfulAgentTool,
  buildAgentTaskRequirements,
  summarizeAgentPendingRequirements,
  validateAgentFinalDecision,
  buildAgentDecisionRepairPrompt,
  sanitizeAgentGeneratedFileContent,
  sanitizeAgentGeneratedEditProgram,
  buildAgentWriteFileContentPrompt,
  buildAgentEditFileContentPrompt,
  buildAgentRewriteExistingFilePrompt,
  buildAgentPlanPrompt,
  buildAgentPlanSpec,
  buildAgentDecisionPrompt,
} = agentPlanner || {};

const agentRuntime = window.AIExeAgentRuntime && typeof window.AIExeAgentRuntime.createAgentRuntime === 'function'
  ? window.AIExeAgentRuntime.createAgentRuntime({
    agentPlannerEndpoint,
    agentPlannerRequestTimeoutMs,
    agentDecisionMaxTokens,
    agentFileContentMaxTokens,
    getAgentFileOutputBudget,
    agentFileGenerationRequestTimeoutMs,
    loadPromptTemplate,
    renderPromptTemplate,
    buildAgentWriteFileContentPrompt,
    buildAgentEditFileContentPrompt,
    buildAgentRewriteExistingFilePrompt,
    sanitizeAgentGeneratedFileContent,
    sanitizeAgentGeneratedEditProgram,
    requestSelectedRemoteTextCompletion,
    markAgentToolProgress,
    updateAgentStreamingFile,
    clearAgentStreamingFile,
    // Persist a file to disk mid-generation so it's created + visible in the
    // workspace and progress isn't lost if generation stops.
    persistAgentFile: async (path, content) => {
      try {
        const p = normalizeWorkspacePath(path || '');
        if (!p || p === '/') return;
        const parent = parentWorkspacePath(p);
        if (parent && parent !== '/' && parent !== '.') await invokeWorkspaceAction('workspaceMkdir', { path: parent });
        const res = await invokeWorkspaceAction('workspaceWriteFile', { path: p, content: String(content || '') });
        if (res && res.ok) {
          upsertWorkspaceTreeEntry({ kind: 'file', path: p, name: workspaceBaseName(p), sizeBytes: estimateTextBytes(String(content || '')), updatedAt: nowTs(), optimisticUntil: nowTs() + 5000 });
        }
      } catch (_) { }
    },
    nativeBridge,
    normalizeWorkspacePath,
    deriveProjectNameFromTask,
    sanitizeAssistantText,
  })
  : null;
const {
  generateAgentWriteFileContent,
  generateAgentProjectFiles,
  generateAgentEditFileProgram,
  generateAgentRewriteExistingFileContent,
  buildAgentCompletionFallbackText,
  generateAgentCompletionText,
  buildAgentProgressMarkdown,
  describeAgentToolTarget,
  verifyAgentDoneCriteria,
  reviewAgentProjectCoherence,
} = agentRuntime || {};

const agentExecutor = window.AIExeAgentExecutor && typeof window.AIExeAgentExecutor.createAgentExecutor === 'function'
  ? window.AIExeAgentExecutor.createAgentExecutor({
    normalizeWorkspacePath,
    mapWorkspaceEntry,
    isIgnoredWorkspaceEntryName,
    deriveProjectNameFromTask,
    invokeWorkspaceAction,
    saveWorkspaceRootPath,
    getWorkspaceRootName: () => workspaceRootName,
    getWorkspaceTreeState: () => workspaceTreeState,
    setWorkspaceRootName: (value) => { workspaceRootName = String(value || ''); },
    resetWorkspaceForNewProject,
    getWorkspaceContext,
    getWorkspaceStateComparison,
    requestWorkspaceStatusSnapshot,
    chatHasPriorAgentWorkspaceWork,
    recordDebugTrace,
    debugPreview,
    syncFileTabFromWorkspaceWrite,
    workspaceBaseName,
    agentMaxToolOutputChars,
    isLikelyNewAgentFileTarget,
    setActiveAgentStreamStatus,
    isAgentGeneratedContentTarget,
    generateAgentWriteFileContent,
    generateAgentProjectFiles,
    isAgentTaskSoftwareProject,
    isAgentTaskGameLike,
    isExplicitReadmeOrDocsTask,
    isExistingProjectMutationRequest,
    getLatestSuccessfulAgentSourceWrite,
    isLikelyCompleteReadme,
    isLikelyCompletePythonGameSource,
    isLikelyCompletePrimarySource,
    parentWorkspacePath,
    setWorkspaceSelection,
    upsertWorkspaceTreeEntry,
    estimateTextBytes,
    nowTs,
    parseAgentEditProgram,
    generateAgentEditFileProgram,
    generateAgentRewriteExistingFileContent,
    applyAgentEditProgram,
    removeWorkspaceTreeEntry,
    guessWorkspaceTargetKind,
    syncMovedFileTab,
    removeWorkspaceTab,
    reviewAgentProjectCoherence,
    runWorkspaceAppSmokeTest,
  })
  : null;
const {
  executeDeveloperToolCall,
  describeAgentToolPhase,
} = agentExecutor || {};

const agentLoop = window.AIExeAgentLoop && typeof window.AIExeAgentLoop.createAgentLoop === 'function'
  ? window.AIExeAgentLoop.createAgentLoop({
    nativeBridge,
    agentTotalTimeoutMs,
    agentToolTimeoutMs,
    agentToolIdleTimeoutMs,
    agentToolHardCapMs,
    markAgentToolProgress,
    getLastAgentToolProgressAt,
    agentMaxSteps,
    agentDecisionMaxTokens,
    agentDecisionGrammar,
    agentStepTimeoutMs,
    agentMaxToolOutputChars,
    mergeAgentActivityIntoList,
    pushActiveAgentStreamActivity,
    scheduleLiveStreamRender,
    isInferenceActive,
    abortInFlightInference,
    hasLiveAssistantRow: hasConnectedLiveAssistantRow,
    createLiveAssistantRow,
    setActiveAgentStreamStatus,
    setLiveAgentProgress: (value) => {
      const text = String(value || '').trim();
      if (activeAgentStreamState) {
        activeAgentStreamState.statusText = text;
      }
      activeStreamRawText = buildAgentProgressMarker(text || 'Working...');
      activeStreamText = '';
      updateTokenRing();
    },
    buildAgentPlanSpec,
    applyAgentProjectChatName,
    pushDebugTrace,
    recordDebugTrace,
    debugPreview,
    resetActiveAgentStreamState,
    buildAgentPlanActivity,
    computeAgentChecklistProgress,
    renderAgentChecklist,
    buildAgentPlanMarkdown,
    parseAgentPlanMarkdown,
    firstUnfinishedPhaseIndex,
    setAgentPhaseTracker,
    clearAgentPhaseTracker,
    setThinkingStatus: (text) => {
      // While the agent elapsed timer owns the below-input status, ignore the
      // loop's blanking calls so the live "Xs" counter keeps ticking. Honor any
      // real (non-empty) status text.
      if (isAgentElapsedTimerActive() && !String(text || '').trim()) return;
      setThinkingStatus(text);
    },
    buildAgentDecisionPrompt,
    requestAgentPlannerInference,
    parseAgentDecision,
    buildAgentDecisionRepairPrompt,
    requestNativeAgentPlannerInference,
    deriveFallbackAgentDecision,
    validateAgentFinalDecision,
    consumeLiveAssistantText,
    refreshWorkspaceTree,
    commitAssistantMessage,
    describeAgentToolTarget,
    isLikelyNewAgentFileTarget,
    buildAgentPendingActivity,
    buildAgentCorrectionActivity,
    executeDeveloperToolCall,
    normalizeWorkspacePath,
    buildAgentActivityFromToolResult,
    getWorkspaceContext,
    getWorkspaceStateComparison,
    requestWorkspaceStatusSnapshot,
    syncWorkspaceStateFromNative,
    getWorkspaceRootName: () => workspaceRootName,
    deriveProjectNameFromTask,
    generateAgentCompletionText,
    verifyAgentDoneCriteria,
    getChatManualContext: (chatId) => String((findChatById(chatId) || {}).manualContext || ''),
    requestProjectScopeConfirmation,
    invokeWorkspaceAction,
    resetWorkspaceForNewProject,
    scheduleWorkspaceExplorerBackgroundRefresh,
    sanitizeAssistantText,
    describeAgentToolPhase,
  })
  : null;
const {
  requestDeveloperAgentReply,
} = agentLoop || {};

const aiNativeAgentLoop = window.AIExeAiNativeAgentLoop && typeof window.AIExeAiNativeAgentLoop.createAiNativeAgentLoop === 'function'
  ? window.AIExeAiNativeAgentLoop.createAiNativeAgentLoop({
    nativeBridge,
    agentTotalTimeoutMs,
    agentMaxSteps,
    agentDecisionMaxTokens,
    agentMaxToolOutputChars,
    mergeAgentActivityIntoList,
    pushActiveAgentStreamActivity,
    scheduleLiveStreamRender,
    isInferenceActive,
    abortInFlightInference,
    hasLiveAssistantRow: hasConnectedLiveAssistantRow,
    createLiveAssistantRow,
    setActiveAgentStreamStatus,
    setLiveAgentProgress: (value) => {
      const text = String(value || '').trim();
      if (activeAgentStreamState) {
        activeAgentStreamState.statusText = text;
      }
      activeStreamRawText = buildAgentProgressMarker(text || 'Working...');
      activeStreamText = '';
    },
    requestAgentPlannerInference,
    executeDeveloperToolCall,
    buildAgentActivityFromToolResult,
    describeAgentToolTarget,
    describeAgentToolPhase,
    normalizeWorkspacePath,
    getWorkspaceContext,
    refreshWorkspaceTree,
    commitAssistantMessage,
    consumeLiveAssistantText,
    sanitizeAssistantText,
    requestProjectScopeConfirmation,
    invokeWorkspaceAction,
    deriveProjectNameFromTask,
    resetWorkspaceForNewProject,
    syncWorkspaceStateFromNative,
  })
  : null;
const {
  requestAiNativeAgentReply,
  buildAiNativePrompt,
} = aiNativeAgentLoop || {};
window.AIExeExperimentalAgent = {
  requestAiNativeAgentReply,
  buildAiNativePrompt,
};

function shouldUseExperimentalAgentLoop(promptText = '') {
  const text = String(promptText || '').trim();
  // Explicit per-message overrides win regardless of the stored setting.
  if (/^\/dev-agent\b/i.test(text)) return false;
  const explicit = /^\/ai-agent\b/i.test(text);
  // AI-native loop is now the default. Opt out by setting the flag to '0'.
  let disabled = false;
  try {
    disabled = String(localStorage.getItem('aiExeExperimentalAgent') || '') === '0';
  } catch (_) {
    disabled = false;
  }
  return Boolean(requestAiNativeAgentReply) && (explicit || !disabled);
}

function getExperimentalAgentTaskText(promptText = '') {
  const text = String(promptText || '').trim();
  return text.replace(/^\/ai-agent\b\s*/i, '').trim() || text;
}

async function requestSelectedDeveloperAgentReply(requestToken, chatId, rawPromptText) {
  const promptText = resolveAgentResumeTaskText(chatId, rawPromptText);
  // Keep a live elapsed counter below the input for the whole agent run, and make
  // sure it is always torn down when the run ends (success, stop, or throw).
  startAgentElapsedTimer(0, chatId);
  try {
    if (shouldUseExperimentalAgentLoop(promptText)) {
      recordDebugTrace('experimental_agent_route', {
        chatId: String(chatId || ''),
        explicit: String(/^\/ai-agent\b/i.test(String(promptText || '').trim())),
        latestUserPreview: debugPreview(promptText, 220),
      }, {
        chatId: String(chatId || ''),
        latestUserInput: String(promptText || ''),
        workspace: getWorkspaceDebugSnapshot(),
      });
      return await requestAiNativeAgentReply(requestToken, chatId, getExperimentalAgentTaskText(promptText));
    }
    const devTaskText = String(promptText || '').replace(/^\/dev-agent\b\s*/i, '');
    return await requestDeveloperAgentReply(requestToken, chatId, devTaskText);
  } finally {
    stopAgentElapsedTimer();
  }
}

function hasConnectedLiveAssistantRow() {
  return Boolean(activeStreamRow && activeStreamRow.isConnected);
}

async function refreshWorkspaceExplorerAfterMutation(forceReload = false) {
  await refreshWorkspaceTree(forceReload);
}

async function startWorkspaceRenameSelected() {
  if (workspaceActions && typeof workspaceActions.startWorkspaceRenameSelected === 'function') {
    return workspaceActions.startWorkspaceRenameSelected();
  }
  return undefined;
}

function updateWorkspaceHeaderUi(...args) {
  if (workspaceRenderer && typeof workspaceRenderer.updateWorkspaceHeaderUi === 'function') {
    return workspaceRenderer.updateWorkspaceHeaderUi(...args);
  }
  return undefined;
}

function getWorkspaceCreateParentPath(...args) {
  if (workspaceActions && typeof workspaceActions.getWorkspaceCreateParentPath === 'function') {
    return workspaceActions.getWorkspaceCreateParentPath(...args);
  }
  return workspaceCurrentKind === 'folder'
    ? normalizeWorkspacePath(workspaceCurrentPath)
    : parentWorkspacePath(workspaceCurrentPath);
}

function startWorkspaceDraft(...args) {
  if (workspaceActions && typeof workspaceActions.startWorkspaceDraft === 'function') {
    return workspaceActions.startWorkspaceDraft(...args);
  }
  return undefined;
}

function cancelWorkspaceDraft(...args) {
  if (workspaceActions && typeof workspaceActions.cancelWorkspaceDraft === 'function') {
    return workspaceActions.cancelWorkspaceDraft(...args);
  }
  return undefined;
}

function cancelWorkspaceRenameDraft(...args) {
  if (workspaceActions && typeof workspaceActions.cancelWorkspaceRenameDraft === 'function') {
    return workspaceActions.cancelWorkspaceRenameDraft(...args);
  }
  return undefined;
}

async function commitWorkspaceDraft(...args) {
  if (workspaceActions && typeof workspaceActions.commitWorkspaceDraft === 'function') {
    return workspaceActions.commitWorkspaceDraft(...args);
  }
  return false;
}

async function startWorkspaceRenamePath(...args) {
  if (workspaceActions && typeof workspaceActions.startWorkspaceRenamePath === 'function') {
    return workspaceActions.startWorkspaceRenamePath(...args);
  }
  return false;
}

async function commitWorkspaceRenameDraft(...args) {
  if (workspaceActions && typeof workspaceActions.commitWorkspaceRenameDraft === 'function') {
    return workspaceActions.commitWorkspaceRenameDraft(...args);
  }
  return false;
}

function getDroppedFileSystemEntries(...args) {
  if (workspaceActions && typeof workspaceActions.getDroppedFileSystemEntries === 'function') {
    return workspaceActions.getDroppedFileSystemEntries(...args);
  }
  return [];
}

async function uploadDroppedDataTransfer(...args) {
  if (workspaceActions && typeof workspaceActions.uploadDroppedDataTransfer === 'function') {
    return workspaceActions.uploadDroppedDataTransfer(...args);
  }
  return undefined;
}

function parseDraggedWorkspacePaths(...args) {
  if (workspaceActions && typeof workspaceActions.parseDraggedWorkspacePaths === 'function') {
    return workspaceActions.parseDraggedWorkspacePaths(...args);
  }
  return [];
}

async function moveWorkspaceEntries(...args) {
  if (workspaceActions && typeof workspaceActions.moveWorkspaceEntries === 'function') {
    return workspaceActions.moveWorkspaceEntries(...args);
  }
  return undefined;
}

async function downloadWorkspaceFile(...args) {
  if (workspaceActions && typeof workspaceActions.downloadWorkspaceFile === 'function') {
    return workspaceActions.downloadWorkspaceFile(...args);
  }
  return undefined;
}

async function importWorkspacePickedFiles(...args) {
  if (workspaceActions && typeof workspaceActions.importWorkspacePickedFiles === 'function') {
    return workspaceActions.importWorkspacePickedFiles(...args);
  }
  return undefined;
}

function importWorkspaceFiles(...args) {
  if (workspaceActions && typeof workspaceActions.importWorkspaceFiles === 'function') {
    return workspaceActions.importWorkspaceFiles(...args);
  }
  return undefined;
}

async function importWorkspacePickedFolderFiles(...args) {
  if (workspaceActions && typeof workspaceActions.importWorkspacePickedFolderFiles === 'function') {
    return workspaceActions.importWorkspacePickedFolderFiles(...args);
  }
  return undefined;
}

function importWorkspaceFolder(...args) {
  if (workspaceActions && typeof workspaceActions.importWorkspaceFolder === 'function') {
    return workspaceActions.importWorkspaceFolder(...args);
  }
  return undefined;
}

async function revealWorkspaceInSystem(...args) {
  if (workspaceActions && typeof workspaceActions.revealWorkspaceInSystem === 'function') {
    return workspaceActions.revealWorkspaceInSystem(...args);
  }
  return undefined;
}

/* ─── File Tab Management ─── */

function getOpenFileTab(...args) {
  return fileViewerApi.getOpenFileTab
    ? fileViewerApi.getOpenFileTab(...args)
    : null;
}

function getActiveFileTab(...args) {
  return fileViewerApi.getActiveFileTab
    ? fileViewerApi.getActiveFileTab(...args)
    : null;
}

function formatFileViewerBreadcrumb(...args) {
  return fileViewerApi.formatFileViewerBreadcrumb
    ? fileViewerApi.formatFileViewerBreadcrumb(...args)
    : 'file';
}

function inferFileViewerLanguage(...args) {
  return fileViewerApi.inferFileViewerLanguage
    ? fileViewerApi.inferFileViewerLanguage(...args)
    : 'text';
}

function renderFileViewerHighlight(...args) {
  if (fileViewerApi.renderFileViewerHighlight) {
    return fileViewerApi.renderFileViewerHighlight(...args);
  }
  return undefined;
}

function renderFileViewerLineNumbers(...args) {
  if (fileViewerApi.renderFileViewerLineNumbers) {
    return fileViewerApi.renderFileViewerLineNumbers(...args);
  }
  return undefined;
}

function updateFileViewerCurrentLine(...args) {
  if (fileViewerApi.updateFileViewerCurrentLine) {
    return fileViewerApi.updateFileViewerCurrentLine(...args);
  }
  return undefined;
}

function selectFileViewerLine(...args) {
  if (fileViewerApi.selectFileViewerLine) {
    return fileViewerApi.selectFileViewerLine(...args);
  }
  return undefined;
}

function applyFileViewerSearchSelection(...args) {
  if (fileViewerApi.applyFileViewerSearchSelection) {
    return fileViewerApi.applyFileViewerSearchSelection(...args);
  }
  return undefined;
}

function updateFileViewerSearch(...args) {
  if (fileViewerApi.updateFileViewerSearch) {
    return fileViewerApi.updateFileViewerSearch(...args);
  }
  return undefined;
}

function setFileViewerSearchOpen(...args) {
  if (fileViewerApi.setFileViewerSearchOpen) {
    return fileViewerApi.setFileViewerSearchOpen(...args);
  }
  return undefined;
}

function syncFileViewerScroll(...args) {
  if (fileViewerApi.syncFileViewerScroll) {
    return fileViewerApi.syncFileViewerScroll(...args);
  }
  return undefined;
}

function refreshActiveFileTabView(...args) {
  if (fileViewerApi.refreshActiveFileTabView) {
    return fileViewerApi.refreshActiveFileTabView(...args);
  }
  return undefined;
}

function setActiveFileTabContent(...args) {
  if (fileViewerApi.setActiveFileTabContent) {
    return fileViewerApi.setActiveFileTabContent(...args);
  }
  return undefined;
}

async function saveFileTab(...args) {
  if (fileViewerApi.saveFileTab) {
    return fileViewerApi.saveFileTab(...args);
  }
  return false;
}

function persistFileTabsStateNow(...args) {
  if (fileViewerApi.persistFileTabsStateNow) {
    return fileViewerApi.persistFileTabsStateNow(...args);
  }
  return undefined;
}

function schedulePersistFileTabsState(...args) {
  if (fileViewerApi.schedulePersistFileTabsState) {
    return fileViewerApi.schedulePersistFileTabsState(...args);
  }
  return undefined;
}

async function loadStoredFileTabs(...args) {
  if (fileViewerApi.loadStoredFileTabs) {
    return fileViewerApi.loadStoredFileTabs(...args);
  }
  return undefined;
}

function renderTabBar(...args) {
  if (fileViewerApi.renderTabBar) {
    return fileViewerApi.renderTabBar(...args);
  }
  return undefined;
}

function syncFileTabFromWorkspaceWrite(...args) {
  if (fileViewerApi.syncFileTabFromWorkspaceWrite) {
    return fileViewerApi.syncFileTabFromWorkspaceWrite(...args);
  }
  return undefined;
}

async function refreshOpenFileTabsFromWorkspace(...args) {
  if (fileViewerApi.refreshOpenFileTabsFromWorkspace) {
    return fileViewerApi.refreshOpenFileTabsFromWorkspace(...args);
  }
  return undefined;
}

function switchToTab(...args) {
  if (fileViewerApi.switchToTab) {
    return fileViewerApi.switchToTab(...args);
  }
  return undefined;
}

async function openFileTab(...args) {
  if (fileViewerApi.openFileTab) {
    return fileViewerApi.openFileTab(...args);
  }
  return undefined;
}

function closeFileTab(...args) {
  if (fileViewerApi.closeFileTab) {
    return fileViewerApi.closeFileTab(...args);
  }
  return undefined;
}

async function renderArtifacts(...args) {
  if (workspaceRenderer && typeof workspaceRenderer.renderArtifacts === 'function') {
    return workspaceRenderer.renderArtifacts(...args);
  }
  return undefined;
}

function collapseAllFolders(...args) {
  if (workspaceActions && typeof workspaceActions.collapseAllFolders === 'function') {
    return workspaceActions.collapseAllFolders(...args);
  }
  return undefined;
}

async function openWorkspaceProject(...args) {
  if (workspaceActions && typeof workspaceActions.openWorkspaceProject === 'function') {
    return workspaceActions.openWorkspaceProject(...args);
  }
  return undefined;
}

async function runWorkspaceApp(...args) {
  if (workspaceActions && typeof workspaceActions.runWorkspaceApp === 'function') {
    return workspaceActions.runWorkspaceApp(...args);
  }
  return undefined;
}

async function closeWorkspaceProject(...args) {
  if (workspaceActions && typeof workspaceActions.closeWorkspaceProject === 'function') {
    return workspaceActions.closeWorkspaceProject(...args);
  }
  return undefined;
}

async function deleteSelectedWorkspaceItems(...args) {
  if (workspaceActions && typeof workspaceActions.deleteSelectedWorkspaceItems === 'function') {
    return workspaceActions.deleteSelectedWorkspaceItems(...args);
  }
  return undefined;
}

function renderArtifactBrowser() {
  if (!artifactBrowser || !artifactListView || !artifactDetailView) return;
  const hasUser = Boolean(currentAuthUser());
  const showingCodeOnly = artifactListFilter === 'code';
  const allArtifactItems = getAllStoredArtifacts();
  const artifactItems = showingCodeOnly ? allArtifactItems.filter((item) => isCodeArtifact(item)) : allArtifactItems.filter((item) => !isCodeArtifact(item));
  const selected = allArtifactItems.find((item) => makeArtifactKey(item) === artifactDetailKey) || null;
  const detailMode = middleViewMode === 'artifacts_detail' && Boolean(selected);

  if (artifactBackBtn) artifactBackBtn.classList.toggle('hidden', !detailMode);
  if (artifactBrowserTitle) {
    if (!hasUser) {
      artifactBrowserTitle.textContent = 'Artifacts';
    } else if (detailMode) {
      artifactBrowserTitle.textContent = selected.name || 'Artifact';
    } else {
      artifactBrowserTitle.textContent = showingCodeOnly ? 'Code' : 'Artifacts';
    }
  }

  artifactListView.classList.toggle('hidden', detailMode);
  artifactDetailView.classList.toggle('hidden', !detailMode);
  artifactListView.classList.toggle('empty-mode', !detailMode && (!hasUser || artifactItems.length === 0));

  if (!detailMode) {
    artifactListView.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'history-empty artifact-empty';

    if (!hasUser) {
      empty.innerHTML = `
          <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>
          </svg>
          <div class="history-empty-title">Sign In Required</div>
          <div class="history-empty-sub">Log in to view your private artifacts.</div>
        `;
      artifactListView.appendChild(empty);
      return;
    }

    if (artifactItems.length === 0) {
      const emptyTitle = showingCodeOnly ? 'No Code Artifacts' : 'No Artifacts';
      const emptySub = showingCodeOnly
        ? 'Generate code blocks in chat to collect them here.'
        : 'Create canvas artifacts in chat to see them here.';
      empty.innerHTML = `
          <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="4" y="4" width="16" height="16" rx="2"></rect>
            <path d="M8 10h8"></path>
            <path d="M8 14h5"></path>
          </svg>
          <div class="history-empty-title">${emptyTitle}</div>
          <div class="history-empty-sub">${emptySub}</div>
        `;
      artifactListView.appendChild(empty);
      return;
    }

    artifactItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'artifact-row';
      const linkedChat = findChatById(item.chatId);
      const chatName = linkedChat ? linkedChat.name : 'Unknown chat';
      const langBadge = isCodeArtifact(item) && item.language
        ? String(item.language).trim().toUpperCase()
        : '';
      const preview = String(item.content || '').trim().slice(0, 180);
      const allowDelete = Boolean(item) && (isCodeArtifact(item) || item.type !== 'canvas');
      row.innerHTML = `
          <button type="button" class="artifact-row-main">
            ${preview ? `<div class="artifact-row-preview">${escapeHtml(preview)}</div>` : ''}
          </button>
          <div class="artifact-row-actions">
            <button type="button" class="artifact-open-chat-btn" title="Open source chat">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 4h11a2 2 0 0 1 2 2v11"></path>
                <polyline points="10 14 20 4"></polyline>
                <polyline points="14 4 20 4 20 10"></polyline>
                <path d="M4 10v10h10"></path>
              </svg>
            </button>
            ${allowDelete ? `<button type="button" class="artifact-delete-btn" title="Delete artifact">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                <path d="M10 11v6"></path><path d="M14 11v6"></path>
                <path d="M9 6V4h6v2"></path>
              </svg>
            </button>` : ''}
          </div>
          <div class="artifact-row-info">
            ${langBadge ? `<div class="artifact-row-badge">${escapeHtml(langBadge)}</div>` : ''}
            <div class="artifact-row-title">${escapeHtml(item.name)}</div>
            <div class="artifact-row-meta">${escapeHtml(chatName)} • ${escapeHtml(formatTimeAgo(item.createdAt))} • ${escapeHtml(item.size || '0 B')}</div>
          </div>
        `;
      const mainBtn = row.querySelector('.artifact-row-main');
      if (mainBtn) {
        mainBtn.addEventListener('click', () => openArtifactDetail(makeArtifactKey(item), 'artifacts'));
      }
      const openBtn = row.querySelector('.artifact-open-chat-btn');
      if (openBtn) {
        applyCustomTooltip(openBtn, 'Open source chat');
        const canOpen = Boolean(linkedChat);
        openBtn.disabled = !canOpen;
        openBtn.addEventListener('click', (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          if (!linkedChat) return;
          loadHistory(linkedChat.id);
        });
      }
      const delBtn = row.querySelector('.artifact-delete-btn');
      if (delBtn) {
        applyCustomTooltip(delBtn, 'Delete artifact');
        delBtn.addEventListener('click', (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          if (delBtn.dataset.armed === 'true') {
            const key = makeArtifactKey(item);
            artifacts = artifacts.filter((a) => makeArtifactKey(a) !== key);
            saveArtifacts();
            renderSidebarCounts();
            renderArtifactBrowser();
          } else {
            delBtn.dataset.armed = 'true';
            delBtn.classList.add('armed');
            delBtn.dataset.tooltip = 'Click again to confirm delete';
            setTimeout(() => {
              delBtn.dataset.armed = '';
              delBtn.classList.remove('armed');
              delBtn.dataset.tooltip = 'Delete artifact';
            }, 2500);
          }
        });
      }
      artifactListView.appendChild(row);
    });
    return;
  }

  if (!selected) {
    artifactDetailKey = '';
    artifactDetailOrigin = 'artifacts';
    middleViewMode = 'artifacts_list';
    renderArtifactBrowser();
    return;
  }

  if (artifactDetailMeta) {
    const linkedChat = findChatById(selected.chatId);
    const chatName = linkedChat ? linkedChat.name : 'Unknown chat';
    const typeLabel = getArtifactTypeLabel(selected);
    artifactDetailMeta.textContent = `${typeLabel} • ${chatName} • ${formatTimeAgo(selected.createdAt)} • ${selected.size || '0 B'}`;
  }
  if (artifactEditor) {
    artifactEditor.value = String(selected.content || '');
    artifactEditor.scrollTop = 0;
  }
  if (artifactOpenChatBtn) {
    const linkedChat = findChatById(selected.chatId);
    artifactOpenChatBtn.disabled = !linkedChat;
    artifactOpenChatBtn.dataset.chatId = linkedChat ? linkedChat.id : '';
    artifactOpenChatBtn.title = linkedChat ? `Open chat: ${linkedChat.name}` : 'Source chat unavailable';
  }
}

function renderMiddleView() {
  if (chatShell && typeof chatShell.renderMiddleView === 'function') {
    return chatShell.renderMiddleView();
  }
  return undefined;
}

function saveArtifacts() {
  const key = scopedStorageKey(artifactsStoragePrefix);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(artifacts.slice(0, 120)));
  } catch (_) { }
}

function saveWorkspaceState() {
  const key = scopedStorageKey(workspaceStoragePrefix);
  if (!key) return;
  const payload = {
    currentPath: workspaceCurrentPath || '/',
    currentKind: workspaceCurrentKind || 'folder',
    rootPath: workspaceRootName ? '' : '',
  };
  try {
    const rawExisting = localStorage.getItem(key);
    if (rawExisting) {
      const existing = JSON.parse(rawExisting);
      if (existing && existing.rootPath) {
        payload.rootPath = existing.rootPath;
      }
    }
  } catch (_) { }
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (_) { }
}

function saveWorkspaceRootPath(rootPath) {
  const key = scopedStorageKey(workspaceStoragePrefix);
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    const payload = raw ? JSON.parse(raw) : {};
    payload.rootPath = rootPath || '';
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (_) { }
}

function loadStoredWorkspace() {
  workspaceItems = [];
  workspaceCurrentPath = '/';
  workspaceCurrentKind = 'folder';
  workspaceTreeState.clear();
  workspaceSelectedPaths.clear();
  workspaceRenameDraft = null;
  workspaceRenameFocusId = 0;
  const key = scopedStorageKey(workspaceStoragePrefix);
  let savedRootPath = '';
  if (key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        workspaceCurrentPath = normalizeWorkspacePath((parsed && parsed.currentPath) || '/');
        workspaceCurrentKind = (parsed && parsed.currentKind) === 'file' ? 'file' : 'folder';
        savedRootPath = (parsed && parsed.rootPath) || '';
      }
    } catch (_) { }
  }
  workspaceSelectedPaths.add(workspaceCurrentPath);

  if (savedRootPath && nativeBridge.available()) {
    invokeWorkspaceAction('workspaceRestoreRoot', { rootPath: savedRootPath }).then((response) => {
      if (response && response.ok) {
        void requestWorkspaceStatusSnapshot().then((snapshot) => {
          applyWorkspaceStatusSnapshot(snapshot);
          workspaceTreeState.clear();
          const freshRoot = getWorkspaceNodeState('/');
          freshRoot.expanded = true;
          freshRoot.loaded = false;
          void renderArtifacts();
        });
      }
    }).catch(() => { });
  }
}

function loadStoredArtifacts() {
  artifacts = [];
  const key = scopedStorageKey(artifactsStoragePrefix);
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    artifacts = parsed
      .filter((item) => item && typeof item.name === 'string' && typeof item.size === 'string')
      .slice(0, 120)
      .map((item) => ({
        name: item.name.trim() || `artifact_${nowTs()}.bin`,
        size: item.size.trim() || '0.0 MB',
        createdAt: Number(item.createdAt) || nowTs(),
        type: (item.type === 'canvas' || item.type === 'code' || item.type === 'generated') ? item.type : 'generated',
        chatId: typeof item.chatId === 'string' ? item.chatId : '',
        messageTs: Number(item.messageTs) || 0,
        language: typeof item.language === 'string' ? item.language : '',
        canvasFormat: (item.canvasFormat === 'code' ? 'code' : 'text'),
        content: typeof item.content === 'string' ? item.content.slice(0, maxArtifactContentChars) : '',
        truncated: Boolean(item.truncated),
      }));
  } catch (_) { }
}

function persistActiveChatId() {
  const key = scopedStorageKey(activeChatStoragePrefix);
  if (!key) return;
  try {
    if (activeChatId) {
      localStorage.setItem(key, activeChatId);
    } else {
      localStorage.removeItem(key);
    }
  } catch (_) { }
}

function saveChats() {
  const key = scopedStorageKey(chatsStoragePrefix);
  if (!key) return;
  chats.forEach((chat) => ensureChatThreadState(chat));
  sortChatsInPlace();
  try {
    localStorage.setItem(key, JSON.stringify(chats.slice(0, 60)));
  } catch (_) { }
  persistActiveChatId();
}

function normalizeStoredPendingPreflightConfirmation(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = String(value.kind || 'confirm').trim();
  const originalTask = String(value.originalTask || '').trim();
  const userMessage = String(value.userMessage || '').trim();
  const workspaceOpen = value.workspaceOpen === false ? false : Boolean(value.workspaceOpen);
  const createdAt = Number(value.createdAt) || nowTs();
  if (!kind || !userMessage) return null;
  return {
    kind,
    originalTask,
    userMessage,
    workspaceOpen,
    createdAt,
  };
}

function loadStoredChats() {
  chats = [];
  pendingPreflightConfirmations.clear();
  const key = scopedStorageKey(chatsStoragePrefix);
  if (!key) {
    activeChatId = null;
    inNewChatMode = false;
    return;
  }
  let parsedChats = [];
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsedChats = parsed;
      }
    }
  } catch (_) { }

  chats = parsedChats
    .filter((chat) => chat && typeof chat.id === 'string')
    .slice(0, 60)
    .map((chat) => {
      const normalizeStoredMessages = (list) => Array.isArray(list)
        ? list
          .filter((m) => m && (m.role === 'user' || m.role === 'ai' || m.role === 'error') && typeof m.text === 'string')
          .map((m) => ({
            role: m.role,
            text: m.text,
            ts: Number(m.ts) || nowTs(),
            displayTs: Number(m.displayTs) || 0,
            thinking: m && m.role === 'ai' && typeof m.thinking === 'string'
              ? m.thinking.slice(0, 20000)
              : '',
            thinkingMeta: m && m.role === 'ai' && m.thinkingMeta && typeof m.thinkingMeta === 'object'
              ? {
                startedAt: Number(m.thinkingMeta.startedAt) || 0,
                completedAt: Number(m.thinkingMeta.completedAt) || 0,
              }
              : null,
            agentActivities: m && m.role === 'ai' && Array.isArray(m.agentActivities)
              ? normalizeAgentActivities(m.agentActivities)
              : [],
            agentMeta: m && m.role === 'ai'
              ? cloneAgentMeta(m.agentMeta)
              : null,
            branchAnchorTs: Number(m && m.branchAnchorTs) || 0,
          }))
        : [];
      const topLevelMessages = normalizeStoredMessages(chat.messages);
      const topLevelBranchLinks = normalizeBranchLinks(chat.branchLinks);
      const topLevelPendingBranchLink = chat && chat.pendingBranchLink && typeof chat.pendingBranchLink === 'object'
        ? { ...chat.pendingBranchLink }
        : null;

      const rawThreads = Array.isArray(chat.threads) && chat.threads.length
        ? chat.threads
        : [{
          id: String(chat.activeThreadId || makeThreadId()),
          messages: chat.messages,
          branchLinks: chat.branchLinks,
          pendingBranchLink: chat.pendingBranchLink,
          needsContinue: chat.needsContinue,
        }];
      const threads = rawThreads.map((thread) => cloneThreadState({
        id: String(thread && thread.id ? thread.id : makeThreadId()),
        messages: normalizeStoredMessages(thread && thread.messages),
        branchLinks: thread && thread.branchLinks,
        pendingBranchLink: thread && thread.pendingBranchLink,
        needsContinue: Boolean(thread && thread.needsContinue),
      }));
      const activeThreadIdx = Math.max(0, threads.findIndex((thread) => String(thread.id || '') === String(chat.activeThreadId || '')));
      let activeThread = threads[activeThreadIdx] || cloneThreadState({});
      const richestThread = threads.reduce((best, thread) => {
        const bestCount = Array.isArray(best && best.messages) ? best.messages.length : 0;
        const nextCount = Array.isArray(thread && thread.messages) ? thread.messages.length : 0;
        return nextCount > bestCount ? thread : best;
      }, activeThread);
      if (topLevelMessages.length > 0 && topLevelMessages.length >= (Array.isArray(activeThread.messages) ? activeThread.messages.length : 0)) {
        const repairedActiveThread = cloneThreadState(activeThread, {
          messages: topLevelMessages,
          branchLinks: topLevelBranchLinks,
          pendingBranchLink: topLevelPendingBranchLink,
          needsContinue: Boolean(chat.needsContinue),
        });
        if (threads[activeThreadIdx]) {
          threads[activeThreadIdx] = repairedActiveThread;
        } else {
          threads.push(repairedActiveThread);
        }
        activeThread = repairedActiveThread;
      } else if (
        Array.isArray(richestThread && richestThread.messages)
        && Array.isArray(activeThread && activeThread.messages)
        && activeThread.messages.length <= 1
        && richestThread.messages.length > activeThread.messages.length
      ) {
        activeThread = cloneThreadState(richestThread);
      }
      const messages = Array.isArray(activeThread.messages)
        ? activeThread.messages.map((msg) => ({ ...msg }))
        : [];
      const createdAt = Number(chat.createdAt) || nowTs();
      const updatedAt = Number(chat.updatedAt) || createdAt;
      const hasAiMessage = messages.some((m) => m.role === 'ai' && String(m.text || '').trim());
      const hasErrorMessage = messages.some((m) => m.role === 'error' && String(m.text || '').trim());
      const shouldResetNaming = Boolean(chat.isNaming) && !hasAiMessage;
      const isNaming = Boolean(chat.isNaming) && !shouldResetNaming;
      return {
        id: chat.id,
        name: normalizeChatName(
          chat.customName
            ? (chat.name || messages.find((m) => m.role === 'user')?.text || 'New Chat')
            : toAutoTitleCase((shouldResetNaming ? 'New Chat' : chat.name) || messages.find((m) => m.role === 'user')?.text || 'New Chat')
        ),
        customName: Boolean(chat.customName),
        isNaming,
        createdAt,
        updatedAt,
        messages,
        needsContinue: Boolean(chat.needsContinue),
        canvasMode: Boolean(chat.canvasMode),
        agentMode: Boolean(chat.agentMode),
        thinkMode: Boolean(chat.thinkMode),
        pendingAttachments: normalizePendingAttachmentList(chat.pendingAttachments),
        manualContext: typeof chat.manualContext === 'string' ? chat.manualContext.slice(0, 4000) : '',
        pendingPreflightConfirmation: normalizeStoredPendingPreflightConfirmation(chat.pendingPreflightConfirmation),
        phaseTracker: (chat.phaseTracker && typeof chat.phaseTracker === 'object'
          && Array.isArray(chat.phaseTracker.phases) && chat.phaseTracker.phases.length > 1)
          ? {
            projectName: String(chat.phaseTracker.projectName || ''),
            phases: chat.phaseTracker.phases,
            activeIndex: Number(chat.phaseTracker.activeIndex) || 0,
          }
          : null,
        branchLinks: normalizeBranchLinks(activeThread.branchLinks),
        pendingBranchLink: activeThread.pendingBranchLink ? { ...activeThread.pendingBranchLink } : null,
        threads,
        activeThreadId: String(activeThread.id || ''),
      };
    });

  chats.forEach((chat) => ensureChatThreadState(chat));
  chats.forEach((chat) => {
    const pending = normalizeStoredPendingPreflightConfirmation(chat && chat.pendingPreflightConfirmation);
    if (!pending || !chat || !chat.id) return;
    chat.pendingPreflightConfirmation = { ...pending };
    pendingPreflightConfirmations.set(String(chat.id), { ...pending });
  });
  sortChatsInPlace();
  let storedActive = null;
  try {
    storedActive = localStorage.getItem(scopedStorageKey(activeChatStoragePrefix));
  } catch (_) { }
  activeChatId = (storedActive && findChatById(storedActive)) ? storedActive : (chats[0]?.id || null);
  inNewChatMode = !activeChatId;
  persistActiveChatId();
}

function buildHistoryEmpty() {
  if (chatShell && typeof chatShell.buildHistoryEmpty === 'function') {
    return chatShell.buildHistoryEmpty();
  }
  return document.createElement('div');
}

function setDeleteArmed(armed) {
  deleteArmed = Boolean(armed);
  if (chatDeleteBtn) {
    chatDeleteBtn.textContent = deleteArmed ? 'Confirm Delete' : 'Delete Chat';
  }
  if (chatDeleteConfirmNote) {
    chatDeleteConfirmNote.classList.toggle('visible', deleteArmed);
  }
}

function openChatActionModal(chatId) {
  const chat = findChatById(chatId);
  if (!chat || !chatActionBackdrop) return;
  modalChatId = chat.id;
  setDeleteArmed(false);
  chatNameInput.value = chat.name || '';
  chatActionBackdrop.classList.add('open');
  chatActionBackdrop.setAttribute('aria-hidden', 'false');
  setTimeout(() => chatNameInput.focus(), 0);
}

function closeChatActionModal() {
  setDeleteArmed(false);
  modalChatId = null;
  if (!chatActionBackdrop) return;
  chatActionBackdrop.classList.remove('open');
  chatActionBackdrop.setAttribute('aria-hidden', 'true');
}

function saveChatNameFromModal() {
  const chat = findChatById(modalChatId);
  if (!chat) return;
  const nextName = normalizeChatName(chatNameInput.value);
  chat.name = nextName;
  chat.customName = true;
  chat.isNaming = false;
  chat.updatedAt = nowTs();
  saveChats();
  renderHistory();
  closeChatActionModal();
}

function deleteChatFromModal() {
  if (!modalChatId) return;
  const chat = findChatById(modalChatId);
  if (!chat) return;
  if (!deleteArmed) {
    setDeleteArmed(true);
    return;
  }
  const deletedChatId = String(modalChatId);
  if (
    activeInferenceRequest
    && String(activeInferenceRequest.chatId || '') === deletedChatId
    && !activeInferenceRequest.cancelled
  ) {
    cancelActiveInference();
    clearTypingIndicator();
    setThinkingStatus('');
  }
  thinkingStartedByChatId.delete(deletedChatId);
  chats = chats.filter((chat) => chat.id !== modalChatId);
  artifacts = artifacts.filter((item) => String(item && item.chatId ? item.chatId : '') !== String(modalChatId));
  debugTraceEntries = debugTraceEntries.filter(
    (entry) => String(entry && entry.chatId ? entry.chatId : '') !== deletedChatId
  );
  if (activeChatId === modalChatId) {
    activeChatId = chats[0]?.id || null;
  }
  artifactDetailKey = '';
  inNewChatMode = !activeChatId;
  saveChats();
  saveArtifacts();
  renderArtifacts();
  renderHistory();
  renderSidebarCounts();
  renderActiveChat();
  syncSidebarNavState();
  closeChatActionModal();
}

if (chatSaveBtn) chatSaveBtn.addEventListener('click', saveChatNameFromModal);
if (chatCancelBtn) chatCancelBtn.addEventListener('click', closeChatActionModal);
if (chatDeleteBtn) chatDeleteBtn.addEventListener('click', deleteChatFromModal);
if (chatNameInput) {
  chatNameInput.addEventListener('input', () => setDeleteArmed(false));
  chatNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveChatNameFromModal();
    }
  });
}
if (chatActionBackdrop) {
  chatActionBackdrop.addEventListener('click', (e) => {
    if (e.target === chatActionBackdrop) {
      closeChatActionModal();
    }
  });
}
if (loginBtn) {
  loginBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!currentAuthUser()) {
      openAuthModal('login');
      return;
    }
    toggleAccountPopover();
  });
}
if (accountProfileBtn) {
  accountProfileBtn.addEventListener('click', () => {
    closeAccountPopover();
    openAuthModal(currentAuthUser() ? 'account' : 'login');
  });
}
if (accountSettingsBtn) {
  accountSettingsBtn.addEventListener('click', () => {
    closeAccountPopover();
    void openSettingsModal();
  });
}
if (accountUsageBtn) {
  accountUsageBtn.addEventListener('click', () => {
    showAppNotification({
      title: 'Usage',
      message: 'Usage details are not available in this offline preview.',
      kind: 'info',
    });
  });
}
if (accountLogoutBtn) {
  accountLogoutBtn.addEventListener('click', () => {
    closeAccountPopover();
    if (currentAuthUser()) {
      handleLogout();
    } else {
      openAuthModal('login');
    }
  });
}
if (accountPopover) {
  accountPopover.addEventListener('click', (event) => {
    event.stopPropagation();
  });
}
document.addEventListener('click', closeAccountPopover);
if (authLoginTab) authLoginTab.addEventListener('click', () => setAuthMode('login'));
if (authSignupTab) authSignupTab.addEventListener('click', () => setAuthMode('signup'));
if (authActionBtn) authActionBtn.addEventListener('click', () => { void handleAuthAction(); });
if (authLogoutBtn) authLogoutBtn.addEventListener('click', handleLogout);
if (authCancelBtn) authCancelBtn.addEventListener('click', closeAuthModal);
if (authBackdrop) {
  authBackdrop.addEventListener('click', (e) => {
    if (e.target === authBackdrop) {
      closeAuthModal();
    }
  });
}
document.addEventListener('click', (event) => {
  if (!authBackdrop || !authBackdrop.classList.contains('open')) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('#authCancelBtn')) {
    event.preventDefault();
    event.stopPropagation();
    closeAuthModal();
    return;
  }
  if (target.closest('#authActionBtn')) {
    event.preventDefault();
    event.stopPropagation();
    void handleAuthAction();
    return;
  }
  if (target.closest('#authLoginTab')) {
    event.preventDefault();
    event.stopPropagation();
    setAuthMode('login');
    return;
  }
  if (target.closest('#authSignupTab')) {
    event.preventDefault();
    event.stopPropagation();
    setAuthMode('signup');
    return;
  }
  if (target === authBackdrop) {
    event.preventDefault();
    event.stopPropagation();
    closeAuthModal();
  }
}, true);
if (settingsBtn) {
  settingsBtn.addEventListener('click', () => { void openSettingsModal(); });
}
if (settingsImportBtn) {
  settingsImportBtn.addEventListener('click', async () => {
    const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    setSettingsNote('');
    setButtonLoading(settingsImportBtn, true);
    await waitForUiPaint();
    try {
      const res = await fetchRuntimeStatus('importModel');
      if (res && res.ok) {
        setSettingsNote(res.message || 'Model imported.', 'info');
      } else {
        setSettingsNote((res && res.message) || 'Model import failed.');
      }
    } finally {
      await ensureMinLoading(startedAt);
      setButtonLoading(settingsImportBtn, false);
    }
  });
}

// Model setup banner buttons (first-run experience)
(function setupModelBannerButtons() {
  const importBtn = document.getElementById('modelImportBtn');
  const retryBtn = document.getElementById('modelRetryBtn');
  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      try {
        const res = await fetchRuntimeStatus('importModel');
        if (res && res.ok) {
          importBtn.textContent = 'Model Imported ✓';
          showAppNotification({
            title: 'Model imported',
            message: res.message || 'The local model is ready.',
            kind: 'success',
          });
        } else {
          importBtn.textContent = 'Import Model';
          showAppNotification({
            title: 'Model import failed',
            message: (res && res.message) || 'Model import failed.',
            kind: 'error',
          });
        }
      } finally {
        importBtn.disabled = false;
      }
    });
  }
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = 'Checking…';
      try {
        await fetchRuntimeStatus('refresh');
      } finally {
        retryBtn.disabled = false;
        retryBtn.textContent = 'Check Again';
      }
    });
  }
})();
if (settingsVerifyBtn) {
  settingsVerifyBtn.addEventListener('click', async () => {
    const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    setSettingsNote('');
    setButtonLoading(settingsVerifyBtn, true);
    await waitForUiPaint();
    try {
      const res = await fetchRuntimeStatus('verifyModel');
      if (res && res.ok) {
        setSettingsNote('Model checksum verified.', 'info');
      } else {
        setSettingsNote((res && res.message) || 'Checksum verification failed.');
      }
    } finally {
      await ensureMinLoading(startedAt);
      setButtonLoading(settingsVerifyBtn, false);
    }
  });
}
if (settingsProviderSelect) {
  settingsProviderSelect.addEventListener('change', () => {
    appSettings.inferenceProvider = remoteProvidersEnabled && Object.prototype.hasOwnProperty.call(inferenceProviderDefs, settingsProviderSelect.value)
      ? String(settingsProviderSelect.value || 'local').trim().toLowerCase()
      : 'local';
    syncSettingsProviderUi();
    saveSettingsFromUi({ toast: false });
  });
}
settingsNavButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    openSettingsSection(btn.dataset.settingsSection || 'general');
  });
});
if (settingsWorkModeCoding) {
  settingsWorkModeCoding.addEventListener('change', () => {
    if (settingsWorkModeCoding.checked) {
      appSettings.workMode = 'coding';
      syncSettingsWorkModeUi();
      saveSettingsFromUi({ toast: false });
    }
  });
}
if (settingsWorkModeEveryday) {
  settingsWorkModeEveryday.addEventListener('change', () => {
    if (settingsWorkModeEveryday.checked) {
      appSettings.workMode = 'everyday';
      syncSettingsWorkModeUi();
      saveSettingsFromUi({ toast: false });
    }
  });
}
if (settingsApiModelPreset) {
  settingsApiModelPreset.addEventListener('change', () => {
    if (!settingsApiModelInput || !settingsProviderSelect) return;
    const preset = String(settingsApiModelPreset.value || '').trim();
    if (!preset || preset === '__custom__') {
      settingsApiModelInput.focus();
      settingsApiModelInput.select();
      return;
    }
    settingsApiModelInput.value = preset;
    saveSettingsFromUi({ toast: false });
  });
}
if (settingsApiModelInput) {
  settingsApiModelInput.addEventListener('input', () => {
    if (!settingsApiModelPreset || !settingsProviderSelect) return;
    const provider = String(settingsProviderSelect.value || 'local').trim().toLowerCase();
    settingsApiModelPreset.value = getProviderPresetValue(provider, settingsApiModelInput.value);
    scheduleSettingsAutosave();
  });
}
if (settingsApiKeyInput) {
  settingsApiKeyInput.addEventListener('input', () => scheduleSettingsAutosave());
}
if (settingsApiKeyToggle && settingsApiKeyInput) {
  const eyeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeOffIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 5.1A9.6 9.6 0 0 1 12 5c6.4 0 10 7 10 7a17.7 17.7 0 0 1-3.1 4M6.4 6.5A17.7 17.7 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4-.86"/><path d="M9.6 9.6a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>';
  const renderSecretToggle = () => {
    const shown = settingsApiKeyInput.type === 'text';
    settingsApiKeyToggle.innerHTML = shown ? eyeOffIcon : eyeIcon;
    settingsApiKeyToggle.setAttribute('aria-pressed', shown ? 'true' : 'false');
    settingsApiKeyToggle.setAttribute('aria-label', shown ? 'Hide API key' : 'Show API key');
  };
  settingsApiKeyToggle.addEventListener('click', () => {
    settingsApiKeyInput.type = settingsApiKeyInput.type === 'password' ? 'text' : 'password';
    renderSecretToggle();
    settingsApiKeyInput.focus();
  });
  renderSecretToggle();
}
if (settingsApiEndpointInput) {
  settingsApiEndpointInput.addEventListener('input', () => scheduleSettingsAutosave());
}
if (settingsModelUrlInput) {
  settingsModelUrlInput.addEventListener('input', () => scheduleSettingsAutosave());
}
if (settingsKeepModelChk) {
  settingsKeepModelChk.addEventListener('change', () => saveSettingsFromUi({ toast: false }));
}
if (settingsDebugTraceChk) {
  settingsDebugTraceChk.addEventListener('change', () => saveSettingsFromUi({ toast: false }));
}
if (settingsSaveBtn) {
  settingsSaveBtn.addEventListener('click', async () => {
    const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    setButtonLoading(settingsSaveBtn, true);
    await waitForUiPaint();
    try {
      saveSettingsFromUi({ toast: true });
      await ensureMinLoading(startedAt, 180);
    } finally {
      setButtonLoading(settingsSaveBtn, false);
    }
  });
}
if (settingsDebugDumpBtn) {
  settingsDebugDumpBtn.addEventListener('click', async () => {
    const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    setButtonLoading(settingsDebugDumpBtn, true);
    await waitForUiPaint();
    try {
      const scopedChatId = inNewChatMode ? '' : String(activeChatId || '');
      let text = dumpDebugTrace(14, scopedChatId);
      let usedScope = scopedChatId;
      if (scopedChatId && /^Debug trace is empty for chat /i.test(text)) {
        text = dumpDebugTrace(24, '');
        usedScope = '';
      }
      const copied = await copyTextToClipboard(text);
      const debugEnabled = Boolean(appSettings.debugTraceEnabled);
      setSettingsNote(
        copied
          ? (usedScope
            ? 'Debug trace for active chat copied to clipboard. Use :debug dump in chat for inline view.'
            : 'Debug trace copied to clipboard.')
          : (usedScope
            ? 'Debug trace for active chat ready. Use :debug dump in chat for inline view.'
            : 'Debug trace ready. Use :debug dump in chat for inline view.'),
        'info'
      );
      if (!debugEnabled) {
        setSettingsNote('Debug trace is OFF. Enable "Debug trace" and Save Settings, then retry.', 'info');
      }
    } finally {
      await ensureMinLoading(startedAt, 180);
      setButtonLoading(settingsDebugDumpBtn, false);
    }
  });
}
if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettingsModal);
if (settingsBackdrop) {
  settingsBackdrop.addEventListener('click', (e) => {
    if (e.target === settingsBackdrop) {
      closeSettingsModal();
    }
  });
}
if (composerPlusBtn) {
  composerPlusBtn.addEventListener('click', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
    setComposerMenuOpen(!composerMenuOpen);
  });
}
if (menuCanvasBtn) {
  menuCanvasBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
    setCanvasMode(!canvasModeEnabled);
    syncInputAugmentState();
    setComposerMenuOpen(false);
  });
}
if (menuAttachBtn) {
  menuAttachBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
    void openAttachPicker();
    setComposerMenuOpen(false);
  });
}
if (menuAgentBtn) {
  menuAgentBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
    setDeveloperAgentMode(!developerAgentEnabled);
    syncInputAugmentState();
    setComposerMenuOpen(false);
  });
}
if (menuThinkBtn) {
  menuThinkBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
    setThinkMode(!thinkModeEnabled);
    syncInputAugmentState();
    setComposerMenuOpen(false);
  });
}
if (menuContextBtn) {
  menuContextBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
    editManualContext();
    setComposerMenuOpen(false);
  });
}
if (expImportBtn) {
  expImportBtn.addEventListener('click', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    setExplorerMoreMenuOpen(false);
    setExplorerImportMenuOpen(!explorerImportMenuOpen);
  });
}
if (expMoreBtn) {
  expMoreBtn.addEventListener('click', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    setExplorerImportMenuOpen(false);
    setExplorerMoreMenuOpen(!explorerMoreMenuOpen);
  });
}
if (canvasBtn) {
  canvasBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
    setCanvasMode(false);
    syncInputAugmentState();
  });
}
if (attachBtn) {
  attachBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
    clearPendingAttachments();
  });
}
if (agentBtn) {
  agentBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
    setDeveloperAgentMode(false);
    syncInputAugmentState();
  });
}
if (thinkBtn) {
  thinkBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
    setThinkMode(false);
    syncInputAugmentState();
  });
}
if (contextBtn) {
  contextBtn.addEventListener('click', (event) => {
    if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
    const clearTarget = event && event.target && typeof event.target.closest === 'function'
      ? event.target.closest('.close-on-hover')
      : null;
    if (clearTarget) {
      setActiveManualContext('');
      updateContextButtonState();
      syncInputAugmentState();
      return;
    }
    editManualContext();
  });
}
if (micBtn) {
  micBtn.addEventListener('click', () => {
    startDictationFromMic();
  });
}
if (dictationCancelBtn) {
  dictationCancelBtn.addEventListener('click', () => {
    stopDictation();
    clearPendingDictationTranscript();
  });
}
if (dictationApplyBtn) {
  dictationApplyBtn.addEventListener('click', () => {
    applyPendingDictationTranscript();
  });
}
document.addEventListener('click', (evt) => {
  const target = evt.target;
  if (composerMenuOpen) {
    if (!(composerMenu && composerMenu.contains(target)) && !(composerPlusBtn && composerPlusBtn.contains(target))) {
      setComposerMenuOpen(false);
    }
  }
  if (explorerImportMenuOpen) {
    const inImport = expImportMenu && expImportMenu.contains(target);
    const onImportBtn = expImportBtn && expImportBtn.contains(target);
    if (!inImport && !onImportBtn) setExplorerImportMenuOpen(false);
  }
  if (explorerMoreMenuOpen) {
    const inMore = expMoreMenu && expMoreMenu.contains(target);
    const onMoreBtn = expMoreBtn && expMoreBtn.contains(target);
    if (!inMore && !onMoreBtn) setExplorerMoreMenuOpen(false);
  }
});
if (attachFileInput) {
  attachFileInput.addEventListener('change', () => {
    void handleAttachSelection(attachFileInput.files);
  });
}
if (authUserInput) {
  authUserInput.addEventListener('input', () => setAuthNote(''));
  authUserInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (authPassInput && authMode !== 'account') {
        authPassInput.focus();
      }
    }
  });
}
if (authPassInput) {
  authPassInput.addEventListener('input', () => setAuthNote(''));
  authPassInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (authMode === 'signup' && authConfirmInput) {
        authConfirmInput.focus();
        return;
      }
      void handleAuthAction();
    }
  });
}
if (authConfirmInput) {
  authConfirmInput.addEventListener('input', () => setAuthNote(''));
  authConfirmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleAuthAction();
    }
  });
}
if (fileViewerEditor) {
  fileViewerEditor.addEventListener('input', () => {
    setActiveFileTabContent(fileViewerEditor.value);
  });
  fileViewerEditor.addEventListener('scroll', () => {
    syncFileViewerScroll();
  });
  fileViewerEditor.addEventListener('click', () => {
    updateFileViewerCurrentLine();
  });
  fileViewerEditor.addEventListener('mouseup', () => {
    updateFileViewerCurrentLine();
  });
  fileViewerEditor.addEventListener('keyup', () => {
    updateFileViewerCurrentLine();
  });
  fileViewerEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const start = Number(fileViewerEditor.selectionStart || 0);
      const end = Number(fileViewerEditor.selectionEnd || 0);
      const value = String(fileViewerEditor.value || '');
      const next = `${value.slice(0, start)}  ${value.slice(end)}`;
      fileViewerEditor.value = next;
      fileViewerEditor.selectionStart = fileViewerEditor.selectionEnd = start + 2;
      setActiveFileTabContent(next);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      setFileViewerSearchOpen(true);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveFileTab();
    }
  });
}
if (fileViewerGutterLines) {
  fileViewerGutterLines.addEventListener('click', (e) => {
    const lineEl = e.target instanceof Element ? e.target.closest('.file-viewer-gutter-line') : null;
    if (!lineEl || !fileViewerEditor) return;
    const lineNumber = Number(lineEl.getAttribute('data-line') || 1);
    selectFileViewerLine(lineNumber, { focusEditor: true, reveal: false });
  });
}
if (fileViewerSearchInput) {
  fileViewerSearchInput.addEventListener('input', () => {
    updateFileViewerSearch();
  });
  fileViewerSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyFileViewerSearchSelection(fileViewerSearchState.index + (e.shiftKey ? -1 : 1));
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setFileViewerSearchOpen(false);
      fileViewerEditor && fileViewerEditor.focus();
    }
  });
}
if (fileViewerSearchPrev) {
  fileViewerSearchPrev.addEventListener('click', () => {
    applyFileViewerSearchSelection(fileViewerSearchState.index - 1);
  });
}
if (fileViewerSearchNext) {
  fileViewerSearchNext.addEventListener('click', () => {
    applyFileViewerSearchSelection(fileViewerSearchState.index + 1);
  });
}
if (fileViewerSearchClose) {
  fileViewerSearchClose.addEventListener('click', () => {
    setFileViewerSearchOpen(false);
    if (fileViewerEditor) fileViewerEditor.focus();
  });
}
document.addEventListener('keydown', (e) => {
  // Inline explorer drafts (new file/folder, rename): the embedded webview does
  // not always focus the draft input, so its own Enter/Escape handlers can't
  // fire. Handle them here independently of focus, and preventDefault so macOS
  // doesn't beep on the unfocused keystroke. If the input IS focused, let its
  // own handler do the work to avoid double-committing.
  if ((workspaceDraft || workspaceRenameDraft) && (e.key === 'Enter' || e.key === 'Escape')) {
    const active = document.activeElement;
    const activeIsDraftInput = Boolean(
      active && active.classList && active.classList.contains('ws-draft-input'),
    );
    if (!activeIsDraftInput) {
      e.preventDefault();
      const liveInput = (rightSidebar || document).querySelector('.ws-draft-input');
      if (e.key === 'Escape') {
        if (workspaceRenameDraft) cancelWorkspaceRenameDraft();
        if (workspaceDraft) cancelWorkspaceDraft();
      } else if (workspaceRenameDraft) {
        void commitWorkspaceRenameDraft(liveInput ? liveInput.value : workspaceRenameDraft.name);
      } else if (workspaceDraft) {
        void commitWorkspaceDraft(liveInput ? liveInput.value : workspaceDraft.name);
      }
      return;
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    const activeFileTab = getActiveFileTab();
    if (activeFileTab) {
      if (fileViewerSurface && fileViewerSurface.classList.contains('cm-active')) {
        return;
      }
      e.preventDefault();
      setFileViewerSearchOpen(true);
      return;
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    const activeFileTab = getActiveFileTab();
    if (activeFileTab) {
      e.preventDefault();
      void saveFileTab(activeFileTab);
      return;
    }
  }
  if (e.key === 'Escape') {
    if (fileViewerSearch && !fileViewerSearch.classList.contains('hidden')) {
      setFileViewerSearchOpen(false);
      if (fileViewerEditor) fileViewerEditor.focus();
      return;
    }
    setComposerMenuOpen(false);
    closeExplorerMenus();
    stopDictationForEscape();
    closeChatActionModal();
    closeAuthModal();
    closeSettingsModal();
    cancelWorkspaceRenameDraft(false);
    cancelWorkspaceDraft();
    clearWorkspaceDragExpandTimers();
  }
  if (e.key === 'F2') {
    const tag = String((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) {
      return;
    }
    e.preventDefault();
    void startWorkspaceRenameSelected();
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    const tag = String((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) {
      return;
    }
    if (workspaceSelectedPaths.size > 0 && !workspaceRenameDraft) {
      e.preventDefault();
      void deleteSelectedWorkspaceItems();
    }
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    openWorkspaceProject();
  }
});

// New-file/folder and rename are inline inputs in the explorer. Focus can be
// unreliable in the embedded webview, so don't depend solely on the input's
// blur to discard them — cancel a pending draft on any pointerdown that lands
// outside the draft input. This guarantees click-away removes an unconfirmed
// draft even when the input never received focus (and so never blurred).
document.addEventListener('pointerdown', (evt) => {
  if (!workspaceDraft && !workspaceRenameDraft) return;
  const target = evt.target;
  const insideDraft = target && typeof target.closest === 'function'
    && target.closest('.ws-draft, .ws-draft-input');
  if (insideDraft) return;
  if (workspaceDraft) cancelWorkspaceDraft();
  if (workspaceRenameDraft) cancelWorkspaceRenameDraft();
}, true);

// Clicking empty space in the explorer (not on a row) selects the root folder,
// so the next New File/Folder lands at the project root by default.
if (folderArea) {
  folderArea.addEventListener('click', (evt) => {
    const target = evt.target;
    if (target && typeof target.closest === 'function'
      && target.closest('.ws-row, .ws-draft-input, .exp-icon-btn, .exp-menu')) {
      return;
    }
    if (workspaceDraft || workspaceRenameDraft) return;
    if (!String(workspaceRootName || '').trim()) return;
    if (workspaceCurrentPath === '/' && workspaceSelectedPaths.has('/') && workspaceSelectedPaths.size === 1) return;
    setWorkspaceSelection('/', 'folder');
    void renderArtifacts();
  });
}

function renderHistory() {
  if (chatShell && typeof chatShell.renderHistory === 'function') {
    return chatShell.renderHistory();
  }
  return undefined;
}

function loadHistory(chatId) {
  if (chatShell && typeof chatShell.loadHistory === 'function') {
    return chatShell.loadHistory(chatId);
  }
  return undefined;
}

function escapeHtml(value) {
  return markdownRendererApi.escapeHtml
    ? markdownRendererApi.escapeHtml(value)
    : String(value || '');
}

function sanitizeHref(rawHref) {
  return markdownRendererApi.sanitizeHref
    ? markdownRendererApi.sanitizeHref(rawHref)
    : '';
}

// Pinned phased-build tracker. Run-scoped state set by the agent loop; rendered
// as its own card above the input for the owning chat. (.aiexe/plan.md = truth.)
let activePhaseTracker = null;
let phaseTrackerCollapsed = false;
// Accordion: which phase rows are expanded (re-seeded to the active phase when it
// advances; the user can open/close any phase in between).
const phaseTrackerExpanded = new Set();
let phaseTrackerExpandedFor = -1;
const AGENT_PLAN_FILE = '/.aiexe/plan.md';

// A phase is done when it has tasks and they're all ticked (or a task-less phase
// is explicitly flagged done) — derived from plan.md state, not position.
function phaseIsDone(phase) {
  if (!phase) return false;
  const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
  return tasks.length ? tasks.every((t) => t && t.done) : Boolean(phase.done);
}

// Snapshot the tracker on the owning chat so it survives reload (cleared when done).
function persistPhaseTrackerToChat(state) {
  try {
    const cid = state && state.chatId;
    if (!cid) return;
    const chat = findChatById(cid);
    if (!chat) return;
    chat.phaseTracker = (state.allDone || !Array.isArray(state.phases) || state.phases.length < 2)
      ? null
      : { projectName: String(state.projectName || ''), phases: state.phases, activeIndex: Number(state.activeIndex) || 0 };
    saveChats();
  } catch (_) { /* best-effort */ }
}

function setAgentPhaseTracker(state) {
  activePhaseTracker = state && typeof state === 'object' ? state : null;
  if (activePhaseTracker) persistPhaseTrackerToChat(activePhaseTracker);
  renderPhaseTracker();
}

function clearAgentPhaseTracker(chatId) {
  if (activePhaseTracker && chatId && activePhaseTracker.chatId !== chatId) return;
  const ownerId = (activePhaseTracker && activePhaseTracker.chatId) || chatId;
  activePhaseTracker = null;
  try {
    const chat = ownerId ? findChatById(ownerId) : null;
    if (chat && chat.phaseTracker) { chat.phaseTracker = null; saveChats(); }
  } catch (_) { /* best-effort */ }
  renderPhaseTracker();
}

async function openAgentPlanFile() {
  try {
    await openFileTab(AGENT_PLAN_FILE, 'plan.md');
  } catch (_) { /* file may not exist yet */ }
}

function renderPhaseTracker() {
  if (!phaseTracker) return;
  // Rehydrate from the active chat's snapshot after reload / chat switch.
  const activeChatForTracker = typeof getActiveChat === 'function' ? getActiveChat() : null;
  if (activeChatForTracker && activeChatForTracker.phaseTracker
    && (!activePhaseTracker || activePhaseTracker.chatId !== activeChatForTracker.id)) {
    activePhaseTracker = {
      chatId: activeChatForTracker.id,
      projectName: String(activeChatForTracker.phaseTracker.projectName || ''),
      phases: Array.isArray(activeChatForTracker.phaseTracker.phases) ? activeChatForTracker.phaseTracker.phases : [],
      activeIndex: Number(activeChatForTracker.phaseTracker.activeIndex) || 0,
      allDone: false,
    };
  }
  const state = activePhaseTracker;
  const phases = state && Array.isArray(state.phases) ? state.phases.filter((p) => p && p.title) : [];
  const visible = Boolean(state && phases.length > 1 && state.chatId === activeChatId && !state.allDone);
  if (!visible) {
    phaseTracker.classList.remove('visible', 'fading');
    phaseTracker.classList.add('hidden');
    phaseTracker.setAttribute('aria-hidden', 'true');
    phaseTracker.innerHTML = '';
    return;
  }
  const activeIndex = Math.max(0, Math.min(phases.length - 1, Number(state.activeIndex) || 0));
  // Re-seed the open accordion to the active phase whenever it advances.
  if (phaseTrackerExpandedFor !== activeIndex) {
    phaseTrackerExpandedFor = activeIndex;
    phaseTrackerExpanded.clear();
    phaseTrackerExpanded.add(activeIndex);
  }
  const name = String(state.projectName || '').trim();
  const doneTotal = phases.filter((p) => phaseIsDone(p)).length;
  const headLabel = `${name ? `Building ${escapeHtml(name)}` : 'Building'} · Phase ${activeIndex + 1} of ${phases.length}`;
  const chevron = '<svg class="phase-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  const rows = phases.map((phase, i) => {
    const done = phaseIsDone(phase);
    const status = done ? 'done' : (i === activeIndex ? 'active' : 'pending');
    const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
    const doneCount = tasks.filter((t) => t && t.done).length;
    const count = tasks.length ? `<span class="phase-row-count">${doneCount}/${tasks.length}</span>` : '';
    const expanded = phaseTrackerExpanded.has(i);
    const check = `<span class="phase-row-check ${status}">${done ? '✓' : ''}</span>`;
    let tasksHtml = '';
    if (expanded && tasks.length) {
      tasksHtml = `<div class="phase-row-tasks">${tasks.map((t) => {
        const tdone = Boolean(t && t.done);
        return `<div class="phase-task${tdone ? ' done' : ''}"><span class="phase-task-box">${tdone ? '✓' : ''}</span><span class="phase-task-label">${escapeHtml(String((t && t.text) || ''))}</span></div>`;
      }).join('')}</div>`;
    }
    return `<div class="phase-row ${status}${expanded ? ' expanded' : ''}">`
      + `<button class="phase-row-main" type="button" data-phase-toggle="${i}" aria-expanded="${expanded ? 'true' : 'false'}"${tasks.length ? '' : ' disabled'}>`
      + `${check}<span class="phase-row-title">Phase ${i + 1} · ${escapeHtml(String(phase.title || ''))}</span>${count}${tasks.length ? chevron : ''}`
      + `</button>${tasksHtml}</div>`;
  }).join('');
  phaseTracker.innerHTML = `
    <div class="phase-tracker-head">
      <button class="phase-tracker-collapse" type="button" id="phaseTrackerCollapse" aria-label="${phaseTrackerCollapsed ? 'Expand phases' : 'Collapse phases'}" aria-expanded="${phaseTrackerCollapsed ? 'false' : 'true'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
      <span class="phase-tracker-title">${headLabel}</span>
      <span class="phase-tracker-progress">${doneTotal}/${phases.length}</span>
      <button class="phase-tracker-viewplan" type="button" id="phaseTrackerViewPlan">View plan</button>
    </div>
    <div class="phase-tracker-phases">${rows}</div>`;
  phaseTracker.classList.remove('hidden', 'fading');
  phaseTracker.classList.toggle('collapsed', phaseTrackerCollapsed);
  phaseTracker.classList.add('visible');
  phaseTracker.setAttribute('aria-hidden', 'false');
  const viewBtn = document.getElementById('phaseTrackerViewPlan');
  if (viewBtn) viewBtn.addEventListener('click', openAgentPlanFile);
  const collapseBtn = document.getElementById('phaseTrackerCollapse');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      phaseTrackerCollapsed = !phaseTrackerCollapsed;
      renderPhaseTracker();
    });
  }
  phaseTracker.querySelectorAll('[data-phase-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-phase-toggle'));
      if (phaseTrackerExpanded.has(idx)) phaseTrackerExpanded.delete(idx);
      else phaseTrackerExpanded.add(idx);
      renderPhaseTracker();
    });
  });
}

function renderInlineMarkdown(text) {
  return markdownRendererApi.renderInlineMarkdown
    ? markdownRendererApi.renderInlineMarkdown(text)
    : escapeHtml(text);
}

function normalizeCodeLanguage(lang) {
  return markdownRendererApi.normalizeCodeLanguage
    ? markdownRendererApi.normalizeCodeLanguage(lang)
    : String(lang || '').trim().toLowerCase();
}

function highlightCodeHtml(code, lang) {
  return markdownRendererApi.highlightCodeHtml
    ? markdownRendererApi.highlightCodeHtml(code, lang)
    : escapeHtml(code);
}

function renderMarkdownHtml(text) {
  return markdownRendererApi.renderMarkdownHtml
    ? markdownRendererApi.renderMarkdownHtml(text)
    : escapeHtml(text);
}

function attachCodeCopyButtons(container) {
  if (markdownRendererApi.attachCodeCopyButtons) {
    markdownRendererApi.attachCodeCopyButtons(container);
  }
}

function buildThinkingState(...args) {
  return chatRendererApi.buildThinkingState
    ? chatRendererApi.buildThinkingState(...args)
    : { text: '', inProgress: false };
}

function normalizeImplicitThinkingTrace(...args) {
  return chatRendererApi.normalizeImplicitThinkingTrace
    ? chatRendererApi.normalizeImplicitThinkingTrace(...args)
    : String(args[0] || '');
}

function normalizeStandaloneFinalAnswer(...args) {
  return chatRendererApi.normalizeStandaloneFinalAnswer
    ? chatRendererApi.normalizeStandaloneFinalAnswer(...args)
    : String(args[0] || '').trim();
}

function buildThinkingLoader(...args) {
  return chatRendererApi.buildThinkingLoader
    ? chatRendererApi.buildThinkingLoader(...args)
    : document.createElement('div');
}

function buildAgentProgressMarker(...args) {
  return chatRendererApi.buildAgentProgressMarker
    ? chatRendererApi.buildAgentProgressMarker(...args)
    : String(args[0] || '');
}

function parseAgentProgressMarker(...args) {
  return chatRendererApi.parseAgentProgressMarker
    ? chatRendererApi.parseAgentProgressMarker(...args)
    : '';
}

function formatAgentWorkedDuration(...args) {
  return chatRendererApi.formatAgentWorkedDuration
    ? chatRendererApi.formatAgentWorkedDuration(...args)
    : '0s';
}

function normalizeAgentActivities(...args) {
  return chatRendererApi.normalizeAgentActivities
    ? chatRendererApi.normalizeAgentActivities(...args)
    : [];
}

function normalizeAgentMeta(...args) {
  return chatRendererApi.normalizeAgentMeta
    ? chatRendererApi.normalizeAgentMeta(...args)
    : null;
}

function cloneAgentActivities(...args) {
  return chatRendererApi.cloneAgentActivities
    ? chatRendererApi.cloneAgentActivities(...args)
    : [];
}

function cloneAgentMeta(...args) {
  return chatRendererApi.cloneAgentMeta
    ? chatRendererApi.cloneAgentMeta(...args)
    : null;
}

function mergeAgentActivityIntoList(...args) {
  return chatRendererApi.mergeAgentActivityIntoList
    ? chatRendererApi.mergeAgentActivityIntoList(...args)
    : args[0];
}

function ensureActiveAgentStreamState(...args) {
  return chatRendererApi.ensureActiveAgentStreamState
    ? chatRendererApi.ensureActiveAgentStreamState(...args)
    : null;
}

function resetActiveAgentStreamState(...args) {
  if (chatRendererApi.resetActiveAgentStreamState) {
    return chatRendererApi.resetActiveAgentStreamState(...args);
  }
  return undefined;
}

function setActiveAgentStreamStatus(...args) {
  if (chatRendererApi.setActiveAgentStreamStatus) {
    return chatRendererApi.setActiveAgentStreamStatus(...args);
  }
  return undefined;
}

function pushActiveAgentStreamActivity(...args) {
  if (chatRendererApi.pushActiveAgentStreamActivity) {
    return chatRendererApi.pushActiveAgentStreamActivity(...args);
  }
  return undefined;
}

function buildAgentActivityFromToolResult(...args) {
  return chatRendererApi.buildAgentActivityFromToolResult
    ? chatRendererApi.buildAgentActivityFromToolResult(...args)
    : null;
}

function buildAgentPendingActivity(...args) {
  return chatRendererApi.buildAgentPendingActivity
    ? chatRendererApi.buildAgentPendingActivity(...args)
    : null;
}

function buildAgentPlanActivity(...args) {
  return chatRendererApi.buildAgentPlanActivity
    ? chatRendererApi.buildAgentPlanActivity(...args)
    : null;
}

function buildAgentCorrectionActivity(...args) {
  return chatRendererApi.buildAgentCorrectionActivity
    ? chatRendererApi.buildAgentCorrectionActivity(...args)
    : null;
}

function buildAgentActivityPanel(...args) {
  return chatRendererApi.buildAgentActivityPanel
    ? chatRendererApi.buildAgentActivityPanel(...args)
    : document.createElement('div');
}

function buildAgentProgressMarker(...args) {
  return chatRendererApi.buildAgentProgressMarker
    ? chatRendererApi.buildAgentProgressMarker(...args)
    : `__AGENT_PROGRESS__:${String(args[0] || '').trim()}`;
}

function hasCanvasTokenStarted(...args) {
  return chatRendererApi.hasCanvasTokenStarted
    ? chatRendererApi.hasCanvasTokenStarted(...args)
    : false;
}

function buildCanvasLoader(...args) {
  return chatRendererApi.buildCanvasLoader
    ? chatRendererApi.buildCanvasLoader(...args)
    : document.createElement('div');
}

function populateAssistantBubble(...args) {
  if (chatRendererApi.populateAssistantBubble) {
    return chatRendererApi.populateAssistantBubble(...args);
  }
  return undefined;
}

function buildMsgNode(...args) {
  return chatRendererApi.buildMsgNode
    ? chatRendererApi.buildMsgNode(...args)
    : document.createElement('div');
}

function renderActiveChat(...args) {
  updateTokenRing();
  let result;
  if (chatRendererApi.renderActiveChat) {
    result = chatRendererApi.renderActiveChat(...args);
  }
  // After the chat is drawn, re-evaluate per-view inference gating: the composer
  // lockout and cancel-mode belong only to the chat that owns the run, and
  // returning to that chat reattaches its live progress row.
  syncAgentElapsedStatusForActiveChat();
  syncLiveInferenceUiState();
  renderPhaseTracker();
  return result;
}

function createChat(seedText) {
  const ts = nowTs();
  const id = makeChatId();
  const chat = {
    id,
    name: 'New Chat',
    customName: false,
    isNaming: true,
    autoNamed: false,
    createdAt: ts,
    updatedAt: ts,
    messages: [],
    needsContinue: false,
    canvasMode: Boolean(canvasModeEnabled),
    agentMode: Boolean(developerAgentEnabled),
    thinkMode: Boolean(thinkModeEnabled),
    pendingAttachments: normalizePendingAttachmentList(pendingAttachments),
    manualContext: String(pendingManualContext || '').trim(),
    branchLinks: [],
    threads: [],
    activeThreadId: '',
  };
  ensureChatThreadState(chat);
  chats.unshift(chat);
  activeChatId = chat.id;
  inNewChatMode = false;
  pushDebugTrace('chat_created', {
    chatId: chat.id,
    name: chat.name,
  });
  saveChats();
  renderHistory();
  syncSidebarNavState();
  return chat;
}

function startNewChat() {
  if (chatShell && typeof chatShell.startNewChat === 'function') {
    return chatShell.startNewChat();
  }
  return undefined;
}

function appendErrorMessageToChat(chatId, text, forcedTs = 0) {
  return appendMessageToChat(chatId, 'error', humanizeAssistantErrorText(text), forcedTs);
}

function appendMessageToChat(chatId, role, text, forcedTs = 0, options = {}) {
  const chat = findChatById(chatId);
  if (!chat) return null;
  const activeThread = getChatActiveThread(chat);
  if (!activeThread) return null;
  const cleaned = (text || '').trim();
  if (!cleaned) return null;

  const ts = Number(forcedTs) || nowTs();
  const message = { role, text: cleaned, ts };
  let shouldScheduleSmartRename = false;
  if (role === 'ai' && typeof options.thinking === 'string' && options.thinking.trim()) {
    message.thinking = options.thinking.trim();
  }
  if (role === 'ai' && options.thinkingMeta && typeof options.thinkingMeta === 'object') {
    message.thinkingMeta = {
      startedAt: Number(options.thinkingMeta.startedAt) || 0,
      completedAt: Number(options.thinkingMeta.completedAt) || 0,
    };
  }
  if (role === 'ai' && Array.isArray(options.agentActivities) && options.agentActivities.length > 0) {
    message.agentActivities = cloneAgentActivities(options.agentActivities);
  }
  if (role === 'ai' && options.agentMeta) {
    message.agentMeta = cloneAgentMeta(options.agentMeta);
  }
  activeThread.messages.push(message);
  chat.updatedAt = ts;

  if (role === 'ai') {
    if (activeThread.pendingBranchLink && typeof activeThread.pendingBranchLink === 'object') {
      const groupId = String(activeThread.pendingBranchLink.groupId || '').trim();
      const order = Number(activeThread.pendingBranchLink.order) || 0;
      const anchorTs = Number(activeThread.pendingBranchLink.anchorTs) || ts;
      const kind = String(activeThread.pendingBranchLink.kind || '').trim().toLowerCase();
      if (groupId) {
        setChatBranchLink(activeThread, anchorTs, groupId, order, kind);
        message.branchAnchorTs = anchorTs;
      }
      activeThread.pendingBranchLink = null;
    }
    if (typeof options.forceNeedsContinue === 'boolean') {
      activeThread.needsContinue = options.forceNeedsContinue;
    } else {
      activeThread.needsContinue = isLikelyIncompleteResponse(cleaned);
    }
    // Detect model looping: if AI repeated the exact same response back-to-back, flag it.
    const prevAi = [...activeThread.messages].reverse().find((m, i) => i > 0 && m.role === 'ai');
    if (prevAi && prevAi.text.trim() === cleaned) {
      message.loopDetected = true;
    }
    const aiCount = activeThread.messages.filter((m) => m && m.role === 'ai' && String(m.text || '').trim()).length;
    // After the first reply, smart-rename the chat (it skips already-final names).
    shouldScheduleSmartRename = aiCount === 1;
  } else if (role === 'error') {
    activeThread.needsContinue = false;
    if (chat.isNaming && !chat.customName) {
      chat.name = 'New Chat';
      chat.isNaming = false;
    }
  }
  syncChatFromThread(chat, activeThread);
  saveChats();
  renderHistory();
  renderSidebarCounts();
  updateContinueButtonVisibility();
  if (activeChatId === chatId) {
    renderActiveChat();
  }
  updateChatScrollDownButtonVisibility();
  if (shouldScheduleSmartRename) {
    scheduleSmartChatRename(chatId);
  }
  return message;
}

function handleKey(e) {
  if (getActiveComposerPermissionRequest()) {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissComposerPermission();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      setComposerPermissionSelectedIndex(composerConfirmSelectedIndex + 1);
      renderComposerConfirmationUi();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setComposerPermissionSelectedIndex(composerConfirmSelectedIndex - 1);
      renderComposerConfirmationUi();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitComposerPermissionSelection();
      return;
    }
  }
  // Swallow Enter only in the chat that owns the running op; elsewhere
  // sendMessage queues the message.
  if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
    }
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  const cc = document.getElementById('charCount');
  if (cc) cc.textContent = `${el.value.length} / ∞`;
  updateTokenRing();
}

function clearInputBox() {
  mainInput.value = '';
  mainInput.style.height = 'auto';
  const cc = document.getElementById('charCount');
  if (cc) cc.textContent = '0 / ∞';
  updateTokenRing();
}

function setMicListeningState(listening) {
  speechRecognitionActive = Boolean(listening);
  pushDictationTrace('mic_state', { listening: speechRecognitionActive });
  if (micBtn) {
    micBtn.classList.toggle('listening', speechRecognitionActive);
    micBtn.title = speechRecognitionActive ? 'Stop dictation' : 'Dictate';
    micBtn.setAttribute('aria-label', speechRecognitionActive ? 'Stop dictation' : 'Dictate message');
  }
  if (inputRow) {
    inputRow.classList.toggle('dictation-active', speechRecognitionActive);
  }
  if (dictationBar) {
    dictationBar.classList.toggle('hidden', !speechRecognitionActive);
  }
  if (!speechRecognitionActive) {
    setDictationApplyLoading(false);
    dictationApplyPending = false;
  }
}

function stopDictation() {
  pushDictationTrace('stop', { reason: 'manual_or_state_change' });
  dictationOpToken += 1;
  dictationTranscriptInFlight = false;
  setMicListeningState(false);
  stopDictationWaveVisualizer();
  stopDictationLevelPolling();
  if (nativeBridge.available()) {
    nativeBridge.invoke('dictationCancel', {}).catch(() => { });
  }
}

function clearPendingDictationTranscript() {
  pushDictationTrace('clear_transcript');
  pendingDictationTranscript = '';
  dictationTranscriptInFlight = false;
  setDictationApplyLoading(false);
  dictationApplyPending = false;
}

function startDictationLevelPolling() {
  stopDictationLevelPolling();
  if (!nativeBridge.available()) return;
  const poll = async () => {
    if (!speechRecognitionActive) return;
    try {
      const res = await nativeBridge.invoke('dictationLevel', {});
      const raw = Number.parseFloat(String((res && res.output) || '0'));
      if (Number.isFinite(raw)) {
        dictationNativeLevel = Math.max(0, Math.min(1, raw));
      }
    } catch (_) { }
  };
  poll();
  dictationLevelPollTimer = window.setInterval(poll, 70);
}

function stopDictationLevelPolling() {
  if (dictationLevelPollTimer) {
    clearInterval(dictationLevelPollTimer);
    dictationLevelPollTimer = 0;
  }
  dictationNativeLevel = 0;
}

function applyPendingDictationTranscript() {
  pushDictationTrace('apply_click', {
    transcriptLen: String(pendingDictationTranscript || '').trim().length,
  });
  const text = String(pendingDictationTranscript || '').trim();
  if (!text) {
    if (speechRecognitionActive) {
      dictationApplyPending = true;
      setDictationApplyLoading(true);
      pushDictationTrace('apply_waiting_for_transcript');
      void requestDictationTranscript();
    }
    return;
  }
  if (!mainInput) {
    stopDictation();
    clearPendingDictationTranscript();
    return;
  }
  setDictationApplyLoading(false);
  dictationApplyPending = false;
  const merged = [String(mainInput.value || '').trim(), text].filter(Boolean).join(' ');
  pushDictationTrace('apply_done', { transcriptLen: text.length });
  stopDictation();
  mainInput.value = merged;
  requestAnimationFrame(() => {
    autoResize(mainInput);
    mainInput.focus();
  });
  clearPendingDictationTranscript();
}

function setDictationApplyLoading(loading) {
  if (!dictationApplyBtn) return;
  if (loading) {
    dictationApplyLoadingSinceMs = Date.now();
  }
  dictationApplyBtn.classList.toggle('loading', Boolean(loading));
  pushDictationTrace('apply_loading', { loading: Boolean(loading) });
  if (!loading && dictationApplyLoadingSinceMs > 0) {
    pushDictationTrace('apply_loading_done', {
      visibleMs: Math.max(0, Date.now() - dictationApplyLoadingSinceMs),
    });
    dictationApplyLoadingSinceMs = 0;
  }
}

function stopDictationWaveVisualizer() {
  pushDictationTrace('wave_stop');
  if (dictationWaveRaf) {
    cancelAnimationFrame(dictationWaveRaf);
    dictationWaveRaf = 0;
  }
  if (dictationWaveStream) {
    try {
      dictationWaveStream.getTracks().forEach((track) => track.stop());
    } catch (_) { }
  }
  dictationWaveStream = null;
  dictationWaveData = null;
  dictationWaveAnalyser = null;
  if (dictationWaveAudioCtx) {
    try {
      dictationWaveAudioCtx.close();
    } catch (_) { }
  }
  dictationWaveAudioCtx = null;
  dictationWaveHistory = [];
}

function drawDictationWaveFrame() {
  if (!dictationWaveCanvas || !speechRecognitionActive) return;
  const rect = dictationWaveCanvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.floor(rect.width || 0));
  const cssHeight = Math.max(1, Math.floor(rect.height || 0));
  if (cssWidth <= 1 || cssHeight <= 1) {
    dictationWaveRaf = requestAnimationFrame(drawDictationWaveFrame);
    return;
  }
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const targetWidth = Math.max(1, Math.floor(cssWidth * dpr));
  const targetHeight = Math.max(1, Math.floor(cssHeight * dpr));
  if (dictationWaveCanvas.width !== targetWidth || dictationWaveCanvas.height !== targetHeight) {
    dictationWaveCanvas.width = targetWidth;
    dictationWaveCanvas.height = targetHeight;
  }
  const ctx = dictationWaveCanvas.getContext('2d');
  if (!ctx) return;

  let amplitude = 0;
  if (dictationWaveAnalyser) {
    if (!dictationWaveData || dictationWaveData.length !== dictationWaveAnalyser.fftSize) {
      dictationWaveData = new Uint8Array(dictationWaveAnalyser.fftSize);
    }
    dictationWaveAnalyser.getByteTimeDomainData(dictationWaveData);
    let sum = 0;
    for (let i = 0; i < dictationWaveData.length; i += 1) {
      const centered = (dictationWaveData[i] - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / Math.max(1, dictationWaveData.length));
    amplitude = Math.min(1, rms * 2.8);
  } else {
    const native = Math.max(0, Math.min(1, Number(dictationNativeLevel) || 0));
    if (native > 0) {
      amplitude = native;
    } else {
      dictationWaveFallbackPhase += 0.2;
      amplitude = 0.08 + (Math.sin(dictationWaveFallbackPhase) + 1) * 0.08;
    }
  }

  const samples = Math.max(50, Math.floor(cssWidth / 3));
  dictationWaveHistory.push(amplitude);
  if (dictationWaveHistory.length > samples) {
    dictationWaveHistory.splice(0, dictationWaveHistory.length - samples);
  }

  const w = targetWidth;
  const h = targetHeight;
  const centerY = h * 0.5;
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(235, 240, 248, 0.72)';
  ctx.lineWidth = Math.max(1, dpr);
  ctx.setLineDash([2 * dpr, 2.6 * dpr]);
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(w, centerY);
  ctx.stroke();
  ctx.setLineDash([]);

  const step = 3 * dpr;
  const barW = Math.max(1, Math.round(1.4 * dpr));
  for (let i = 0; i < dictationWaveHistory.length; i += 1) {
    const value = dictationWaveHistory[dictationWaveHistory.length - 1 - i];
    const x = w - (i * step) - barW;
    if (x < 0) break;
    const barH = Math.max(2 * dpr, (h * 0.7 * value) + (1.5 * dpr));
    const y = centerY - (barH / 2);
    ctx.fillStyle = value > 0.18 ? 'rgba(246, 250, 255, 0.95)' : 'rgba(220, 229, 238, 0.75)';
    ctx.fillRect(x, y, barW, barH);
  }
  dictationWaveRaf = requestAnimationFrame(drawDictationWaveFrame);
}

async function startDictationWaveVisualizer(useMic = true) {
  stopDictationWaveVisualizer();
  if (!dictationWaveCanvas || !useMic || typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    pushDictationTrace('wave_synthetic_mode', { useMic: Boolean(useMic) });
    dictationWaveRaf = requestAnimationFrame(drawDictationWaveFrame);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    if (!speechRecognitionActive) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    dictationWaveStream = stream;
    dictationWaveAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = dictationWaveAudioCtx.createMediaStreamSource(stream);
    dictationWaveAnalyser = dictationWaveAudioCtx.createAnalyser();
    dictationWaveAnalyser.fftSize = 1024;
    dictationWaveAnalyser.smoothingTimeConstant = 0.55;
    source.connect(dictationWaveAnalyser);
    pushDictationTrace('wave_live');
  } catch (_) {
    dictationWaveAnalyser = null;
    pushDictationTrace('wave_fallback');
  }
  dictationWaveRaf = requestAnimationFrame(drawDictationWaveFrame);
}

async function startDictation() {
  if (!mainInput || pendingInferenceCount > 0) return;
  if (!nativeBridge.available()) {
    showAppNotification({
      title: 'Runtime unavailable',
      message: 'Native runtime bridge unavailable.',
      kind: 'error',
    });
    return;
  }
  pushDictationTrace('start');
  clearPendingDictationTranscript();
  dictationApplyPending = false;
  setDictationApplyLoading(false);
  setMicListeningState(true);
  // Avoid dual microphone capture (WebAudio + native Speech) which can starve native transcript capture.
  void startDictationWaveVisualizer(false);
  try {
    const res = await nativeBridge.invoke('dictationStart', {
      locale: navigator.language || 'en-US',
    });
    pushDictationTrace('native_start_response', {
      ok: Boolean(res && res.ok),
      message: String((res && res.message) || ''),
    });
    if (!res || !res.ok) {
      setMicListeningState(false);
      stopDictationWaveVisualizer();
      stopDictationLevelPolling();
      showAppNotification({
        title: 'Dictation failed',
        message: String((res && res.message) || 'Failed to start offline dictation.'),
        kind: 'error',
      });
      return;
    }
    startDictationLevelPolling();
  } catch (err) {
    setMicListeningState(false);
    stopDictationWaveVisualizer();
    stopDictationLevelPolling();
    showAppNotification({
      title: 'Dictation failed',
      message: `Failed to start offline dictation: ${String(err && err.message ? err.message : err || 'Unknown error')}`,
      kind: 'error',
    });
  }
}

async function requestDictationTranscript() {
  if (!speechRecognitionActive || dictationTranscriptInFlight) return;
  if (!nativeBridge.available()) {
    setDictationApplyLoading(false);
    dictationApplyPending = false;
    return;
  }
  dictationTranscriptInFlight = true;
  const opToken = ++dictationOpToken;
  pushDictationTrace('request_start', {
    opToken,
    locale: String(navigator.language || 'en-US'),
  });
  stopDictationWaveVisualizer();
  stopDictationLevelPolling();
  try {
    const spinnerStartedAt = Date.now();
    const res = await nativeBridge.invoke('dictationFinalize', {
      timeoutMs: 15000,
      locale: navigator.language || 'en-US',
    });
    if (opToken !== dictationOpToken) return;
    pushDictationTrace('request_finish', {
      opToken,
      ok: Boolean(res && res.ok),
      hasOutput: Boolean(String((res && res.output) || '').trim()),
      message: String((res && res.message) || ''),
    });
    const transcript = String((res && res.output) || '').trim();
    const minSpinnerMs = 300;
    const waitedMs = Date.now() - spinnerStartedAt;
    if (waitedMs < minSpinnerMs) {
      await new Promise((resolve) => setTimeout(resolve, minSpinnerMs - waitedMs));
    }
    if (res && res.ok && transcript) {
      pendingDictationTranscript = transcript;
      pushDictationTrace('transcript_ready', { opToken, transcriptLen: transcript.length });
      if (dictationApplyPending) {
        applyPendingDictationTranscript();
      } else {
        setDictationApplyLoading(false);
      }
      return;
    }
    // Keep UI non-blocking; user can retry dictation without modal alerts.
    pushDictationTrace('transcript_empty_or_failed', {
      opToken,
      message: String((res && res.message) || ''),
    });
    setDictationApplyLoading(false);
    dictationApplyPending = false;
  } catch (_) {
    if (opToken !== dictationOpToken) return;
    pushDictationTrace('request_error', { opToken });
    setDictationApplyLoading(false);
    dictationApplyPending = false;
  } finally {
    if (opToken !== dictationOpToken) return;
    dictationTranscriptInFlight = false;
    if (speechRecognitionActive && !pendingDictationTranscript.trim()) {
      pushDictationTrace('finalize_empty_stop_session', { opToken });
      stopDictation();
      clearPendingDictationTranscript();
    }
  }
}

function cancelDictationIfActive() {
  if (!speechRecognitionActive) return;
  stopDictation();
}

function maybeStopDictationForSend() {
  if (!speechRecognitionActive) return;
  stopDictation();
  clearPendingDictationTranscript();
}

function startDictationFromMic() {
  if (speechRecognitionActive) {
    stopDictation();
    return;
  }
  void startDictation();
}

function stopDictationForEscape() {
  if (!speechRecognitionActive) return;
  stopDictation();
  clearPendingDictationTranscript();
}

function emitLocalAssistantMessage(userText, assistantText) {
  if (!ensureSignedIn()) return;
  enterChatView();
  const chat = (inNewChatMode || !getActiveChat()) ? createChat(userText) : getActiveChat();
  if (!chat) return;
  chatAutoScrollPinned = true;
  appendMessageToChat(chat.id, 'user', userText);
  appendMessageToChat(chat.id, 'ai', assistantText);
}

function handleLocalCommand(rawValue) {
  const input = String(rawValue || '').trim();
  const lower = input.toLowerCase();
  if (!lower.startsWith(':debug')) return false;

  const parts = input.split(/\s+/).filter(Boolean);
  const action = (parts[1] || '').toLowerCase();
  if (action === 'on') {
    appSettings.debugTraceEnabled = true;
    saveAppSettings();
    if (settingsDebugTraceChk) settingsDebugTraceChk.checked = true;
    emitLocalAssistantMessage(input, 'Debug trace enabled.');
    return true;
  }
  if (action === 'off') {
    appSettings.debugTraceEnabled = false;
    saveAppSettings();
    if (settingsDebugTraceChk) settingsDebugTraceChk.checked = false;
    emitLocalAssistantMessage(input, 'Debug trace disabled.');
    return true;
  }
  if (action === 'clear') {
    clearDebugTraceEntries();
    emitLocalAssistantMessage(input, 'Debug trace cleared.');
    return true;
  }
  if (action === 'dump') {
    const limit = Number(parts[2] || 14);
    const scopeRaw = String(parts[3] || '').trim().toLowerCase();
    const scopeAll = scopeRaw === 'all' || scopeRaw === '*';
    const scopedChatId = scopeAll ? '' : String(activeChatId || '');
    const body = dumpDebugTrace(limit, scopedChatId);
    emitLocalAssistantMessage(input, `\`\`\`text\n${body}\n\`\`\``);
    return true;
  }
  emitLocalAssistantMessage(input, 'Debug commands: :debug on | :debug off | :debug dump [N] [all] | :debug clear');
  return true;
}

function parseThinkControl(rawValue) {
  const input = String(rawValue || '').trim();
  if (!input) return { handled: false, modelText: input, userText: input, thinkForced: false };
  const lower = input.toLowerCase();

  if (/^\/think\s+off$/.test(lower) || /^\/unthink$/.test(lower)) {
    setThinkMode(false);
    syncInputAugmentState();
    return {
      handled: true,
      infoMessage: 'Think mode disabled for this chat.',
      infoUserText: input,
      modelText: '',
      userText: '',
      thinkForced: false,
    };
  }
  if (/^\/think$/.test(lower) || /^\/think\s+on$/.test(lower)) {
    setThinkMode(true);
    syncInputAugmentState();
    return {
      handled: true,
      infoMessage: 'Think mode enabled for this chat.',
      infoUserText: input,
      modelText: '',
      userText: '',
      thinkForced: false,
    };
  }

  const withPayload = input.match(/^\/think(?:\s*[:\-]\s*|\s+)([\s\S]+)$/i);
  if (!withPayload) {
    return { handled: false, modelText: input, userText: input, thinkForced: false };
  }
  const payload = String(withPayload[1] || '').trim();
  if (!payload) {
    return { handled: false, modelText: input, userText: input, thinkForced: false };
  }
  return { handled: false, modelText: payload, userText: input, thinkForced: true };
}

const quickStartPromptMap = {
  'ANALYZE.DATA': 'Analyze this dataset and return: 1) data quality issues, 2) top trends, 3) anomalies, 4) recommended next actions.',
  'BUILD.APP': 'Help me plan and build this app end-to-end. Start with architecture, folder structure, and step-by-step implementation tasks.',
  'GEN.MODEL': 'Design a practical local AI model workflow for this use case, including data prep, training/eval strategy, and deployment notes.',
  'DEPLOY.API': 'Create a deployment plan for this API: environment setup, build/run commands, config, health checks, logging, and rollback steps.',
  'DEBUG.CODE': 'Debug this issue methodically: identify likely root causes, show verification steps, and propose the minimal safe fix.',
};

function resolveQuickStartPrompt(rawLabel) {
  const label = String(rawLabel || '').trim().toUpperCase();
  if (!label) return '';
  return quickStartPromptMap[label] || String(rawLabel || '').trim();
}

// Sends from other chats while an operation runs are queued (single-operation
// engine) and dispatched when it finishes. In-memory only: lost on reload.
const queuedSends = [];
function dispatchNextQueuedSend() {
  while (queuedSends.length) {
    const job = queuedSends.shift();
    if (!findChatById(job.chatId)) continue;
    beginInferenceRequest();
    void requestAssistantReply(job.chatId, job.prompt, true, job.options);
    return;
  }
}

function sendMessage() {
  const operationRunning = pendingInferenceCount > 0;
  if (operationRunning && isCurrentViewInferenceChat()) {
    showComposerNotice('Still responding in this chat — press stop to interrupt, or wait.');
    return;
  }
  const rawVal = mainInput.value.trim();
  if (!rawVal) return;
  maybeStopDictationForSend();
  if (handleLocalCommand(rawVal)) {
    clearInputBox();
    return;
  }
  const thinkControl = parseThinkControl(rawVal);
  if (thinkControl.handled) {
    clearInputBox();
    if (thinkControl.infoMessage) {
      emitLocalAssistantMessage(thinkControl.infoUserText || rawVal, thinkControl.infoMessage);
    }
    return;
  }
  const userText = String(thinkControl.userText || rawVal).trim();
  if (!userText) return;
  if (!ensureSignedIn()) return;
  enterChatView();
  const modelPrompt = buildPromptWithInputAugments(thinkControl.modelText || userText);
  clearInputBox();
  clearPendingAttachments();
  const chat = (inNewChatMode || !getActiveChat()) ? createChat(userText) : getActiveChat();
  if (!chat) return;
  chatAutoScrollPinned = true;
  appendMessageToChat(chat.id, 'user', userText);
  if (operationRunning) {
    queuedSends.push({
      chatId: chat.id,
      prompt: modelPrompt,
      options: { thinkForced: Boolean(thinkControl.thinkForced) },
    });
    showComposerNotice("Queued — I'll answer here as soon as the other chat finishes.");
    recordDebugTrace('send_queued', {
      chatId: String(chat.id || ''),
      queueLength: String(queuedSends.length),
    }, { chatId: chat.id, queueLength: queuedSends.length });
    return;
  }
  beginInferenceRequest();
  void requestAssistantReply(chat.id, modelPrompt, true, { thinkForced: Boolean(thinkControl.thinkForced) });
}

function sendChip(el) {
  // Chips only prefill the input — block them only in the chat that is running.
  if (pendingInferenceCount > 0 && isCurrentViewInferenceChat()) return;
  const text = resolveQuickStartPrompt(el && el.textContent ? el.textContent : '');
  if (!text || !mainInput) return;
  mainInput.value = text;
  autoResize(mainInput);
  mainInput.focus();
  const end = mainInput.value.length;
  if (typeof mainInput.setSelectionRange === 'function') {
    mainInput.setSelectionRange(end, end);
  }
}

function continueMessage() {
  // Starts a new operation — stays globally gated (single-operation architecture).
  if (pendingInferenceCount > 0) return;
  maybeStopDictationForSend();
  if (!ensureSignedIn()) return;
  enterChatView();
  const chat = getActiveChat();
  if (!chat) return;
  if (!chat.needsContinue) return;

  const lastAssistant = findLastAssistantMessage(chat);
  const lastWasAgentRun = Boolean(lastAssistant && Array.isArray(lastAssistant.agentActivities) && lastAssistant.agentActivities.length > 0);
  chat.needsContinue = false;
  // Show a visible "Continue" bubble (resume still recovers the original task).
  appendMessageToChat(chat.id, 'user', 'Continue');
  chatAutoScrollPinned = true;
  if (developerAgentEnabled && lastWasAgentRun) {
    void requestAssistantReply(chat.id, 'continue', false, {
      preflightChoiceResolved: 'agent',
      suppressChatNameInstruction: true,
    });
    return;
  }
  setChatAutoContinuing(chat.id, true);
  void startAssistantContinuation(chat.id, { autoContinuationRemaining: 0 });
}

function startAssistantContinuation(chatId, options = {}) {
  const chat = findChatById(chatId);
  if (!chat) return Promise.resolve(false);
  const continuationPrompt = buildContinuationPrompt(chatId);
  setChatAutoContinuing(chatId, true);
  return requestAssistantReply(chatId, continuationPrompt, false, {
    latestUserOverride: continuationPrompt,
    appendToLastAssistant: true,
    isContinuation: true,
    autoContinuationRemaining: Math.max(0, Number(options.autoContinuationRemaining) || 0),
  });
}


function buildRequestThinkingMeta(requestToken) {
  const token = requestToken && typeof requestToken === 'object' ? requestToken : null;
  if (!token) return null;
  const active = Boolean(thinkModeEnabled || token.thinkForced);
  if (!active) return null;
  return {
    startedAt: Number(token.startedAt) || Date.now(),
    completedAt: Date.now(),
  };
}

async function buildInferencePrompt(chatId, fallbackPrompt, options = {}) {
  return promptCoreApi.buildInferencePrompt
    ? promptCoreApi.buildInferencePrompt(chatId, fallbackPrompt, options)
    : String(fallbackPrompt || '');
}

function buildAgentHistoryTranscript(chatId, maxMessages = 14) {
  return promptCoreApi.buildAgentHistoryTranscript
    ? promptCoreApi.buildAgentHistoryTranscript(chatId, maxMessages)
    : '';
}



function stripThinkingBlocksAndFragments(text) {
  return normalizeImplicitThinkingTrace(text)
    .replace(/<(thinking|think)>[\s\S]*?<\/\1>/gi, '')
    .replace(/(?:^|\n)\s*<(thinking|think)>[\s\S]*$/i, '')
    .replace(/(?:^|\n)\s*<\s*\/?\s*t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?[^>\n]*$/i, '');
}

function sanitizeAssistantDelta(text) {
  return stripThinkingBlocksAndFragments(
    String(text || '')
      .replace(/<\|im_start\|>/gi, '')
      .replace(/<\|im_end\|>/gi, '')
      .replace(/^\s*\[\s*Prompt:[^\]]*\]\s*$/gim, '')
      .replace(/^\s*llama_memory_breakdown_print:.*$/gim, '')
      .replace(/^\s*Exiting\.\.\.\s*$/gim, '')
      .replace(/\[START OF CHAT HISTORY\]/gi, '')
      .replace(/\[END OF CHAT HISTORY\]/gi, '')
      .replace(/\[CHAT HISTORY\]/gi, '')
      .replace(/\[END HISTORY\]/gi, '')
      .replace(/AI_EXE_RESPONSE:/gi, '')
      .replace(/FINAL_RESPONSE:/gi, '')
  );
}

function sanitizeStreamDelta(text) {
  const clean = stripLeadingAiExePromptLeak(
    stripInlineChatNameMarkers(
      sanitizeAssistantDelta(String(text || '').replace(/\r/g, '')),
      { trimLeading: false }
    ),
    { trimLeading: false }
  );
  return clean.replace(/^\s*<?DONE>?\s*$/i, '');
}

function stripCanvasBlocksForDisplay(text) {
  let out = String(text || '');
  out = stripThinkingBlocksAndFragments(out);
  out = out.replace(/<AIcanvasJSON>[\s\S]*?<\/AIcanvasJSON>/gi, '');
  out = out.replace(/<AIcanvasJSON>[\s\S]*$/i, '');
  out = out.replace(/<\/AIcanvasJSON>/gi, '');
  out = out.replace(/<AIcanvas[^>]*>[\s\S]*?<\/AIcanvas>/gi, '');
  out = out.replace(/<AIcanvas[^>]*>[\s\S]*$/i, '');
  out = out.replace(/<\/AIcanvas>/gi, '');
  out = out.replace(/^canvas\s*[>:]\s*/i, '');
  out = out.replace(/^<canvas>\s*/i, '');
  out = out.replace(/<\/canvas>\s*$/i, '');
  out = out.replace(/<(?:\/)?AI[^>]*$/i, '');
  out = out.replace(/<(?:\/)?AIcan[^>]*$/i, '');
  out = out.replace(/<\/?AIcanvas[^>]*>/gi, '');
  return out;
}

function sanitizeAssistantText(text) {
  // The local llama.cpp server returns a raw error string as the "completion" when
  // the prompt overflows its context window. Don't show that to the user verbatim —
  // surface a clear, actionable message instead.
  if (/exceeds the available context size|send_error:\s*task id|tokens?\)\s*exceeds/i.test(String(text || ''))) {
    return 'This conversation got too long for the local model\'s context window (32K tokens). Start a new chat to continue, or switch to a larger-context model in Settings.';
  }
  const normalizedSource = normalizeImplicitThinkingTrace(text);
  const hadThinkingTrace = /<(thinking|think)>[\s\S]*?<\/\1>/i.test(normalizedSource);
  let clean = sanitizeAssistantDelta(text);
  // Strip leaked prompt-template markers that wrap the prior assistant turn.
  clean = clean.replace(/<\/?LAST_ASSISTANT_TAIL>/gi, '');
  clean = clean.replace(/^\s*__?AGENT_PROGRESS__?:\s*(?:Thinking|Working|Planning|Inspecting|Creating|Writing|Editing|Saving|Checking|Continuing|Starting|Finalizing|Adjusting|Stopped)\b(?:[^.\n]*\.\.\.)?\s*/gim, '');
  clean = clean.replace(/^\s*__?AGENT_PROGRESS__?:[^\n]*(?:\n|$)/gim, '');
  clean = clean.replace(/^\s*(?:Writing answer|Preparing grounded answer|Choosing relevant files|Inspecting workspace|Planning changes|Creating project workspace)\.\.\.\s*/gim, '');
  clean = clean.replace(/Output exactly one non-empty canvas block in this format:[\s\S]*?The content after --- must be non-empty\. Never leave it blank\./gi, '');
  clean = clean.replace(/Respond with ONLY a canvas block containing the full answer\./gi, '');
  clean = clean.replace(/\[\s*THINK_MODE\s*\][\s\S]*$/gi, '');
  clean = clean.replace(/\[\s*MANUAL_CONTEXT\s*\][\s\S]*$/gi, '');
  clean = stripInlineChatNameMarkers(clean);
  clean = stripLeadingLlamaEngineNoise(clean);
  clean = stripLeadingAiExePromptLeak(clean);
  // Some local-model outputs leak prompt transcript markers inline
  // (e.g. "... | [USER] ... FINAL_RESPONSE: ..."). Drop leaked tail.
  clean = clean.replace(/\|\s*\[(?:USER|ASSISTANT)\][\s\S]*$/gi, '');
  // Strip leaked model-native tool-call markup that some models emit as plain text
  // when the agent decision parser doesn't consume it (DeepSeek DSML / special-token
  // tool calls, generic <tool_calls>/<function_calls>/<invoke> blocks). These trail
  // the prose, so cut from the first opener to the end. [^A-Za-z0-9\s]{0,4} tolerates
  // the surrounding pipe characters (ASCII | or full-width ｜).
  clean = clean.replace(/<[^A-Za-z0-9\s]{0,4}\s*DSML[\s\S]*$/i, '');
  clean = clean.replace(/<\s*(?:\/\s*)?(?:tool_calls?|function_calls?|antml:invoke|antml:parameter|invoke\s+name=)\b[\s\S]*$/i, '');
  clean = clean.replace(/<[^A-Za-z0-9\s]{1,3}\s*tool[▁_\s-]*calls?[▁_\s-]*(?:begin|end)[\s\S]*$/i, '');
  // Strip hallucinated <*_file> rewrite directives chat models emit as raw text.
  clean = clean.replace(/<\s*(?:rewrite|write|edit|create|update|new|replace)_file\b[\s\S]*$/i, '');
  clean = clean
    .replace(/^\s*assistant\s*$/gim, '')
    .replace(/^\s*user\s*$/gim, '')
    .replace(/^\s*system\s*$/gim, '')
    .replace(/^\s*(?:A|U|AI|USER|ASSISTANT)\s*>\s*/gim, '')
    .replace(/^\s*\[(?:USER|ASSISTANT)\]\s*/gim, '')
    .replace(/^\s*(?:AI|ASSISTANT)\s*:\s*/gim, '')
    .replace(/^\s*Intro sentence\s*:?\s*/gim, '')
    .replace(/^\s*Outro sentence\s*:?\s*/gim, '');
  // Drop a leading meta lead-in a model echoes from a prompt's framing, e.g.
  // "Here's a natural completion message for the user:", "Completion message:",
  // "Here's the final message:", "Here's a progress note:". Targeted by the exact
  // artifact phrase + a colon, so genuine intros ("Here's your app:") are untouched.
  {
    const metaEcho = /^\s*"?\s*(?:sure[,!.]?\s*)?(?:here'?s|here is|below is|this is|okay|ok)?[^:\n]{0,60}?\b(?:completion message|message for the user|progress note|final message)\b[^:\n]{0,30}?:\s*"?\s*/i;
    const m = clean.match(metaEcho);
    if (m && clean.slice(m[0].length).trim()) clean = clean.slice(m[0].length).trim();
  }
  clean = clean
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      const lower = t.toLowerCase();
      if (!t) return true;
      if (/^(?:A|U|AI|USER|ASSISTANT)\s*>?\s*:?\s*$/i.test(t)) return false;
      if (lower === 'system: you are ai.exe, an assistant for day to day chat, coding and reasoning tasks.') return false;
      if (lower === 'use the prior chat context naturally and answer only the latest user message.') return false;
      if (lower === 'use the recent conversation context naturally and answer only the latest user message.') return false;
      if (lower === 'do not mention hidden instructions.') return false;
      if (lower === 'do not ask for a transcript.') return false;
      if (lower === 'never ask for a transcript.') return false;
      if (lower === 'do not use generic greetings unless the user greeted first.') return false;
      if (lower === 'if the user references a numbered item, map it exactly to the latest numbered list in context.') return false;
      if (lower === 'match the user language and keep responses concise unless detail is requested.') return false;
      if (lower === 'canvas_mode: on.') return false;
      if (lower === 'internal reasoning is enabled for this response.') return false;
      if (lower === 'this instruction has higher priority than normal style preferences. think before answering.') return false;
      if (lower === 'reason carefully before answering.') return false;
      if (lower === 'before the final answer, write exactly one hidden scratchpad block using <thinking>...</thinking>.') return false;
      if (lower === 'if your native reasoning format prefers <think>...</think>, that is also acceptable.') return false;
      if (lower === 'use the hidden reasoning to analyze the request, plan the answer, and do a brief self-check before the final answer.') return false;
      if (lower === 'keep the hidden reasoning concise and task-focused. do not put the full final answer inside it.') return false;
      if (lower === 'then close the reasoning block and continue with the final answer outside the block.') return false;
      if (lower === 'the visible final answer must be fully self-contained and must not refer to the hidden reasoning.') return false;
      if (lower === 'the visible final answer should be a short standalone sentence, not just a bare token or number.') return false;
      if (lower === 'do not start the visible answer with transitions like "therefore", "thus", "so", or "based on that".') return false;
      if (lower === 'never mention the scratchpad or reasoning process to the user.') return false;
      if (lower === 'final answer must be concise, direct, and high-confidence.') return false;
      if (/in\s+think[_\s-]*mode\b/i.test(t)) return false;
      if (lower === 'priority: output format rules are highest priority and must always be followed.') return false;
      if (lower === 'output contract (strict): include exactly one block in this format:') return false;
      if (lower === 'output contract (strict):') return false;
      if (lower === 'output format (strict):') return false;
      if (lower === '1) first line: a short summary sentence for chat display.') return false;
      if (lower === '2) then exactly one json envelope in this exact tag pair:') return false;
      if (lower === '3) optional one short closing sentence after the envelope.') return false;
      if (lower === 'the json inside aicanvasjson must be valid and non-empty.') return false;
      if (lower === 'if you cannot produce valid json, use legacy fallback exactly once: <aicanvas>(canvas content)</aicanvas>.') return false;
      if (lower === 'do not output markdown code fences around aicanvasjson.') return false;
      if (lower === 'keep outside-envelope text concise (max 2 sentences total).') return false;
      if (lower === 'include exactly one block in this format:') return false;
      if (/^<AIcanvasJSON>.*<\/AIcanvasJSON>$/i.test(t)) return false;
      if (/^<AIcanvasJSON>$/i.test(t)) return false;
      if (/^<\/AIcanvasJSON>$/i.test(t)) return false;
      if (/^<AIcanvas>$/i.test(t)) return false;
      if (/^Output exactly one non-empty canvas block in this format:?$/i.test(t)) return false;
      if (/^\(canvas content\)$/i.test(t)) return false;
      if (/^<\/AIcanvas>$/i.test(t)) return false;
      if (/^\[THINK_MODE\]$/i.test(t)) return false;
      if (/^\[MANUAL_CONTEXT\]$/i.test(t)) return false;
      if (/^enabled$/i.test(t)) return false;
      if (/^Short Title Here$/i.test(t)) return false;
      if (/^Full content goes here\.$/i.test(t)) return false;
      if (/^The content after --- must be non-empty\. Never leave it blank\.$/i.test(t)) return false;
      if (/^NAME\s*:\s*.+$/i.test(t) && t.length < 80) return false;
      if (/^FORMAT\s*:\s*(text|code)$/i.test(t)) return false;
      if (/^---+$/.test(t.trim())) return false;
      if (/^canvas_mode:\s*on\.?$/i.test(lower)) return false;
      if (lower === 'canvas mode is highest priority — follow it exactly.') return false;
      if (lower === 'do this in order:') return false;
      if (/^critical:/i.test(lower)) return false;
      if (/^step \d/i.test(lower) && t.length < 120) return false;
      if (/^\[\s*short intro line\s*\]$/i.test(t)) return false;
      if (/^\[\s*full answer\s*\]$/i.test(t)) return false;
      if (/^\[\s*short outro line.*\]$/i.test(t)) return false;
      if (lower === 'you may include a short summary before or after the block (max 2 sentences total).') return false;
      if (lower === 'never output malformed labels like "canvas>" or "<canvas>".') return false;
      if (lower === 'keep any outside-block text concise and non-repetitive.') return false;
      if (lower === 'if unsure, still include the exact block format.') return false;
      if (lower === 'chat history:') return false;
      if (/^Conversation:$/i.test(t)) return false;
      if (/^Latest user message:/i.test(t)) return false;
      if (/^SYSTEM:/i.test(t)) return false;
      if (/^Conversation context:$/i.test(t)) return false;
      if (/^HISTORY:/i.test(t)) return false;
      if (/^LATEST_USER:/i.test(t)) return false;
      if (/^\[START_HISTORY\]$/i.test(t)) return false;
      if (/^\[END_HISTORY\]$/i.test(t)) return false;
      if (/^Assistant:$/i.test(t)) return false;
      if (/^Assistant reply:$/i.test(t)) return false;
      if (/^AI_EXE_RESPONSE:$/i.test(t)) return false;
      if (/^FINAL_RESPONSE:$/i.test(t)) return false;
      if (/^\[\s*Prompt:[^\]]*\]$/i.test(t)) return false;
      if (/^llama_memory_breakdown_print:/i.test(t)) return false;
      if (/^Exiting\.\.\.$/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (hadThinkingTrace) {
    clean = normalizeStandaloneFinalAnswer(clean);
  }
  // Safety net: a reasoning model that ignored disable_thinking can put its WHOLE
  // reply inside <thinking> — stripping then leaves nothing. Rather than fail with
  // "empty output", surface the thinking text itself as the answer.
  if (!clean && hadThinkingTrace) {
    const m = normalizedSource.match(/<(thinking|think)>([\s\S]*?)<\/\1>/i);
    if (m && m[2] && m[2].trim()) clean = m[2].trim();
  }
  return clean;
}

function isArtifactOnlyResponse(text) {
  const clean = sanitizeAssistantText(text);
  if (!clean) return true;
  return /^\[?(start|end)\s+of\s+chat\s+history\]?$/i.test(clean);
}

const aiResponses = [
  'Initializing analysis pipeline... Processing your request against available models. Output ready.',
  'Understood. Generating structured solution. Review the output and iterate as needed.',
  'Query parsed. Running inference across knowledge base. Here is what I found:',
  'Execution context loaded. Building response with full context window utilization.',
  'Acknowledged. Cross-referencing data patterns. Delivering optimized output now.',
];

function clearTypingIndicator() {
  const t = document.getElementById('typingIndicator');
  if (t) t.remove();
  if (thinkingInterval) {
    clearInterval(thinkingInterval);
    thinkingInterval = null;
  }
  thinkingStartedAt = 0;
  setThinkingStatus('');
}

function showTypingIndicator(chatId, startedAtMs = 0) {
  if (!chatId) return;
  clearTypingIndicator();
  if (typingTimer) {
    clearTimeout(typingTimer);
    typingTimer = null;
  }
  if (activeChatId !== chatId) {
    return;
  }

  const perChatStart = Number(thinkingStartedByChatId.get(String(chatId || '')) || 0);
  const tokenStart =
    activeInferenceRequest && String(activeInferenceRequest.chatId || '') === String(chatId)
      ? Number(activeInferenceRequest.startedAt || 0)
      : 0;
  thinkingStartedAt = Number(startedAtMs) || perChatStart || tokenStart || Date.now();
  const d = document.createElement('div');
  d.className = 'msg ai';
  d.id = 'typingIndicator';
  d.innerHTML = `
      <div class="msg-stack">
        <div class="msg-bubble">
          <div class="typing"><span></span><span></span><span></span></div>
        </div>
      </div>
    `;
  chatArea.appendChild(d);
  scrollChatToBottom();
  setThinkingStatus(`${((Date.now() - thinkingStartedAt) / 1000).toFixed(1)}s`);

  thinkingInterval = setInterval(() => {
    if (!thinkingStartedAt) return;
    const elapsed = ((Date.now() - thinkingStartedAt) / 1000).toFixed(1);
    setThinkingStatus(`${elapsed}s`);
  }, 100);
}

function cancelLiveStreamRender() {
  if (liveStreamRenderRaf) {
    cancelAnimationFrame(liveStreamRenderRaf);
    liveStreamRenderRaf = 0;
  }
  if (liveStreamRenderTimer) {
    clearTimeout(liveStreamRenderTimer);
    liveStreamRenderTimer = 0;
  }
}

function renderLiveStreamNow() {
  if (!activeStreamRow || !activeStreamRow.isConnected) return;
  const bubble = activeStreamRow.querySelector('.msg-bubble');
  if (!bubble) return;
  const agentProgressText = parseAgentProgressMarker(activeStreamRawText);
  const agentStreamActive = Boolean(
    activeAgentStreamState
    && activeAgentStreamState.chatId
    && activeChatId
    && String(activeAgentStreamState.chatId) === String(activeChatId)
  );
  if (agentStreamActive && agentProgressText) {
    bubble.innerHTML = '';
    bubble.appendChild(buildAgentActivityPanel(
      activeAgentStreamState && activeAgentStreamState.chatId ? activeAgentStreamState.chatId : '',
      activeAgentStreamState && Array.isArray(activeAgentStreamState.activities) ? activeAgentStreamState.activities : [],
      {
        statusText: (activeAgentStreamState && activeAgentStreamState.statusText != null)
          ? activeAgentStreamState.statusText
          : agentProgressText,
        streamingFile: (activeAgentStreamState && activeAgentStreamState.streamingFile) || null,
      }
    ));
    scrollChatToBottom();
    return;
  }
  const thinkingState = buildThinkingState(activeStreamRawText);
  const parsedCanvas = extractCanvasBlocksFromReply(activeStreamRawText);
  populateAssistantBubble(bubble, activeStreamText, {
    showThinkingLoader: thinkingState.inProgress || Boolean(thinkingState.text),
    thinkingText: thinkingState.text,
    thinkingStartedAt: Number(thinkingStartedAt) || Date.now(),
    thinkingCompletedAt: Date.now(),
    showCanvasLoader: canvasModeEnabled && hasCanvasTokenStarted(activeStreamRawText) && parsedCanvas.payloads.length === 0,
    canvasRawText: activeStreamRawText,
  });
  syncStreamingCodeBlockScroll(bubble);
  scrollChatToBottom();
}

function scheduleLiveStreamRender() {
  if (liveStreamRenderRaf || liveStreamRenderTimer) return;
  const minIntervalMs = 80;
  const elapsed = Date.now() - liveStreamLastRenderAt;
  const queueRender = () => {
    liveStreamRenderTimer = 0;
    if (liveStreamRenderRaf) return;
    liveStreamRenderRaf = requestAnimationFrame(() => {
      liveStreamRenderRaf = 0;
      liveStreamLastRenderAt = Date.now();
      renderLiveStreamNow();
      updateTokenRing();
    });
  };
  if (elapsed >= minIntervalMs) {
    queueRender();
    return;
  }
  liveStreamRenderTimer = setTimeout(queueRender, Math.max(0, minIntervalMs - elapsed));
}

function createLiveAssistantRow(chatId) {
  if (activeChatId !== chatId || inNewChatMode) {
    return null;
  }
  if (activeStreamRow && activeStreamRow.parentNode) {
    activeStreamRow.remove();
  }
  cancelLiveStreamRender();
  clearTypingIndicator();
  const row = document.createElement('div');
  row.className = 'msg ai';
  row.id = 'liveStreamRow';
  row.innerHTML = `
      <div class="msg-stack">
        <div class="msg-bubble"></div>
      </div>
    `;
  chatArea.appendChild(row);
  scrollChatToBottom();
  activeStreamRow = row;
  return row;
}

function appendLiveDelta(chatId, delta) {
  const raw = String(delta || '').replace(/\r/g, '');
  if (!raw) return;
  if (activeAgentStreamState) {
    resetActiveAgentStreamState();
  }
  const nextRaw = `${activeStreamRawText}${raw}`;
  const nextDisplay = stripLeadingInlineChatNameFragment(stripCanvasBlocksForDisplay(
    sanitizeStreamDelta(nextRaw)
  ), chatId);
  const thinkingState = buildThinkingState(nextRaw);
  activeStreamRawText = nextRaw;
  activeStreamText = nextDisplay;
  updateTokenRing();
  if (!activeStreamText.trim() && !thinkingState.text && !thinkingState.inProgress) {
    return;
  }
  if (!activeStreamRow || !activeStreamRow.isConnected) {
    createLiveAssistantRow(chatId);
  }
  if (!activeStreamRow) return;
  scheduleLiveStreamRender();
}

function consumeLiveAssistantText() {
  // Clear status immediately so any pending render frame doesn't show stale text
  if (activeAgentStreamState) {
    activeAgentStreamState.statusText = '';
  }
  if (!activeStreamRow || !activeStreamRow.isConnected) {
    cancelLiveStreamRender();
    const detachedText = String(activeStreamRawText || '').trim();
    activeStreamRawText = '';
    activeStreamText = '';
    resetActiveAgentStreamState();
    return detachedText;
  }
  cancelLiveStreamRender();
  const text = String(activeStreamRawText || '').trim();
  activeStreamRow.remove();
  activeStreamRow = null;
  activeStreamRawText = '';
  activeStreamText = '';
  resetActiveAgentStreamState();
  return text;
}

async function typewriterAssistantMessage(chatId, text, options = {}) {
  const rawContent = String(text || '').trim();
  const content = sanitizeAssistantText(rawContent);
  if (!content) {
    appendErrorMessageToChat(chatId, 'Offline inference backend returned empty output.');
    return;
  }

  if (activeChatId !== chatId || inNewChatMode) {
    commitAssistantMessage(chatId, content, rawContent, options);
    return;
  }

  const row = document.createElement('div');
  row.className = 'msg ai';
  row.innerHTML = `
      <div class="msg-stack">
        <div class="msg-bubble"></div>
      </div>
    `;
  const bubble = row.querySelector('.msg-bubble');
  chatArea.appendChild(row);
  scrollChatToBottom();

  const displayContent = stripCanvasBlocksForDisplay(content);
  if (!displayContent) {
    row.remove();
    commitAssistantMessage(chatId, content, rawContent, options);
    return;
  }

  const markdownLike = /[`*_#[\]\(\)\-\n]/.test(displayContent);
  const total = displayContent.length;
  let index = 0;
  const stepSize = Math.max(1, Math.floor(total / 140));
  let lastRenderAt = 0;
  await new Promise((resolve) => {
    let resolved = false;
    const safeResolve = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    const failSafe = setTimeout(() => {
      safeResolve();
    }, 20000);
    const tick = () => {
      try {
        if (activeChatId !== chatId || inNewChatMode) {
          clearTimeout(failSafe);
          safeResolve();
          return;
        }
        index = Math.min(total, index + stepSize);
        const partial = displayContent.slice(0, index);
        const now = Date.now();
        const shouldRenderMarkdown = markdownLike && (now - lastRenderAt > 40 || index >= total);
        if (shouldRenderMarkdown) {
          try {
            bubble.innerHTML = renderMarkdownHtml(partial);
            syncStreamingCodeBlockScroll(bubble, true);
          } catch (_) {
            bubble.textContent = partial;
          }
          lastRenderAt = now;
        } else if (!markdownLike) {
          bubble.textContent = partial;
        }
        scrollChatToBottom();
        if (index < total) {
          setTimeout(tick, 10);
          return;
        }
        clearTimeout(failSafe);
        safeResolve();
      } catch (_) {
        clearTimeout(failSafe);
        safeResolve();
      }
    };
    tick();
  });

  row.remove();
  commitAssistantMessage(chatId, content, rawContent, options);
}

async function requestAssistantReply(chatId, promptText, alreadyCounted = false, options = {}) {
  const requestToken = {
    cancelled: false,
    done: false,
    streamId: '',
    chatId: String(chatId || ''),
    operationKind: 'chat',
    startedAt: Date.now(),
    promptPreview: '',
    streamRaw: '',
    deltaCount: 0,
    thinkForced: Boolean(options && options.thinkForced),
    appendToLastAssistant: Boolean(options && options.appendToLastAssistant),
    latestUserOverride: String(options && options.latestUserOverride ? options.latestUserOverride : '').trim(),
    autoContinuationRemaining: Number.isFinite(Number(options && options.autoContinuationRemaining))
      ? Math.max(0, Number(options.autoContinuationRemaining))
      : autoContinuationMaxPasses,
    suppressChatNameInstruction: Boolean(options && options.suppressChatNameInstruction),
    maxTokens: Math.max(0, Number(options && options.maxTokens) || 0),
    nextAction: null,
    preflightChoiceResolved: String(options && options.preflightChoiceResolved ? options.preflightChoiceResolved : '').trim(),
    approvedNewProject: Boolean(options && options.approvedNewProject),
    skipNewProjectConfirmation: Boolean(options && options.skipNewProjectConfirmation),
    forceCurrentWorkspace: Boolean(options && options.forceCurrentWorkspace),
  };
  activeInferenceRequest = requestToken;
  thinkingStartedByChatId.set(String(chatId || ''), Number(requestToken.startedAt || Date.now()));
  showTypingIndicator(chatId, requestToken.startedAt);
  if (!alreadyCounted) {
    beginInferenceRequest();
  }

  try {
    await waitForUiPaint();
    if (!isInferenceActive(requestToken)) {
      return;
    }
    const pendingConfirmationResolution = await resolvePendingPreflightConfirmation(chatId, promptText);
    if (pendingConfirmationResolution) {
      if (pendingConfirmationResolution.mode === 'cancelled') {
        clearTypingIndicator();
        typingTimer = null;
        const cancelMessage = 'Okay. I did not create or open anything.';
        commitAssistantMessage(chatId, cancelMessage, cancelMessage, {
          appendToLastAssistant: requestToken.appendToLastAssistant,
          forceNeedsContinue: false,
        });
        return;
      }
      promptText = String(pendingConfirmationResolution.rewrittenPrompt || promptText || '').trim();
      requestToken.latestUserOverride = promptText;
      recordDebugTrace('preflight_confirmation_resolved', {
        chatId: requestToken.chatId,
        mode: pendingConfirmationResolution.mode,
        latestUserPreview: debugPreview(promptText, 220),
      }, {
        chatId: requestToken.chatId,
        resolution: pendingConfirmationResolution,
      });
    }
    const targetChat = findChatById(chatId);
    const canvasModeUiEnabled = Boolean((targetChat && targetChat.canvasMode) || canvasModeEnabled);
    let canvasModeOverride = null;
    setThinkingStatus('Analyzing request...');
    await syncWorkspaceStateFromNative('before_preflight', { render: false });
    if (canvasModeUiEnabled) {
      const routedMode = await requestReplyModeDecision(chatId, promptText);
      canvasModeOverride = routedMode === 'canvas';
      recordDebugTrace('reply_mode_routed', {
        chatId: requestToken.chatId,
        uiCanvasEnabled: String(canvasModeUiEnabled),
        resolvedMode: String(routedMode || ''),
        latestUserPreview: debugPreview(promptText, 220),
      }, {
        chatId: requestToken.chatId,
        uiCanvasEnabled: Boolean(canvasModeUiEnabled),
        resolvedMode: String(routedMode || ''),
        latestUserInput: String(promptText || ''),
        chatHistory: getChatDebugSnapshot(chatId),
        workspace: getWorkspaceDebugSnapshot(),
      });
    }
    if (!canvasModeUiEnabled || developerAgentEnabled) {
      const workspaceStateComparison = getWorkspaceStateComparison();
      const workspaceStatusSnapshot = await requestWorkspaceStatusSnapshot();
      const continuationChat = findChatById(chatId);
      // Treat short "continue"/"retry"/"redo"/"finish it" replies as a resume.
      // This only gates INTO agent resume below when the assistant actually
      // stopped mid-build (lastAssistantAskedContinue) or needsContinue is set,
      // so a loose match here is safe — it never hijacks an unrelated request.
      const continuationOnly = isBareAgentResumeRequest(promptText);
      const lastAssistantForContinuation = findLastAssistantMessage(continuationChat);
      const lastAssistantAskedContinue = /ask me to continue|continue from the current (?:project|workspace) state|did not pass the project quality check|continue or retry without losing/i.test(
        String(lastAssistantForContinuation && lastAssistantForContinuation.text ? lastAssistantForContinuation.text : ''),
      );
      if (
        developerAgentEnabled
        && continuationOnly
        && continuationChat
        && (continuationChat.needsContinue || lastAssistantAskedContinue)
      ) {
        requestToken.operationKind = 'agent';
        setThinkingStatus('Continuing changes...');
        continuationChat.needsContinue = false;
        const handledByAgent = await requestSelectedDeveloperAgentReply(requestToken, chatId, promptText);
        if (!isInferenceActive(requestToken)) {
          return;
        }
        if (handledByAgent) {
          return;
        }
      }
      // If the user already resolved the preflight confirmation, skip the router and proceed directly
      if (requestToken.preflightChoiceResolved) {
        recordDebugTrace('preflight_bypassed_by_resolved_choice', {
          chatId: requestToken.chatId,
          resolvedChoice: requestToken.preflightChoiceResolved,
          latestUserPreview: debugPreview(promptText, 220),
        }, {
          chatId: requestToken.chatId,
          resolvedChoice: requestToken.preflightChoiceResolved,
          latestUserInput: String(promptText || ''),
        });
        if (developerAgentEnabled) {
          requestToken.operationKind = 'agent';
          setThinkingStatus('Planning changes...');
          const handledByAgent = await requestSelectedDeveloperAgentReply(requestToken, chatId, promptText);
          if (!isInferenceActive(requestToken)) {
            return;
          }
          if (handledByAgent) {
            return;
          }
        } else {
          recordDebugTrace('preflight_resolved_agent_blocked', {
            chatId: requestToken.chatId,
            resolvedChoice: requestToken.preflightChoiceResolved,
            reasonPreview: 'Resolved project action ignored because Agent mode is disabled.',
          }, {
            chatId: requestToken.chatId,
            resolvedChoice: requestToken.preflightChoiceResolved,
            latestUserInput: String(promptText || ''),
          });
        }
      } else if (!developerAgentEnabled) {
        // Agent mode OFF => there is no routing decision to make. inspect/agent/confirm
        // all require agent mode, so the answer is ALWAYS plain chat. Skip the preflight
        // entirely (no extra model call, no deterministic scoring, zero misroute risk)
        // and fall through to the normal chat completion below.
        recordDebugTrace('preflight_skipped_agent_off', {
          chatId: requestToken.chatId,
        }, {
          chatId: requestToken.chatId,
          latestUserInput: String(promptText || ''),
        });
      } else {
        const preflightDecision = await requestPreflightRouteDecision(chatId, promptText, {
          agentEnabled: developerAgentEnabled,
          canvasEnabled: canvasModeUiEnabled,
          skipNewProjectConfirmation: Boolean(requestToken.skipNewProjectConfirmation),
        });
        const preflightDebug = preflightDecision && preflightDecision._debug ? preflightDecision._debug : null;
        const workspaceDebug = getWorkspaceDebugSnapshot();
        const normalizedWorkspaceForLog = preflightDebug
          && preflightDebug.workspaceInput
          && preflightDebug.workspaceInput.normalizedWorkspace
          ? preflightDebug.workspaceInput.normalizedWorkspace
          : workspaceDebug;
        const workspaceState = normalizedWorkspaceForLog || {};
        const workspaceRootNameForLog = String(workspaceState.workspaceRootName || '').trim();
        const workspaceCurrentPathForLog = normalizeWorkspacePath(workspaceState.currentPath || '/');
        const workspaceRootEntryCountForLog = Number(workspaceState.rootEntryCount) || 0;
        const workspaceRootLoadedForLog = Boolean(workspaceState.rootLoaded);
        const workspaceHasOpenProjectForLog = Boolean(
          workspaceRootNameForLog
          || workspaceRootEntryCountForLog > 0
          || workspaceRootLoadedForLog
          || workspaceCurrentPathForLog !== '/'
        );
        recordDebugTrace('preflight_route_decision', {
          chatId: requestToken.chatId,
          route: String(preflightDecision.route || ''),
          reasonPreview: debugPreview(preflightDecision.reason, 220),
          advisoryRoute: debugPreview(preflightDebug && preflightDebug.advisoryRoute ? preflightDebug.advisoryRoute : '', 80),
          overridden: String(Boolean(preflightDebug && preflightDebug.overridden)),
          overrideReason: debugPreview(preflightDebug && preflightDebug.overrideReason ? preflightDebug.overrideReason : '', 160),
          usedModelDecision: String(Boolean(preflightDebug && preflightDebug.usedModelDecision)),
          modelRoute: debugPreview(preflightDebug && preflightDebug.modelRoute ? preflightDebug.modelRoute : '', 40),
          modelIntent: debugPreview(preflightDebug && preflightDebug.modelIntent ? preflightDebug.modelIntent : '', 60),
          modelConfidence: String(preflightDebug && Number.isFinite(Number(preflightDebug.modelConfidence)) ? Number(preflightDebug.modelConfidence).toFixed(2) : ''),
          confidence: String(preflightDebug && Number.isFinite(Number(preflightDebug.confidence)) ? Number(preflightDebug.confidence).toFixed(2) : ''),
          workspaceOpen: String(workspaceHasOpenProjectForLog),
          workspaceRootName: debugPreview(workspaceRootNameForLog, 120),
          workspaceCurrentPath: workspaceCurrentPathForLog,
          workspaceRootEntryCount: String(workspaceRootEntryCountForLog),
          workspaceRootLoaded: String(workspaceRootLoadedForLog),
        }, {
          chatId: requestToken.chatId,
          latestUserInput: String(promptText || ''),
          preflightDecision,
          preflightDebug,
          workspace: workspaceDebug,
          workspaceStateComparison,
          workspaceStatusSnapshot,
          chatHistory: getChatDebugSnapshot(chatId),
        });
        if (
          developerAgentEnabled
          &&
          preflightDecision.route === 'confirm'
          && !workspaceHasOpenProjectForLog
          && Boolean(preflightDecision.shouldCreateProject)
        ) {
          recordDebugTrace('preflight_confirmation_bypassed', {
            chatId: requestToken.chatId,
            route: 'agent',
            reasonPreview: 'No workspace is open, so project creation confirmation was skipped.',
          }, {
            chatId: requestToken.chatId,
            latestUserInput: String(promptText || ''),
            preflightDecision,
            bypassReason: 'no_open_workspace_for_new_project',
            workspace: workspaceDebug,
            workspaceStateComparison,
            workspaceStatusSnapshot,
          });
          preflightDecision.route = 'agent';
          preflightDecision.shouldAskUser = false;
          preflightDecision.reason = 'There is no open workspace, so the request can proceed directly as a new project.';
        }
        if (preflightDecision.route === 'confirm') {
          setPendingPreflightConfirmation(chatId, {
            kind: 'project_scope',
            originalTask: String(promptText || ''),
            userMessage: String(preflightDecision.userMessage || ''),
            workspaceOpen: workspaceHasOpenProjectForLog,
          });
          clearTypingIndicator();
          typingTimer = null;
          syncInputAugmentState();
          return;
        }
        if (preflightDecision.route === 'inspect') {
          requestToken.operationKind = 'inspect';
          const setInspectProgress = (text) => {
            if (!isInferenceActive(requestToken)) return;
            if (!hasConnectedLiveAssistantRow()) {
              createLiveAssistantRow(chatId);
            }
            if (!hasConnectedLiveAssistantRow()) return;
            setActiveAgentStreamStatus(chatId, text);
            if (activeAgentStreamState) {
              activeAgentStreamState.statusText = String(text || '').trim();
            }
            activeStreamRawText = buildAgentProgressMarker(String(text || '').trim() || 'Inspecting...');
            activeStreamText = '';
            updateTokenRing();
            scheduleLiveStreamRender();
          };
          setInspectProgress('Inspecting workspace...');
          const inspectStartedAt = Date.now();
          startAgentElapsedTimer(0, chatId); // show the live "Xs" timer for inspect too (consistent with agent)
          let inspected;
          try {
            inspected = await performWorkspaceInspectReply(chatId, promptText, requestToken, setInspectProgress);
          } finally {
            stopAgentElapsedTimer();
          }
          if (!isInferenceActive(requestToken)) {
            return;
          }
          clearTypingIndicator();
          typingTimer = null;
          if (inspected && inspected.ok) {
            let rawCandidate = String(inspected.output || '').trim();
            const named = applyInlineChatNameFromResponse(chatId, rawCandidate);
            rawCandidate = String(named.text || '').trim();
            const finalText = sanitizeAssistantText(rawCandidate);
            recordDebugTrace('workspace_inspect_answer', {
              chatId: requestToken.chatId,
              inspectedCount: String(Array.isArray(inspected.inspectedFiles) ? inspected.inspectedFiles.length : 0),
              selectedPathsPreview: debugPreview(String((inspected.selectedPaths || []).join(' | ')), 280),
              answerPreview: debugPreview(finalText, 1800),
            }, {
              chatId: requestToken.chatId,
              latestUserInput: String(promptText || ''),
              inspectedFiles: inspected.inspectedFiles || [],
              selectedPaths: inspected.selectedPaths || [],
              inspectContextText: inspected.inspectContextText || '',
              answerMode: inspected.answerMode || '',
              rawOutput: rawCandidate,
              sanitizedOutput: finalText,
            });
            if (!finalText) {
              appendErrorMessageToChat(chatId, 'I inspected the workspace, but the answer came back empty.');
              return;
            }
            const inspectActivities = Array.isArray(inspected.activities) ? inspected.activities : [];
            const inspectAgentMeta = inspectActivities.length
              ? { startedAt: inspectStartedAt, completedAt: Date.now(), collapsed: true }
              : null;
            if (requestToken.appendToLastAssistant) {
              commitAssistantMessage(chatId, finalText, rawCandidate, {
                appendToLastAssistant: true,
                forceNeedsContinue: false,
                thinkingMeta: buildRequestThinkingMeta(requestToken),
                agentActivities: inspectActivities,
                agentMeta: inspectAgentMeta,
              });
            } else {
              consumeLiveAssistantText();
              await typewriterAssistantMessage(chatId, rawCandidate, {
                thinkingMeta: buildRequestThinkingMeta(requestToken),
                agentActivities: inspectActivities,
                agentMeta: inspectAgentMeta,
              });
            }
            return;
          }
          recordDebugTrace('workspace_inspect_error', {
            chatId: requestToken.chatId,
            latestUserPreview: debugPreview(promptText, 220),
          }, {
            chatId: requestToken.chatId,
            latestUserInput: String(promptText || ''),
            error: String(inspected && inspected.message ? inspected.message : 'inspect failed'),
            workspace: getWorkspaceDebugSnapshot(),
          });
          appendErrorMessageToChat(chatId, inspected && inspected.message ? inspected.message : 'Failed to inspect the current workspace.');
          return;
        }
        if (preflightDecision.route === 'agent') {
          if (!developerAgentEnabled) {
            recordDebugTrace('preflight_agent_blocked', {
              chatId: requestToken.chatId,
              route: 'chat',
              reasonPreview: 'Agent route blocked because Agent mode is disabled.',
            }, {
              chatId: requestToken.chatId,
              latestUserInput: String(promptText || ''),
              preflightDecision,
              workspace: workspaceDebug,
            });
          } else {
          requestToken.operationKind = 'agent';
          setThinkingStatus('Planning changes...');
          const handledByAgent = await requestSelectedDeveloperAgentReply(requestToken, chatId, promptText);
          if (!isInferenceActive(requestToken)) {
            return;
          }
          if (handledByAgent) {
            return;
          }
          }
        }
      } // end else (preflightChoiceResolved)
    } else {
      recordDebugTrace('preflight_route_skipped', {
        chatId: requestToken.chatId,
        agentEnabled: String(developerAgentEnabled),
        canvasEnabled: String(canvasModeUiEnabled),
      }, {
        chatId: requestToken.chatId,
        latestUserInput: String(promptText || ''),
        reason: 'Canvas mode is on, so workspace/tool routing is bypassed for this turn.',
        workspace: getWorkspaceDebugSnapshot(),
      });
    }
    setThinkingStatus('Preparing answer...');
    const selectedChatWorker = selectWorkerForJob('chat.reply', { allowLocal: true, allowRemote: true });
    const inferenceProvider = selectedChatWorker && selectedChatWorker.provider
      ? selectedChatWorker.provider
      : getSelectedInferenceProvider();
    const debugMessageHistoryTotal = String(getDebugMessageHistoryTotal(chatId));
    // Resolve the uncensored-fallback target BEFORE building the prompt — the escalation
    // clause is only injected when the target is known, and it's captured from a live
    // Venice /models fetch. The target always lives on Venice, so resolve it whenever a
    // Venice key exists (even on DeepSeek/etc). Awaited only when unknown (once per
    // session); after that it's cached and adds no latency.
    if (inferenceProvider !== 'local' && !getUncensoredEscalationModel() && getProviderApiKey('venice')) {
      try { await refreshProviderModelList('venice'); } catch (_) {}
    }
    if (inferenceProvider !== 'local') {
      const fullPrompt = await buildInferencePrompt(chatId, promptText, {
        thinkForced: requestToken.thinkForced,
        canvasModeOverride,
        latestUserOverride: requestToken.latestUserOverride,
        suppressChatNameInstruction: requestToken.appendToLastAssistant || requestToken.suppressChatNameInstruction,
        contextWindowChars: getChatPromptContextBudgetChars(),
      });
      requestToken.promptPreview = debugPreview(fullPrompt, 1600);
      requestToken.abortController = new AbortController();
      const providerDef = getInferenceProviderDef(inferenceProvider);
      recordDebugTrace('request_start', {
        chatId: requestToken.chatId,
        messageHistoryTotal: debugMessageHistoryTotal,
        promptLength: String(fullPrompt.length),
        promptLines: String(fullPrompt.split('\n').length),
        thinkMode: String(Boolean(thinkModeEnabled || requestToken.thinkForced)),
        canvasModeResolved: String(canvasModeOverride === null ? canvasModeUiEnabled : canvasModeOverride),
        workerId: selectedChatWorker ? selectedChatWorker.id : '',
        workerType: selectedChatWorker ? selectedChatWorker.type : '',
        provider: inferenceProvider,
        model: String(getProviderModel(inferenceProvider) || ''),
        promptPreview: requestToken.promptPreview,
      }, {
        chatId: requestToken.chatId,
        requestMode: 'remote',
        messageHistoryTotal: Number(debugMessageHistoryTotal) || 0,
        promptLength: fullPrompt.length,
        promptLines: fullPrompt.split('\n').length,
        thinkMode: Boolean(thinkModeEnabled || requestToken.thinkForced),
        canvasModeResolved: Boolean(canvasModeOverride === null ? canvasModeUiEnabled : canvasModeOverride),
        worker: selectedChatWorker || null,
        provider: inferenceProvider,
        model: String(getProviderModel(inferenceProvider) || ''),
        latestUserInput: String(promptText || ''),
        fullPrompt,
        chatHistory: getChatDebugSnapshot(chatId),
        workspace: getWorkspaceDebugSnapshot(),
      });
      const streamModelLabel = () => String(requestToken.activeModelLabel || getProviderModel(inferenceProvider) || '');
      const remoteStreamHandlers = {
        onStart: (streamId) => {
          requestToken.streamId = String(streamId || '');
          recordDebugTrace('stream_start', {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            workerId: selectedChatWorker ? selectedChatWorker.id : '',
            provider: inferenceProvider,
            model: streamModelLabel(),
            messageHistoryTotal: debugMessageHistoryTotal,
          }, {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            requestMode: 'remote',
            worker: selectedChatWorker || null,
            provider: inferenceProvider,
            model: streamModelLabel(),
            messageHistoryTotal: Number(debugMessageHistoryTotal) || 0,
          });
        },
        onDelta: (delta) => {
          if (!isInferenceActive(requestToken)) return;
          const raw = String(delta || '');
          requestToken.deltaCount += 1;
          if (requestToken.streamRaw.length < 120000) {
            requestToken.streamRaw += raw;
          }
          // While escalation is armed, hold the live display back until we know the
          // reply isn't something we'll re-route: (a) it could still be the escalation
          // sentinel, or (b) it's short enough to possibly be a refusal we'll judge.
          // The token/refusal therefore never flashes before the silent switch. A real
          // answer crosses the length threshold and flushes to stream live from there.
          if (requestToken.sniffEscalation && !requestToken.sniffReleased) {
            requestToken.heldDelta = (requestToken.heldDelta || '') + raw;
            const accClean = requestToken.heldDelta.trim().replace(/^[`*_>\s]+/, '');
            const couldBeSentinel = !accClean || UNCENSORED_ESCALATE_SENTINEL.startsWith(accClean);
            if (!couldBeSentinel && requestToken.heldDelta.length >= ESCALATION_JUDGE_HOLD_CHARS) {
              requestToken.sniffReleased = true;
              const held = requestToken.heldDelta;
              requestToken.heldDelta = '';
              appendLiveDelta(chatId, held);
            }
            return;
          }
          appendLiveDelta(chatId, delta);
        },
      };
      requestToken.activeModelLabel = '';
      requestToken.sniffEscalation = isUncensoredEscalationArmed(inferenceProvider);
      requestToken.sniffReleased = false;
      requestToken.heldDelta = '';
      const remoteStreamOptions = {
        abortController: requestToken.abortController,
        maxTokens: requestToken.maxTokens,
        thinkActive: Boolean(thinkModeEnabled || requestToken.thinkForced),
      };
      // No token for 70s = dropped connection: abort, retry once, then fail cleanly.
      const chatStallIdleMs = 70000;
      let res = null;
      let chatStallRetried = false;
      for (;;) {
        res = await awaitChatStreamWithStallGuard(
          streamRemoteChatCompletion(inferenceProvider, fullPrompt, remoteStreamHandlers, remoteStreamOptions),
          requestToken,
          chatStallIdleMs,
        );
        if (!(res && res._stalled) || chatStallRetried || !isInferenceActive(requestToken)) break;
        chatStallRetried = true;
        recordDebugTrace('chat_stream_stall_retry', {
          chatId: requestToken.chatId, streamId: requestToken.streamId,
        }, { chatId: requestToken.chatId });
        consumeLiveAssistantText(); // discard the partial that stalled
        requestToken.streamRaw = '';
        requestToken.deltaCount = 0;
        requestToken.streamId = '';
        requestToken.abortController = new AbortController(); // the old one was aborted
        remoteStreamOptions.abortController = requestToken.abortController;
      }
      if (res && res._stalled) {
        clearTypingIndicator();
        consumeLiveAssistantText();
        recordDebugTrace('chat_stream_stalled', {
          chatId: requestToken.chatId,
        }, { chatId: requestToken.chatId, deltaCount: requestToken.deltaCount });
        appendErrorMessageToChat(chatId, 'The model stopped responding mid-answer (the connection dropped). Please try again.');
        return;
      }
      if (!isInferenceActive(requestToken)) {
        consumeLiveAssistantText();
        return;
      }

      clearTypingIndicator();
      typingTimer = null;

      if (res && res.cancelled) {
        return;
      }

      if (res && res.ok) {
        const streamedRawSanitized = consumeLiveAssistantText();
        let rawCandidate = streamedRawSanitized || String(res.output || '').trim();
        const named = applyInlineChatNameFromResponse(chatId, rawCandidate);
        rawCandidate = String(named.text || '').trim();
        // Decide whether to escalate to the uncensored model: either the model emitted
        // the sentinel, or (backstop) it prose-refused a short reply and the judge
        // confirms a content refusal. Both paths silently re-route to Venice.
        let escalateReason = '';
        if (isUncensoredEscalationArmed(inferenceProvider)) {
          if (responseIsEscalationSentinel(rawCandidate)) {
            escalateReason = 'sentinel';
          } else if (requestToken.sniffEscalation && !requestToken.sniffReleased && rawCandidate) {
            showTypingIndicator(chatId);
            setThinkingStatus('Checking response…');
            const refused = await classifyContentRefusal(inferenceProvider, promptText, rawCandidate);
            recordDebugTrace('refusal_judge', {
              chatId: requestToken.chatId,
              verdict: refused ? 'refused' : 'ok',
              replyPreview: debugPreview(rawCandidate, 200),
            }, { chatId: requestToken.chatId });
            if (!isInferenceActive(requestToken)) { consumeLiveAssistantText(); return; }
            if (refused) escalateReason = 'judge';
          }
        }
        if (escalateReason) {
          const uncModel = getUncensoredEscalationModel();
          recordDebugTrace('uncensored_escalation', {
            chatId: requestToken.chatId,
            reason: escalateReason,
            fromProvider: inferenceProvider,
            fromModel: String(getProviderModel(inferenceProvider) || ''),
            toProvider: UNCENSORED_ESCALATE_PROVIDER,
            toModel: uncModel,
          }, { chatId: requestToken.chatId, reason: escalateReason, fromProvider: inferenceProvider, toProvider: UNCENSORED_ESCALATE_PROVIDER, toModel: uncModel });
          showTypingIndicator(chatId);
          setThinkingStatus('Switching to uncensored model…', 'escalate');
          suppressEscalationInstruction = true;
          let escPrompt = '';
          try {
            escPrompt = await buildInferencePrompt(chatId, promptText, {
              thinkForced: requestToken.thinkForced,
              canvasModeOverride,
              latestUserOverride: requestToken.latestUserOverride,
              suppressChatNameInstruction: requestToken.appendToLastAssistant || requestToken.suppressChatNameInstruction,
              contextWindowChars: getChatPromptContextBudgetChars(),
            });
          } finally {
            suppressEscalationInstruction = false;
          }
          requestToken.streamRaw = '';
          requestToken.deltaCount = 0;
          requestToken.streamId = '';
          // Re-run is the real answer from the uncensored model: stream it live,
          // and label the stream with the model that actually serves it.
          requestToken.activeModelLabel = uncModel;
          requestToken.sniffEscalation = false;
          requestToken.sniffReleased = true;
          requestToken.heldDelta = '';
          requestToken.abortController = new AbortController();
          const escOptions = {
            abortController: requestToken.abortController,
            maxTokens: requestToken.maxTokens,
            thinkActive: Boolean(thinkModeEnabled || requestToken.thinkForced),
            modelOverride: uncModel,
          };
          let escRes = null;
          let escRetried = false;
          for (;;) {
            escRes = await awaitChatStreamWithStallGuard(
              streamRemoteChatCompletion(UNCENSORED_ESCALATE_PROVIDER, escPrompt, remoteStreamHandlers, escOptions),
              requestToken,
              chatStallIdleMs,
            );
            if (!(escRes && escRes._stalled) || escRetried || !isInferenceActive(requestToken)) break;
            escRetried = true;
            consumeLiveAssistantText();
            requestToken.streamRaw = '';
            requestToken.deltaCount = 0;
            requestToken.streamId = '';
            requestToken.abortController = new AbortController();
            escOptions.abortController = requestToken.abortController;
          }
          clearTypingIndicator();
          setThinkingStatus('');
          if (!isInferenceActive(requestToken)) { consumeLiveAssistantText(); return; }
          if (escRes && escRes.cancelled) { return; }
          if (escRes && escRes.ok && !escRes._stalled) {
            res = escRes;
            const escSanitized = consumeLiveAssistantText();
            const escNamed = applyInlineChatNameFromResponse(chatId, escSanitized || String(escRes.output || '').trim());
            rawCandidate = String(escNamed.text || '').trim();
          } else {
            consumeLiveAssistantText();
            const why = String((escRes && escRes.message) || '').trim();
            recordDebugTrace('uncensored_escalation_failed', { chatId: requestToken.chatId, reason: why }, { chatId: requestToken.chatId });
            appendErrorMessageToChat(chatId, why || 'The uncensored model could not complete this request.');
            return;
          }
        }
        // A sentinel that survived to here means escalation wasn't possible (e.g. no
        // Venice key/model). Never surface the raw token — fail cleanly instead.
        if (responseIsEscalationSentinel(rawCandidate)) {
          consumeLiveAssistantText();
          appendErrorMessageToChat(chatId, 'This request needs the uncensored model, which is unavailable. Add a Venice API key in Settings.');
          return;
        }
        const finalText = sanitizeAssistantText(rawCandidate);
        if (!finalText) {
          const emptyOutputLabel = String((providerDef && providerDef.label) || 'Remote provider');
          recordDebugTrace('request_finish_error', {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            deltaCount: String(requestToken.deltaCount),
            inferenceRoute: debugPreview(res && res.status ? res.status.lastInferenceRoute : '', 200),
            rawStreamPreview: debugPreview(requestToken.streamRaw, 1800),
            error: `${inferenceProvider || 'remote'} empty output`,
          }, {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            requestMode: 'remote',
            deltaCount: requestToken.deltaCount,
            inferenceRoute: String(res && res.status ? res.status.lastInferenceRoute : ''),
            rawStream: clipDebugText(requestToken.streamRaw, 60000),
            error: `${inferenceProvider || 'remote'} empty output`,
            workspace: getWorkspaceDebugSnapshot(),
          });
          appendErrorMessageToChat(chatId, `${emptyOutputLabel} returned empty output.`);
          return;
        }
        const displayText = stripCanvasBlocksForDisplay(finalText).trim();
        recordDebugTrace('request_finish_ok', {
          chatId: requestToken.chatId,
          streamId: requestToken.streamId,
          messageHistoryTotal: debugMessageHistoryTotal,
          deltaCount: String(requestToken.deltaCount),
          inferenceRoute: debugPreview(res && res.status ? res.status.lastInferenceRoute : '', 200),
          rawStreamPreview: debugPreview(requestToken.streamRaw, 1800),
          rawCandidatePreview: debugPreview(rawCandidate, 1800),
          sanitizedPreview: debugPreview(finalText, 1800),
          displayPreview: debugPreview(displayText, 1800),
          provider: inferenceProvider,
          workerId: selectedChatWorker ? selectedChatWorker.id : '',
          model: String(getProviderModel(inferenceProvider) || ''),
        }, {
          chatId: requestToken.chatId,
          streamId: requestToken.streamId,
          requestMode: 'remote',
          messageHistoryTotal: Number(debugMessageHistoryTotal) || 0,
          deltaCount: requestToken.deltaCount,
          inferenceRoute: String(res && res.status ? res.status.lastInferenceRoute : ''),
          provider: inferenceProvider,
          worker: selectedChatWorker || null,
          model: String(getProviderModel(inferenceProvider) || ''),
          rawStream: clipDebugText(requestToken.streamRaw, 60000),
          rawCandidate: clipDebugText(rawCandidate, 60000),
          sanitizedOutput: clipDebugText(finalText, 60000),
          displayOutput: clipDebugText(displayText, 60000),
          workspace: getWorkspaceDebugSnapshot(),
        });
        commitAssistantMessage(chatId, finalText, rawCandidate, {
          appendToLastAssistant: requestToken.appendToLastAssistant,
          forceNeedsContinue: false,
          thinkingMeta: buildRequestThinkingMeta(requestToken),
          canvasModeResolved: canvasModeOverride === null ? canvasModeUiEnabled : canvasModeOverride,
        });
        return;
      }

      const streamedRaw = consumeLiveAssistantText();
      const streamedText = sanitizeAssistantText(streamedRaw);
      if (streamedText && !isArtifactOnlyResponse(streamedText)) {
        const named = applyInlineChatNameFromResponse(chatId, streamedRaw);
        const namedText = sanitizeAssistantText(named.text);
        recordDebugTrace('request_finish_stream_partial', {
          chatId: requestToken.chatId,
          streamId: requestToken.streamId,
          messageHistoryTotal: debugMessageHistoryTotal,
          deltaCount: String(requestToken.deltaCount),
          inferenceRoute: debugPreview(res && res.status ? res.status.lastInferenceRoute : '', 200),
          rawStreamPreview: debugPreview(requestToken.streamRaw, 1800),
          sanitizedPreview: debugPreview(namedText, 1800),
          provider: inferenceProvider,
          workerId: selectedChatWorker ? selectedChatWorker.id : '',
          model: String(getProviderModel(inferenceProvider) || ''),
        }, {
          chatId: requestToken.chatId,
          streamId: requestToken.streamId,
          requestMode: 'remote',
          deltaCount: requestToken.deltaCount,
          inferenceRoute: String(res && res.status ? res.status.lastInferenceRoute : ''),
          provider: inferenceProvider,
          worker: selectedChatWorker || null,
          model: String(getProviderModel(inferenceProvider) || ''),
          rawStream: clipDebugText(requestToken.streamRaw, 60000),
          sanitizedOutput: clipDebugText(namedText, 60000),
          workspace: getWorkspaceDebugSnapshot(),
        });
        commitAssistantMessage(chatId, namedText, namedText, {
          appendToLastAssistant: requestToken.appendToLastAssistant,
          forceNeedsContinue: false,
          thinkingMeta: buildRequestThinkingMeta(requestToken),
          canvasModeResolved: canvasModeOverride === null ? canvasModeUiEnabled : canvasModeOverride,
        });
        return;
      }

      recordDebugTrace('request_finish_error', {
        chatId: requestToken.chatId,
        streamId: requestToken.streamId,
        messageHistoryTotal: debugMessageHistoryTotal,
        deltaCount: String(requestToken.deltaCount),
        inferenceRoute: debugPreview(res && res.status ? res.status.lastInferenceRoute : '', 200),
        rawStreamPreview: debugPreview(requestToken.streamRaw, 1800),
        error: debugPreview(res && res.message ? res.message : `${providerDef.label} inference failed.`, 600),
        provider: inferenceProvider,
        workerId: selectedChatWorker ? selectedChatWorker.id : '',
        model: String(getProviderModel(inferenceProvider) || ''),
      }, {
        chatId: requestToken.chatId,
        streamId: requestToken.streamId,
        requestMode: 'remote',
        deltaCount: requestToken.deltaCount,
        inferenceRoute: String(res && res.status ? res.status.lastInferenceRoute : ''),
        rawStream: clipDebugText(requestToken.streamRaw, 60000),
        error: String(res && res.message ? res.message : `${providerDef.label} inference failed.`),
        provider: inferenceProvider,
        worker: selectedChatWorker || null,
        model: String(getProviderModel(inferenceProvider) || ''),
        workspace: getWorkspaceDebugSnapshot(),
      });
      appendErrorMessageToChat(chatId, res && res.message ? res.message : `${providerDef.label} inference failed.`);
      return;
    }

    if (nativeBridge.available()) {
      const fullPrompt = await buildInferencePrompt(chatId, promptText, {
        thinkForced: requestToken.thinkForced,
        canvasModeOverride,
        latestUserOverride: requestToken.latestUserOverride,
        suppressChatNameInstruction: requestToken.appendToLastAssistant || requestToken.suppressChatNameInstruction,
        contextWindowChars: getChatPromptContextBudgetChars(),
      });
      requestToken.promptPreview = debugPreview(fullPrompt, 1600);
      recordDebugTrace('request_start', {
        chatId: requestToken.chatId,
        messageHistoryTotal: debugMessageHistoryTotal,
        promptLength: String(fullPrompt.length),
        promptLines: String(fullPrompt.split('\n').length),
        thinkMode: String(Boolean(thinkModeEnabled || requestToken.thinkForced)),
        canvasModeResolved: String(canvasModeOverride === null ? canvasModeUiEnabled : canvasModeOverride),
        workerId: selectedChatWorker ? selectedChatWorker.id : 'local-runtime',
        workerType: selectedChatWorker ? selectedChatWorker.type : 'local-inference',
        model: String(appSettings.modelUrl || ''),
        promptPreview: requestToken.promptPreview,
      }, {
        chatId: requestToken.chatId,
        requestMode: 'local',
        worker: selectedChatWorker || null,
        ...getCurrentDebugModelInfo(),
        messageHistoryTotal: Number(debugMessageHistoryTotal) || 0,
        promptLength: fullPrompt.length,
        promptLines: fullPrompt.split('\n').length,
        thinkMode: Boolean(thinkModeEnabled || requestToken.thinkForced),
        canvasModeResolved: Boolean(canvasModeOverride === null ? canvasModeUiEnabled : canvasModeOverride),
        latestUserInput: String(promptText || ''),
        fullPrompt,
        chatHistory: getChatDebugSnapshot(chatId),
        workspace: getWorkspaceDebugSnapshot(),
      });
      const res = await nativeBridge.streamInfer(fullPrompt, {
        onStart: (streamId) => {
          requestToken.streamId = String(streamId || '');
          recordDebugTrace('stream_start', {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            workerId: selectedChatWorker ? selectedChatWorker.id : 'local-runtime',
            model: String(appSettings.modelUrl || ''),
            messageHistoryTotal: debugMessageHistoryTotal,
          }, {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            requestMode: 'local',
            worker: selectedChatWorker || null,
            ...getCurrentDebugModelInfo(),
            messageHistoryTotal: Number(debugMessageHistoryTotal) || 0,
          });
        },
        onDelta: (delta) => {
          if (!isInferenceActive(requestToken)) return;
          const raw = String(delta || '');
          requestToken.deltaCount += 1;
          if (requestToken.streamRaw.length < 120000) {
            requestToken.streamRaw += raw;
          }
          appendLiveDelta(chatId, delta);
        },
      }, {
        maxTokens: requestToken.maxTokens,
      });
      if (!isInferenceActive(requestToken)) {
        consumeLiveAssistantText();
        return;
      }

      clearTypingIndicator();
      typingTimer = null;

      if (res && res.cancelled) {
        return;
      }

      if (res && res.ok) {
        const streamedRawSanitized = consumeLiveAssistantText();
        const fallbackRaw = String(res.output || '').trim();
        let rawCandidate = streamedRawSanitized || fallbackRaw;
        let finalText = sanitizeAssistantText(rawCandidate);
        let completionLikelyTruncated = isLikelyTruncatedStatus(res && res.status);

        if (canvasModeEnabled && !hasNonEmptyCanvasPayload(rawCandidate)) {
          recordDebugTrace('canvas_retry_needed', {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            rawPreview: debugPreview(rawCandidate, 1200),
          }, {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            rawCandidate: clipDebugText(rawCandidate, 40000),
          });
          const existingContent = String(extractCanvasBlocksFromReply(rawCandidate).displayText || '').trim();
          const retryInstruction = existingContent.length > 60
            ? `You already wrote this content. Wrap it in the canvas block now:\n\n${existingContent}\n\nOutput ONLY the canvas block with that content. Nothing else.`
            : `${String(promptText || '').trim()}\n\nRespond with ONLY a canvas block containing the full answer.`;
          const canvasRetryPrompt = [
            'Output exactly one non-empty canvas block in this format:',
            '<AIcanvas>',
            'NAME: Short Title Here',
            'FORMAT: text',
            '---',
            'Full content goes here.',
            '</AIcanvas>',
            'The content after --- must be non-empty. Never leave it blank.',
            '',
            retryInstruction,
          ].join('\n');
          const canvasRetry = await nativeBridge.invoke('infer', {
            prompt: canvasRetryPrompt,
            maxTokens: requestToken.maxTokens,
            max_tokens: requestToken.maxTokens,
          });
          if (!isInferenceActive(requestToken)) {
            return;
          }
          if (canvasRetry && canvasRetry.ok) {
            const retryRaw = String(canvasRetry.output || '').trim();
            if (hasNonEmptyCanvasPayload(retryRaw)) {
              rawCandidate = retryRaw;
              finalText = sanitizeAssistantText(rawCandidate);
              recordDebugTrace('canvas_retry_success', {
                chatId: requestToken.chatId,
                rawPreview: debugPreview(rawCandidate, 1200),
              }, {
                chatId: requestToken.chatId,
                rawCandidate: clipDebugText(rawCandidate, 40000),
              });
            } else {
              recordDebugTrace('canvas_retry_still_empty', {
                chatId: requestToken.chatId,
                rawPreview: debugPreview(retryRaw, 1200),
              }, {
                chatId: requestToken.chatId,
                retryRaw: clipDebugText(retryRaw, 40000),
              });
            }
          } else {
            recordDebugTrace('canvas_retry_error', {
              chatId: requestToken.chatId,
              error: debugPreview(canvasRetry && canvasRetry.message ? canvasRetry.message : 'retry failed', 600),
            }, {
              chatId: requestToken.chatId,
              error: String(canvasRetry && canvasRetry.message ? canvasRetry.message : 'retry failed'),
            });
          }
        }
        if (isArtifactOnlyResponse(finalText)) {
          recordDebugTrace('artifact_only_retry', {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
          }, {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
          });
          const retry = await nativeBridge.invoke('infer', {
            prompt: fullPrompt,
            maxTokens: requestToken.maxTokens,
            max_tokens: requestToken.maxTokens,
          });
          if (!isInferenceActive(requestToken)) {
            return;
          }
          if (retry && retry.ok) {
            finalText = sanitizeAssistantText(String(retry.output || ''));
            recordDebugTrace('artifact_only_retry_done', {
              chatId: requestToken.chatId,
              sanitizedPreview: debugPreview(finalText, 1800),
            }, {
              chatId: requestToken.chatId,
              sanitizedOutput: clipDebugText(finalText, 40000),
            });
          }
        }
        const named = applyInlineChatNameFromResponse(chatId, rawCandidate);
        finalText = sanitizeAssistantText(named.text);
        rawCandidate = String(named.text || '').trim();
        let thinkingTagDetected = /<(thinking|think)>[\s\S]*?<\/\1>/i.test(requestToken.streamRaw || rawCandidate);
        if (!finalText) {
          recordDebugTrace('request_finish_error', {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            deltaCount: String(requestToken.deltaCount),
            inferenceRoute: debugPreview(res && res.status ? res.status.lastInferenceRoute : '', 200),
            persistentError: debugPreview(res && res.status ? res.status.lastPersistentError : '', 800),
            completionStatus: debugPreview(res && res.status ? res.status.lastCompletionStatus : '', 120),
            completionLikelyTruncated: String(Boolean(completionLikelyTruncated)),
            rawStreamPreview: debugPreview(requestToken.streamRaw, 1800),
            rawCandidatePreview: debugPreview(rawCandidate, 1800),
            error: 'backend empty output',
          }, {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            requestMode: 'local',
            ...getCurrentDebugModelInfo(),
            deltaCount: requestToken.deltaCount,
            inferenceRoute: String(res && res.status ? res.status.lastInferenceRoute : ''),
            persistentError: String(res && res.status ? res.status.lastPersistentError : ''),
            completionStatus: String(res && res.status ? res.status.lastCompletionStatus : ''),
            completionLikelyTruncated: Boolean(completionLikelyTruncated),
            rawStream: clipDebugText(requestToken.streamRaw, 60000),
            rawCandidate: clipDebugText(rawCandidate, 60000),
            error: 'backend empty output',
            workspace: getWorkspaceDebugSnapshot(),
          });
          appendErrorMessageToChat(chatId, 'Offline inference backend returned empty output.');
          return;
        }
        const displayText = stripCanvasBlocksForDisplay(finalText).trim();
        const forceNeedsContinue = completionLikelyTruncated && isLikelyIncompleteResponse(displayText || finalText);
        const autoContinue = shouldAutoContinueResponse(chatId, displayText || finalText, res && res.status, requestToken);
        recordDebugTrace('request_finish_ok', {
          chatId: requestToken.chatId,
          streamId: requestToken.streamId,
          messageHistoryTotal: debugMessageHistoryTotal,
          deltaCount: String(requestToken.deltaCount),
          inferenceRoute: debugPreview(res && res.status ? res.status.lastInferenceRoute : '', 200),
          persistentError: debugPreview(res && res.status ? res.status.lastPersistentError : '', 800),
          completionStatus: debugPreview(res && res.status ? res.status.lastCompletionStatus : '', 120),
          completionLikelyTruncated: String(Boolean(completionLikelyTruncated)),
          thinkingTagDetected: String(Boolean(thinkingTagDetected)),
          rawStreamPreview: debugPreview(requestToken.streamRaw, 1800),
          rawCandidatePreview: debugPreview(rawCandidate, 1800),
          sanitizedPreview: debugPreview(finalText, 1800),
          displayPreview: debugPreview(displayText, 1800),
          model: String(appSettings.modelUrl || ''),
        }, {
          chatId: requestToken.chatId,
          streamId: requestToken.streamId,
          requestMode: 'local',
          ...getCurrentDebugModelInfo(),
          messageHistoryTotal: Number(debugMessageHistoryTotal) || 0,
          deltaCount: requestToken.deltaCount,
          inferenceRoute: String(res && res.status ? res.status.lastInferenceRoute : ''),
          persistentError: String(res && res.status ? res.status.lastPersistentError : ''),
          completionStatus: String(res && res.status ? res.status.lastCompletionStatus : ''),
          completionLikelyTruncated: Boolean(completionLikelyTruncated),
          thinkingTagDetected: Boolean(thinkingTagDetected),
          rawStream: clipDebugText(requestToken.streamRaw, 60000),
          rawCandidate: clipDebugText(rawCandidate, 60000),
          sanitizedOutput: clipDebugText(finalText, 60000),
          displayOutput: clipDebugText(displayText, 60000),
          workspace: getWorkspaceDebugSnapshot(),
        });
        if (requestToken.appendToLastAssistant && /^<?DONE>?$/i.test(String(finalText || '').trim())) {
          const chat = findChatById(chatId);
          if (chat) {
            chat.needsContinue = false;
            chat.updatedAt = nowTs();
            saveChats();
            renderHistory();
            updateContinueButtonVisibility();
            if (activeChatId === chatId) {
              renderActiveChat();
            }
          }
          return;
        }
        if (autoContinue) {
          setChatAutoContinuing(chatId, true);
        }
        commitAssistantMessage(chatId, finalText, rawCandidate, {
          appendToLastAssistant: requestToken.appendToLastAssistant,
          forceNeedsContinue,
          thinkingMeta: buildRequestThinkingMeta(requestToken),
        });
        if (autoContinue) {
          requestToken.nextAction = () => {
            void startAssistantContinuation(chatId, {
              autoContinuationRemaining: Math.max(0, requestToken.autoContinuationRemaining - 1),
            });
          };
        }
        return;
      }

      const streamedRaw = consumeLiveAssistantText();
      const streamedText = sanitizeAssistantText(streamedRaw);
      if (streamedText && !isArtifactOnlyResponse(streamedText)) {
        const named = applyInlineChatNameFromResponse(chatId, streamedRaw);
        const namedText = sanitizeAssistantText(named.text);
        const partialNeedsContinue = isLikelyTruncatedStatus(res && res.status) || isLikelyIncompleteResponse(namedText);
        const thinkingTagDetected = /<(thinking|think)>[\s\S]*?<\/\1>/i.test(requestToken.streamRaw || streamedRaw);
        recordDebugTrace('request_finish_stream_partial', {
          chatId: requestToken.chatId,
          streamId: requestToken.streamId,
          deltaCount: String(requestToken.deltaCount),
          inferenceRoute: debugPreview(res && res.status ? res.status.lastInferenceRoute : '', 200),
          persistentError: debugPreview(res && res.status ? res.status.lastPersistentError : '', 800),
          completionStatus: debugPreview(res && res.status ? res.status.lastCompletionStatus : '', 120),
          completionLikelyTruncated: String(Boolean(isLikelyTruncatedStatus(res && res.status))),
          thinkingTagDetected: String(Boolean(thinkingTagDetected)),
          rawStreamPreview: debugPreview(requestToken.streamRaw, 1800),
          sanitizedPreview: debugPreview(namedText, 1800),
        }, {
          chatId: requestToken.chatId,
          streamId: requestToken.streamId,
          requestMode: 'local',
          ...getCurrentDebugModelInfo(),
          deltaCount: requestToken.deltaCount,
          inferenceRoute: String(res && res.status ? res.status.lastInferenceRoute : ''),
          persistentError: String(res && res.status ? res.status.lastPersistentError : ''),
          completionStatus: String(res && res.status ? res.status.lastCompletionStatus : ''),
          completionLikelyTruncated: Boolean(isLikelyTruncatedStatus(res && res.status)),
          thinkingTagDetected: Boolean(thinkingTagDetected),
          rawStream: clipDebugText(requestToken.streamRaw, 60000),
          sanitizedOutput: clipDebugText(namedText, 60000),
          workspace: getWorkspaceDebugSnapshot(),
        });
        commitAssistantMessage(chatId, namedText, namedText, {
          appendToLastAssistant: requestToken.appendToLastAssistant,
          forceNeedsContinue: partialNeedsContinue,
          thinkingMeta: buildRequestThinkingMeta(requestToken),
        });
        return;
      }

      if (res && typeof res.message === 'string' && /unsupported action/i.test(res.message)) {
        const fallback = await nativeBridge.invoke('infer', {
          prompt: fullPrompt,
          maxTokens: requestToken.maxTokens,
          max_tokens: requestToken.maxTokens,
        });
        if (!isInferenceActive(requestToken)) {
          return;
        }
        if (fallback && fallback.ok) {
          const rawFallback = String(fallback.output || '');
          const named = applyInlineChatNameFromResponse(chatId, rawFallback);
          const namedOutput = String(named.text || '');
          const fallbackNeedsContinue =
            isLikelyTruncatedStatus(fallback && fallback.status) ||
            isLikelyIncompleteResponse(namedOutput);
          recordDebugTrace('request_finish_fallback', {
            chatId: requestToken.chatId,
            reason: 'unsupported_action',
            inferenceRoute: debugPreview(fallback && fallback.status ? fallback.status.lastInferenceRoute : '', 200),
            persistentError: debugPreview(fallback && fallback.status ? fallback.status.lastPersistentError : '', 800),
            rawPreview: debugPreview(namedOutput, 1800),
          }, {
            chatId: requestToken.chatId,
            requestMode: 'local',
            ...getCurrentDebugModelInfo(),
            reason: 'unsupported_action',
            inferenceRoute: String(fallback && fallback.status ? fallback.status.lastInferenceRoute : ''),
            persistentError: String(fallback && fallback.status ? fallback.status.lastPersistentError : ''),
            rawOutput: clipDebugText(namedOutput, 60000),
            workspace: getWorkspaceDebugSnapshot(),
          });
          if (requestToken.appendToLastAssistant) {
            commitAssistantMessage(chatId, namedOutput, namedOutput, {
              appendToLastAssistant: true,
              forceNeedsContinue: fallbackNeedsContinue,
              thinkingMeta: buildRequestThinkingMeta(requestToken),
            });
          } else {
            await typewriterAssistantMessage(chatId, namedOutput, {
              thinkingMeta: buildRequestThinkingMeta(requestToken),
            });
          }
          return;
        }
      }

      recordDebugTrace('request_finish_error', {
        chatId: requestToken.chatId,
        streamId: requestToken.streamId,
        deltaCount: String(requestToken.deltaCount),
        inferenceRoute: debugPreview(res && res.status ? res.status.lastInferenceRoute : '', 200),
        persistentError: debugPreview(res && res.status ? res.status.lastPersistentError : '', 800),
        rawStreamPreview: debugPreview(requestToken.streamRaw, 1800),
        error: debugPreview(res && res.message ? res.message : 'Inference failed.', 600),
      }, {
        chatId: requestToken.chatId,
        streamId: requestToken.streamId,
        requestMode: 'local',
        ...getCurrentDebugModelInfo(),
        deltaCount: requestToken.deltaCount,
        inferenceRoute: String(res && res.status ? res.status.lastInferenceRoute : ''),
        persistentError: String(res && res.status ? res.status.lastPersistentError : ''),
        rawStream: clipDebugText(requestToken.streamRaw, 60000),
        error: String(res && res.message ? res.message : 'Inference failed.'),
        workspace: getWorkspaceDebugSnapshot(),
      });
      appendErrorMessageToChat(chatId, res && res.message ? res.message : 'Inference failed.');
      return;
    }

    const delay = 1400 + Math.random() * 800;
    await new Promise((resolve) => {
      typingTimer = setTimeout(resolve, delay);
    });
    if (!isInferenceActive(requestToken)) {
      return;
    }
    await resolveTypingFallback(chatId);
  } finally {
    completeInferenceRequest(requestToken);
    if (!requestToken.cancelled && typeof requestToken.nextAction !== 'function' && !isChatOperationVisibleHere(chatId)) {
      const chat = findChatById(chatId);
      const chatName = String(chat && chat.name ? chat.name : 'this chat');
      const prefix = requestToken.operationKind === 'agent'
        ? 'Agent finished'
        : requestToken.operationKind === 'inspect'
          ? 'Inspection finished'
          : 'Reply finished';
      showChatCompletionNotification(chatId, `${prefix} in ${chatName}.`);
    }
    if (!requestToken.cancelled && typeof requestToken.nextAction === 'function') {
      requestToken.nextAction();
    } else {
      setChatAutoContinuing(chatId, false);
    }
  }
}

async function resolveTypingFallback(chatId) {
  clearTypingIndicator();
  typingTimer = null;
  const resp = aiResponses[Math.floor(Math.random() * aiResponses.length)];
  await typewriterAssistantMessage(chatId, resp);
}

loadAuthStore();
updateLoginUi();
loadAppSettings();
moveGlobalControlsIntoSidebar();
setupMacTopbarNativeDrag();
hydrateCustomTooltips(document);
initGlobalTooltipSystem();
refreshWorkspaceForCurrentUser();

// ── Project generation
function handleProjKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generateProject(); }
}

function createFolder() {
  if (!ensureSignedIn()) return;
  if (!nativeBridge.available()) {
    showAppNotification({
      title: 'Runtime unavailable',
      message: 'Native runtime bridge unavailable.',
      kind: 'error',
    });
    return;
  }
  startWorkspaceDraft('folder');
}

function createFile() {
  if (!ensureSignedIn()) return;
  if (!nativeBridge.available()) {
    showAppNotification({
      title: 'Runtime unavailable',
      message: 'Native runtime bridge unavailable.',
      kind: 'error',
    });
    return;
  }
  startWorkspaceDraft('file');
}

function renameSelectedWorkspaceItem() {
  if (!ensureSignedIn()) return;
  if (!nativeBridge.available()) {
    showAppNotification({
      title: 'Runtime unavailable',
      message: 'Native runtime bridge unavailable.',
      kind: 'error',
    });
    return;
  }
  void startWorkspaceRenameSelected();
}

function openWorkspaceParent() {
  if (workspaceCurrentPath === '/') return;
  setWorkspaceSelection(parentWorkspacePath(workspaceCurrentPath), 'folder');
  void renderArtifacts();
}

function generateProject() {
  if (!ensureSignedIn()) return;
  const val = projInput ? projInput.value.trim() : '';
  const type = projType ? projType.value : 'software';
  if (!val) return;
  const promptText = `Create a ${String(type || 'software').toUpperCase()} project plan for: ${val}. Only create files when explicitly requested.`;
  const chat = (inNewChatMode || !getActiveChat()) ? createChat(promptText) : getActiveChat();
  if (!chat) return;
  beginInferenceRequest();
  chatAutoScrollPinned = true;
  appendMessageToChat(chat.id, 'user', promptText);
  void requestAssistantReply(chat.id, promptText, true);

  if (projInput) projInput.value = '';
}

async function newProject() {
  if (!ensureSignedIn()) return;
  if (!nativeBridge.available()) {
    showAppNotification({
      title: 'Runtime unavailable',
      message: 'Native runtime bridge unavailable.',
      kind: 'error',
    });
    return;
  }

  // If a project is currently open, confirm before closing it.
  if (workspaceRootName) {
    const confirmed = window.confirm(
      `The current project "${workspaceRootName}" will be closed to create a new project.\n\nDo you want to continue?`
    );
    if (!confirmed) return;
    // Close the current project first.
    const closeRes = await invokeWorkspaceAction('workspaceCloseRoot', {});
    if (!closeRes || !closeRes.ok) {
      showAppNotification({
        title: 'Project close failed',
        message: (closeRes && closeRes.message) || 'Failed to close current project.',
        kind: 'error',
      });
      return;
    }
    clearWorkspaceDragExpandTimers();
    workspaceDraft = null;
    workspaceDraftFocusId = 0;
    workspaceRenameDraft = null;
    workspaceRenameFocusId = 0;
    applyWorkspaceStatusSnapshot({ ok: true, rootPath: '', rootName: '', currentPath: '/', currentKind: 'folder' });
    openFileTabs.length = 0;
    switchToTab('chat');
  }

  // Create a new project folder in Downloads and set it as workspace root.
  const response = await invokeWorkspaceAction('workspaceNewProject', {});
  if (!response || !response.ok) {
    showAppNotification({
      title: 'Project creation failed',
      message: (response && response.message) || 'Failed to create new project.',
      kind: 'error',
    });
    return;
  }

  // Refresh workspace state with the new project root.
  try {
    const snapshot = await requestWorkspaceStatusSnapshot();
    applyWorkspaceStatusSnapshot(snapshot);
  } catch (_) { }
  workspaceTreeState.clear();
  const freshRoot = getWorkspaceNodeState('/');
  freshRoot.expanded = true;
  freshRoot.loaded = false;
  setWorkspaceSelection('/', 'folder');
  await renderArtifacts();
}

Object.assign(window, {
  handleKey,
  autoResize,
  handleSendButtonClick,
  sendChip,
  continueMessage,
  toggleCanvasMode,
  openAttachPicker,
  editManualContext,
  newProject,
  createFolder,
  createFile,
  importWorkspaceFiles,
  importWorkspaceFolder,
  openWorkspaceProject,
  revealWorkspaceInSystem,
  closeWorkspaceProject,
  renameSelectedWorkspaceItem,
  refreshWorkspaceTree,
  collapseAllFolders,
  deleteSelectedWorkspaceItems,
  openWorkspaceParent,
  generateProject,
  handleProjKey,
});

window.addEventListener('beforeunload', () => {
  if (activeAgentStreamState && activeAgentStreamState.chatId) {
    commitInterruptedAgentRun(String(activeAgentStreamState.chatId || ''), 'Agent was interrupted before the app closed or reloaded.');
  }
  persistFileTabsStateNow();
  clearDebugTraceEntries();
});
