const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const WXML_PATH = path.join(ROOT, 'pages/input/input.wxml');
const WXML = fs.readFileSync(WXML_PATH, 'utf8').replace(/<!--[^]*?-->/g, '');
const VOID_NODES = new Set(['input', 'textarea', 'image', 'icon']);

function tagEnd(source, start) {
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index + 1;
  }
  return -1;
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(String(source || '')))) {
    attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function parseTree() {
  const root = {
    attributes: {}, children: [], end: WXML.length, name: 'root', parent: null, start: 0
  };
  const stack = [root];
  let cursor = 0;
  while (cursor < WXML.length) {
    const start = WXML.indexOf('<', cursor);
    if (start < 0) break;
    const end = tagEnd(WXML, start + 1);
    if (end < 0) {
      const error = new Error('Unclosed WXML tag');
      error.code = 'WXML_PARSE_ERROR';
      throw error;
    }
    const raw = WXML.slice(start, end);
    cursor = end;
    if (/^<!|^<\?/.test(raw)) continue;
    const closing = raw.match(/^<\/\s*([A-Za-z][\w-]*)/);
    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].name !== closing[1]) continue;
        stack[index].end = end;
        stack.length = index;
        break;
      }
      continue;
    }
    const opening = raw.match(/^<\s*([A-Za-z][\w-]*)([^]*)>$/);
    if (!opening) continue;
    const parent = stack[stack.length - 1];
    const node = {
      attributes: parseAttributes(opening[2]),
      children: [],
      end,
      name: opening[1],
      openEnd: end,
      parent,
      start
    };
    parent.children.push(node);
    if (!VOID_NODES.has(node.name) && !/\/\s*>$/.test(raw)) stack.push(node);
  }
  if (stack.length !== 1) {
    const error = new Error(`Unclosed WXML node ${stack[stack.length - 1].name}`);
    error.code = 'WXML_PARSE_ERROR';
    throw error;
  }
  return root;
}

const TREE = parseTree();

function flatten(node = TREE, output = []) {
  (node.children || []).forEach((child) => {
    output.push(child);
    flatten(child, output);
  });
  return output;
}

const NODES = flatten();

function nodeSource(node) {
  return node ? WXML.slice(node.start, node.end) : '';
}

function classTokens(node) {
  return String(node && node.attributes.class || '').split(/\s+/).filter(Boolean);
}

function descendants(node, output = []) {
  (node && node.children || []).forEach((child) => {
    output.push(child);
    descendants(child, output);
  });
  return output;
}

function contains(ancestor, node) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function lowestCommonAncestor(nodes) {
  const candidates = [];
  let current = nodes[0] || null;
  while (current && current !== TREE) {
    candidates.push(current);
    current = current.parent;
  }
  return candidates.find((candidate) => nodes.every((node) => contains(candidate, node))) || null;
}

function nearestConditionalAncestor(node) {
  let current = node;
  while (current && current !== TREE) {
    const attributes = current.attributes || {};
    if (attributes['wx:if'] !== undefined
      || attributes['wx:elif'] !== undefined
      || attributes['wx:else'] !== undefined) return current;
    current = current.parent;
  }
  return null;
}

function stripMustache(value) {
  const text = String(value || '').trim();
  const match = text.match(/^\{\{([^]*)\}\}$/);
  return (match ? match[1] : text).trim();
}

function expressionValue(value, data) {
  const expression = stripMustache(value);
  if (!expression) return false;
  if (expression === 'true') return true;
  if (expression === 'false') return false;
  const scope = new Proxy(data || {}, {
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      return target[key];
    },
    has() { return true; }
  });
  try {
    return Boolean(Function('scope', `with (scope) { return (${expression}); }`)(scope));
  } catch (error) {
    return false;
  }
}

function previousBranchNodes(node) {
  if (!node || !node.parent) return [];
  const siblings = node.parent.children || [];
  const index = siblings.indexOf(node);
  const output = [];
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = siblings[cursor];
    if (candidate.attributes['wx:if'] !== undefined) {
      output.unshift(candidate);
      break;
    }
    if (candidate.attributes['wx:elif'] !== undefined) {
      output.unshift(candidate);
      continue;
    }
    break;
  }
  return output;
}

function ownBranchVisible(node, data) {
  const attributes = node.attributes || {};
  if (attributes['wx:if'] !== undefined) {
    return expressionValue(attributes['wx:if'], data);
  }
  if (attributes['wx:elif'] !== undefined) {
    return previousBranchNodes(node).every((entry) => !expressionValue(
      entry.attributes['wx:if'] ?? entry.attributes['wx:elif'], data
    )) && expressionValue(attributes['wx:elif'], data);
  }
  if (attributes['wx:else'] !== undefined) {
    return previousBranchNodes(node).every((entry) => !expressionValue(
      entry.attributes['wx:if'] ?? entry.attributes['wx:elif'], data
    ));
  }
  return true;
}

function isVisible(node, data) {
  if (!node) return false;
  if (node.parent && node.parent !== TREE && !isVisible(node.parent, data)) return false;
  if (!ownBranchVisible(node, data)) return false;
  if (node.attributes.hidden !== undefined && expressionValue(node.attributes.hidden, data)) return false;
  return true;
}

function isEnabled(node, data) {
  return isVisible(node, data)
    && !(node.attributes.disabled !== undefined && expressionValue(node.attributes.disabled, data));
}

module.exports = {
  NODES,
  TREE,
  WXML,
  WXML_PATH,
  classTokens,
  contains,
  descendants,
  expressionValue,
  isEnabled,
  isVisible,
  lowestCommonAncestor,
  nearestConditionalAncestor,
  nodeSource,
  stripMustache
};
