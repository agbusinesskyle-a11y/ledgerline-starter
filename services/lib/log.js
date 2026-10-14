const sensitive = /secret|token|password|key|dsn|url/i;
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, sensitive.test(key) ? '***' : redact(item)]));
  }
  return value;
}
export function log(level, message, fields = {}) {
  console.log(JSON.stringify(redact({ ...fields, time: new Date().toISOString(), level, message })));
}
export function requireEnv(env, name) {
  if (!env[name]) {
    const error = new Error(`missing variable: ${name}`);
    error.missingVariable = name;
    throw error;
  }
  return env[name];
}
const bounded = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : undefined);
export function logFailure(message, error) {
  // Arbitrary exception messages can contain credentials or remote payloads, so the raw
  // message is never logged. Only structured, bounded fields are: Node syscall errors
  // (ENOTFOUND + hostname), server-generated Postgres errors (SQLSTATE + routine +
  // message), SDK error names/HTTP status, and pg tool diagnostics from runPg.
  if (error.missingVariable) return log('error', `missing variable: ${error.missingVariable}`);
  const fields = { code: /^[A-Z0-9_]{1,30}$/.test(error.code || '') ? error.code : 'FAILED' };
  if (error.name && error.name !== 'Error') fields.name = bounded(String(error.name), 60);
  if (error.syscall) { fields.syscall = bounded(error.syscall, 40); fields.hostname = bounded(error.hostname, 120); }
  if (error.severity) { fields.pg_routine = bounded(error.routine, 60); fields.pg_message = bounded(error.message, 300); }
  if (Number.isInteger(error.$metadata?.httpStatusCode)) fields.http_status = error.$metadata.httpStatusCode;
  if (error.diagnostic) fields.diagnostic = bounded(error.diagnostic, 300);
  log('error', message, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
}
