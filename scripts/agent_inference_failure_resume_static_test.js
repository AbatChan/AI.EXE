const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const promptCore = read('ui/prompt-core.js');
const loop = read('ui/agent-loop.js');
const nativeLoop = read('ui/agent-ai-loop.js');
const plannerSource = read('ui/agent-planner.js');
const executorSource = read('ui/agent-executor.js');
const rendererSource = read('ui/chat-renderer.js');
const ui = read('ui/ai-exe.js');
const cmake = read('CMakeLists.txt');
const coreSource = read('ui/agent-core.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert((promptCore.match(/!msg\.inferenceFailure/g) || []).length >= 2,
  'normal and agent histories must exclude inference failures');
assert(ui.includes('function surfaceAgentInferenceUnavailable(chatId, rawReason)'),
  'UI must surface agent inference failures without a chat message');
assert(ui.includes('chat.needsContinue = true;') && ui.includes('showInferenceUnavailableNotice(rawReason);'),
  'provider failure must preserve Continue state and show a local notice');
assert(ui.includes('lastMessage.syntheticAgentResume === true') && ui.includes('messages.pop();'),
  'a failed resume must roll back its synthetic Continue bubble');
assert(ui.includes('if (isInternalInferenceFailureText(text))'),
  'internal inference errors must not be appended as chat messages');

const continueStart = ui.indexOf('async function continueMessage()');
const continueEnd = ui.indexOf('\nfunction startAssistantContinuation', continueStart);
const continueBody = ui.slice(continueStart, continueEnd);
const adapterCheck = 'await ensureVeniceAdapterReady({ resendPending: false })';
const continueAppend = "appendMessageToChat(chat.id, 'user', 'Continue'";
assert(continueBody.indexOf(adapterCheck) >= 0,
  'Continue must check the Venice adapter');
assert(continueBody.indexOf(adapterCheck) < continueBody.indexOf(continueAppend),
  'adapter readiness must be checked before Continue is added to history');
assert(continueBody.indexOf(adapterCheck) < continueBody.indexOf('chat.needsContinue = false'),
  'adapter readiness must be checked before phase state is cleared');

assert(loop.includes('agent_resume_new_project_blocked') && loop.includes('agent_resume_workspace_seeded')
    && loop.includes('[resume-project-already-created]'),
  'resumed open workspaces must block a second new_project');
assert(!loop.includes("I couldn't plan this build"),
  'raw planning failures must not be committed as assistant text');
assert((loop.match(/surfaceAgentInferenceUnavailable/g) || []).length >= 4,
  'all main agent inference failure exits must use the local recovery surface');
assert(nativeLoop.includes('surfaceAgentInferenceUnavailable'),
  'native agent inference failures must use the local recovery surface');
assert(cmake.includes('WIN_AGENT_AI_LOOP_JS') && cmake.includes('MAC_AGENT_AI_LOOP_JS'),
  'native agent loop must be bundled on Windows and macOS');
assert(ui.includes("enabled = String(localStorage.getItem('aiExeExperimentalAgent') || '') === '1'"),
  'experimental agent must require explicit opt-in');
assert(ui.includes('return Boolean(requestAiNativeAgentReply) && (explicit || enabled);'),
  'stable phased agent must remain the default route');
assert(plannerSource.includes('For a NON-FINAL phase, use static file validation only.')
    && plannerSource.includes('Full dependency installation and runtime/build verification happen once in the FINAL phase'),
  'non-final phase instructions must defer dependency installation and runtime builds');
assert(loop.includes('agent_nonfinal_phase_runtime_deferred')
    && loop.includes('[defer-runtime-until-final-phase]')
    && loop.includes('[defer-runtime-validate-phase]'),
  'non-final runtime and dependency-install decisions must be blocked deterministically');
assert(executorSource.includes("'@react-three/fiber': '^8.17.10'")
    && executorSource.includes("'@react-three/drei': '^9.114.0'")
    && executorSource.includes("three: '^0.169.0'"),
  'deterministic Next scaffolds must have coherent React Three dependency pins');
assert(executorSource.includes('!isNonFinalValidationPhase && typeof deps.reviewAgentProjectCoherence'),
  'broad AI coherence advisories must wait for final-phase integration');
assert(rendererSource.includes('validationAdvisoryTotal'),
  'advisory UI must report the real deduplicated total rather than the five-item preview cap');
assert(plannerSource.includes('Project progress:') && plannerSource.includes('Already completed ahead of schedule'),
  'phased prompts must carry compact done/remaining progress and early phase credit');
assert(plannerSource.includes('CACHED DEPENDENCY BRIEF')
    && plannerSource.includes('do NOT repeat the batch')
    && !plannerSource.includes('if that content is no longer shown in this prompt, re-reading it is allowed'),
  'compacted batch reads must retain a dependency brief without inviting a broad reread');
assert(loop.includes('agent_batch_reread_blocked')
    && loop.includes('agent_read_batch_focused')
    && loop.includes('selectVitalReadPaths(unread, 6)'),
  'batch reads must deduplicate cached paths and focus oversized batches');
assert(promptCore.includes('choose only the 3–6 VITAL files')
    && promptCore.includes('name that symbol/selector/error'),
  'the agent prompt must teach focused read/search selection before mutation');
assert(ui.includes("['node_modules', 'dependencies']")
    && ui.includes("['.venv', 'virtual environment']")
    && ui.includes("['target', 'generated output']")
    && ui.includes("['cmakefiles', 'CMake output']")
    && ui.includes("['.gradle', 'Gradle cache']"),
  'tree summaries must omit large generated/dependency roots across supported ecosystems');
assert(ui.includes('IMPORTANT_MANIFEST') && ui.includes('SOURCE_DIR')
    && ui.includes('[deeper files omitted]') && ui.includes('more entries omitted'),
  'tree summaries must prioritize manifests/source and explain bounded omissions');
assert(coreSource.includes("'remember_project'") && coreSource.includes("'read_project_memory'")
    && coreSource.includes("'forget_project_memory'"),
  'agent decision parsing must accept semantic project-memory tools');
assert(promptCore.includes('Rules — project memory:')
    && promptCore.includes('Never claim that memory was saved'),
  'agent prompts must ground explicit project-memory changes');
assert(ui.includes("path: '/.aiexe/MEMORY.md'")
    && ui.includes('getProjectMemoryContext')
    && ui.includes('invalidateProjectMemoryCache'),
  'project memory must be cached, auto-loaded, and invalidated after changes');
assert(plannerSource.includes('const projectMemory = await getProjectMemoryContext()')
    && plannerSource.includes('[projectMemory, projectState]'),
  'project memory must reach planning and generated file prompts');
assert(executorSource.includes("tool === 'read_project_memory'")
    && executorSource.includes("tool === 'remember_project'")
    && executorSource.includes("tool === 'forget_project_memory'"),
  'project-memory tools must use grounded workspace reads and writes');
assert(rendererSource.includes('Recalling project memory…')
    && rendererSource.includes('Saved to project memory'),
  'project-memory activity must use natural user-facing language');

global.window = global;
require(path.join(root, 'ui/agent-core.js'));
const core = global.AIExeAgentCore.createAgentCore({});
assert(core.deriveProjectNameFromTask('Build "RoboForge" — a web app for 3D robotic arm simulation.') === 'roboforge',
  'quoted project names must be preserved');
assert(core.deriveProjectNameFromTask('Build a "RoboForge" web app.') === 'roboforge',
  'quoted project names with an article must be preserved');
const openWorkspaceCore = global.AIExeAgentCore.createAgentCore({
  getWorkspaceContext: () => ({
    workspaceRootName: 'roboforge',
    currentPath: '/',
    rootLoaded: true,
    rootEntryCount: 8,
  }),
});
const semanticScratchDecision = openWorkspaceCore.deriveFallbackAgentDecision(
  'Implement the FABRIK algorithm from scratch with no IK library.',
  [],
  {
    taskKind: 'project',
    projectName: 'roboforge',
    phases: [{ title: 'Foundation' }, { title: 'IK' }],
    expectedFiles: ['/src/lib/fabrik.ts'],
  }
);
assert(!semanticScratchDecision || semanticScratchDecision.tool !== 'new_project',
  '"from scratch" feature wording must not replace an open workspace');

console.log('agent inference failure resume static test passed');
