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


  // The model classifies the user's intent (route + intent + needs_* flags). This
  // is the authoritative semantic signal; the regex features below are only a
  // fallback for when the model call is unavailable or unparseable.
  const MODEL_ROUTES = ['chat', 'inspect', 'agent'];
  const MODEL_INTENTS = [
    'casual_chat', 'general_answer', 'workspace_question',
    'create_or_build_deliverable', 'modify_existing_workspace', 'debug_existing_workspace',
  ];
  function normalizeModelRouteDecision(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const route = String(raw.route || '').toLowerCase().trim();
    const intent = String(raw.intent || '').toLowerCase().trim();
    if (!MODEL_ROUTES.includes(route) && !MODEL_INTENTS.includes(intent)) return null;
    const yes = (v) => /^(yes|true|1)$/i.test(String(v == null ? '' : v).trim());
    const confidenceRaw = Number(raw.confidence);
    return {
      route: MODEL_ROUTES.includes(route) ? route : '',
      intent: MODEL_INTENTS.includes(intent) ? intent : '',
      needsWorkspace: yes(raw.needs_workspace),
      needsFileMutation: yes(raw.needs_file_mutation),
      confidence: Number.isFinite(confidenceRaw) ? confidenceRaw : null,
      reason: String(raw.reason || '').trim(),
    };
  }

  // Replace ONLY the semantic feature flags with the model's decision. Deterministic
  // state (hasOpenWorkspace, chatOwnsWorkspace, workspaceIsEmpty, rootName, ...) is
  // left untouched so the downstream confirm/agent/inspect scoring is unchanged.
  function applyModelIntentToFeatures(features, m) {
    const route = m.route || (
      m.intent === 'casual_chat' || m.intent === 'general_answer' ? 'chat'
        : m.intent === 'workspace_question' ? 'inspect'
        : m.intent === 'create_or_build_deliverable' || m.intent === 'modify_existing_workspace' || m.intent === 'debug_existing_workspace' ? 'agent'
        : 'chat'
    );
    features.pureGreeting = false;
    features.asksGeneralKnowledge = false;
    features.likelyInspectRequest = false;
    features.likelyProjectCreation = false;
    features.likelyFileMutation = false;
    features.styleFollowupIntent = false;
    features.vagueButActionable = false;
    if (route === 'chat') {
      features.pureGreeting = m.intent === 'casual_chat';
      features.asksGeneralKnowledge = m.intent !== 'casual_chat';
    } else if (route === 'inspect') {
      features.likelyInspectRequest = true;
    } else if (route === 'agent') {
      if (m.intent === 'create_or_build_deliverable') {
        features.likelyProjectCreation = true;
      } else {
        features.likelyFileMutation = true;
        features.referencesCurrentWorkspace = true;
      }
    }
    return route;
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
    const hasOpenWorkspace = Boolean(rootName || currentPath !== '/');
    const workspaceIsEmpty = !hasOpenWorkspace || rootEntryCount <= 0;
    // Whether the current chat session was the one that created/opened this workspace.
    // When true, all follow-ups are treated as mutations — no confirmation needed.
    const chatOwnsWorkspace = Boolean(options.chatOwnsWorkspace);

    const pureGreeting = /^(hi|hello|hey|yo|sup|good (morning|afternoon|evening))([!. ]+)?$/i.test(text);
    const asksGeneralKnowledge = /\b(what is|who is|define|meaning of|explain)\b/.test(lower)
      && !/\b(project|workspace|code|codebase|file|files|current|existing|this)\b/.test(lower);
    const explicitNewProjectIntent = /\b(new project|new workspace|from scratch|start from scratch|brand new|separate project|different project|create a new project|start a new project)\b/.test(lower);
    const explicitUseCurrentWorkspaceIntent = /\b(use current project|use the current project|use this project|keep this project|keep the current project)\b/.test(lower);
    const mutationVerb = /\b(add|update|edit|modify|change|fix|delete|remove|rename|refactor|improve|implement|wire up|polish|clean up|upgrade|adjust|enhance|refine)\b/.test(lower);
    const existingProjectTarget = /\b(project|workspace|code|codebase|file|files|readme|docs?|current|existing|this|ui|page|app|site)\b/.test(lower);
    const referencesCurrentWorkspace = /\b(this|current|existing)\b/.test(lower) || explicitUseCurrentWorkspaceIntent;
    const likelyFileMutation = mutationVerb && (existingProjectTarget || hasOpenWorkspace);
    const vagueButActionable = /\b(make it better|improve it|fix it|clean it up|upgrade it|polish it)\b/.test(lower);
    const styleFollowupIntent = Boolean(
      hasOpenWorkspace
      && !pureGreeting
      && !asksGeneralKnowledge
      && /\b(modern|polished|sleek|responsive|style|styles|styling|css|layout|font|fonts|color|colors|theme|spacing|animation|animations|hover|mobile|desktop)\b/.test(lower)
      && !/\b(what is|who is|define|meaning of|explain|why does|how does)\b/.test(lower)
    );
    const inspectVerb = /\b(inspect|review|audit|check|verify|explain|understand|walk me through|how do i run|how to run|run|start|launch|open|what does this do)\b/.test(lower);
    const likelyInspectRequest = inspectVerb && (existingProjectTarget || hasOpenWorkspace);
    const creationVerb = /\b(create|build|make|design|develop|generate|start|set up|setup)\b/.test(lower);
    const deliverableNoun = /\b(app|site|website|page|landing page|dashboard|tool|game|calculator|portfolio|blog|api|service|cli|project|frontend|ui)\b/.test(lower);
    const likelyProjectCreation = (creationVerb && deliverableNoun)
      || (/\b(calculator|todo|landing page|portfolio|dashboard|website|web app|site|app|page|tool|game)\b/.test(lower)
        && /\b(i need|i want|help me|can you|could you)\b/.test(lower));

    // Safety net only — the model prompt is the primary classifier. Backstop for when
    // it misclassifies a clear pasted error/"broken" report as a read-only question.
    const looksLikePastedError = (
      /\buncaught\b/i.test(text)
      || /\b(?:TypeError|ReferenceError|RangeError|SyntaxError|EvalError|URIError|DOMException)\b/.test(text)
      || /\b[\w./-]+\.(?:js|mjs|cjs|ts|jsx|tsx|css|html?|py|json)\s*:\s*\d+/i.test(text)
      || /\bis not defined\b|\bis not a function\b|cannot (?:read|set) propert(?:y|ies)|unexpected (?:token|identifier|end of)|maximum call stack|traceback \(most recent/i.test(lower)
      || /^\s*at\s+.+:\d+:\d+\)?\s*$/m.test(text)
    );
    const brokenIntent = /\b(broken|not working|doesn'?t work|does not work|isn'?t working|won'?t work|still (?:broken|not working|failing)|crash(?:es|ing)?|throws?|throwing|fails?|failing|not loading|blank (?:page|screen)|nothing (?:happens|shows))\b/i.test(lower);
    const errorFixIntent = (looksLikePastedError || brokenIntent) && hasOpenWorkspace;

    return {
      text,
      lower,
      hasOpenWorkspace,
      workspaceIsEmpty,
      selectedKind,
      currentPath,
      rootName,
      rootEntryCount,
      chatOwnsWorkspace,
      pureGreeting,
      asksGeneralKnowledge,
      explicitNewProjectIntent,
      explicitUseCurrentWorkspaceIntent,
      likelyProjectCreation,
      likelyFileMutation: likelyFileMutation || (vagueButActionable && hasOpenWorkspace) || styleFollowupIntent,
      likelyInspectRequest,
      referencesCurrentWorkspace,
      vagueButActionable,
      styleFollowupIntent,
      creationVerb,
      deliverableNoun,
      mutationVerb,
      existingProjectTarget,
      inspectVerb,
      errorFixIntent,
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
    // A pasted error / "it's broken" in an open workspace is a fix request: bias
    // strongly to agent and cancel the inspect pull so it fixes, not lectures.
    if (features.errorFixIntent) { scores.agent += 8; scores.inspect -= 4; }

    // Chat owns workspace → treat follow-ups as agent mutations (no confirmation).
    // BUT only when the request is actually actionable: a follow-up can also be a
    // plain question ("why'd you name it that?") or casual chat, which must NOT be
    // forced into the agent just because this chat created the project.
    const ownedFollowupIsActionable = !features.likelyInspectRequest
      && !features.pureGreeting
      && !features.asksGeneralKnowledge;
    if (features.chatOwnsWorkspace && features.hasOpenWorkspace && ownedFollowupIsActionable) {
      if (features.explicitNewProjectIntent) {
        // User explicitly wants to start over → agent with shouldCreateProject
        scores.agent += 10;
      } else {
        scores.agent += 8;
      }
    } else if (features.hasOpenWorkspace && !features.workspaceIsEmpty) {
      // Workspace exists but this chat didn't create it.
      // Ask once if the request looks like a brand-new project.
      if (features.explicitNewProjectIntent) {
        scores.agent += 8; // explicit → just do it
      } else if (features.likelyProjectCreation && !features.referencesCurrentWorkspace) {
        scores.confirm += 6; // ambiguous new-project intent → ask once
      }
    } else if (!features.hasOpenWorkspace) {
      if (features.likelyProjectCreation) scores.agent += 7;
      if (features.explicitNewProjectIntent) scores.agent += 4;
    }

    if (features.explicitUseCurrentWorkspaceIntent && features.hasOpenWorkspace) {
      scores.agent += 4;
      scores.confirm -= 4;
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
      // Agent mode off = pure chat. No workspace-touching route is allowed — not
      // agent/confirm (writes) and not inspect (reads). Everything answers in chat.
      scores.agent = -999;
      scores.confirm = -999;
      scores.inspect = -999;
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
      ? (
        (!features.hasOpenWorkspace && features.likelyProjectCreation)
        || Boolean(features.hasOpenWorkspace && features.likelyProjectCreation && !features.explicitUseCurrentWorkspaceIntent)
      )
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

    if (!agentEnabled && (route === 'agent' || route === 'confirm') && (features.likelyProjectCreation || features.likelyFileMutation)) {
      route = 'chat';
      overrideReason = 'Agent mode is disabled, so an action request answers in chat without reading or changing workspace files.';
    } else if (
      features.hasOpenWorkspace
      && features.likelyProjectCreation
      && !features.chatOwnsWorkspace
      && !features.styleFollowupIntent
      && !features.explicitUseCurrentWorkspaceIntent
      && !features.explicitNewProjectIntent
      && route === 'agent'
    ) {
      route = agentEnabled ? 'confirm' : 'chat';
      overrideReason = agentEnabled
        ? 'Project creation in an open workspace needs scope confirmation before changing files.'
        : 'Agent mode is disabled, so project creation stays in chat instead of workspace actions.';
    } else if (!agentEnabled && route === 'agent') {
      route = 'chat';
      overrideReason = 'Agent mode is disabled, so the agent route is blocked and answered in chat (no workspace reads).';
    } else if (!features.hasOpenWorkspace && features.likelyProjectCreation && route === 'confirm') {
      route = agentEnabled ? 'agent' : 'chat';
      overrideReason = agentEnabled
        ? 'There is no open workspace, so the request can proceed directly as a new project.'
        : 'Agent mode is disabled, so project creation stays in chat instead of workspace actions.';
    } else if (!features.hasOpenWorkspace && features.likelyProjectCreation && route === 'chat') {
      route = agentEnabled ? 'confirm' : 'chat';
      overrideReason = agentEnabled
        ? 'New project intent without an open workspace should confirm scope before agent changes.'
        : 'Agent mode is disabled, so project creation stays in chat instead of workspace actions.';
    } else if (features.hasOpenWorkspace && features.likelyFileMutation && route === 'chat') {
      route = agentEnabled ? 'agent' : 'chat';
      overrideReason = agentEnabled
        ? 'Implementation intent in an open workspace should route to Agent mode.'
        : 'Agent mode is disabled, so implementation intent answers in chat without reading workspace files.';
    } else if (agentEnabled && features.hasOpenWorkspace && features.errorFixIntent && (route === 'inspect' || route === 'chat')) {
      // A pasted error / "it's broken" is a request to FIX it, not just inspect it.
      route = 'agent';
      overrideReason = 'A pasted error or broken-app report in an open workspace should be FIXED in Agent mode, not just inspected.';
    } else if (
      agentEnabled
      && features.hasOpenWorkspace
      && features.likelyInspectRequest
      && !features.likelyProjectCreation
      && !features.likelyFileMutation
      && route === 'chat'
    ) {
      route = 'inspect';
      overrideReason = 'Workspace-grounded inspection intent should prefer inspect over chat.';
    }

    // Agent mode is the single gate for ALL workspace tool access (read AND write).
    // With it off, nothing may touch the workspace — every request is answered in
    // plain chat: no inspect file-reads, no agent edits.
    if (!agentEnabled && route !== 'chat') {
      route = 'chat';
      overrideReason = 'Agent mode is off, so this is answered in chat without any workspace access (no file reads or edits).';
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
      chatOwnsWorkspace: Boolean(args.chatOwnsWorkspace),
    });
    // Prefer the model's intent classification when present and reasonably
    // confident; fall back to the regex features otherwise. Low-confidence model
    // outputs are ignored so a shaky guess never overrides the deterministic path.
    const modelDecision = normalizeModelRouteDecision(args.modelDecision);
    const usedModelDecision = Boolean(
      modelDecision
      && (modelDecision.confidence == null || modelDecision.confidence >= 0.35),
    );
    if (usedModelDecision) {
      applyModelIntentToFeatures(features, modelDecision);
    }
    const scores = computeScores(features, advisoryDecision, Boolean(args.agentEnabled));
    // Model-primary: give a confident model route weight proportional to its
    // confidence so the model's judgment LEADS the decision. Deterministic scoring
    // then only breaks genuine ties and applies hard-state rules (agent-off
    // downgrades, new-project-in-a-foreign-workspace -> confirm), which carry larger
    // weights and still win when they should.
    if (usedModelDecision && modelDecision.route && scores[modelDecision.route] != null) {
      const conf = Number(modelDecision.confidence);
      scores[modelDecision.route] += Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) * 4 : 2;
    }
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
        usedModelDecision,
        modelRoute: modelDecision ? (modelDecision.route || '') : '',
        modelIntent: modelDecision ? (modelDecision.intent || '') : '',
        modelConfidence: modelDecision ? modelDecision.confidence : null,
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
          pureGreeting: features.pureGreeting,
          asksGeneralKnowledge: features.asksGeneralKnowledge,
          vagueButActionable: features.vagueButActionable,
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
