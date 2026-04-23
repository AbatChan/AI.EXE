(function initAIExePreflightRouter(global) {
  function defaultNormalizeWorkspacePath(raw) {
    const value = String(raw || '/').replace(/\\/g, '/').trim();
    const parts = value.split('/').filter((part) => part && part !== '.' && part !== '..');
    return parts.length > 0 ? `/${parts.join('/')}` : '/';
  }

  function normalizeDecision(rawDecision) {
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

  const topicStopwords = new Set([
    'a', 'an', 'and', 'app', 'application', 'browser', 'build', 'by', 'can', 'code', 'create', 'current',
    'dashboard', 'design', 'develop', 'do', 'existing', 'file', 'files', 'folder', 'for', 'from', 'frontend',
    'game', 'help', 'html', 'i', 'implement', 'improve', 'in', 'it', 'js', 'make', 'me', 'modify', 'my', 'new',
    'nice', 'of', 'page', 'please', 'project', 'repo', 'repository', 'scratch', 'simple', 'site', 'software',
    'start', 'style', 'styles', 'the', 'this', 'to', 'tool', 'ui', 'up', 'use', 'web', 'website', 'with', 'workspace', 'you',
  ]);

  function tokenizeTopicWords(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token && token.length >= 3 && !topicStopwords.has(token));
  }

  function collectWorkspaceTopicTokens(workspace) {
    const tokens = new Set();
    const addTokens = (value) => {
      tokenizeTopicWords(value).forEach((token) => tokens.add(token));
    };
    addTokens(workspace && workspace.workspaceRootName ? workspace.workspaceRootName : '');
    const entries = Array.isArray(workspace && workspace.rootEntries) ? workspace.rootEntries : [];
    entries.slice(0, 12).forEach((entry) => {
      addTokens(entry && entry.name ? entry.name : '');
      addTokens(entry && entry.path ? entry.path : '');
    });
    return Array.from(tokens);
  }

  function computeFeatures(latestUserMessage, workspace, options = {}) {
    const normalizeWorkspacePath = typeof options.normalizeWorkspacePath === 'function'
      ? options.normalizeWorkspacePath
      : defaultNormalizeWorkspacePath;
    const text = String(latestUserMessage || '').trim();
    const lower = text.toLowerCase();
    const currentPath = normalizeWorkspacePath(workspace && workspace.currentPath ? workspace.currentPath : '/');
    const selectedKind = workspace && workspace.currentKind === 'file' ? 'file' : 'folder';
    const rootName = String(workspace && workspace.workspaceRootName ? workspace.workspaceRootName : '').trim();
    const rootEntryCount = Number(workspace && workspace.rootEntryCount) || 0;
    const rootLoaded = Boolean(workspace && workspace.rootLoaded);
    // Treat the workspace root identity as the source of truth for "open project".
    // Stale tree entries can linger briefly after close, so rootEntryCount/rootLoaded
    // alone should not make the router believe a project is still open.
    const hasOpenWorkspace = Boolean(rootName || currentPath !== '/');
    const workspaceIsEmpty = !hasOpenWorkspace || rootEntryCount <= 0;
    const requestTopicTokens = Array.from(new Set(tokenizeTopicWords(text)));
    const workspaceTopicTokens = collectWorkspaceTopicTokens(workspace);
    const workspaceTokenSet = new Set(workspaceTopicTokens);
    const topicOverlapTokens = requestTopicTokens.filter((token) => workspaceTokenSet.has(token));
    const topicOverlapRatio = requestTopicTokens.length > 0
      ? topicOverlapTokens.length / requestTopicTokens.length
      : 0;

    const pureGreeting = /^(hi|hello|hey|yo|sup|good (morning|afternoon|evening))([!. ]+)?$/i.test(text);
    const asksGeneralKnowledge = /\b(what is|who is|define|meaning of|explain)\b/.test(lower)
      && !/\b(project|workspace|repo|repository|code|codebase|file|files|current|existing|this)\b/.test(lower);
    const creationVerb = /\b(create|build|make|design|develop|generate|start|set up|setup)\b/.test(lower);
    const deliverableNoun = /\b(app|site|website|page|landing page|dashboard|tool|game|calculator|portfolio|blog|api|service|cli|project|frontend|ui)\b/.test(lower);
    const explicitNewProjectIntent = /\b(new project|new workspace|from scratch|start from scratch|brand new|separate project|different project)\b/.test(lower);
    const explicitUseCurrentWorkspaceIntent = /\b(use current project|use the current project|use this project|use existing workspace|use the existing workspace|use the existing folder|keep this project|keep the current project)\b/.test(lower);
    const likelyProjectCreation = (creationVerb && deliverableNoun)
      || (/\b(calculator|todo|landing page|portfolio|dashboard|website|web app|site|app|page|tool|game)\b/.test(lower)
        && /\b(i need|i want|help me|can you|could you)\b/.test(lower));
    const mutationVerb = /\b(add|update|edit|modify|change|fix|delete|remove|rename|refactor|improve|implement|wire up|polish|clean up|upgrade)\b/.test(lower);
    const existingProjectTarget = /\b(project|workspace|code|codebase|file|files|readme|docs?|current|existing|this|ui|page|app|site)\b/.test(lower);
    const referencesCurrentWorkspace = /\b(this|current|existing)\b/.test(lower)
      || /\b(in|inside|within)\s+(this|the current|the existing)\s+(project|workspace|repo|repository|app|site|codebase)\b/.test(lower)
      || explicitUseCurrentWorkspaceIntent;
    const likelyFileMutation = mutationVerb && (existingProjectTarget || hasOpenWorkspace);
    const inspectVerb = /\b(inspect|review|audit|check|verify|explain|understand|walk me through|how do i run|how to run|run|start|launch|open|does .* satisfy|what does this do)\b/.test(lower);
    const likelyInspectRequest = inspectVerb && (existingProjectTarget || hasOpenWorkspace);
    const riskyScopeIntent = explicitNewProjectIntent
      || explicitUseCurrentWorkspaceIntent
      || /\b(existing folder|open an existing folder)\b/.test(lower);
    const vagueButActionable = /\b(make it better|improve it|fix it|clean it up|upgrade it|polish it)\b/.test(lower);
    const likelyWorkspaceMismatch = Boolean(
      hasOpenWorkspace
      && !workspaceIsEmpty
      && likelyProjectCreation
      && !referencesCurrentWorkspace
      && !explicitNewProjectIntent
      && requestTopicTokens.length > 0
      && topicOverlapRatio < 0.34
    );

    return {
      text,
      lower,
      hasOpenWorkspace,
      workspaceIsEmpty,
      selectedKind,
      currentPath,
      rootName,
      rootEntryCount,
      pureGreeting,
      asksGeneralKnowledge,
      explicitNewProjectIntent,
      explicitUseCurrentWorkspaceIntent,
      likelyProjectCreation,
      likelyFileMutation: likelyFileMutation || (vagueButActionable && hasOpenWorkspace),
      likelyInspectRequest,
      riskyScopeIntent,
      vagueButActionable,
      referencesCurrentWorkspace,
      likelyWorkspaceMismatch,
      requestTopicTokens,
      workspaceTopicTokens,
      topicOverlapTokens,
      topicOverlapRatio,
      creationVerb,
      deliverableNoun,
      mutationVerb,
      existingProjectTarget,
      inspectVerb,
    };
  }

  function computeScores(features, advisoryDecision, agentEnabled) {
    const scores = {
      chat: 0,
      inspect: 0,
      agent: 0,
      confirm: 0,
    };

    if (features.pureGreeting) scores.chat += 7;
    if (features.asksGeneralKnowledge) scores.chat += 5;
    if (features.likelyInspectRequest) scores.inspect += features.hasOpenWorkspace ? 6 : 2;
    if (features.likelyFileMutation) scores.agent += features.hasOpenWorkspace ? 7 : 1;
    if (features.likelyProjectCreation) {
      scores.confirm += features.hasOpenWorkspace ? 2 : 7;
      scores.agent += features.hasOpenWorkspace ? 4 : 0;
    }
    if (features.explicitNewProjectIntent) {
      scores.confirm += features.hasOpenWorkspace ? 1 : 4;
      scores.agent += features.hasOpenWorkspace ? 6 : 0;
    }
    if (features.riskyScopeIntent) scores.confirm += 3;
    if (features.likelyWorkspaceMismatch) scores.confirm += 7;
    if (features.likelyProjectCreation && features.hasOpenWorkspace && !features.referencesCurrentWorkspace) {
      scores.confirm += 3;
    }
    if (features.explicitUseCurrentWorkspaceIntent && features.hasOpenWorkspace) {
      scores.agent += 4;
      scores.confirm -= 2;
    }

    if (!features.hasOpenWorkspace && !features.likelyProjectCreation && !features.asksGeneralKnowledge) {
      scores.chat += 1;
    }
    if (features.hasOpenWorkspace && !features.likelyFileMutation && !features.likelyProjectCreation && !features.likelyInspectRequest) {
      scores.inspect += 1;
    }

    if (advisoryDecision && scores[advisoryDecision.route] != null) {
      scores[advisoryDecision.route] += 1.5;
    }

    if (!agentEnabled) {
      scores.agent = -999;
    }

    return scores;
  }

  function chooseTopRoute(scores) {
    const order = ['confirm', 'agent', 'inspect', 'chat'];
    let winner = 'chat';
    let best = Number.NEGATIVE_INFINITY;
    order.forEach((route) => {
      const score = Number(scores && scores[route]);
      if (score > best) {
        best = score;
        winner = route;
      }
    });
    return winner;
  }

  function buildDecision(route, advisoryDecision, features) {
    const base = normalizeDecision(advisoryDecision);
    base.route = route;
    base.shouldInspectWorkspace = route === 'inspect';
    base.shouldReadFiles = route === 'inspect';
    base.shouldModifyFiles = route === 'agent';
    base.shouldCreateProject = route === 'confirm'
      ? ((!features.hasOpenWorkspace && features.likelyProjectCreation) || Boolean(features.likelyWorkspaceMismatch))
      : Boolean(features.explicitNewProjectIntent && route === 'agent');
    base.shouldAskUser = route === 'confirm';
    if (base.userMessage && (base.userMessage.includes('\n') || base.userMessage.length > 150)) {
      base.userMessage = '';
    }
    if (route === 'confirm' && !base.userMessage) {
      if (features.hasOpenWorkspace && !features.workspaceIsEmpty) {
        const workspaceLabel = features.rootName || 'the current workspace';
        base.userMessage = `I already have "${workspaceLabel}" open. Do you want me to keep using that project, or create a new one for this request?`;
      } else {
        base.userMessage = 'Should I create a new project for this request, or do you want to open an existing folder first?';
      }
    }
    if (!base.reason) {
      if (route === 'chat') base.reason = 'The request looks conversational and does not require workspace actions.';
      if (route === 'inspect') base.reason = 'The request needs grounded workspace inspection before answering.';
      if (route === 'agent') base.reason = 'The request asks for implementation work in the workspace.';
      if (route === 'confirm') base.reason = 'The request likely needs project or scope confirmation before making changes.';
    }
    return base;
  }

  function validateRoute(chosenRoute, features, agentEnabled) {
    let route = chosenRoute;
    let overrideReason = '';

    if (!agentEnabled && route === 'agent') {
      route = features.hasOpenWorkspace ? 'inspect' : 'confirm';
      overrideReason = 'Agent mode is disabled, so agent route is blocked.';
    } else if (!features.hasOpenWorkspace && features.likelyProjectCreation && route === 'confirm') {
      route = agentEnabled ? 'agent' : 'confirm';
      overrideReason = agentEnabled
        ? 'There is no open workspace, so the request can proceed directly as a new project.'
        : 'There is no open workspace, so a new project needs confirmation because agent mode is unavailable.';
    } else if (!features.hasOpenWorkspace && features.likelyProjectCreation && route === 'chat') {
      route = 'confirm';
      overrideReason = 'New project intent without an open workspace cannot go to chat.';
    } else if (features.hasOpenWorkspace && features.likelyWorkspaceMismatch && !features.explicitUseCurrentWorkspaceIntent && route !== 'confirm') {
      route = 'confirm';
      overrideReason = 'The request looks like a new project that may not match the current workspace, so scope confirmation is required first.';
    } else if (features.hasOpenWorkspace && features.likelyFileMutation && route === 'chat') {
      route = agentEnabled ? 'agent' : 'inspect';
      overrideReason = 'Implementation intent in an open workspace cannot go to chat.';
    } else if (features.hasOpenWorkspace && features.likelyInspectRequest && route === 'chat') {
      route = 'inspect';
      overrideReason = 'Workspace-grounded inspection intent should prefer inspect over chat.';
    }

    return { route, overrideReason };
  }

  function explainWhyChatWon(features, scores) {
    if (scores.chat < Math.max(scores.inspect, scores.agent, scores.confirm)) {
      return '';
    }
    if (features.pureGreeting) return 'chat allowed because the message is a pure greeting.';
    if (features.asksGeneralKnowledge) return 'chat allowed because the message looks like a general knowledge question.';
    return 'chat allowed because no strong workspace, mutation, or project-creation signals were detected.';
  }

  function evaluate(args = {}) {
    const advisoryDecision = normalizeDecision(args.advisoryDecision || {});
    const features = computeFeatures(args.latestUserMessage, args.workspace, {
      normalizeWorkspacePath: args.normalizeWorkspacePath,
    });
    const scores = computeScores(features, advisoryDecision, Boolean(args.agentEnabled));
    const initialRoute = chooseTopRoute(scores);
    const validated = validateRoute(initialRoute, features, Boolean(args.agentEnabled));
    const finalDecision = buildDecision(validated.route, advisoryDecision, features);
    if (validated.overrideReason) {
      finalDecision.reason = validated.overrideReason;
    }
    const advisoryRejected = advisoryDecision.route !== finalDecision.route;
    const overrideReason = validated.overrideReason
      || (advisoryRejected ? `Advisory model route "${advisoryDecision.route}" was replaced by deterministic preflight scoring.` : '');

    const sortedScores = Object.values(scores).sort((a, b) => b - a);
    const confidence = sortedScores.length >= 2
      ? Math.max(0, sortedScores[0] - sortedScores[1])
      : 0;
    const whyChatAllowed = finalDecision.route === 'chat'
      ? explainWhyChatWon(features, scores)
      : '';

    return {
      decision: finalDecision,
      debug: {
        advisoryRoute: advisoryDecision.route,
        initialRoute,
        finalRoute: finalDecision.route,
        overridden: Boolean(overrideReason),
        overrideReason,
        confidence,
        routeScores: scores,
        whyChatAllowed,
        signals: {
          hasOpenWorkspace: features.hasOpenWorkspace,
          workspaceIsEmpty: features.workspaceIsEmpty,
          selectedKind: features.selectedKind,
          explicitNewProjectIntent: features.explicitNewProjectIntent,
          explicitUseCurrentWorkspaceIntent: features.explicitUseCurrentWorkspaceIntent,
          likelyProjectCreation: features.likelyProjectCreation,
          likelyFileMutation: features.likelyFileMutation,
          likelyInspectRequest: features.likelyInspectRequest,
          referencesCurrentWorkspace: features.referencesCurrentWorkspace,
          likelyWorkspaceMismatch: features.likelyWorkspaceMismatch,
          riskyScopeIntent: features.riskyScopeIntent,
          pureGreeting: features.pureGreeting,
          asksGeneralKnowledge: features.asksGeneralKnowledge,
          vagueButActionable: features.vagueButActionable,
          topicOverlapRatio: features.topicOverlapRatio,
          topicOverlapTokens: features.topicOverlapTokens,
        },
      },
    };
  }

  const api = {
    normalizeDecision,
    computeFeatures,
    computeScores,
    evaluate,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  global.AIExePreflightRouter = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
