#!/usr/bin/env node

const fs   = require('fs');
const path = require('path');

const TARGET_KEYWORDS = ['Profile', 'CodeSystem', 'ValueSet'];

if (process.argv.length < 3) {
  console.error('Usage: node validate-fsh <directory> [--whitelist=w1,w2,...]');
  process.exit(1);
}

const ROOT_DIR      = path.resolve(process.argv[2]);
const wlArg         = (process.argv.find(a => a.startsWith('--whitelist=')) || '')
                        .split('=')[1] || '';
const WHITELIST     = (wlArg ? wlArg : 'medcom') // defaults to medcom
                        .split(',')
                        .map(s => s.trim().toLowerCase())
                        .filter(Boolean);

const isPascalCase = s => /^[A-Z][A-Za-z0-9]*$/.test(s);

// collapse any hyphenated spelling of whitelist words back to the bare word
function collapseWhitelist(id) {
  WHITELIST.forEach(w => {
    // Build a pattern like  h-?o-?m-?e-?c-?a-?r-?e  → matches “homecare”, “home-care”, “h-o-m-e-care”, etc.
    const pattern = new RegExp(w.split('').join('-?'), 'g');
    id = id.replace(pattern, w);
  });
  return id;
}

function pascalToKebab(name) {
  let id = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')          // fooB → foo-B
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')       // ABCd → AB-Cd
    .toLowerCase();

  return collapseWhitelist(id);
}

// walk directory tree
function walk(dir, fn) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const full = path.join(dir, e.name);
    e.isDirectory() ? walk(full, fn) : fn(full);
  });
}

function validateFile(fp, problems) {
  if (!fp.endsWith('.fsh')) return;

  const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
  let current = null;

  lines.forEach((line, idx) => {
    const clean = line.replace(/\/\/.*$/, '').trim();
    if (clean === '') return;

    const m = clean.match(/^(\w+)\s*:\s*(\S+)/);
    if (m && TARGET_KEYWORDS.includes(m[1])) {
      current = { kind: m[1], name: m[2], id: null, line: idx + 1 };

      if (!isPascalCase(current.name)) {
        problems.push({
          file: fp,
          line: current.line,
          msg : `${current.kind} name “${current.name}” is not PascalCase`
        });
      }
      return;
    }

    if (current && current.id === null) {
      const idMatch = clean.match(/^Id\s*:\s*(\S+)/i);
      if (idMatch) {
        current.id = idMatch[1];
        const expected = pascalToKebab(current.name);
        if (current.id !== expected) {
          problems.push({
            file: fp,
            line: idx + 1,
            msg : `Id “${current.id}” should be “${expected}” (from ${current.name})`
          });
        }
        current = null;
      }
    }
  });
}

function main() {
  const problems = [];
  walk(ROOT_DIR, fp => validateFile(fp, problems));

  if (problems.length === 0) {
    console.log(`✅  All .fsh files passed (whitelist: ${WHITELIST.join(', ')})`);
    return;
  }

  console.log("Linting found the following potential problems/warnings")
  problems.forEach(p => console.log(`- ${p.file}:${p.line}  ${p.msg}`));
}

main();
