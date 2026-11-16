// The JSON Schema keywords spec/schema/*.json use, checked without a dependency. An unknown keyword
// fails the check, so a schema can never rely on a keyword this validator ignores.
type Schema = { [keyword: string]: unknown };

const KNOWN = new Set([
  '$schema',
  '$id',
  'title',
  'type',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'uniqueItems',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'exclusiveMinimum',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Every violation of `schema` by `value`, as `path: message`; empty when it conforms. */
export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  for (const keyword of Object.keys(schema))
    if (!KNOWN.has(keyword))
      errors.push(`${path}: unsupported keyword ${keyword}`);
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = ([] as string[]).concat(schema.type as string | string[]);
    const ok =
      allowed.includes(actual) ||
      (actual === 'integer' && allowed.includes('number'));
    if (!ok)
      return [
        ...errors,
        `${path}: expected ${allowed.join('|')}, got ${actual}`,
      ];
  }
  if (schema.enum !== undefined && !(schema.enum as unknown[]).includes(value))
    errors.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'string') {
    if (
      typeof schema.pattern === 'string' &&
      !new RegExp(schema.pattern, 'u').test(value)
    )
      errors.push(`${path}: does not match ${schema.pattern}`);
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      errors.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      errors.push(`${path}: below ${schema.minimum}`);
    if (
      typeof schema.exclusiveMinimum === 'number' &&
      value <= schema.exclusiveMinimum
    )
      errors.push(`${path}: not above ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (
      schema.uniqueItems === true &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      errors.push(`${path}: duplicate items`);
  }
  if (Array.isArray(value) && schema.items !== undefined)
    for (const [index, item] of value.entries())
      errors.push(
        ...validate(schema.items as Schema, item, `${path}[${index}]`),
      );
  if (actual === 'object') {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[])
      if (!(key in object)) errors.push(`${path}: missing ${key}`);
    for (const [key, item] of Object.entries(object)) {
      const own = properties[key];
      if (own !== undefined)
        errors.push(...validate(own, item, `${path}.${key}`));
      else if (schema.additionalProperties === false)
        errors.push(`${path}: unknown property ${key}`);
      else if (typeof schema.additionalProperties === 'object')
        errors.push(
          ...validate(
            schema.additionalProperties as Schema,
            item,
            `${path}.${key}`,
          ),
        );
    }
  }
  return errors;
}
