(function initAIExeMarkdownRenderer(global) {
  function createMarkdownRenderer(deps) {
    const applyCustomTooltip = deps.applyCustomTooltip;
    const copyTextToClipboard = deps.copyTextToClipboard;
    const applyCopyFeedback = deps.applyCopyFeedback;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHref(rawHref) {
  const href = String(rawHref || '').trim();
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:/i.test(href)) return href;
  return '';
}

function renderInlineMarkdown(text) {
  const codeTokens = [];
  const linkTokens = [];
  const mathTokens = [];
  let working = String(text || '');

  working = working.replace(/`([^`\n]+)`/g, (_, codeText) => {
    const token = `@@MD_CODE_${codeTokens.length}@@`;
    codeTokens.push(`<code>${escapeHtml(codeText)}</code>`);
    return token;
  });

  working = working.replace(/\\\(([^`\n]+?)\\\)/g, (_, expr) => {
    const token = `@@MD_MATH_INLINE_${mathTokens.length}@@`;
    mathTokens.push(`<span class="md-math-inline">${escapeHtml(expr)}</span>`);
    return token;
  });

  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safeHref = sanitizeHref(href);
    const token = `@@MD_LINK_${linkTokens.length}@@`;
    if (!safeHref) {
      linkTokens.push(`${escapeHtml(label)} (${escapeHtml(href)})`);
    } else {
      linkTokens.push(
        `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      );
    }
    return token;
  });

  working = escapeHtml(working);
  working = working.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  working = working.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  working = working.replace(/@@MD_CODE_(\d+)@@/g, (_, idx) => codeTokens[Number(idx)] || '');
  working = working.replace(/@@MD_MATH_INLINE_(\d+)@@/g, (_, idx) => mathTokens[Number(idx)] || '');
  working = working.replace(/@@MD_LINK_(\d+)@@/g, (_, idx) => linkTokens[Number(idx)] || '');
  return working;
}

const codeLanguageAliases = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  fish: 'bash',
  yml: 'yaml',
  htm: 'html',
  svg: 'xml',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rs: 'rust',
  rb: 'ruby',
  plaintext: 'text',
  txt: 'text',
};

const javascriptLikeLangs = new Set(['javascript', 'typescript']);
const cLikeLangs = new Set(['c', 'cpp', 'csharp', 'java', 'go', 'rust', 'php']);

const highlightRulesJsLike = [
  { cls: 'comment', priority: 0, regex: /\/\*[\s\S]*?\*\/|\/\/.*$/gm },
  { cls: 'string', priority: 1, regex: /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/gm },
  { cls: 'decorator', priority: 2, regex: /@[A-Za-z_$][\w$]*/gm },
  { cls: 'keyword', priority: 3, regex: /\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|if|implements|import|in|instanceof|interface|let|namespace|new|of|override|private|protected|public|readonly|return|static|super|switch|throw|try|type|typeof|var|void|while|with|yield)\b/gm },
  { cls: 'constant', priority: 4, regex: /\b(?:true|false|null|undefined|NaN|Infinity|this)\b/gm },
  { cls: 'number', priority: 5, regex: /\b(?:0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gm },
  { cls: 'function', priority: 6, regex: /\b[A-Za-z_$][\w$]*(?=\s*\()/gm },
];

const highlightRulesCLike = [
  { cls: 'comment', priority: 0, regex: /\/\*[\s\S]*?\*\/|\/\/.*$/gm },
  { cls: 'decorator', priority: 1, regex: /^\s*#\s*[A-Za-z_]\w*.*$/gm },
  { cls: 'string', priority: 2, regex: /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/gm },
  { cls: 'keyword', priority: 3, regex: /\b(?:auto|bool|break|case|catch|char|class|const|constexpr|continue|default|delete|do|double|else|enum|explicit|export|extern|false|final|float|for|friend|goto|if|inline|int|interface|long|mutable|namespace|new|null|nullptr|operator|override|private|protected|public|register|return|short|signed|sizeof|static|struct|super|switch|template|this|throw|true|try|typedef|typename|union|unsigned|using|virtual|void|volatile|while)\b/gm },
  { cls: 'number', priority: 4, regex: /\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:[uUlLfF]*)\b/gm },
  { cls: 'function', priority: 5, regex: /\b[A-Za-z_]\w*(?=\s*\()/gm },
];

const highlightRulesPython = [
  { cls: 'comment', priority: 0, regex: /#.*$/gm },
  { cls: 'string', priority: 1, regex: /'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/gm },
  { cls: 'decorator', priority: 2, regex: /@[A-Za-z_][\w.]*/gm },
  { cls: 'keyword', priority: 3, regex: /\b(?:and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/gm },
  { cls: 'constant', priority: 4, regex: /\b(?:True|False|None|self|cls)\b/gm },
  { cls: 'number', priority: 5, regex: /\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gm },
  { cls: 'function', priority: 6, regex: /\b[A-Za-z_]\w*(?=\s*\()/gm },
];

const highlightRulesBash = [
  { cls: 'comment', priority: 0, regex: /#.*$/gm },
  { cls: 'string', priority: 1, regex: /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/gm },
  { cls: 'variable', priority: 2, regex: /\$\{?[A-Za-z_][\w]*\}?|\$[@*#?$!-]|\$\d+/gm },
  { cls: 'keyword', priority: 3, regex: /\b(?:case|coproc|do|done|elif|else|esac|export|fi|for|function|if|in|local|readonly|select|then|time|until|while)\b/gm },
  { cls: 'number', priority: 4, regex: /\b\d+\b/gm },
];

const highlightRulesJson = [
  { cls: 'key', priority: 0, regex: /"(?:\\.|[^"\\])*"(?=\s*:)/gm },
  { cls: 'string', priority: 1, regex: /"(?:\\.|[^"\\])*"/gm },
  { cls: 'constant', priority: 2, regex: /\b(?:true|false|null)\b/gm },
  { cls: 'number', priority: 3, regex: /\b-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?\b/gm },
];

const highlightRulesMarkup = [
  { cls: 'comment', priority: 0, regex: /<!--[\s\S]*?-->/gm },
  { cls: 'string', priority: 1, regex: /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/gm },
  { cls: 'tag', priority: 2, regex: /<\/?[A-Za-z][A-Za-z0-9:-]*/gm },
  { cls: 'attr', priority: 3, regex: /\b[A-Za-z_:][A-Za-z0-9:._-]*(?=\=)/gm },
];

const highlightRulesCss = [
  { cls: 'comment', priority: 0, regex: /\/\*[\s\S]*?\*\//gm },
  { cls: 'string', priority: 1, regex: /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/gm },
  { cls: 'decorator', priority: 2, regex: /@[A-Za-z-]+/gm },
  { cls: 'attr', priority: 3, regex: /\b[A-Za-z-]+(?=\s*:)/gm },
  { cls: 'constant', priority: 4, regex: /#[\da-fA-F]{3,8}\b/gm },
  { cls: 'number', priority: 5, regex: /\b\d+(?:\.\d+)?(?:%|px|em|rem|vh|vw|deg|ms|s)?\b/gm },
];

const highlightRulesYaml = [
  { cls: 'comment', priority: 0, regex: /#.*$/gm },
  { cls: 'key', priority: 1, regex: /^[ \t-]*[A-Za-z0-9_.-]+(?=\s*:)/gm },
  { cls: 'string', priority: 2, regex: /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/gm },
  { cls: 'constant', priority: 3, regex: /\b(?:true|false|null|yes|no|on|off)\b/gim },
  { cls: 'number', priority: 4, regex: /\b-?(?:0|[1-9]\d*)(?:\.\d+)?\b/gm },
];

function normalizeCodeLanguage(lang) {
  const input = String(lang || '').trim().toLowerCase();
  if (!input) return '';
  return codeLanguageAliases[input] || input;
}

function findNextHighlightMatch(code, cursor, rules) {
  let best = null;
  for (const rule of rules) {
    rule.regex.lastIndex = cursor;
    const match = rule.regex.exec(code);
    if (!match || !match[0]) continue;
    const candidate = {
      cls: rule.cls,
      priority: Number(rule.priority) || 0,
      index: match.index,
      text: match[0],
    };
    if (!best ||
        candidate.index < best.index ||
        (candidate.index === best.index && candidate.priority < best.priority) ||
        (candidate.index === best.index && candidate.priority === best.priority &&
         candidate.text.length > best.text.length)) {
      best = candidate;
    }
  }
  return best;
}

function highlightCodeWithRules(code, rules) {
  const input = String(code || '');
  if (!input) return '';
  let cursor = 0;
  let out = '';
  while (cursor < input.length) {
    const match = findNextHighlightMatch(input, cursor, rules);
    if (!match) {
      out += escapeHtml(input.slice(cursor));
      break;
    }
    if (match.index > cursor) {
      out += escapeHtml(input.slice(cursor, match.index));
    }
    out += `<span class="tok-${match.cls}">${escapeHtml(match.text)}</span>`;
    cursor = match.index + match.text.length;
  }
  return out;
}

function highlightCodeHtml(code, lang) {
  const input = String(code || '').replace(/\n$/, '');
  const normalized = normalizeCodeLanguage(lang);
  if (!input) return '';
  if (!normalized || normalized === 'text' || normalized === 'markdown') {
    return escapeHtml(input);
  }
  if (normalized === 'python') return highlightCodeWithRules(input, highlightRulesPython);
  if (normalized === 'bash') return highlightCodeWithRules(input, highlightRulesBash);
  if (normalized === 'json') return highlightCodeWithRules(input, highlightRulesJson);
  if (normalized === 'html' || normalized === 'xml') return highlightCodeWithRules(input, highlightRulesMarkup);
  if (normalized === 'css' || normalized === 'scss' || normalized === 'less') return highlightCodeWithRules(input, highlightRulesCss);
  if (normalized === 'yaml') return highlightCodeWithRules(input, highlightRulesYaml);
  if (javascriptLikeLangs.has(normalized)) return highlightCodeWithRules(input, highlightRulesJsLike);
  if (cLikeLangs.has(normalized)) return highlightCodeWithRules(input, highlightRulesCLike);
  return highlightCodeWithRules(input, highlightRulesJsLike);
}

let markdownRenderer = null;
let markdownRendererInitAttempted = false;

function renderCodeFenceHtml(code, lang) {
  const normalized = normalizeCodeLanguage(lang) || 'text';
  return `<pre><code class="language-${escapeHtml(normalized)}">${highlightCodeHtml(code, normalized)}</code></pre>`;
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeMathBlockBody(text) {
  const body = String(text || '').trim();
  if (!body) return false;
  if (/\\[A-Za-z]+(?:\s*[{[]|\b)/.test(body)) {
    return true;
  }
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (!/[=+\-*/^<>±≈≤≥×÷]/.test(normalized) && !/[\p{L}\p{N}]_[\p{L}\p{N}{]/u.test(normalized)) {
    return false;
  }
  return /^[\p{L}\p{N}\s+\-*/=(),.^_%<>|[\]{}:!;\\&±≈≤≥×÷·∞∂∇∑∫√→←↔]+$/u.test(normalized);
}

function normalizeStandaloneBracketMathBlocks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  if (!lines.length) return '';
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const current = String(lines[i] || '');
    const trimmed = current.trim();
    if (!/^(?:\\)?\[$/.test(trimmed)) {
      out.push(current);
      continue;
    }

    const bodyLines = [];
    let closingIndex = -1;
    for (let j = i + 1; j < lines.length && j <= i + 12; j += 1) {
      const candidate = String(lines[j] || '');
      const candidateTrimmed = candidate.trim();
      if (/^(?:\\)?\]$/.test(candidateTrimmed)) {
        closingIndex = j;
        break;
      }
      bodyLines.push(candidate);
    }

    if (closingIndex === -1) {
      out.push(current);
      continue;
    }

    const bodyText = bodyLines.join('\n').trim();
    if (!looksLikeMathBlockBody(bodyText)) {
      out.push(current);
      continue;
    }

    const leading = current.match(/^\s*/)?.[0] || '';
    out.push(`${leading}\\[`);
    bodyLines.forEach((line) => out.push(line));
    out.push(`${leading}\\]`);
    i = closingIndex;
  }

  return out.join('\n');
}

function normalizeMarkdownForDisplay(text) {
  return normalizeStandaloneBracketMathBlocks(text);
}

function dedentBlockText(lines) {
  const srcLines = Array.isArray(lines) ? lines.map((line) => String(line || '')) : [];
  const nonEmpty = srcLines.filter((line) => line.trim().length > 0);
  if (!nonEmpty.length) {
    return '';
  }
  const minIndent = nonEmpty.reduce((min, line) => {
    const indent = (line.match(/^\s*/) || [''])[0].length;
    return Math.min(min, indent);
  }, Number.MAX_SAFE_INTEGER);
  return srcLines
    .map((line) => line.slice(Math.min(minIndent, line.length)))
    .join('\n')
    .trim();
}

function renderKatexInlineHtml(expr) {
  const source = String(expr || '').trim();
  if (!source) {
    return '';
  }
  try {
    if (typeof window !== 'undefined' &&
        window.katex &&
        typeof window.katex.renderToString === 'function') {
      return window.katex.renderToString(source, {
        displayMode: false,
        throwOnError: false,
        strict: 'ignore',
      });
    }
  } catch (_) {
  }
  return `<span class="md-math-inline">${escapeHtml(source)}</span>`;
}

function renderKatexDisplayHtml(expr) {
  const source = String(expr || '').trim();
  if (!source) {
    return '';
  }
  try {
    if (typeof window !== 'undefined' &&
        window.katex &&
        typeof window.katex.renderToString === 'function') {
      const html = window.katex.renderToString(source, {
        displayMode: true,
        throwOnError: false,
        strict: 'ignore',
      });
      return `<div class="md-katex-block">${html}</div>`;
    }
  } catch (_) {
  }
  return `<div class="md-math-block">${escapeHtml(source).replace(/\n/g, '<br>')}</div>`;
}

function looksLikeInlineMathSource(text) {
  const source = String(text || '').trim();
  if (!source) return false;
  if (/\\[A-Za-z]+(?:\s*[{[]|\b)/.test(source)) return true;
  if (/^[A-Za-z]$/.test(source)) return true;
  if (/^[A-Za-z](?:_[A-Za-z0-9{}]+|\^[A-Za-z0-9{}]+)+$/.test(source)) return true;
  if (/[=+\-*/^_<>±≈≤≥×÷]/.test(source)) return true;
  if (/[∂∇∑∫√∞μρϵεψΨℏ]/.test(source)) return true;
  return false;
}

function replaceDollarMathDelimiters(text, replacements) {
  const src = String(text || '');
  let out = '';

  const pushInlineToken = (expr) => {
    const source = String(expr || '').trim();
    if (!source || !looksLikeInlineMathSource(source)) {
      return null;
    }
    const token = `@@MD_KATEX_INLINE_${replacements.length}@@`;
    replacements.push({
      token,
      html: renderKatexInlineHtml(source),
      display: false,
    });
    return token;
  };

  const pushDisplayToken = (expr) => {
    const source = String(expr || '').trim();
    if (!source) {
      return null;
    }
    const token = `@@MD_KATEX_BLOCK_${replacements.length}@@`;
    replacements.push({
      token,
      html: renderKatexDisplayHtml(source),
      display: true,
    });
    return token;
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (ch === '\\') {
      out += ch;
      if (i + 1 < src.length) {
        out += src[i + 1];
        i += 1;
      }
      continue;
    }

    if (ch !== '$') {
      out += ch;
      continue;
    }

    const isDouble = src[i + 1] === '$';
    if (isDouble) {
      let end = i + 2;
      let found = -1;
      while (end < src.length) {
        if (src[end] === '\\') {
          end += 2;
          continue;
        }
        if (src[end] === '$' && src[end + 1] === '$') {
          found = end;
          break;
        }
        end += 1;
      }
      if (found === -1) {
        out += '$$';
        i += 1;
        continue;
      }
      const expr = src.slice(i + 2, found);
      const token = pushDisplayToken(expr);
      if (!token) {
        out += src.slice(i, found + 2);
      } else {
        out += token;
      }
      i = found + 1;
      continue;
    }

    let end = i + 1;
    let found = -1;
    while (end < src.length) {
      if (src[end] === '\n' || src[end] === '\r') {
        break;
      }
      if (src[end] === '\\') {
        end += 2;
        continue;
      }
      if (src[end] === '$') {
        found = end;
        break;
      }
      end += 1;
    }
    if (found === -1) {
      out += '$';
      continue;
    }

    const expr = src.slice(i + 1, found);
    const token = pushInlineToken(expr);
    if (!token) {
      out += src.slice(i, found + 1);
    } else {
      out += token;
    }
    i = found;
  }

  return out;
}

function extractFencedCodeBlockTokens(text) {
  const blocks = [];
  const out = String(text || '').replace(/```([a-zA-Z0-9_+\-]*)\n?([\s\S]*?)(```|$)/g, (match) => {
    const token = `@@MD_CODE_FENCE_${blocks.length}@@`;
    blocks.push(match);
    return token;
  });
  return { text: out, blocks };
}

function restoreFencedCodeBlockTokens(text, blocks) {
  return String(text || '').replace(/@@MD_CODE_FENCE_(\d+)@@/g, (_, idx) => blocks[Number(idx)] || '');
}

function extractKatexMathTokens(text) {
  const replacements = [];
  const tokenizedCode = extractFencedCodeBlockTokens(text);
  const lines = String(tokenizedCode.text || '').split('\n');
  const out = [];

  const pushDisplayToken = (expr, indent = '') => {
    const trimmedExpr = String(expr || '').trim();
    if (!trimmedExpr) {
      return false;
    }
    const token = `@@MD_KATEX_BLOCK_${replacements.length}@@`;
    replacements.push({
      token,
      html: renderKatexDisplayHtml(trimmedExpr),
      display: true,
    });
    if (out.length && out[out.length - 1].trim()) {
      out.push('');
    }
    out.push(`${indent}${token}`);
    out.push('');
    return true;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || '');
    const trimmed = line.trim();

    if (/^@@MD_CODE_FENCE_\d+@@$/.test(trimmed)) {
      out.push(line);
      continue;
    }

    const singleLineDisplay = trimmed.match(/^\\\[\s*([\s\S]*?)\s*\\\]$/);
    if (singleLineDisplay) {
      const leading = (line.match(/^\s*/) || [''])[0];
      if (pushDisplayToken(singleLineDisplay[1], leading)) {
        continue;
      }
    }

    if (trimmed === '\\[') {
      const bodyLines = [];
      let closingIndex = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = String(lines[j] || '');
        const candidateTrimmed = candidate.trim();
        if (/^@@MD_CODE_FENCE_\d+@@$/.test(candidateTrimmed)) {
          break;
        }
        if (candidateTrimmed === '\\]') {
          closingIndex = j;
          break;
        }
        bodyLines.push(candidate);
      }
      if (closingIndex >= 0) {
        const leading = (line.match(/^\s*/) || [''])[0];
        const expr = dedentBlockText(bodyLines);
        if (pushDisplayToken(expr, leading)) {
          i = closingIndex;
          continue;
        }
      }
    }

    out.push(line);
  }

  let working = out.join('\n');
  working = replaceDollarMathDelimiters(working, replacements);
  working = working.replace(/\\\(([^\n]*?)\\\)/g, (match, expr) => {
    const source = String(expr || '').trim();
    if (!source) {
      return match;
    }
    const token = `@@MD_KATEX_INLINE_${replacements.length}@@`;
    replacements.push({
      token,
      html: renderKatexInlineHtml(source),
      display: false,
    });
    return token;
  });

  working = restoreFencedCodeBlockTokens(working, tokenizedCode.blocks);
  return { text: working, replacements };
}

function injectKatexMathTokens(html, replacements) {
  let out = String(html || '');
  for (const entry of Array.isArray(replacements) ? replacements : []) {
    if (!entry || !entry.token) {
      continue;
    }
    const tokenPattern = escapeRegex(entry.token);
    if (entry.display) {
      out = out
        .replace(new RegExp(`<p>${tokenPattern}</p>`, 'g'), entry.html)
        .replace(new RegExp(`<p>\\s*${tokenPattern}\\s*</p>`, 'g'), entry.html)
        .replace(new RegExp(`<li>\\s*${tokenPattern}\\s*</li>`, 'g'), `<li>${entry.html}</li>`);
    }
    out = out.replace(new RegExp(tokenPattern, 'g'), entry.html);
  }
  return out;
}

function initMarkdownRenderer() {
  if (markdownRendererInitAttempted) {
    return markdownRenderer;
  }
  markdownRendererInitAttempted = true;

  if (typeof window === 'undefined' ||
      typeof window.markdownit !== 'function') {
    return null;
  }

  try {
    const md = window.markdownit({
      html: false,
      breaks: true,
      linkify: true,
      typographer: false,
      langPrefix: 'language-',
      highlight: (code, lang) => renderCodeFenceHtml(code, lang),
    });

    const defaultLinkOpen = md.renderer.rules.link_open ||
      ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      const hrefIndex = tokens[idx].attrIndex('href');
      const href = hrefIndex >= 0 ? String(tokens[idx].attrs[hrefIndex][1] || '') : '';
      const safeHref = sanitizeHref(href);
      if (!safeHref) {
        tokens[idx].attrSet('href', '#');
      } else {
        tokens[idx].attrSet('href', safeHref);
      }
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      return defaultLinkOpen(tokens, idx, options, env, self);
    };

    const defaultTableOpen = md.renderer.rules.table_open ||
      ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    const defaultTableClose = md.renderer.rules.table_close ||
      ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.table_open = (tokens, idx, options, env, self) => {
      tokens[idx].attrJoin('class', 'md-table');
      return `<div class="md-table-wrap">${defaultTableOpen(tokens, idx, options, env, self)}`;
    };
    md.renderer.rules.table_close = (tokens, idx, options, env, self) => {
      return `${defaultTableClose(tokens, idx, options, env, self)}</div>`;
    };

    markdownRenderer = md;
  } catch (_) {
    markdownRenderer = null;
  }

  return markdownRenderer;
}

function splitMarkdownTableCells(line) {
  let raw = String(line || '').trim();
  if (raw.startsWith('|')) raw = raw.slice(1);
  if (raw.endsWith('|')) raw = raw.slice(0, -1);
  return raw.split('|').map((cell) => cell.trim());
}

function isPotentialMarkdownTableLine(line) {
  const text = String(line || '').trim();
  if (!text || !text.includes('|')) return false;
  const cells = splitMarkdownTableCells(text).filter((c) => c.length > 0);
  return cells.length >= 2;
}

function isMarkdownTableDivider(line) {
  const cells = splitMarkdownTableCells(line);
  if (!cells.length) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function renderMarkdownTableBlock(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return '';
  let headerCells = splitMarkdownTableCells(lines[0]);
  if (!headerCells.length) return '';

  const bodyCells = lines.slice(2).map((line) => splitMarkdownTableCells(line));
  const widestBody = bodyCells.reduce((max, cells) => Math.max(max, cells.length), 0);
  let colCount = Math.max(headerCells.length, widestBody);
  if (colCount <= 0) return '';

  if (headerCells.length + 1 === colCount) {
    headerCells = ['Aspect'].concat(headerCells);
  }
  while (headerCells.length < colCount) {
    headerCells.push(`Column ${headerCells.length + 1}`);
  }

  const headerRow = `<tr>${headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr>`;
  const bodyRows = bodyCells.map((rawCells) => {
    const cells = rawCells.slice();
    if (cells.length < colCount) {
      while (cells.length < colCount) cells.push('');
    }
    const clipped = cells.slice(0, colCount);
    return `<tr>${clipped.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`;
  }).join('');

  return `<div class="md-table-wrap"><table class="md-table"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table></div>`;
}

function extractMarkdownTableTokens(inputText) {
  const lines = String(inputText || '').split('\n');
  const tableBlocks = [];
  const out = [];
  const isTableLine = (line) => isPotentialMarkdownTableLine(line);

  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i];
    const next = lines[i + 1];
    if (isTableLine(current) && isTableLine(next) && isMarkdownTableDivider(next)) {
      const tableLines = [current, next];
      i += 2;
      while (i < lines.length && isTableLine(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      i -= 1;
      const html = renderMarkdownTableBlock(tableLines);
      if (html) {
        const token = `@@MD_TABLE_${tableBlocks.length}@@`;
        tableBlocks.push(html);
        out.push('', token, '');
        continue;
      }
    }
    out.push(current);
  }

  return { text: out.join('\n'), tableBlocks };
}

function renderMarkdownHtmlLegacy(text) {
  const codeBlocks = [];
  const mathBlocks = [];
  let working = String(text || '').replace(/\r\n?/g, '\n');

  working = working.replace(/\\\[([\s\S]*?)\\\]/g, (_, expr) => {
    const html = `<div class="md-math-block">${escapeHtml(String(expr || '').trim()).replace(/\n/g, '<br>')}</div>`;
    const token = `@@MD_MATH_${mathBlocks.length}@@`;
    mathBlocks.push(html);
    return `\n\n${token}\n\n`;
  });

  working = working.replace(/```([a-zA-Z0-9_+\-]*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
    const languageClass = lang ? ` language-${escapeHtml(lang)}` : '';
    const html = `<pre><code class="${languageClass.trim()}">${highlightCodeHtml(code, lang)}</code></pre>`;
    const token = `@@MD_BLOCK_${codeBlocks.length}@@`;
    codeBlocks.push(html);
    return `\n\n${token}\n\n`;
  });

  const extractedTables = extractMarkdownTableTokens(working);
  const tableBlocks = extractedTables.tableBlocks;
  working = extractedTables.text;

  const paragraphs = working.split(/\n{2,}/);
  const rendered = paragraphs.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return '';

    const blockMatch = trimmed.match(/^@@MD_BLOCK_(\d+)@@$/);
    if (blockMatch) {
      return codeBlocks[Number(blockMatch[1])] || '';
    }

    const mathMatch = trimmed.match(/^@@MD_MATH_(\d+)@@$/);
    if (mathMatch) {
      return mathBlocks[Number(mathMatch[1])] || '';
    }

    const tableMatch = trimmed.match(/^@@MD_TABLE_(\d+)@@$/);
    if (tableMatch) {
      return tableBlocks[Number(tableMatch[1])] || '';
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length);
      const content = renderInlineMarkdown(headingMatch[2].trim());
      return `<h${level}>${content}</h${level}>`;
    }

    if (/(^|\n)\s*#{1,6}\s+.+/.test(trimmed)) {
      const lines = trimmed.split('\n');
      const parts = [];
      let paragraphLines = [];
      const flushParagraph = () => {
        const text = paragraphLines.join('\n').trim();
        paragraphLines = [];
        if (!text) return;
        parts.push(`<p>${renderInlineMarkdown(text).replace(/\n/g, '<br>')}</p>`);
      };

      lines.forEach((line) => {
        const lineTrimmed = String(line || '').trim();
        if (!lineTrimmed) {
          flushParagraph();
          return;
        }
        const lineHeading = lineTrimmed.match(/^(#{1,6})\s+(.+)$/);
        if (lineHeading) {
          flushParagraph();
          const level = Math.min(6, lineHeading[1].length);
          const content = renderInlineMarkdown(lineHeading[2].trim());
          parts.push(`<h${level}>${content}</h${level}>`);
          return;
        }
        paragraphLines.push(line);
      });
      flushParagraph();
      if (parts.length > 0) {
        return parts.join('');
      }
    }

    const lines = trimmed.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length > 0 && lines.every((line) => /^\s*[-*]\s+/.test(line))) {
      const items = lines
        .map((line) => line.replace(/^\s*[-*]\s+/, ''))
        .map((line) => `<li>${renderInlineMarkdown(line)}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    }

    if (lines.length > 0 && lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
      const items = lines
        .map((line) => {
          const m = line.match(/^\s*(\d+)\.\s+([\s\S]*)$/);
          if (!m) return `<li>${renderInlineMarkdown(line)}</li>`;
          const idx = Number(m[1]);
          const body = String(m[2] || '');
          return `<li value="${Number.isFinite(idx) ? idx : 1}">${renderInlineMarkdown(body)}</li>`;
        })
        .join('');
      return `<ol>${items}</ol>`;
    }

    return `<p>${renderInlineMarkdown(trimmed).replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return rendered
    .replace(/@@MD_BLOCK_(\d+)@@/g, (_, idx) => codeBlocks[Number(idx)] || '')
    .replace(/@@MD_MATH_(\d+)@@/g, (_, idx) => mathBlocks[Number(idx)] || '')
    .replace(/@@MD_TABLE_(\d+)@@/g, (_, idx) => tableBlocks[Number(idx)] || '');
}

function renderMarkdownHtml(text) {
  const source = normalizeMarkdownForDisplay(String(text || ''));
  const mathTokens = extractKatexMathTokens(source);
  const md = initMarkdownRenderer();
  if (!md) {
    return renderMarkdownHtmlLegacy(source);
  }
  try {
    const rendered = md.render(mathTokens.text);
    return injectKatexMathTokens(rendered, mathTokens.replacements);
  } catch (_) {
    return renderMarkdownHtmlLegacy(source);
  }
}

function attachCodeCopyButtons(container) {
  if (!container) return;
  container.querySelectorAll('pre').forEach((pre) => {
    const codeEl = pre.querySelector('code');
    const codeText = codeEl ? String(codeEl.textContent || '') : String(pre.textContent || '');
    const className = codeEl ? String(codeEl.className || '') : '';
    const langMatch = className.match(/(?:^|\s)language-([a-zA-Z0-9_+\-]+)/);
    const lang = (langMatch && langMatch[1] ? String(langMatch[1]).toLowerCase() : 'text');

    let wrapper = pre.parentElement;
    if (!wrapper || !wrapper.classList.contains('code-block')) {
      const parent = pre.parentNode;
      if (!parent) return;
      wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      parent.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
    }

    let header = wrapper.querySelector('.code-block-header');
    if (!header) {
      header = document.createElement('div');
      header.className = 'code-block-header';
      wrapper.insertBefore(header, pre);
    }

    let langEl = header.querySelector('.code-block-lang');
    if (!langEl) {
      langEl = document.createElement('span');
      langEl.className = 'code-block-lang';
      header.appendChild(langEl);
    }
    langEl.textContent = lang;

    if (header.querySelector('.code-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Copy code');
    applyCustomTooltip(btn, 'Copy code');
    btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      `;
    btn.addEventListener('click', async (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const copied = await copyTextToClipboard(codeText);
      applyCopyFeedback(btn, copied, 'Copy code');
    });
    header.appendChild(btn);
  });
}

    return {
      escapeHtml,
      sanitizeHref,
      renderInlineMarkdown,
      normalizeCodeLanguage,
      highlightCodeHtml,
      renderMarkdownHtml,
      attachCodeCopyButtons,
    };
  }

  global.AIExeMarkdownRenderer = {
    createMarkdownRenderer,
  };
})(window);
