// PP 2.0.0 DAILY_DIGEST publication gate — C3-D2A candidate module.
// Frozen specification binding: PP 2.0.0 DAILY_DIGEST formal specification
//   SHA-256 e450f44438d0fdeb5f3459ebef3afcf16f59ff512f32a48d6e8468e1a3dde78b
// Fail-closed: any uncertainty returns {pass:false}. DAILY_DIGEST has no
// score/scoreInput stage — PQ=BLOCKED_PROVIDER_CAPABILITY does not apply here.
// Mode B is not consulted (DISABLED). Source of truth: governance layer;
// this module performs scope/format validation only.
export const FROZEN_SPEC_SHA256 = 'e450f44438d0fdeb5f3459ebef3afcf16f59ff512f32a48d6e8468e1a3dde78b';
export const CONTENT_CLASS = 'DAILY_DIGEST';
const V2_RADARS = ['ai', 'dev', 'app', 'security', 'skill'];
const policyTag = () => 'PP-2.0.0-DAILY_DIGEST@' + FROZEN_SPEC_SHA256.slice(0, 12);
const reject = reason => ({pass: false, reason, policy: policyTag()});

export function evaluateDailyDigestGate({radar, date, contentSha256, contentClass = CONTENT_CLASS} = {}) {
  if (contentClass !== CONTENT_CLASS) return reject('CONTENT_CLASS_NOT_DAILY_DIGEST');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return reject('BAD_DATE_FORMAT');
  if (!V2_RADARS.includes(radar)) return reject('RADAR_OUT_OF_V2_SCOPE');
  if (!/^[0-9a-f]{64}$/.test(String(contentSha256 ?? ''))) return reject('BAD_CONTENT_SHA256_FORMAT');
  return {pass: true, reason: 'DAILY_DIGEST_SCOPE_VALID', policy: policyTag()};
}
