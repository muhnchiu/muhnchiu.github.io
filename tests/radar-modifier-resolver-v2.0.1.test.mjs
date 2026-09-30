import assert from 'node:assert/strict';
import test from 'node:test';
import { clampRadarModifierV201, resolveRadarModifierV201 } from '../src/lib/radar-intelligence/radar-modifier-resolver-v2.0.1.mjs';

const security = (title, entity = '') => resolveRadarModifierV201({ radar: 'sec', title, entity });

test('Security ai matching is whole-token and deterministic', () => {
  for (const title of ['AI', 'ai', 'AI security', 'AI-assisted']) {
    assert.equal(security(title).radarModifier, 1, `${title} should compose -2 + 3.`);
  }
  for (const title of ['AIO', 'paid', 'maintain']) {
    assert.equal(security(title).radarModifier, -2, `${title} should retain only the default bias.`);
  }
  assert.equal(security('MCP-security').radarModifier, 1);
  assert.equal(security('agentic').radarModifier, -2, 'Security agent trigger is also a whole token.');
  assert.equal(security('Gecko').radarModifier, 1);
});

test('Security composition records bias plus no more than one topical trigger', () => {
  const result = security('AI MCP agent Gecko');
  assert.equal(result.radarModifier, 1);
  assert.deepEqual(result.matchedRules, ['SECURITY_DEFAULT_BIAS', 'SECURITY_TOPICAL']);
  assert.deepEqual(result.modifierComponents, [
    { rule: 'SECURITY_DEFAULT_BIAS', value: -2 },
    { rule: 'SECURITY_TOPICAL', term: 'ai', value: 3 },
  ]);
  assert.equal(typeof result.modifierReason, 'string');
});

test('App unrelated negative triggers are generically suppressed', () => {
  for (const [title, entity] of [
    ['Obscura VPN zero logs', 'obscura-vpn'],
    ['PGSTY Silo MinIO replacement', 'minio'],
    ['Radicle protocol disclosure', 'radicle'],
  ]) {
    const result = resolveRadarModifierV201({ radar: 'app', title, entity, relevanceLevel: 'UNRELATED' });
    assert.equal(result.radarModifier, 0);
    assert.deepEqual(result.modifierComponents, [{ rule: 'APP_NEGATIVE_SUPPRESSED_UNRELATED', term: title.includes('VPN') ? 'vpn' : title.includes('MinIO') ? 'minio' : 'radicle', value: 0 }]);
  }
  assert.equal(resolveRadarModifierV201({ radar: 'app', title: 'VPN product', relevanceLevel: 'ADJACENT' }).radarModifier, -3);
});

test('resolver input/output contract excludes unrelated scoring fields and clamps safely', () => {
  const input = { radar: 'sec', title: 'AI security', entity: '', relevanceLevel: 'DIRECT', securityGate: 'UNRELATED', directBonus: 5, impact: 9 };
  assert.equal(resolveRadarModifierV201(input).radarModifier, 1);
  assert.equal(clampRadarModifierV201(11), 10);
  assert.equal(clampRadarModifierV201(-11), -10);
  assert.throws(() => clampRadarModifierV201(Number.NaN), /finite/);
  assert.throws(() => resolveRadarModifierV201({ radar: 'other' }), /radar must be/);
});
