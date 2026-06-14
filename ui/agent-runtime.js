(function initAIExeAgentRuntime(global) {
  function createAgentRuntime(deps) {
    const agentPlannerEndpoint = String(deps.agentPlannerEndpoint || '');
    const agentPlannerRequestTimeoutMs = Number(deps.agentPlannerRequestTimeoutMs) || 15000;
    const agentDecisionMaxTokens = Number(deps.agentDecisionMaxTokens) || 120;
    const agentFileContentMaxTokens = Number(deps.agentFileContentMaxTokens) || 5000;
    // Model-aware per-call output budget (provider/context dependent); falls back to
    // the flat cap when the host doesn't supply one.
    const getAgentFileOutputBudget = typeof deps.getAgentFileOutputBudget === 'function'
      ? deps.getAgentFileOutputBudget
      : () => agentFileContentMaxTokens;
    const recordDebugTrace = typeof deps.recordDebugTrace === 'function'
      ? deps.recordDebugTrace
      : () => {};
    const agentFileGenerationRequestTimeoutMs = Number(deps.agentFileGenerationRequestTimeoutMs) || 30000;

    async function requestExternalAgentPlanner(prompt, maxTokens, timeoutMs = agentPlannerRequestTimeoutMs) {
      if (!agentPlannerEndpoint) return null;
      try {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutId = controller
          ? setTimeout(() => controller.abort(), timeoutMs)
          : null;
        const response = await fetch(agentPlannerEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: String(prompt || ''),
            max_tokens: Number(maxTokens) || agentDecisionMaxTokens,
          }),
          signal: controller ? controller.signal : undefined,
        });
        if (timeoutId) clearTimeout(timeoutId);
        if (!response.ok) return null;
        const payload = await response.json();
        if (!payload || !payload.ok) return null;
        return {
          ok: true,
          output: String(payload.output || ''),
          externalPlanner: true,
        };
      } catch (_) {
        return null;
      }
    }

    // Detect a file cut off by the per-call output token cap (the dominant cause of
    // "unclosed CSS blocks" / mid-function truncation that then traps the agent in a
    // repair loop). Brace/bracket imbalance or an obviously mid-token ending are
    // strong, language-agnostic signals.
    function looksTruncatedFileContent(content, path) {
      const text = String(content || '');
      if (!text.trim()) return false;
      const ext = ((String(path || '').match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
      if (['css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json'].includes(ext)) {
        const bal = (o, c) => (text.split(o).length - 1) - (text.split(c).length - 1);
        if (bal('{', '}') > 0 || bal('(', ')') > 0 || bal('[', ']') > 0) return true;
      }
      if (['css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx'].includes(ext)) {
        // Unterminated /* block comment */ — a common mid-comment truncation.
        if ((text.match(/\/\*/g) || []).length > (text.match(/\*\//g) || []).length) return true;
      }
      if (['html', 'htm'].includes(ext)) {
        if (/<html[\s>]/i.test(text) && !/<\/html\s*>/i.test(text)) return true;
      }
      const tail = text.replace(/\s+$/, '');
      const lastChar = tail.slice(-1);
      if (tail.length > 400 && /[A-Za-z0-9_,:(\[{]/.test(lastChar) && !/[}\])>;]$/.test(tail)) return true;
      return false;
    }

    // Append a continuation chunk, dropping a repeated seam: find the largest
    // suffix of the base that the continuation re-emitted as its prefix and trim it,
    // so "continue from where you stopped" doesn't duplicate the overlap.
    function stitchFileContinuation(base, addition) {
      const b = String(base || '');
      let add = String(addition || '');
      if (!add) return b;
      if (!b) return add;
      const max = Math.min(b.length, add.length, 240);
      for (let n = max; n > 0; n -= 1) {
        if (b.slice(-n) === add.slice(0, n)) {
          add = add.slice(n);
          break;
        }
      }
      return b + add;
    }

    // Returns { output, truncated }. `truncated` prefers the provider's real signal
    // (OpenAI finish_reason==='length' / Anthropic stop_reason==='max_tokens'); the
    // native path has no such flag, so completeness there is judged structurally.
    // Per-delta heartbeat: a single long remote generation used to look idle to
    // the tool watchdog (heartbeats only fired between calls) and got killed
    // mid-flight. Streaming beats per token; true stalls still time out.
    const beatToolProgress = () => {
      if (typeof deps.markAgentToolProgress === 'function') deps.markAgentToolProgress();
    };

    async function runRawAgentFileInference(prompt, onPartial = null) {
      const budget = Math.max(1, Number(getAgentFileOutputBudget()) || agentFileContentMaxTokens);
      let streamed = '';
      const remote = await deps.requestSelectedRemoteTextCompletion(prompt, budget, '', {
        preferStreaming: true,
        onDelta: (delta) => {
          beatToolProgress();
          if (typeof onPartial === 'function' && delta) { streamed += String(delta); onPartial(streamed); }
        },
      });
      if (remote && remote.ok && String(remote.output || '').trim()) {
        return { output: String(remote.output || ''), truncated: Boolean(remote.truncated) };
      }
      const external = await requestExternalAgentPlanner(prompt, budget, agentFileGenerationRequestTimeoutMs);
      if (external && external.ok && String(external.output || '').trim()) {
        return { output: String(external.output || ''), truncated: Boolean(external.truncated) };
      }
      if (!deps.nativeBridge.available()) return { output: '', truncated: false };
      const res = await deps.nativeBridge.invoke('infer', { prompt, maxTokens: budget, max_tokens: budget });
      if (!res || !res.ok) return { output: '', truncated: false };
      return { output: String(res.output || ''), truncated: Boolean(res.truncated) };
    }

    // Generate a full file, continuing across multiple capped calls when a large
    // file overflows a single response, then sanitize the stitched result once.
    // Continues on either the provider's truncation signal or a structural check.
    // Emits an `agent_file_generation` trace (prompt size, output size, #continuations)
    // so under-generation / context-overflow is visible instead of silent.
    async function generateFullAgentFile(prompt, path) {
      const promptChars = String(prompt || '').length;
      // Heartbeat so the loop's idle-timeout knows this slow multi-pass generation
      // is actually progressing (not hung) and lets it finish a large file.
      const beat = () => { if (typeof deps.markAgentToolProgress === 'function') deps.markAgentToolProgress(); };
      // Live-stream the partial content into the work panel so the file is seen
      // filling in as it generates; the real file is committed by write_file later.
      const emitPartial = (text) => {
        if (typeof deps.updateAgentStreamingFile === 'function') deps.updateAgentStreamingFile(path, String(text || ''));
      };
      beat();
      const first = await runRawAgentFileInference(prompt, emitPartial);
      beat();
      let raw = first.output;
      if (!raw) {
        if (typeof deps.clearAgentStreamingFile === 'function') deps.clearAgentStreamingFile(path);
        recordAgentFileGenTrace(path, promptChars, 0, 0, first.truncated, 'empty_output');
        return '';
      }
      let wasTruncated = first.truncated;
      let guard = 0;
      while (guard < 3 && (wasTruncated || looksTruncatedFileContent(raw, path))) {
        guard += 1;
        const continuationPrompt = `${prompt}\n\nPARTIAL_OUTPUT_ALREADY_SAVED (do NOT repeat any of this):\n${raw.slice(-1600)}\n\nContinue the file from exactly where it stopped. Output ONLY the remaining content — no repetition, no commentary, no code fences.`;
        const carried = raw;
        const next = await runRawAgentFileInference(continuationPrompt, (partial) => emitPartial(stitchFileContinuation(carried, partial)));
        beat();
        if (!next.output || !next.output.trim()) break;
        const before = raw.length;
        raw = stitchFileContinuation(raw, next.output);
        wasTruncated = next.truncated;
        if (raw.length <= before) break;
      }
      if (typeof deps.clearAgentStreamingFile === 'function') deps.clearAgentStreamingFile(path);
      const finalContent = deps.sanitizeAgentGeneratedFileContent(raw, path);
      recordAgentFileGenTrace(path, promptChars, String(finalContent || '').length, guard, wasTruncated,
        guard >= 3 ? 'continuation_exhausted' : 'ok');
      return finalContent;
    }

    // Visibility into file generation: a tiny output next to a large prompt (as when
    // sibling-file bloat overflowed the local 8192-token context) is now diagnosable.
    function recordAgentFileGenTrace(path, promptChars, outputChars, continuations, truncated, status) {
      recordDebugTrace('agent_file_generation', {
        path: String(path || ''),
        promptChars: String(promptChars),
        approxPromptTokens: String(Math.round(Number(promptChars) / 3.7)),
        outputChars: String(outputChars),
        continuations: String(continuations),
        truncatedSignal: String(Boolean(truncated)),
        status: String(status || ''),
      }, {
        path: String(path || ''),
        promptChars,
        outputChars,
        continuations,
        truncated: Boolean(truncated),
        status,
      });
    }

    async function generateAgentWriteFileContent(taskText, toolEvents, path, priorAttempt = '', planSpec = null) {
      const prompt = await deps.buildAgentWriteFileContentPrompt(taskText, toolEvents, path, priorAttempt, planSpec);
      return generateFullAgentFile(prompt, path);
    }

    async function generateAgentEditFileProgram(taskText, toolEvents, path, currentContent, priorAttempt = '', planSpec = null) {
      const prompt = await deps.buildAgentEditFileContentPrompt(taskText, toolEvents, path, currentContent, priorAttempt, planSpec);
      // Live feedback while the harness GENERATES edit content (only happens when the
      // model didn't provide an inline find/replace program in its decision).
      let streamed = '';
      const remote = await deps.requestSelectedRemoteTextCompletion(prompt, agentDecisionMaxTokens * 3, '', {
        preferStreaming: true,
        onDelta: (delta) => {
          beatToolProgress();
          if (delta && typeof deps.updateAgentStreamingFile === 'function') { streamed += String(delta); deps.updateAgentStreamingFile(path, streamed); }
        },
      });
      if (typeof deps.clearAgentStreamingFile === 'function') deps.clearAgentStreamingFile(path);
      if (remote && remote.ok) {
        const cleaned = deps.sanitizeAgentGeneratedEditProgram(remote.output || '');
        if (cleaned) return cleaned;
      }
      const external = await requestExternalAgentPlanner(prompt, agentDecisionMaxTokens * 3, agentFileGenerationRequestTimeoutMs);
      if (external && external.ok) {
        const cleaned = deps.sanitizeAgentGeneratedEditProgram(external.output || '');
        if (cleaned) return cleaned;
      }
      if (!deps.nativeBridge.available()) return '';
      const res = await deps.nativeBridge.invoke('infer', {
        prompt,
        maxTokens: agentDecisionMaxTokens * 3,
        max_tokens: agentDecisionMaxTokens * 3,
      });
      if (!res || !res.ok) return '';
      return deps.sanitizeAgentGeneratedEditProgram(res.output || '');
    }

    async function generateAgentRewriteExistingFileContent(taskText, toolEvents, path, currentContent, priorAttempt = '', planSpec = null) {
      const prompt = await deps.buildAgentRewriteExistingFilePrompt(taskText, toolEvents, path, currentContent, priorAttempt, planSpec);
      return generateFullAgentFile(prompt, path);
    }

    const loadPromptTemplate = typeof deps.loadPromptTemplate === 'function'
      ? deps.loadPromptTemplate
      : null;
    const renderPromptTemplate = typeof deps.renderPromptTemplate === 'function'
      ? deps.renderPromptTemplate
      : null;

    // Bounded JSON-returning inference (remote -> external -> native) with a hard
    // timeout. Used by the advisory verifiers; any failure resolves to null so the
    // caller treats the check as skipped rather than blocking the run.
    async function runBoundedAgentJsonInference(prompt, maxTokens, timeoutMs) {
      const attempt = (async () => {
        const remote = await deps.requestSelectedRemoteTextCompletion(prompt, maxTokens);
        if (remote && remote.ok && String(remote.output || '').trim()) return String(remote.output || '');
        const external = await requestExternalAgentPlanner(prompt, maxTokens, timeoutMs);
        if (external && external.ok && String(external.output || '').trim()) return String(external.output || '');
        if (!deps.nativeBridge.available()) return '';
        const res = await deps.nativeBridge.invoke('infer', { prompt, maxTokens, max_tokens: maxTokens });
        return res && res.ok ? String(res.output || '') : '';
      })();
      const raw = await Promise.race([
        attempt,
        new Promise((resolve) => setTimeout(() => resolve(''), timeoutMs)),
      ]);
      if (!raw) return null;
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch (_) {
        return null;
      }
    }

    // Single-hunk line diff (common prefix/suffix) — compact, mechanical evidence of
    // what an edit actually changed, for grounding completion text and criteria checks.
    function buildCompactLineDiff(before, after, maxChars = 1400) {
      const a = String(before || '').split('\n');
      const b = String(after || '').split('\n');
      let start = 0;
      while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
      let endA = a.length;
      let endB = b.length;
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1;
        endB -= 1;
      }
      const removed = a.slice(start, endA);
      const added = b.slice(start, endB);
      if (!removed.length && !added.length) {
        return { text: '', removedCount: 0, addedCount: 0, startLine: start + 1 };
      }
      const lines = [];
      removed.slice(0, 24).forEach((line) => lines.push(`- ${line}`));
      if (removed.length > 24) lines.push(`- …(${removed.length - 24} more removed lines)`);
      added.slice(0, 36).forEach((line) => lines.push(`+ ${line}`));
      if (added.length > 36) lines.push(`+ …(${added.length - 36} more added lines)`);
      let text = lines.join('\n');
      if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(diff clipped)`;
      return { text, removedCount: removed.length, addedCount: added.length, startLine: start + 1 };
    }

    // The real modifications made this run, per file: baseline = content before the
    // first touch, current = content after the last. Created files report size only.
    function buildAgentChangeSummaries(toolEvents, maxFiles = 6) {
      const byPath = new Map();
      (Array.isArray(toolEvents) ? toolEvents : []).forEach((event) => {
        if (!event || !event.ok) return;
        const tool = String(event.tool || '').toLowerCase();
        if (!['write_file', 'edit_file'].includes(tool)) return;
        const path = deps.normalizeWorkspacePath(event.path || '');
        if (!path || typeof event.content !== 'string' || !event.content) return;
        const prior = byPath.get(path);
        byPath.set(path, {
          original: prior
            ? prior.original
            : (typeof event.originalContent === 'string' ? event.originalContent : null),
          current: event.content,
        });
      });
      const sections = [];
      Array.from(byPath.entries()).slice(-maxFiles).forEach(([path, state]) => {
        if (state.original == null || !String(state.original).trim()) {
          const lineCount = String(state.current || '').split('\n').length;
          sections.push(`Created ${path} (${lineCount} lines).`);
          return;
        }
        const diff = buildCompactLineDiff(state.original, state.current);
        if (!diff.text) {
          sections.push(`Edited ${path} (no net content change).`);
          return;
        }
        sections.push(`Edited ${path} (around line ${diff.startLine}, -${diff.removedCount}/+${diff.addedCount} lines):\n${diff.text}`);
      });
      return sections.join('\n\n');
    }

    // Model-judged finish audit: do the actual diffs satisfy the plan's done
    // criteria? Replaces phrasing-keyword requirement gates with evidence-based
    // judgment. Advisory by design — any infra failure means "skipped", never block.
    async function verifyAgentDoneCriteria(taskText, toolEvents, planSpec) {
      const criteria = (planSpec && Array.isArray(planSpec.doneCriteria) ? planSpec.doneCriteria : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 8);
      const changes = buildAgentChangeSummaries(toolEvents);
      if (!criteria.length || !changes) return { ok: true, skipped: true };
      const prompt = [
        'You are auditing whether the code changes below actually satisfy each done criterion.',
        'Judge ONLY from the evidence in CHANGES — the real diffs applied this run.',
        'Return EXACTLY one JSON object, nothing else: {"unmet":[{"criterion":"...","why":"..."}]}',
        'Rules:',
        '- List a criterion as unmet ONLY when the evidence clearly cannot produce the required outcome (no change addresses it, or the change targets something that cannot have the described effect).',
        '- "why" is one short sentence citing the concrete evidence gap.',
        '- When a change plausibly satisfies a criterion, count it as met — do not nitpick style or speculate beyond the diffs.',
        '- If everything is addressed, return {"unmet":[]}.',
        `TASK:\n${String(taskText || '').trim()}`,
        `DONE_CRITERIA:\n- ${criteria.join('\n- ')}`,
        `CHANGES:\n${changes}`,
        'JSON:',
      ].join('\n');
      const parsed = await runBoundedAgentJsonInference(prompt, 360, 18000);
      if (!parsed || !Array.isArray(parsed.unmet)) {
        recordDebugTrace('agent_criteria_check', { status: 'skipped' }, { taskText, criteria });
        return { ok: true, skipped: true };
      }
      const unmet = parsed.unmet
        .map((item) => ({
          criterion: String(item && item.criterion ? item.criterion : '').trim(),
          why: String(item && item.why ? item.why : '').trim(),
        }))
        .filter((item) => item.criterion)
        .slice(0, 4);
      recordDebugTrace('agent_criteria_check', {
        status: unmet.length ? 'unmet' : 'met',
        unmetCount: String(unmet.length),
      }, { taskText, criteria, unmet });
      return { ok: unmet.length === 0, unmet };
    }

    // Model-driven cross-file review for the functional-incoherence class static
    // checks can't express (unit mismatches, conflicting defaults, dead wiring).
    // Advisory: returns short issue strings, never blocks.
    async function reviewAgentProjectCoherence(fileContents, taskText) {
      const entries = Object.entries(fileContents || {})
        .filter(([path, content]) => /\.(html?|css|js|mjs|cjs|ts|jsx|tsx|json)$/i.test(path) && String(content || '').trim())
        .slice(0, 4);
      if (entries.length < 2) return [];
      const filesBlock = entries
        .map(([path, content]) => `FILE ${path}:\n${String(content).slice(0, 6000)}`)
        .join('\n\n');
      const prompt = [
        'Review this small multi-file project for REAL cross-file functional defects that a syntax check cannot see.',
        'The defect class: a control\'s HTML min/max/value disagreeing with the script default or the unit the script applies; the same setting initialized to different values in different files; styles or variables defined in one file but never driven by the file meant to drive them; a layout rule on an element that cannot affect the elements it is meant to arrange; script wiring that targets markup that does not exist.',
        'Return EXACTLY one JSON object, nothing else: {"issues":["/file.ext: one concrete sentence", ...]}',
        'Rules:',
        '- At most 5 issues, ordered by user-visible impact.',
        '- Only report defects you can point to in the provided code. No style opinions, no speculation.',
        '- If nothing qualifies, return {"issues":[]}.',
        taskText ? `TASK CONTEXT:\n${String(taskText).trim().slice(0, 600)}` : '',
        `PROJECT FILES:\n${filesBlock}`,
        'JSON:',
      ].filter(Boolean).join('\n');
      const parsed = await runBoundedAgentJsonInference(prompt, 320, 18000);
      if (!parsed || !Array.isArray(parsed.issues)) return [];
      const issues = parsed.issues.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5);
      recordDebugTrace('agent_coherence_review', {
        issueCount: String(issues.length),
      }, { issues });
      return issues;
    }

    function buildAgentCompletionFallbackText(taskText, toolEvents, workspaceLabel) {
      const rows = Array.isArray(toolEvents) ? toolEvents.filter((item) => item && item.ok) : [];
      const writtenPaths = rows
        .filter((item) => ['write_file', 'edit_file'].includes(String(item.tool || '').toLowerCase()))
        .map((item) => deps.normalizeWorkspacePath(item.path || ''))
        .filter(Boolean);
      const uniqueWritten = Array.from(new Set(writtenPaths)).slice(0, 6);
      const createdProject = rows.some((item) => String(item.tool || '').toLowerCase() === 'new_project');
      const action = createdProject && uniqueWritten.length ? 'Created' : 'Updated';
      const fileSummary = uniqueWritten.length
        ? `${action} ${uniqueWritten.map((path) => `\`${path}\``).join(', ')}.`
        : 'Done.';
      const validated = rows.some((item) => String(item.tool || '').toLowerCase() === 'validate_files' && item.validationPassed === true);
      const verification = validated ? ' Validation passed.' : '';
      return `${fileSummary}${verification}`;
    }

    function isLikelyIncompleteCompletion(text) {
      const value = String(text || '').trim();
      if (!value) return true;
      if (/[,:;(\[{]$/.test(value)) return true;
      if (/(?:\b(and|or|with|for|to|by|including|computing|showing|using|plus))$/i.test(value)) return true;
      const lines = value.split(/\n/).map((line) => line.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1] || value;
      if (/^[-*]\s+\S[^.!?`)]*$/.test(lastLine) && lines.length > 1) return true;
      const hasTerminalPunctuation = /[.!?`)"]$/.test(value);
      if (!hasTerminalPunctuation && value.length > 120) return true;
      return false;
    }

    async function generateAgentCompletionText(taskText, toolEvents, workspaceLabel, planSpec = null) {
      const rows = Array.isArray(toolEvents) ? toolEvents.filter((item) => item && item.ok) : [];
      const writtenPaths = rows
        .filter((item) => ['write_file', 'edit_file'].includes(String(item.tool || '').toLowerCase()))
        .map((item) => deps.normalizeWorkspacePath(item.path || ''))
        .filter(Boolean)
        .slice(-6);
      const deterministicCompletion = buildAgentCompletionFallbackText(taskText, toolEvents, workspaceLabel);
      const changeSummaries = buildAgentChangeSummaries(toolEvents);
      const readResults = rows
        .filter((item) => String(item.tool || '').toLowerCase() === 'read_file')
        .slice(-2)
        .map((item, index) => [
          `ReadResult ${index + 1}: ${deps.normalizeWorkspacePath(item.path || '')}`,
          String(item.content || '').slice(0, 8000),
        ].join('\n'))
        .join('\n\n');
      let prompt = [
        'Write a natural completion message for the user.',
        'Return a complete answer. Do not end mid-sentence or mid-list.',
        'Do not dump raw tool results.',
        'Mention the workspace name only if it is useful.',
        'Mention changed files when they help the user understand what happened.',
        'For multi-file app work, short bullets are allowed.',
        'Keep it concise and specific to the actual work. Prefer under 120 words.',
        'CHANGES below lists the only real modifications made this run. Describe an outcome ONLY if those diffs actually implement it; if part of the request has no supporting change there, say plainly that it was not changed.',
        `Workspace name: ${workspaceLabel || deps.deriveProjectNameFromTask(taskText) || 'project'}`,
        `Task: ${String(taskText || '').trim()}`,
        planSpec && planSpec.summary ? `Plan summary: ${planSpec.summary}` : '',
        writtenPaths.length ? `Written files: ${Array.from(new Set(writtenPaths)).slice(0, 6).join(', ')}` : '',
        changeSummaries ? `CHANGES:\n${changeSummaries}` : '',
        readResults ? `READ_RESULTS:\n${readResults}` : '',
        'Completion message:',
      ].filter(Boolean).join('\n');
      if (loadPromptTemplate && renderPromptTemplate) {
        const template = await loadPromptTemplate('developer_agent_completion');
        if (template) {
          prompt = renderPromptTemplate(template, {
            WORKSPACE_NAME: workspaceLabel || deps.deriveProjectNameFromTask(taskText) || 'project',
            TASK: String(taskText || '').trim(),
            PLAN_SUMMARY: planSpec && planSpec.summary ? planSpec.summary : '',
            WRITTEN_FILES: writtenPaths.length
              ? Array.from(new Set(writtenPaths)).slice(0, 6).join(', ')
              : '(none — NO files were created or modified this run)',
            CHANGES: changeSummaries || '(none — nothing was changed)',
            READ_RESULTS: readResults || '(none)',
          });
        }
      }
      const remote = await deps.requestSelectedRemoteTextCompletion(prompt, 420);
      if (remote && remote.ok) {
        const text = deps.sanitizeAssistantText(remote.output || '');
        if (text && !isLikelyIncompleteCompletion(text)) return text;
      }
      const external = await requestExternalAgentPlanner(prompt, 420, 12000);
      if (external && external.ok) {
        const text = deps.sanitizeAssistantText(external.output || '');
        if (text && !isLikelyIncompleteCompletion(text)) return text;
      }
      return deterministicCompletion;
    }

    function buildAgentProgressMarkdown(progressEntries, startedAtMs) {
      const rows = Array.isArray(progressEntries) ? progressEntries : [];
      const elapsed = Math.max(0, Date.now() - Number(startedAtMs || 0));
      const elapsedSec = (elapsed / 1000).toFixed(1);
      const iconFor = (status) => {
        const key = String(status || '').toLowerCase();
        if (key === 'done') return '✅';
        if (key === 'error') return '❌';
        if (key === 'tool') return '🔧';
        if (key === 'running') return '⏳';
        return '•';
      };
      const lines = [
        '**Developer agent is running...**',
        `Elapsed: ${elapsedSec}s`,
        '',
      ];
      rows.forEach((row) => {
        if (!row || !row.text) return;
        lines.push(`- ${iconFor(row.status)} ${row.text}`);
      });
      return lines.join('\n');
    }

    function describeAgentToolTarget(decision) {
      const tool = String(decision && decision.tool ? decision.tool : '').toLowerCase();
      const path = deps.normalizeWorkspacePath(decision && decision.path ? decision.path : '');
      const srcPath = deps.normalizeWorkspacePath(decision && (decision.srcPath || decision.src_path) ? (decision.srcPath || decision.src_path) : '');
      const dstPath = deps.normalizeWorkspacePath(decision && (decision.dstPath || decision.dst_path) ? (decision.dstPath || decision.dst_path) : '');
      if (tool === 'new_project') return 'new project';
      if (tool === 'move') {
        if (srcPath && dstPath) return `${srcPath} -> ${dstPath}`;
        return srcPath || dstPath || '';
      }
      return path || srcPath || '';
    }

    return {
      requestExternalAgentPlanner,
      generateAgentWriteFileContent,
      generateAgentEditFileProgram,
      generateAgentRewriteExistingFileContent,
      looksTruncatedFileContent,
      stitchFileContinuation,
      buildAgentCompletionFallbackText,
      generateAgentCompletionText,
      buildAgentProgressMarkdown,
      describeAgentToolTarget,
      buildCompactLineDiff,
      buildAgentChangeSummaries,
      verifyAgentDoneCriteria,
      reviewAgentProjectCoherence,
    };
  }

  global.AIExeAgentRuntime = {
    createAgentRuntime,
  };
})(window);
