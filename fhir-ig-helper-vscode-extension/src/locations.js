const { parseTree } = require('jsonc-parser');

function firelyPathSegments(firelyPath, resourceType) {
  const segments = [];
  for (const part of firelyPath.split('.')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)(?:\[(\d+)\])?$/.exec(part);
    if (!match) return undefined;
    segments.push(match[1]);
    if (match[2] !== undefined) segments.push(Number(match[2]));
  }
  if (segments[0] === resourceType) segments.shift();
  return segments;
}

function offsetPosition(text, offset) {
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g) || []).length;
  const lastNewline = before.lastIndexOf('\n');
  return { line, character: offset - lastNewline - 1 };
}

function nodeRange(text, node) {
  let target = node;
  if (target?.parent?.type === 'property') {
    target = target.parent.children[0];
  } else if (target?.parent?.type === 'array' && target.parent.parent?.type === 'property') {
    target = target.parent.parent.children[0];
  }
  return {
    start: offsetPosition(text, target.offset),
    end: offsetPosition(text, target.offset + target.length),
  };
}

function findFhirNode(tree, segments) {
  let node = tree;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (node?.type === 'array') {
        node = node.children?.[segment];
      } else if (segment !== 0) {
        return undefined;
      }
    } else {
      if (node?.type !== 'object') return undefined;
      const property = node.children?.find((child) =>
        child.type === 'property' && child.children?.[0]?.value === segment);
      node = property?.children?.[1];
    }
    if (!node) return undefined;
  }
  return node;
}

function extractFirelyIssues(output) {
  const issues = [];
  let current;
  for (const originalLine of output.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (/^(?:Error|Fatal)\s*:/i.test(line)) {
      if (current) issues.push(current);
      current = { lines: [line] };
    } else if (current && /^At\s*:/i.test(line)) {
      current.path = line.replace(/^At\s*:\s*/i, '').trim();
      current.lines.push(line);
    } else if (current && !/^Result\s*:/i.test(line) && line) {
      current.lines.push(line);
    }
  }
  if (current) issues.push(current);
  return issues.map(({ lines, path }) => ({ message: lines.join('\n'), path }));
}

function locateFirelyIssues(source, resourceType, output) {
  const tree = parseTree(source);
  return extractFirelyIssues(output).map((issue) => {
    const segments = issue.path && firelyPathSegments(issue.path, resourceType);
    const node = tree && segments && findFhirNode(tree, segments);
    return { ...issue, range: node ? nodeRange(source, node) : undefined };
  });
}

module.exports = { extractFirelyIssues, findFhirNode, firelyPathSegments, locateFirelyIssues };
