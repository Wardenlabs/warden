import assert from 'node:assert/strict';
import { sanitize } from '../src/guard/sanitize.js';

const short = sanitize('the api key is 2323');
assert.equal(short.masked, 'the api key is [REDACTED:API key]');
assert.deepEqual(short.spans.map((span) => span.kind), ['api-key']);
assert.ok(!short.masked.includes('2323'));

assert.equal(
  sanitize('clave de API: ab12').masked,
  'clave de API: [REDACTED:API key]'
);
assert.equal(
  sanitize('password = "correct horse battery staple"').masked,
  'password = "[REDACTED:password]"'
);
assert.equal(sanitize('the api key is 2323.').masked, 'the api key is [REDACTED:API key].');

for (const prose of [
  'An API key is required for setup.',
  'The access token is missing.',
  'What is an API key?'
]) {
  assert.equal(sanitize(prose).masked, prose);
}

const known = sanitize('Use sk-abcdefghijklmnopqrstuvwxyz1234');
assert.match(known.masked, /\[REDACTED:OpenAI key\]/);

console.log('✓ labelled credentials are masked without redacting ordinary setup prose');
