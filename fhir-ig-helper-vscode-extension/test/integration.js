// Real SDK smoke test: local package profiles, nested Bundle resources, and exit codes.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { validateResources } = require('../src/sdk-resources');
const { createCommandRunner } = require('../src/commands');
const { runProcess } = require('../src/process');

function packageArchive(files) {
  const chunks = [];
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(' ', 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'firely-sdk-integration-'));
  try {
    const canonical = 'http://example.org/StructureDefinition/named-patient';
    const profile = {
      resourceType: 'StructureDefinition', id: 'named-patient', url: canonical, name: 'NamedPatient',
      status: 'active', fhirVersion: '4.0.1', kind: 'resource', abstract: false, type: 'Patient',
      baseDefinition: 'http://hl7.org/fhir/StructureDefinition/Patient', derivation: 'constraint',
      snapshot: { element: [
        { id: 'Patient', path: 'Patient', min: 0, max: '*', constraint: [
          { key: 'patient-has-name', severity: 'error', human: 'The patient must have a name.', expression: 'name.exists()', source: canonical },
        ] },
        { id: 'Patient.meta', path: 'Patient.meta', min: 0, max: '1', type: [{ code: 'Meta' }] },
        { id: 'Patient.text', path: 'Patient.text', min: 1, max: '1', type: [{ code: 'Narrative' }] },
        { id: 'Patient.name', path: 'Patient.name', min: 0, max: '*', type: [{ code: 'HumanName' }] },
      ] },
    };
    const bundle = (valid) => ({ resourceType: 'Bundle', type: 'collection', entry: [{ fullUrl: 'urn:uuid:1285e6f6-73b9-4792-8a74-b86a1f5d0b2e',
      resource: { resourceType: 'Patient', meta: { profile: [canonical] }, text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">Example patient</div>' }, ...(valid ? { name: [{ family: 'Example' }] } : {}) },
    }] });
    const files = {
      'package/package.json': { name: 'example.sdk.test', version: '1.0.0', fhirVersions: ['4.0.1'], dependencies: { 'hl7.fhir.r4.core': '4.0.1' } },
      'package/StructureDefinition-named-patient.json': profile,
      'package/example/Bundle-valid.json': bundle(true),
      'package/example/Bundle-invalid.json': bundle(false),
    };
    await fs.mkdir(path.join(root, 'output'));
    await fs.writeFile(path.join(root, 'output/package.tgz'), packageArchive(files));
    await fs.writeFile(path.join(root, 'sushi-config.yaml'), 'id: example.sdk.test\nversion: 1.0.0\nfhirVersion: 4.0.1\n');
    await fs.writeFile(path.join(root, 'package.json'), 'unchanged');
    const resources = path.join(root, 'output');
    await fs.mkdir(resources, { recursive: true });
    await fs.writeFile(path.join(resources, 'Bundle-valid.json'), JSON.stringify(bundle(true)));
    await fs.writeFile(path.join(resources, 'Bundle-invalid.json'), JSON.stringify(bundle(false)));
    await fs.writeFile(path.join(resources, 'StructureDefinition-named-patient.json'), JSON.stringify(profile));
    // Raw SUSHI output lacks narratives; published output must be the validation input.
    await fs.mkdir(path.join(root, 'fsh-generated/resources'), { recursive: true });
    const rawBundle = bundle(true);
    delete rawBundle.entry[0].resource.text;
    await fs.writeFile(path.join(root, 'fsh-generated/resources/Bundle-valid.json'), JSON.stringify(rawBundle));
    const xml = (withNarrative) => `<Bundle xmlns="http://hl7.org/fhir"><type value="collection"/><entry><fullUrl value="urn:uuid:1285e6f6-73b9-4792-8a74-b86a1f5d0b2e"/><resource><Patient><meta><profile value="${canonical}"/></meta>${withNarrative ? '<text><status value="generated"/><div xmlns="http://www.w3.org/1999/xhtml">Example patient</div></text>' : ''}<name><family value="Example"/></name></Patient></resource></entry></Bundle>`;
    await fs.writeFile(path.join(resources, 'Bundle-valid.xml'), xml(true));
    await fs.writeFile(path.join(resources, 'Bundle-missing-narrative.xml'), xml(false));
    await fs.writeFile(path.join(resources, 'Bundle-malformed.xml'), '<Bundle');
    await fs.writeFile(path.join(resources, 'qa.json'), '{}');
    await fs.writeFile(path.join(resources, 'Bundle-valid.xml.html'), '<html/>');
    const results = [];
    const log = (text) => process.stdout.write(text);
    const summary = await validateResources({
      root, commands: createCommandRunner({ cwd: root, log }), dotnetPath: 'dotnet',
      packagePath: path.join(root, 'output/package.tgz'), terminologyServer: 'https://tx.hl7europe.eu/r4',
      onResult: (result) => results.push(result), log, progress() {},
    });
    assert.equal(summary.passed, 2);
    assert.equal(summary.failed, 3);
    assert.equal(summary.skipped, 0);
    assert.match(results.find(result => result.file.endsWith('Bundle-invalid.json')).output, /patient-has-name/);
    assert.match(results.find(result => result.file.endsWith('Bundle-missing-narrative.xml')).output, /text|Narrative/);
    assert.equal(results.find(result => result.file.endsWith('Bundle-valid.json')).passed, true);
    assert.equal(results.find(result => result.file.endsWith('Bundle-valid.xml')).passed, true);
    assert.ok(results.every(result => result.file.startsWith(resources)));
    assert.equal(results.find(result => result.file.endsWith('Bundle-malformed.xml')).passed, false);
    assert.equal(await fs.readFile(path.join(root, 'package.json'), 'utf8'), 'unchanged');

    const project = path.resolve(__dirname, '../validator/FirelyValidator.csproj');
    async function validatePackage(packagePath, expectedCode) {
      const report = path.join(root, 'report.json');
      await fs.rm(report, { force: true });
      const result = await runProcess('dotnet', ['run', '--no-build', '--project', project, '-c', 'Release', '--', packagePath, '--report', report]);
      assert.equal(result.code, expectedCode, result.output);
      return expectedCode === 2 ? undefined : JSON.parse(await fs.readFile(report, 'utf8'));
    }
    const packagePath = path.join(root, 'output/package.tgz');
    const packaged = await validatePackage(packagePath, 1);
    assert.equal(packaged.passed, 1);
    assert.equal(packaged.failed, 1);
    assert.match(packaged.results.find((r) => r.status === 'failed').output, /patient-has-name/);

    delete files['package/example/Bundle-invalid.json'];
    await fs.writeFile(packagePath, packageArchive(files));
    assert.equal((await validatePackage(packagePath, 0)).passed, 1);
    // Rebuilding the same package version must use its new constraints.
    profile.snapshot.element[0].constraint[0].expression = 'false';
    await fs.writeFile(packagePath, packageArchive(files));
    assert.equal((await validatePackage(packagePath, 1)).failed, 1);
    profile.snapshot.element[0].constraint[0].severity = 'warning';
    await fs.writeFile(packagePath, packageArchive(files));
    const warningOnly = await validatePackage(packagePath, 0);
    assert.equal(warningOnly.passed, 1);
    assert.ok(warningOnly.warnings.length > 0);
    profile.snapshot.element[0].constraint[0].expression = 'name.exists()';
    profile.snapshot.element[0].constraint[0].severity = 'error';
    files['package/example/broken.json'] = '{';
    files['package/example/unknown-profile.json'] = { resourceType: 'Patient', meta: { profile: ['http://example.org/unknown'] } };
    await fs.writeFile(packagePath, packageArchive(files));
    assert.equal((await validatePackage(packagePath, 1)).failed, 2);
    delete files['package/example/broken.json'];
    delete files['package/example/unknown-profile.json'];
    delete files['package/example/Bundle-valid.json'];
    await fs.writeFile(packagePath, packageArchive(files));
    const skipped = await validatePackage(packagePath, 0);
    assert.equal(skipped.validated, 0);
    assert.match(skipped.warnings.join(' '), /No instances/);
    files['package/package.json'].fhirVersions = ['5.0.0'];
    await fs.writeFile(packagePath, packageArchive(files));
    await validatePackage(packagePath, 2);
    await fs.writeFile(packagePath, 'broken archive');
    await validatePackage(packagePath, 2);
    await validatePackage(path.join(root, 'missing.tgz'), 2);
    console.log('SDK integration checks passed.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
