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
  };
  localStorage.setItem(layoutStorageKey, JSON.stringify(state));
}

function restoreLayoutWidths() {
  let left = sidebarDefaultWidth;
  let right = rightDefaultWidth;
  if (!rememberLayout) {
    applyLayoutWidths(left, right);
    return;
  }
  try {
    const raw = localStorage.getItem(layoutStorageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Number.isFinite(parsed.left)) left = parsed.left;
      if (Number.isFinite(parsed.right)) right = parsed.right;
    }
  } catch (_) { }

  applyLayoutWidths(left, right);
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
  return getBrowsableArtifacts().filter((item) => String(item.chatId || '') === chatKey && Number(item.messageTs) === ts);
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
const charCount = document.getElementById('charCount');
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
const emptyStateTemplate = (document.getElementById('emptyState') || { outerHTML: '' }).outerHTML;
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
let explorerImportMenuOpen = false;
let explorerMoreMenuOpen = false;
let modalChatId = null;
let typingTimer = null;
let thinkingInterval = null;
let thinkingStartedAt = 0;
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
const FILE_VIEWER_HIGHLIGHT_LIMIT_BYTES = 256 * 1024;
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
const thinkingStartedByChatId = new Map();
const pendingPreflightConfirmations = new Map();
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
  veniceModel: 'venice-uncensored',
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
  },
  deepseek: {
    label: 'DeepSeek API',
    keyField: 'deepseekApiKey',
    modelField: 'deepseekModel',
    keyLabel: 'DeepSeek API Key',
    keyPlaceholder: 'sk-...',
    modelPlaceholder: 'deepseek-chat',
    defaultModel: 'deepseek-chat',
    helpText: 'Uses DeepSeek\'s OpenAI-compatible chat API. Key stays in local app settings on this machine.',
    endpointUrl: 'https://api.deepseek.com/chat/completions',
    protocol: 'openai',
  },
  venice: {
    label: 'Venice API',
    keyField: 'veniceApiKey',
    modelField: 'veniceModel',
    keyLabel: 'Venice API Key',
    keyPlaceholder: 'via_...',
    modelPlaceholder: 'venice-uncensored',
    defaultModel: 'venice-uncensored',
    helpText: 'Uses Venice\'s OpenAI-compatible API. Key stays in local app settings on this machine.',
    endpointUrl: 'https://api.venice.ai/api/v1/chat/completions',
    protocol: 'openai',
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
    'deepseek-chat',
    'deepseek-reasoner',
  ],
  venice: [
    'venice-uncensored',
    'zai-org-glm-4.7',
    'llama-3.3-70b',
    'mistral-31-24b',
    'qwen3-4b',
    'qwen3-vl-235b-a22b',
  ],
};
let debugTraceEntries = [];
const debugTraceMaxEntries = 120;
const maxArtifactContentChars = 12000;
const maxPendingAttachments = 6;
const maxAttachmentTextChars = 7000;
const agentMaxSteps = 16;
const agentMaxToolOutputChars = 3200;
const agentStepTimeoutMs = 45000;
const agentTotalTimeoutMs = 600000;
const agentDecisionMaxTokens = 220;
const agentFileContentMaxTokens = 2400;
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
    rewrittenPrompt = `${pending.originalTask || ''}\n\nUse the existing workspace folder. DO NOT start from a fresh workspace.`.trim();
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
  void requestAssistantReply(chat.id, rewrittenPrompt, true, {
    latestUserOverride: String(pending.originalTask || rewrittenPrompt || '').trim(),
    preflightChoiceResolved: normalizedMode,
  });
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
    void syncWorkspaceStateFromNative('visibility_return', { render: true });
  });

  window.addEventListener('focus', () => {
    void syncWorkspaceStateFromNative('window_focus', { render: true });
  });
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
  if (pendingInferenceCount > 0) return;
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
  if (pendingInferenceCount > 0) return;
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
      return { ...msg, text: cleaned };
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
  void requestAssistantReply(chat.id, buildPromptWithInputAugments(cleaned), true);
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
  if (pendingInferenceCount > 0) return;
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
  void requestAssistantReply(chat.id, buildPromptWithInputAugments(userMessage), true);
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

function setThinkingStatus(text) {
  if (!thinkingStatus) return;
  const clean = String(text || '').trim();
  thinkingStatus.textContent = clean;
  thinkingStatus.classList.toggle('active', Boolean(clean));
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
      if (pending.midFlightAgentResume) {
        setPendingPreflightConfirmation(activeChatId, null);
        if (typeof activeProjectScopeResolve === 'function') {
          activeProjectScopeResolve(mode);
          activeProjectScopeResolve = null;
        } else {
          const manualText = mode === 'create_new_project' ? 'create a new project' : 'use current project';
          if (typeof window.submitTextPrompt === 'function') {
            window.submitTextPrompt(activeChatId, manualText);
          }
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
  if (pendingInferenceCount > 0) return;
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
  if (pendingInferenceCount > 0) return;
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
  const userMessages = Array.isArray(chat.messages)
    ? chat.messages.filter((msg) => msg && msg.role === 'user' && String(msg.text || '').trim())
    : [];
  const firstUserText = userMessages.length > 0 ? String(userMessages[0].text || '').trim() : '';
  if (isGreetingLikeChatSeed(firstUserText)) {
    return false;
  }
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
  // Match [[CHAT_NAME: title]] OR just [[title]] with or without markdown, allow line breaks
  const marker = src.match(/\[\[\s*\*?\*?(?:CHAT_NAME\s*:\s*)?([^\]]+?)\*?\*?\s*\]\]/i);
  if (!marker) {
    return { title: '', cleaned: src };
  }
  const rawTitle = String(marker[1] || '').trim();
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

function applyAgentProjectChatName(chatId, planSpec = null) {
  const chat = findChatById(chatId);
  if (!chat || chat.customName || !chat.isNaming || !planSpec) return false;
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
  const prettyName = normalizeChatName(toAutoTitleCase(sourceName.replace(/[-_]+/g, ' ')) || sourceName);
  if (!prettyName) return false;
  chat.name = makeUniqueChatName(prettyName, chatId, prettyName);
  chat.isNaming = false;
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
      pushDebugTrace('inline_namer_applied', {
        chatId: String(chatId || ''),
        title: chat.name,
      });
    } else {
      chat.name = deriveFallbackChatName(chat, parsed.cleaned || String(text || ''));
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
  if (pendingInferenceCount > 0) return;
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
      .filter((u) => u && typeof u.username === 'string' && typeof u.usernameKey === 'string' &&
        typeof u.salt === 'string' && typeof u.passwordHash === 'string')
      .slice(0, 100)
      .map((u) => ({
        username: normalizeUsername(u.username),
        usernameKey: usernameKey(u.usernameKey),
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
    if (loginBtnText) loginBtnText.textContent = 'Account';
    if (loginSubText) loginSubText.textContent = `// OFFLINE SESSION @${user.username}`;
    if (avatarBadge) {
      const initial = (user.username || 'U').trim().charAt(0).toUpperCase() || 'U';
      avatarBadge.textContent = initial;
      avatarBadge.title = `@${user.username}`;
    }
  } else {
    if (loginBtnText) loginBtnText.textContent = 'Log In / Sign Up';
    if (loginSubText) loginSubText.textContent = '// SECURE AUTH PROTOCOL';
    if (avatarBadge) {
      avatarBadge.textContent = 'U';
      avatarBadge.title = 'Guest';
    }
  }
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
    veniceModel: 'venice-uncensored',
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
}

function getSelectedInferenceProvider() {
  const raw = String(appSettings && appSettings.inferenceProvider ? appSettings.inferenceProvider : 'local').trim().toLowerCase();
  if (!remoteProvidersEnabled && raw !== 'local') return 'local';
  return Object.prototype.hasOwnProperty.call(inferenceProviderDefs, raw) ? raw : 'local';
}

function isRemoteInferenceProviderEnabled() {
  return remoteProvidersEnabled && getSelectedInferenceProvider() !== 'local';
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

function shouldUseNativeCustomOpenAiRelay(provider) {
  if (!remoteProvidersEnabled) return false;
  return String(provider || '').trim().toLowerCase() === 'customopenai'
    && nativeBridge.available()
    && document.documentElement.classList.contains('platform-mac');
}

function syncInferenceProviderOptions() {
  if (!settingsProviderSelect) return;
  Array.from(settingsProviderSelect.options || []).forEach((option) => {
    const value = String(option && option.value ? option.value : '').trim().toLowerCase();
    if (value && value !== 'local') {
      option.hidden = !remoteProvidersEnabled;
      option.disabled = !remoteProvidersEnabled;
    }
  });
  if (!remoteProvidersEnabled) {
    settingsProviderSelect.value = 'local';
    appSettings.inferenceProvider = 'local';
  }
}

function getProviderPresetValue(provider, modelId) {
  const cleanModel = String(modelId || '').trim();
  const presets = Array.isArray(inferenceProviderModelPresets[provider]) ? inferenceProviderModelPresets[provider] : [];
  return presets.includes(cleanModel) ? cleanModel : '__custom__';
}

function populateProviderPresetOptions(provider, modelId) {
  if (!settingsApiModelPreset) return;
  const presets = Array.isArray(inferenceProviderModelPresets[provider]) ? inferenceProviderModelPresets[provider] : [];
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
}

function populateRemoteProviderFields(provider) {
  const def = getInferenceProviderDef(provider);
  const currentModel = getProviderModel(provider);
  const currentEndpoint = getProviderEndpoint(provider);
  if (settingsApiKeyLabel) settingsApiKeyLabel.textContent = def.keyLabel || 'API Key';
  if (settingsApiKeyInput) {
    settingsApiKeyInput.placeholder = def.keyPlaceholder || 'sk-...';
    settingsApiKeyInput.value = getProviderApiKey(provider);
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
  if (!settingsNote) return;
  const clean = String(text || '').trim();
  if (!clean) {
    settingsNote.textContent = '';
    settingsNote.classList.remove('visible', 'auth-info');
    return;
  }
  settingsNote.textContent = clean;
  settingsNote.classList.add('visible');
  settingsNote.classList.toggle('auth-info', kind === 'info');
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

function setSendLoading(loading) {
  if (!sendBtn) return;
  sendBtn.classList.toggle('loading', loading);
  sendBtn.classList.toggle('cancel-mode', loading);
  sendBtn.title = loading ? 'Stop generation' : 'Send';
  sendBtn.setAttribute('aria-label', loading ? 'Stop generation' : 'Send message');
  sendBtn.disabled = false;
  if (continueBtn) {
    continueBtn.disabled = loading;
  }
  if (canvasBtn) {
    canvasBtn.disabled = loading;
  }
  if (attachBtn) {
    attachBtn.disabled = loading;
  }
  if (agentBtn) {
    agentBtn.disabled = loading;
  }
  if (thinkBtn) {
    thinkBtn.disabled = loading;
  }
  if (contextBtn) {
    contextBtn.disabled = loading;
  }
  if (composerPlusBtn) {
    composerPlusBtn.disabled = loading;
  }
  if (menuCanvasBtn) {
    menuCanvasBtn.disabled = loading;
  }
  if (menuAttachBtn) {
    menuAttachBtn.disabled = loading;
  }
  if (menuAgentBtn) {
    menuAgentBtn.disabled = loading;
  }
  if (menuThinkBtn) {
    menuThinkBtn.disabled = loading;
  }
  if (menuContextBtn) {
    menuContextBtn.disabled = loading;
  }
  if (micBtn) {
    micBtn.disabled = loading;
  }
  if (dictationCancelBtn) {
    dictationCancelBtn.disabled = loading;
  }
  if (dictationApplyBtn) {
    dictationApplyBtn.disabled = loading;
  }
  if (loading && composerMenuOpen) {
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
  // Pre-stream window: request is counted, token may not be attached yet.
  return Boolean(pendingInferenceCount > 0 && !inNewChatMode && middleViewMode === 'chat' && activeChatId);
}

function syncLiveInferenceUiState() {
  if (activeStreamRow && !activeStreamRow.isConnected) {
    activeStreamRow = null;
  }

  const operationRunning = Boolean(pendingInferenceCount > 0);
  const loadingHere = Boolean(operationRunning && isCurrentViewInferenceChat());
  // The send button is global and there is only one active operation at a time,
  // so keep it in cancel mode for the whole duration of the request.
  setSendLoading(operationRunning);
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
  clearTypingIndicator();
  const activeAgentState = activeAgentStreamState && String(activeAgentStreamState.chatId || '') === String(token.chatId || '')
    ? {
      chatId: String(activeAgentStreamState.chatId || ''),
      statusText: String(activeAgentStreamState.statusText || ''),
      activities: cloneAgentActivities(activeAgentStreamState.activities || []),
    }
    : null;
  const partialRaw = consumeLiveAssistantText();
  cancelLiveStreamRender();
  const partialText = sanitizeAssistantText(partialRaw);
  if (activeAgentState && Array.isArray(activeAgentState.activities) && activeAgentState.activities.length > 0) {
    const interruptedActivities = cloneAgentActivities(activeAgentState.activities || []);
    mergeAgentActivityIntoList(interruptedActivities, {
      kind: 'error',
      title: 'Interrupted',
      detail: 'Agent was interrupted before finishing.',
      status: 'error',
    });
    commitAssistantMessage(String(token.chatId || ''), '', '', {
      agentActivities: interruptedActivities,
      agentMeta: { startedAt: Number(token.startedAt) || Date.now(), completedAt: Date.now(), collapsed: true },
      forceNeedsContinue: false,
    });
    pushDebugTrace('request_cancelled_agent_committed', {
      chatId: String(token.chatId || ''),
      activityCount: String(interruptedActivities.length),
    });
  } else if (partialText && !isArtifactOnlyResponse(partialText)) {
    commitAssistantMessage(String(token.chatId || ''), partialText, partialRaw);
    pushDebugTrace('request_cancelled_partial_committed', {
      chatId: String(token.chatId || ''),
      preview: debugPreview(partialText, 600),
    });
  } else {
    resolveChatNamingFallback(String(token.chatId || ''), 'New Chat');
  }
  setThinkingStatus('Cancelled');
  completeInferenceRequest(token);
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
  const model = getProviderModel(provider);
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
      let message = `${def.label} request failed (${response.status}): ${body || response.statusText || 'unknown error'}`;
      try {
        const parsed = JSON.parse(body || '{}');
        const code = String(parsed && parsed.error && parsed.error.code ? parsed.error.code : '').trim();
        const apiMessage = String(parsed && parsed.error && parsed.error.message ? parsed.error.message : '').trim();
        if (code === 'model_not_supported') {
          message = `${def.label} model is not currently available through your enabled Hugging Face providers. Choose a supported preset or use a local model.${apiMessage ? ` Details: ${apiMessage}` : ''}`;
        }
      } catch (_) { }
      return {
        ok: false,
        message,
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
          const delta = parsed
            && Array.isArray(parsed.choices)
            && parsed.choices[0]
            && parsed.choices[0].delta
            && typeof parsed.choices[0].delta.content === 'string'
            ? parsed.choices[0].delta.content
            : '';
          if (!delta) continue;
          output += delta;
          if (typeof handlers.onDelta === 'function') {
            handlers.onDelta(delta);
          }
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
        message: `${def.label} request failed (${response.status}): ${body || response.statusText || 'unknown error'}`,
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

async function requestOpenAiCompatibleTextCompletion(provider, prompt, maxTokens) {
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
      headers: {
        Authorization: getOpenAiCompatibleAuthHeader(provider, apiKey, endpointUrl),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: String(prompt || '') }],
        max_tokens: Math.max(1, Number(maxTokens) || agentFileContentMaxTokens),
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const text = payload
      && Array.isArray(payload.choices)
      && payload.choices[0]
      && payload.choices[0].message
      && typeof payload.choices[0].message.content === 'string'
      ? payload.choices[0].message.content
      : '';
    return text ? { ok: true, output: text } : null;
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
    return text ? { ok: true, output: text } : null;
  } catch (_) {
    return null;
  }
}

async function requestSelectedRemoteTextCompletion(prompt, maxTokens) {
  if (!remoteProvidersEnabled) return null;
  const provider = getSelectedInferenceProvider();
  if (provider === 'local') return null;
  if (provider === 'anthropic') {
    return requestAnthropicTextCompletion(prompt, maxTokens);
  }
  return requestOpenAiCompatibleTextCompletion(provider, prompt, maxTokens);
}

function normalizeReplyModeDecision(text) {
  const lower = String(text || '').trim().toLowerCase();
  if (!lower) return '';
  if (/\bcanvas\b/.test(lower)) return 'canvas';
  if (/\bchat\b/.test(lower)) return 'chat';
  return '';
}

function inferReplyModeDeterministically(latestUserMessage) {
  const lower = String(latestUserMessage || '').toLowerCase();
  const asksForArtifact = /\b(write|draft|create|make|build|generate|design|compose|produce|prepare)\b/.test(lower);
  const artifactNoun = /\b(document|doc|essay|story|article|report|plan|proposal|email|letter|script|code|website|site|page|app|component|landing page|readme|guide|checklist|template|table|canvas)\b/.test(lower);
  const shortFollowUp = /\b(explain|why|how|what|where|when|who|can you|could you|is it|does it|do you|tell me|summarize|review|fix this|change that|continue|yes|no|ok|okay|thanks|thank you)\b/.test(lower);
  if (asksForArtifact && artifactNoun && !shortFollowUp) {
    return 'canvas';
  }
  return 'chat';
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
  const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
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

async function requestPreflightRouteDecision(chatId, latestUserMessage, options = {}) {
  const workspaceDebugSnapshot = getWorkspaceDebugSnapshot();
  const workspaceStatusSnapshot = await requestWorkspaceStatusSnapshot();
  const workspaceHasRealRoot = Boolean(
    workspaceStatusSnapshot
    && workspaceStatusSnapshot.ok
    && String(workspaceStatusSnapshot.rootName || workspaceStatusSnapshot.rootPath || '').trim()
  );
  const workspace = workspaceHasRealRoot
    ? {
      ...workspaceDebugSnapshot,
      workspaceRootName: String(workspaceStatusSnapshot.rootName || workspaceDebugSnapshot.workspaceRootName || '').trim(),
      currentPath: normalizeWorkspacePath(workspaceStatusSnapshot.currentPath || workspaceDebugSnapshot.currentPath || '/'),
    }
    : {
      ...workspaceDebugSnapshot,
      workspaceRootName: '',
      currentPath: '/',
      currentKind: 'folder',
      rootLoaded: false,
      rootEntryCount: 0,
      rootEntries: [],
    };
  const recentMessages = getChatDebugSnapshot(chatId, 10)
    .map((msg) => `${msg.role}: ${String(msg.text || '').slice(0, 1000)}`)
    .join('\n\n');
  const agentEnabled = Boolean(options && options.agentEnabled);
  const canvasEnabled = Boolean(options && options.canvasEnabled);
  const prompt = [
    'Return exactly one JSON object. No prose.',
    'Keys: route, shouldInspectWorkspace, shouldReadFiles, shouldModifyFiles, shouldCreateProject, shouldAskUser, reason, userMessage',
    'route must be one of: chat, inspect, agent, confirm',
    'Use inspect when the answer should be grounded in the current workspace by listing or reading files first, without editing them.',
    'Use agent when the user wants file or project changes.',
    'Use confirm when the next step should be a natural follow-up question before creating a project or making a risky assumption.',
    'Use chat only when no workspace grounding or mutation is needed.',
    'If there is an open workspace and the user refers to the current project or existing work, prefer inspect or agent over chat.',
    'If there is an open workspace but the user appears to be asking for a fresh project that may be unrelated to what is currently open, prefer confirm and ask whether to keep using the current project or create a new one.',
    'If there is no open workspace and the user appears to want project/file changes, prefer confirm with a natural userMessage asking whether to create a new project or open an existing folder.',
    'If agent mode is disabled, do not return agent; use inspect, chat, or confirm.',
    'If canvas mode is enabled, ignore it here; this router is only for chat vs inspect vs agent vs confirm.',
    'Decide from meaning, not keywords alone.',
    'When a follow-up question depends on the already open project, keep it grounded in that workspace even if the user mentions an OS, shell, terminal, package manager, or environment.',
    'Only choose chat when the answer is complete without reading any workspace files.',
    '',
    'Examples:',
    '- Open workspace exists. User: "inspect it" -> route: inspect',
    '- Open workspace exists. User: "how do I run this on Mac?" -> route: inspect',
    '- Open workspace exists. User: "does the current project already satisfy what I asked for?" -> route: inspect',
    '- Open workspace exists. User: "add pause support" -> route: agent',
    '- Open workspace exists. User: "start over in a brand new workspace" -> route: confirm or agent only if the request is explicitly for a separate project',
    '- No open workspace. User: "build a snake game in python" -> route: confirm',
    '- No open workspace. User: "what is Python?" -> route: chat',
    '',
    `Agent enabled: ${agentEnabled ? 'yes' : 'no'}`,
    `Canvas enabled: ${canvasEnabled ? 'yes' : 'no'}`,
    `Workspace root: ${workspace.workspaceRootName || '(none)'}`,
    `Workspace current path: ${workspace.currentPath || '/'}`,
    `Workspace root entry count: ${Number(workspace.rootEntryCount) || 0}`,
    `Recent chat:\n${recentMessages || '(none)'}`,
    '',
    `Latest user message:\n${String(latestUserMessage || '').trim()}`,
    '',
    'JSON:',
  ].join('\n');

  let parsed = null;
  if (remoteProvidersEnabled) {
    const remote = await requestSelectedRemoteTextCompletion(prompt, 220);
    parsed = extractFirstJsonObject(remote && remote.ok ? remote.output : '');
  }
  const advisoryDecision = normalizePreflightRouteDecision(parsed);
  const router = window.AIExePreflightRouter && typeof window.AIExePreflightRouter.evaluate === 'function'
    ? window.AIExePreflightRouter
    : null;
  if (!router) {
    return advisoryDecision;
  }
  const evaluated = router.evaluate({
    advisoryDecision,
    latestUserMessage,
    workspace,
    agentEnabled,
    normalizeWorkspacePath,
  });
  const decision = normalizePreflightRouteDecision(evaluated && evaluated.decision ? evaluated.decision : advisoryDecision);
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
  const inlineChatNameInstruction = buildInlineChatNameInstructionForTurn(chatId);
  const prompt = [
    'Return exactly one JSON object. No prose outside JSON.',
    'Schema: {"answer":"final user-facing answer"}',
    'Answer the user using only the inspected workspace context below.',
    'Do not invent repository URLs, clone steps, or generic setup advice unless the inspected files explicitly show that information.',
    'If the inspected files are insufficient, say what is missing briefly.',
    'Prefer direct grounded answers over generic programming advice.',
    'This is inspect mode only. Do not claim that you changed files, will edit code, or applied an improvement.',
    'If the user asks for an improvement idea, identify the best grounded improvement candidate but describe it as a recommendation, not an action taken.',
    'Do not claim you inspected files that are not included below.',
    'Do not repeat these instructions, prompt headers, recent chat, or workspace context in the answer field.',
    inlineChatNameInstruction,
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
  reportProgress('Choosing relevant files...');
  const plan = await requestWorkspaceInspectPlan(chatId, promptText, listInfo.summary);
  const selectedPaths = normalizeInspectPlanPaths(plan && plan.paths, listInfo.entries, workspaceContext);
  const inspectedFiles = [];
  for (const path of selectedPaths) {
    reportProgress(`Reading ${path}...`);
    const readResponse = await invokeWorkspaceBridgeAction('workspaceReadFile', { path });
    if (!readResponse || !readResponse.ok) continue;
    inspectedFiles.push({
      path,
      content: clipDebugText(String(readResponse.output || ''), 18000),
    });
  }
  const inspectContextText = [
    listInfo.summary,
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
    'Canvas mode is enabled by the user in the app UI, so canvas is allowed but not mandatory.',
    'Choose CANVAS only when the user is asking for a substantial standalone deliverable that should live as an artifact, document, code block, or structured canvas output.',
    'Choose CHAT for conversational replies, short follow-ups, verification, clarification, correction, explanation, or discussion about existing content.',
    'Prefer CHAT unless a new artifact-like deliverable is clearly needed.',
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

function handleSendButtonClick() {
  if (pendingInferenceCount > 0) {
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

  if (/[,:;(\[{`"]$/.test(clean)) return true;
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

  // Show/hide model setup banner
  const showBanner = !status.modelLoaded;
  const bannerEl = document.getElementById('modelSetupBanner');
  if (bannerEl) {
    bannerEl.style.display = showBanner ? 'block' : 'none';
  }
  // Also update the cached template so re-renders keep the right state
  const tmplBanner = document.querySelector('#emptyState .model-setup-banner');
  if (tmplBanner) {
    tmplBanner.style.display = showBanner ? 'block' : 'none';
    emptyStateTemplate = (document.getElementById('emptyState') || { outerHTML: '' }).outerHTML;
  }

  // Track workspace root folder name (like VSCode shows real folder name in explorer)
  if (typeof status.rootPath === 'string') {
    const rp = status.rootPath.replace(/[/\\]+$/, '');
    workspaceRootName = rp ? rp.split(/[/\\]/).pop() || '' : '';
  }
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
  syncSettingsProviderUi();
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
    const charCount = document.getElementById('charCount');
    if (charCount) charCount.textContent = '0 / ∞';
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
  if (canvasModeEnabled && parsed.payloads.length === 0) {
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
        agentActivities: options.agentActivities,
        agentMeta: options.agentMeta,
      })
      : appendMessageToChat(chatId, 'ai', display, 0, {
        forceNeedsContinue,
        thinking: thinkingState.text,
        agentActivities: options.agentActivities,
        agentMeta: options.agentMeta,
      });
  } else if (parsed.payloads.length > 0) {
    appendedMessage = appendMessageToChat(chatId, 'ai', 'Artifact created. Open details below.', 0, {
      forceNeedsContinue: false,
      thinking: thinkingState.text,
      agentActivities: options.agentActivities,
      agentMeta: options.agentMeta,
    });
  } else {
    appendedMessage = appendErrorMessageToChat(chatId, 'Offline inference backend returned empty output.', 0);
  }
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
  notificationContainer.className = 'chat-toast-stack';
  document.body.appendChild(notificationContainer);
  return notificationContainer;
}

function showChatCompletionNotification(chatId, message) {
  const text = String(message || '').trim();
  if (!text) return;
  const stack = ensureNotificationContainer();
  const toast = document.createElement('button');
  toast.type = 'button';
  toast.className = 'chat-toast';
  toast.innerHTML = `
    <span class="chat-toast-title">Operation finished</span>
    <span class="chat-toast-body">${escapeHtml(text)}</span>
  `;
  const close = () => {
    if (!toast.isConnected) return;
    toast.classList.remove('open');
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 180);
  };
  toast.addEventListener('click', () => {
    close();
    if (String(chatId || '').trim()) {
      loadHistory(String(chatId || '').trim());
    }
  });
  stack.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add('open');
  });
  setTimeout(close, 4800);
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
    setWorkspaceDraftFocusId: (value) => { workspaceDraftFocusId = Number(value) || 0; },
    getWorkspaceRenameDraft: () => workspaceRenameDraft,
    setWorkspaceRenameDraft: (value) => { workspaceRenameDraft = value; },
    getWorkspaceRenameFocusId: () => workspaceRenameFocusId,
    setWorkspaceRenameFocusId: (value) => { workspaceRenameFocusId = Number(value) || 0; },
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
    loadWorkspaceChildren,
    setWorkspaceSelection,
    renderArtifacts: (...args) => renderArtifacts(...args),
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
    getWorkspaceNodeState,
    renderArtifacts: (...args) => renderArtifacts(...args),
    updateAssistantAgentMeta,
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
    shouldInlineNameChatResponse,
  })
  : null;
const promptCoreApi = promptCore || {};
const agentDecisionGrammar = String(promptCoreApi.agentDecisionGrammar || '');
const agentPlanGrammar = String(promptCoreApi.agentPlanGrammar || '');

function getWorkspaceContext() {
  const rootNode = workspaceTreeState.get('/') || null;
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
  workspaceRootName = hasRoot ? canonicalRootName : '';
  workspaceCurrentPath = hasRoot ? nextPath : '/';
  workspaceCurrentKind = snapshot.currentKind === 'file' && hasRoot ? 'file' : 'folder';
  if (!hasRoot) {
    workspaceItems = [];
    workspaceTreeState.clear();
    const freshRoot = getWorkspaceNodeState('/');
    freshRoot.expanded = true;
    freshRoot.loaded = false;
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
    workspaceSelectedPaths.clear();
    workspaceSelectedPaths.add(workspaceCurrentPath || '/');
    if (options.persistRootPath !== false) {
      saveWorkspaceRootPath(rootPath);
    }
  }
}

let workspaceSyncPromise = null;
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
  if (String(activeTabId || '') === normalized || String(activeTabId || '').startsWith(`${normalized}/`)) {
    activeTabId = 'chat';
  }
  persistFileTabsStateNow();
  renderTabBar();
}

const agentCore = window.AIExeAgentCore && typeof window.AIExeAgentCore.createAgentCore === 'function'
  ? window.AIExeAgentCore.createAgentCore({
    normalizeWorkspaceName,
    normalizeWorkspacePath,
    getWorkspaceContext,
    looksLikePlaceholderImplementation: (content) => /placeholder|todo:|coming soon|implement this/i.test(String(content || '')),
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
  buildFallbackExpectedFiles,
  shouldFallbackPlanNeedReadme,
  isExplicitReadmeOrDocsTask,
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

async function requestAgentPlannerInference(prompt, maxTokens, grammar = '') {
  if (agentRuntime && typeof agentRuntime.requestExternalAgentPlanner === 'function') {
    const external = await agentRuntime.requestExternalAgentPlanner(prompt, maxTokens);
    if (external && external.ok) {
      return {
        ...external,
        model: String((external && external.model) || '').trim(),
      };
    }
  }
  const remote = await requestSelectedRemoteTextCompletion(prompt, maxTokens);
  if (remote && remote.ok) {
    return {
      ok: true,
      output: String(remote.output || ''),
      model: String((remote && remote.model) || getProviderModel(getSelectedInferenceProvider()) || '').trim(),
    };
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
    buildFallbackAgentPlanSpec,
    buildAgentFileGenerationHints,
    loadPromptTemplate,
    renderPromptTemplate,
    buildAgentHistoryTranscript: (...args) => (promptCoreApi.buildAgentHistoryTranscript ? promptCoreApi.buildAgentHistoryTranscript(...args) : ''),
    requestAgentPlannerInference,
    getWorkspaceContext,
    deriveProjectNameFromTask,
    agentMaxSteps,
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
    agentFileGenerationRequestTimeoutMs,
    loadPromptTemplate,
    renderPromptTemplate,
    buildAgentWriteFileContentPrompt,
    buildAgentEditFileContentPrompt,
    buildAgentRewriteExistingFilePrompt,
    sanitizeAgentGeneratedFileContent,
    sanitizeAgentGeneratedEditProgram,
    requestSelectedRemoteTextCompletion,
    nativeBridge,
    normalizeWorkspacePath,
    deriveProjectNameFromTask,
    sanitizeAssistantText,
  })
  : null;
const {
  generateAgentWriteFileContent,
  generateAgentEditFileProgram,
  generateAgentRewriteExistingFileContent,
  buildAgentCompletionFallbackText,
  generateAgentCompletionText,
  buildAgentProgressMarkdown,
  describeAgentToolTarget,
} = agentRuntime || {};

const agentExecutor = window.AIExeAgentExecutor && typeof window.AIExeAgentExecutor.createAgentExecutor === 'function'
  ? window.AIExeAgentExecutor.createAgentExecutor({
    normalizeWorkspacePath,
    mapWorkspaceEntry,
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
    recordDebugTrace,
    debugPreview,
    syncFileTabFromWorkspaceWrite,
    workspaceBaseName,
    agentMaxToolOutputChars,
    isLikelyNewAgentFileTarget,
    setActiveAgentStreamStatus,
    isAgentGeneratedContentTarget,
    generateAgentWriteFileContent,
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
    agentMaxSteps,
    agentDecisionMaxTokens,
    agentDecisionGrammar,
    agentStepTimeoutMs,
    agentMaxToolOutputChars,
    mergeAgentActivityIntoList,
    pushActiveAgentStreamActivity,
    scheduleLiveStreamRender,
    isInferenceActive,
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
    buildAgentPlanSpec,
    applyAgentProjectChatName,
    pushDebugTrace,
    recordDebugTrace,
    debugPreview,
    resetActiveAgentStreamState,
    buildAgentPlanActivity,
    setThinkingStatus,
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
    requestProjectScopeConfirmation,
    scheduleWorkspaceExplorerBackgroundRefresh,
    sanitizeAssistantText,
    describeAgentToolPhase,
  })
  : null;
const {
  requestDeveloperAgentReply,
} = agentLoop || {};

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
            thinking: m && m.role === 'ai' && typeof m.thinking === 'string'
              ? m.thinking.slice(0, 20000)
              : '',
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
  loginBtn.addEventListener('click', () => {
    if (currentAuthUser()) {
      openAuthModal('account');
    } else {
      openAuthModal('login');
    }
  });
}
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
        } else {
          importBtn.textContent = 'Import Model';
          window.alert((res && res.message) || 'Model import failed.');
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
    syncSettingsProviderUi();
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
  });
}
if (settingsApiModelInput) {
  settingsApiModelInput.addEventListener('input', () => {
    if (!settingsApiModelPreset || !settingsProviderSelect) return;
    const provider = String(settingsProviderSelect.value || 'local').trim().toLowerCase();
    settingsApiModelPreset.value = getProviderPresetValue(provider, settingsApiModelInput.value);
  });
}
if (settingsSaveBtn) {
  settingsSaveBtn.addEventListener('click', async () => {
    const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    setButtonLoading(settingsSaveBtn, true);
    await waitForUiPaint();
    try {
      const provider = settingsProviderSelect
        ? String(settingsProviderSelect.value || 'local').trim().toLowerCase()
        : 'local';
      appSettings.inferenceProvider = remoteProvidersEnabled && Object.prototype.hasOwnProperty.call(inferenceProviderDefs, provider)
        ? provider
        : 'local';
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
      await ensureMinLoading(startedAt, 180);
      setSettingsNote(
        appSettings.inferenceProvider === 'local'
          ? 'Settings saved locally.'
          : `Settings saved locally. ${providerDef.label} is active.`,
        'info'
      );
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
    if (pendingInferenceCount > 0) return;
    setComposerMenuOpen(!composerMenuOpen);
  });
}
if (menuCanvasBtn) {
  menuCanvasBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0) return;
    setCanvasMode(!canvasModeEnabled);
    syncInputAugmentState();
    setComposerMenuOpen(false);
  });
}
if (menuAttachBtn) {
  menuAttachBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0) return;
    void openAttachPicker();
    setComposerMenuOpen(false);
  });
}
if (menuAgentBtn) {
  menuAgentBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0) return;
    setDeveloperAgentMode(!developerAgentEnabled);
    syncInputAugmentState();
    setComposerMenuOpen(false);
  });
}
if (menuThinkBtn) {
  menuThinkBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0) return;
    setThinkMode(!thinkModeEnabled);
    syncInputAugmentState();
    setComposerMenuOpen(false);
  });
}
if (menuContextBtn) {
  menuContextBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0) return;
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
    if (pendingInferenceCount > 0) return;
    setCanvasMode(false);
    syncInputAugmentState();
  });
}
if (attachBtn) {
  attachBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0) return;
    clearPendingAttachments();
  });
}
if (agentBtn) {
  agentBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0) return;
    setDeveloperAgentMode(false);
    syncInputAugmentState();
  });
}
if (thinkBtn) {
  thinkBtn.addEventListener('click', () => {
    if (pendingInferenceCount > 0) return;
    setThinkMode(false);
    syncInputAugmentState();
  });
}
if (contextBtn) {
  contextBtn.addEventListener('click', (event) => {
    if (pendingInferenceCount > 0) return;
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
  if (chatRendererApi.renderActiveChat) {
    return chatRendererApi.renderActiveChat(...args);
  }
  return undefined;
}

function createChat(seedText) {
  const ts = nowTs();
  const id = makeChatId();
  const seed = String(seedText || '').trim();
  const chat = {
    id,
    name: 'New Chat',
    customName: false,
    isNaming: true,
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
  return appendMessageToChat(chatId, 'error', text, forcedTs);
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
  if (role === 'ai' && typeof options.thinking === 'string' && options.thinking.trim()) {
    message.thinking = options.thinking.trim();
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
    if (chat.isNaming && !chat.customName) {
      const aiCount = activeThread.messages.filter((m) => m && m.role === 'ai').length;
      if (aiCount === 1) {
        chat.name = deriveFallbackChatName(chat, cleaned);
        chat.isNaming = false;
      }
    }
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
  if (pendingInferenceCount > 0) {
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
  document.getElementById('charCount').textContent = el.value.length + ' / ∞';
}

function clearInputBox() {
  mainInput.value = '';
  mainInput.style.height = 'auto';
  document.getElementById('charCount').textContent = '0 / ∞';
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
    window.alert('Native runtime bridge unavailable.');
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
      window.alert(String((res && res.message) || 'Failed to start offline dictation.'));
      return;
    }
    startDictationLevelPolling();
  } catch (err) {
    setMicListeningState(false);
    stopDictationWaveVisualizer();
    stopDictationLevelPolling();
    window.alert(`Failed to start offline dictation: ${String(err && err.message ? err.message : err || 'Unknown error')}`);
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

  if (/^\/?think\s+off$/.test(lower) || /^\/?unthink$/.test(lower)) {
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
  if (/^\/?think$/.test(lower) || /^\/?think\s+on$/.test(lower)) {
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

  const withPayload = input.match(/^\/?think(?:\s*[:\-]\s*|\s+)([\s\S]+)$/i);
  if (!withPayload) {
    return { handled: false, modelText: input, userText: input, thinkForced: false };
  }
  const payload = String(withPayload[1] || '').trim();
  if (!payload) {
    return { handled: false, modelText: input, userText: input, thinkForced: false };
  }
  return { handled: false, modelText: payload, userText: payload, thinkForced: true };
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

function sendMessage() {
  if (pendingInferenceCount > 0) return;
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
  beginInferenceRequest();
  chatAutoScrollPinned = true;
  appendMessageToChat(chat.id, 'user', userText);
  void requestAssistantReply(chat.id, modelPrompt, true, { thinkForced: Boolean(thinkControl.thinkForced) });
}

function sendChip(el) {
  if (pendingInferenceCount > 0) return;
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
  if (pendingInferenceCount > 0) return;
  maybeStopDictationForSend();
  if (!ensureSignedIn()) return;
  enterChatView();
  const chat = getActiveChat();
  if (!chat) return;
  if (!chat.needsContinue) return;

  chat.needsContinue = false;
  chatAutoScrollPinned = true;
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
    .replace(/<(thinking|think)>[\s\S]*$/i, '')
    .replace(/<\s*\/?\s*t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?[^>]*$/i, '');
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
  const normalizedSource = normalizeImplicitThinkingTrace(text);
  const hadThinkingTrace = /<(thinking|think)>[\s\S]*?<\/\1>/i.test(normalizedSource);
  let clean = sanitizeAssistantDelta(text);
  clean = clean.replace(/^\s*__?AGENT_PROGRESS__?:\s*/gim, '');
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
  clean = clean
    .replace(/^\s*assistant\s*$/gim, '')
    .replace(/^\s*user\s*$/gim, '')
    .replace(/^\s*system\s*$/gim, '')
    .replace(/^\s*(?:A|U|AI|USER|ASSISTANT)\s*>\s*/gim, '')
    .replace(/^\s*\[(?:USER|ASSISTANT)\]\s*/gim, '')
    .replace(/^\s*(?:AI|ASSISTANT)\s*:\s*/gim, '')
    .replace(/^\s*Intro sentence\s*:?\s*/gim, '')
    .replace(/^\s*Outro sentence\s*:?\s*/gim, '');
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
  if (agentProgressText) {
    bubble.innerHTML = '';
    bubble.appendChild(buildAgentActivityPanel(
      activeAgentStreamState && activeAgentStreamState.chatId ? activeAgentStreamState.chatId : '',
      activeAgentStreamState && Array.isArray(activeAgentStreamState.activities) ? activeAgentStreamState.activities : [],
      {
        statusText: (activeAgentStreamState && activeAgentStreamState.statusText != null)
          ? activeAgentStreamState.statusText
          : agentProgressText,
      }
    ));
    scrollChatToBottom();
    return;
  }
  const thinkingState = buildThinkingState(activeStreamRawText);
  const parsedCanvas = extractCanvasBlocksFromReply(activeStreamRawText);
  populateAssistantBubble(bubble, activeStreamText, {
    showThinkingLoader: thinkingState.inProgress || Boolean(thinkingState.text),
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
  if (!activeStreamRow || !activeStreamRow.isConnected) {
    createLiveAssistantRow(chatId);
  }
  if (!activeStreamRow) return;
  const nextRaw = `${activeStreamRawText}${raw}`;
  const nextDisplay = stripLeadingInlineChatNameFragment(stripCanvasBlocksForDisplay(
    sanitizeStreamDelta(nextRaw)
  ), chatId);
  const thinkingState = buildThinkingState(nextRaw);
  activeStreamRawText = nextRaw;
  activeStreamText = nextDisplay;
  if (!activeStreamText.trim() && !thinkingState.text && !thinkingState.inProgress) {
    return;
  }
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

async function typewriterAssistantMessage(chatId, text) {
  const rawContent = String(text || '').trim();
  const content = sanitizeAssistantText(rawContent);
  if (!content) {
    appendErrorMessageToChat(chatId, 'Offline inference backend returned empty output.');
    return;
  }

  if (activeChatId !== chatId || inNewChatMode) {
    commitAssistantMessage(chatId, content, rawContent);
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
    commitAssistantMessage(chatId, content, rawContent);
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
  commitAssistantMessage(chatId, content, rawContent);
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
        requestToken.operationKind = 'agent';
        setThinkingStatus('Planning changes...');
        const handledByAgent = await requestDeveloperAgentReply(requestToken, chatId, promptText);
        if (!isInferenceActive(requestToken)) {
          return;
        }
        if (handledByAgent) {
          return;
        }
      } else {
        const preflightDecision = await requestPreflightRouteDecision(chatId, promptText, {
          agentEnabled: true,
          canvasEnabled: canvasModeUiEnabled,
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
            scheduleLiveStreamRender();
          };
          setInspectProgress('Inspecting workspace...');
          const inspected = await performWorkspaceInspectReply(chatId, promptText, requestToken, setInspectProgress);
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
            if (requestToken.appendToLastAssistant) {
              commitAssistantMessage(chatId, finalText, rawCandidate, {
                appendToLastAssistant: true,
                forceNeedsContinue: false,
              });
            } else {
              consumeLiveAssistantText();
              await typewriterAssistantMessage(chatId, rawCandidate);
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
          requestToken.operationKind = 'agent';
          setThinkingStatus('Planning changes...');
          const handledByAgent = await requestDeveloperAgentReply(requestToken, chatId, promptText);
          if (!isInferenceActive(requestToken)) {
            return;
          }
          if (handledByAgent) {
            return;
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
    const inferenceProvider = getSelectedInferenceProvider();
    const debugMessageHistoryTotal = String(getDebugMessageHistoryTotal(chatId));
    if (inferenceProvider !== 'local') {
      const fullPrompt = await buildInferencePrompt(chatId, promptText, {
        thinkForced: requestToken.thinkForced,
        canvasModeOverride,
        latestUserOverride: requestToken.latestUserOverride,
        suppressChatNameInstruction: requestToken.appendToLastAssistant || requestToken.suppressChatNameInstruction,
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
        provider: inferenceProvider,
        model: String(getProviderModel(inferenceProvider) || ''),
        latestUserInput: String(promptText || ''),
        fullPrompt,
        chatHistory: getChatDebugSnapshot(chatId),
        workspace: getWorkspaceDebugSnapshot(),
      });
      const res = await streamRemoteChatCompletion(inferenceProvider, fullPrompt, {
        onStart: (streamId) => {
          requestToken.streamId = String(streamId || '');
          recordDebugTrace('stream_start', {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            provider: inferenceProvider,
            model: String(getProviderModel(inferenceProvider) || ''),
            messageHistoryTotal: debugMessageHistoryTotal,
          }, {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            requestMode: 'remote',
            provider: inferenceProvider,
            model: String(getProviderModel(inferenceProvider) || ''),
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
        abortController: requestToken.abortController,
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
        let rawCandidate = streamedRawSanitized || String(res.output || '').trim();
        const named = applyInlineChatNameFromResponse(chatId, rawCandidate);
        rawCandidate = String(named.text || '').trim();
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
          model: String(getProviderModel(inferenceProvider) || ''),
        }, {
          chatId: requestToken.chatId,
          streamId: requestToken.streamId,
          requestMode: 'remote',
          messageHistoryTotal: Number(debugMessageHistoryTotal) || 0,
          deltaCount: requestToken.deltaCount,
          inferenceRoute: String(res && res.status ? res.status.lastInferenceRoute : ''),
          provider: inferenceProvider,
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
          model: String(getProviderModel(inferenceProvider) || ''),
        }, {
          chatId: requestToken.chatId,
          streamId: requestToken.streamId,
          requestMode: 'remote',
          deltaCount: requestToken.deltaCount,
          inferenceRoute: String(res && res.status ? res.status.lastInferenceRoute : ''),
          provider: inferenceProvider,
          model: String(getProviderModel(inferenceProvider) || ''),
          rawStream: clipDebugText(requestToken.streamRaw, 60000),
          sanitizedOutput: clipDebugText(namedText, 60000),
          workspace: getWorkspaceDebugSnapshot(),
        });
        commitAssistantMessage(chatId, namedText, namedText, {
          appendToLastAssistant: requestToken.appendToLastAssistant,
          forceNeedsContinue: false,
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
      });
      requestToken.promptPreview = debugPreview(fullPrompt, 1600);
      recordDebugTrace('request_start', {
        chatId: requestToken.chatId,
        messageHistoryTotal: debugMessageHistoryTotal,
        promptLength: String(fullPrompt.length),
        promptLines: String(fullPrompt.split('\n').length),
        thinkMode: String(Boolean(thinkModeEnabled || requestToken.thinkForced)),
        canvasModeResolved: String(canvasModeOverride === null ? canvasModeUiEnabled : canvasModeOverride),
        model: String(appSettings.modelUrl || ''),
        promptPreview: requestToken.promptPreview,
      }, {
        chatId: requestToken.chatId,
        requestMode: 'local',
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
            model: String(appSettings.modelUrl || ''),
            messageHistoryTotal: debugMessageHistoryTotal,
          }, {
            chatId: requestToken.chatId,
            streamId: requestToken.streamId,
            requestMode: 'local',
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
            });
          } else {
            await typewriterAssistantMessage(chatId, namedOutput);
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
    window.alert('Native runtime bridge unavailable.');
    return;
  }
  startWorkspaceDraft('folder');
}

function createFile() {
  if (!ensureSignedIn()) return;
  if (!nativeBridge.available()) {
    window.alert('Native runtime bridge unavailable.');
    return;
  }
  startWorkspaceDraft('file');
}

function renameSelectedWorkspaceItem() {
  if (!ensureSignedIn()) return;
  if (!nativeBridge.available()) {
    window.alert('Native runtime bridge unavailable.');
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
    window.alert('Native runtime bridge unavailable.');
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
      window.alert((closeRes && closeRes.message) || 'Failed to close current project.');
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
    window.alert((response && response.message) || 'Failed to create new project.');
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
  persistFileTabsStateNow();
  clearDebugTraceEntries();
});
