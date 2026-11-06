const { test } = require('node:test');
const assert = require('node:assert/strict');
const { locateFirelyIssues } = require('../src/locations');

test('maps each Firely At path to the matching nested JSON property', () => {
  const source = `${JSON.stringify({
    resourceType: 'MessageHeader',
    destination: [{ name: 'first', receiver: { reference: 'Organization/one' } }],
    sender: { reference: 'Organization/two' },
  }, null, 2)}\n`;
  const output = `Error: Receiver must be bundled. (for slice primary)
At: MessageHeader.destination[0].receiver[0]
http://hl7.org/fhir/dotnet-api-operation-outcome|1015

Error: Sender must be bundled.
At: MessageHeader.sender[0]
http://hl7.org/fhir/dotnet-api-operation-outcome|1015

Result: INVALID`;
  const findings = locateFirelyIssues(source, 'MessageHeader', output);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map(({ range }) => range.start.line), [5, 10]);
  assert.equal(source.split('\n')[findings[0].range.start.line].slice(findings[0].range.start.character), '"receiver": {');
  assert.equal(source.split('\n')[findings[1].range.start.line].slice(findings[1].range.start.character), '"sender": {');
  assert.match(findings[0].message, /slice primary/);
  assert.match(findings[1].message, /operation-outcome/);
});

test('leaves unsupported or missing paths available for file-level fallback', () => {
  const findings = locateFirelyIssues('{"resourceType":"Patient"}', 'Patient',
    'Error: Bad value\nAt: Patient.name.where(use = "usual")\nResult: INVALID');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].range, undefined);
});
