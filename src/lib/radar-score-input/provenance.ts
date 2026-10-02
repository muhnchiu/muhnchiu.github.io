import { provenanceSchema } from './policy.ts';

type Schema = Record<string, any>;

function resolveRef(ref: string): Schema {
  if (!ref.startsWith('#/')) throw new Error(`UNSUPPORTED_SCHEMA_REF:${ref}`);
  return ref.slice(2).split('/').reduce((value: any, part) => value[part], provenanceSchema);
}

function typeMatches(value: unknown, type: string): boolean {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return true;
}

function validate(value: unknown, schema: Schema, path: string, errors: string[]): void {
  if (schema.$ref) { validate(value, resolveRef(schema.$ref), path, errors); return; }
  if (schema.allOf) for (const part of schema.allOf) validate(value, part, path, errors);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((part: Schema) => { const local: string[] = []; validate(value, part, path, local); return local.length === 0; }).length;
    if (matches !== 1) errors.push(`${path}: expected exactly one matching schema branch, got ${matches}`);
  }
  if (schema.if) {
    const local: string[] = []; validate(value, schema.if, path, local);
    if (local.length === 0 && schema.then) validate(value, schema.then, path, errors);
    if (local.length > 0 && schema.else) validate(value, schema.else, path, errors);
  }
  if (schema.type && !(Array.isArray(schema.type) ? schema.type.some((type: string) => typeMatches(value, type)) : typeMatches(value, schema.type))) errors.push(`${path}: expected ${schema.type}`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(`${path}: expected const ${schema.const}`);
  if (schema.enum && !schema.enum.some((entry: unknown) => Object.is(entry, value))) errors.push(`${path}: value outside enum`);
  if (typeof value === 'string') {
    if (schema.minLength && value.length < schema.minLength) errors.push(`${path}: shorter than minLength`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${path}: pattern mismatch`);
    if (schema.format === 'date-time' && (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) errors.push(`${path}: invalid date-time`);
    if (schema.format === 'uri') { try { const url = new URL(value); if (!url.protocol || !url.hostname) errors.push(`${path}: invalid URI`); } catch { errors.push(`${path}: invalid URI`); } }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(object)) {
      if (schema.properties?.[key]) validate(child, schema.properties[key], `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than maxItems`);
    if (schema.items) value.forEach((entry, index) => validate(entry, schema.items, `${path}[${index}]`, errors));
  }
}

export function validateProvenanceRecord(record: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  validate(record, provenanceSchema, 'provenance', errors);
  return { valid: errors.length === 0, errors };
}
