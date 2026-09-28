const YAML = require('yaml');

const FHIR_RELEASES = [
  { prefix: '3.0.', spec: 'stu3' },
  { prefix: '4.0.', spec: 'r4' },
  { prefix: '4.3.', spec: 'r4b' },
  { prefix: '5.0.', spec: 'r5' },
];

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readFhirVersion(value) {
  const versions = Array.isArray(value) ? value : [value];
  if (versions.length !== 1 || typeof versions[0] !== 'string') {
    throw new Error('sushi-config must declare exactly one fhirVersion.');
  }
  return versions[0];
}

function selectFirelySpec(fhirVersion) {
  const release = FHIR_RELEASES.find(({ prefix }) => fhirVersion.startsWith(prefix));
  if (!release) {
    throw new Error(`Unsupported fhirVersion '${fhirVersion}'. Supported releases: STU3, R4, R4B, R5.`);
  }
  return release.spec;
}

function readDependencies(dependencies = {}) {
  if (!isMapping(dependencies)) {
    throw new Error("'dependencies' in sushi-config must be a YAML mapping.");
  }
  const entries = Object.entries(dependencies).map(([id, value]) => {
    const version = isMapping(value) ? value.version : value;
    if (!isNonEmptyString(version)) {
      throw new Error(`Dependency '${id}' must specify a version string.`);
    }
    return [id, version];
  });
  return Object.fromEntries(entries);
}

function readConfig(text) {
  const config = YAML.parse(text);
  if (!isMapping(config)) {
    throw new Error('sushi-config must be a YAML mapping.');
  }
  for (const key of ['id', 'version']) {
    if (!isNonEmptyString(config[key])) {
      throw new Error(`Missing or invalid '${key}' in sushi-config. Use a non-empty string.`);
    }
  }
  const fhirVersion = readFhirVersion(config.fhirVersion);
  return {
    name: config.id,
    version: config.version,
    description: config.description ?? '',
    fhirVersion,
    spec: selectFirelySpec(fhirVersion),
    dependencies: readDependencies(config.dependencies ?? {}),
  };
}

module.exports = { readConfig, isMapping };
