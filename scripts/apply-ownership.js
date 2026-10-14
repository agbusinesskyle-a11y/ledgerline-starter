#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { createPool } from '../services/lib/db.js';
import { log, logFailure } from '../services/lib/log.js';

class InvalidPlan extends Error {
  constructor(offenders) { super('ownership plan refused'); this.offenders = offenders; }
}
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const key = (institution, mask) => JSON.stringify([institution, mask]);
const label = row => `${row.institution ?? '(missing institution)'} / ${row.mask ?? '(missing mask)'}`;

function options(args) {
  const result = { apply: false, orgSlug: process.env.LL_ORG_SLUG || 'main' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') result.apply = true;
    else if (args[i] === '--org-slug' || args[i] === '--role') {
      const option = args[i], value = args[++i];
      if (!nonempty(value) || value.startsWith('--')) throw new InvalidPlan(['missing option value']);
      result[option === '--role' ? 'role' : 'orgSlug'] = value;
    } else if (args[i].startsWith('-') || result.file) throw new InvalidPlan(['unexpected command argument']);
    else result.file = args[i];
  }
  if (!result.file || (result.role && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(result.role))) {
    throw new InvalidPlan(['usage: scripts/apply-ownership.js <rulings.json> [--apply] [--org-slug main] [--role ll_verify]']);
  }
  return result;
}

function validateFile(file) {
  const errors = [];
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new InvalidPlan(['rulings JSON must be an object']);
  if (!nonempty(file.ruled_by)) errors.push('ruled_by must name the owner');
  for (const field of ['entities', 'dimensions', 'accounts']) {
    if (!Array.isArray(file[field])) errors.push(`${field} must be an array`);
  }
  if (errors.length) throw new InvalidPlan(errors);
  const entities = new Map(), dimensions = new Map(), accounts = new Set();
  for (const row of file.entities) {
    if (!row || !nonempty(row.slug) || !nonempty(row.display_name)) { errors.push('entity requires slug and display_name'); continue; }
    if (entities.has(row.slug)) errors.push(`duplicate entity slug: ${row.slug}`);
    entities.set(row.slug, row);
  }
  for (const row of file.dimensions) {
    if (!row || !nonempty(row.slug) || !nonempty(row.display_name) || !nonempty(row.parent_entity)) {
      errors.push('dimension requires slug, display_name and parent_entity'); continue;
    }
    if (dimensions.has(row.slug)) errors.push(`duplicate dimension slug: ${row.slug}`);
    if (!entities.has(row.parent_entity)) errors.push(`dimension ${row.slug}: unknown parent entity ${row.parent_entity}`);
    dimensions.set(row.slug, row);
  }
  for (const row of file.accounts) {
    if (!row || !nonempty(row.institution) || !nonempty(row.mask) || !nonempty(row.name) || !nonempty(row.entity)) {
      errors.push('account requires institution, string mask, name and entity'); continue;
    }
    const naturalKey = key(row.institution, row.mask);
    if (accounts.has(naturalKey)) errors.push(`duplicate file account: ${label(row)}`);
    accounts.add(naturalKey);
    if (!entities.has(row.entity)) errors.push(`account ${label(row)}: unknown entity ${row.entity}`);
    if (row.dimension !== undefined && (!dimensions.has(row.dimension) || dimensions.get(row.dimension).parent_entity !== row.entity)) {
      errors.push(`account ${label(row)}: dimension ${row.dimension} does not belong to entity ${row.entity}`);
    }
    if (row.note !== undefined && typeof row.note !== 'string') errors.push(`account ${label(row)}: note must be text`);
  }
  if (errors.length) throw new InvalidPlan(errors);
}

function metadata(row, source) {
  let kind = 'other', balance_orientation = 'asset', verification_method = 'unverified';
  if (source.type === 'depository') {
    kind = { checking: 'checking', savings: 'savings', 'money market': 'money_market' }[source.subtype] || 'other';
    verification_method = 'cash_statement';
  } else if (source.type === 'credit') {
    kind = 'credit_card'; balance_orientation = 'liability'; verification_method = 'card_statement';
  } else if (source.type === 'loan') {
    kind = /line of credit/i.test(row.note || '') ? 'line_of_credit' : source.subtype === 'mortgage' ? 'mortgage' : 'loan';
    balance_orientation = 'liability'; verification_method = 'loan_principal';
  } else if (source.type === 'investment') kind = 'brokerage';
  return { display_name: row.name, institution_name: row.institution, mask: row.mask, kind, balance_orientation,
    verification_method, currency: 'USD', status: 'active',
    history_state: source.transactions_update_status === 'HISTORICAL_UPDATE_COMPLETE' ? 'complete' : 'loading', coverage_gap: null };
}

async function resolve(client, file, orgSlug) {
  const org = (await client.query('SELECT org_id FROM core.org WHERE slug=$1', [orgSlug])).rows[0]?.org_id;
  if (!org) throw new InvalidPlan([`unknown org slug: ${orgSlug}`]);
  const errors = [], entities = new Map(), dimensions = new Map();
  const entityRulings = [], dimensionRulings = [], accountRulings = [], accounts = [];
  const existingEntities = (await client.query('SELECT entity_id,slug FROM core.entity WHERE org_id=$1', [org])).rows;
  for (const row of file.entities) {
    const existing = existingEntities.filter(e => e.slug === row.slug);
    if (existing.length > 1) errors.push(`ambiguous existing entity slug: ${row.slug}`);
    const id = existing[0]?.entity_id || randomUUID();
    entities.set(row.slug, id);
    if (!existing.length) entityRulings.push({ kind: 'entity', subject_id: id,
      after: { slug: row.slug, display_name: row.display_name, has_books: true, active: true } });
  }
  const existingDimensions = (await client.query('SELECT dimension_id,entity_id,slug FROM core.dimension WHERE org_id=$1', [org])).rows;
  for (const row of file.dimensions) {
    const existing = existingDimensions.find(d => d.slug === row.slug), entity = entities.get(row.parent_entity);
    if (existing && existing.entity_id !== entity) errors.push(`dimension ${row.slug}: existing parent differs from ${row.parent_entity}`);
    const id = existing?.dimension_id || randomUUID();
    dimensions.set(row.slug, id);
    if (!existing) dimensionRulings.push({ kind: 'dimension', subject_id: id,
      after: { entity_id: entity, slug: row.slug, display_name: row.display_name } });
  }
  // Select only permitted connection columns; ll_verify cannot read encrypted credentials.
  const sources = (await client.query(`SELECT sa.source_account_id,sa.type,sa.subtype,sa.mask,
    c.institution_name,c.state,c.transactions_update_status,aa.account_id,aa.reason,to_jsonb(a) AS account
    FROM core.source_account sa JOIN core.source_connection c USING(org_id,connection_id)
    LEFT JOIN core.account_assignment aa ON aa.org_id=sa.org_id AND aa.source_account_id=sa.source_account_id AND aa.valid @> now()
    LEFT JOIN core.account a ON a.org_id=aa.org_id AND a.account_id=aa.account_id WHERE sa.org_id=$1`, [org])).rows;
  const ownership = (await client.query(`SELECT account_id,entity_id,dimension_id,
    lower_inf(valid) AND upper_inf(valid) AS all_time FROM core.account_entity WHERE org_id=$1 AND NOT isempty(valid)`, [org])).rows;
  const byKey = new Map();
  for (const source of sources) {
    const naturalKey = key(source.institution_name, source.mask);
    if (!byKey.has(naturalKey)) byKey.set(naturalKey, []);
    byKey.get(naturalKey).push(source);
  }
  const covered = new Set(), targetAccounts = new Set();
  for (const row of file.accounts) {
    const matches = byKey.get(key(row.institution, row.mask)) || [];
    if (matches.length !== 1) {
      errors.push(`${matches.length ? 'ambiguous' : 'unmatched'} file account: ${label(row)} (${matches.length} source accounts)`);
      continue;
    }
    const source = matches[0]; covered.add(source.source_account_id);
    if (!source.account_id || !source.account) { errors.push(`missing current assignment: ${label(row)}`); continue; }
    if (targetAccounts.has(source.account_id)) errors.push(`multiple file rows target the same account: ${label(row)}`);
    targetAccounts.add(source.account_id);
    const account = metadata(row, source), entity_id = entities.get(row.entity), dimension_id = dimensions.get(row.dimension) || null;
    if (source.reason === 'placeholder' || Object.entries(account).some(([k, v]) => source.account[k] !== v)) {
      accountRulings.push({ kind: 'assignment', subject_id: source.source_account_id, after: { account_id: source.account_id, account } });
    }
    const existing = ownership.filter(o => o.account_id === source.account_id);
    if (!existing.length) accountRulings.push({ kind: 'account_entity', subject_id: source.account_id,
      after: { entity_id, dimension_id, valid: '(,)' } });
    else if (existing.length !== 1 || !existing[0].all_time || existing[0].entity_id !== entity_id || existing[0].dimension_id !== dimension_id) {
      // project_ruling cannot replace an existing interval with an unbounded one
      // without overlap. Refuse conflicting prior ownership instead of truncating it.
      errors.push(`existing ownership conflicts with all-time seed: ${label(row)}`);
    }
    accounts.push({ ...row, source_account_id: source.source_account_id, account_id: source.account_id, entity_id, account });
  }
  for (const source of sources) {
    if (!['removed', 'replaced'].includes(source.state) && !covered.has(source.source_account_id)) {
      errors.push(`uncovered live account: ${source.institution_name} / ${source.mask} (${source.source_account_id})`);
    }
  }
  if (errors.length) throw new InvalidPlan(errors);
  return { org, entities, accounts, batches: [entityRulings, dimensionRulings, accountRulings] };
}

async function totals(client, plan, dryRun) {
  const entityRows = (await client.query('SELECT entity_id,slug FROM core.entity WHERE org_id=$1', [plan.org])).rows;
  const table = new Map(entityRows.map(e => [e.entity_id, { slug: e.slug, accounts: 0, transactions: 0 }]));
  for (const [slug, id] of plan.entities) if (!table.has(id)) table.set(id, { slug, accounts: 0, transactions: 0 });
  const plannedOwners = new Map(dryRun ? plan.accounts.map(a => [a.account_id, a.entity_id]) : []);
  const accountRows = (await client.query(`SELECT account_id,entity_id FROM core.account_entity
    WHERE org_id=$1 AND valid @> current_date`, [plan.org])).rows;
  const accountOwners = new Map(accountRows.map(a => [a.account_id, a.entity_id]));
  for (const [account, entity] of plannedOwners) accountOwners.set(account, entity);
  for (const entity of accountOwners.values()) if (table.has(entity)) table.get(entity).accounts++;
  const transactionRows = (await client.query(`SELECT t.account_id,ae.entity_id,count(*)::int AS n
    FROM core.transaction t LEFT JOIN core.account_entity ae ON ae.org_id=t.org_id
      AND ae.account_id=t.account_id AND ae.valid @> t.posted_date
    WHERE t.org_id=$1 GROUP BY t.account_id,ae.entity_id`, [plan.org])).rows;
  for (const t of transactionRows) {
    const entity = plannedOwners.get(t.account_id) || t.entity_id;
    if (table.has(entity)) table.get(entity).transactions += t.n;
  }
  const total = Number((await client.query('SELECT count(*) AS n FROM core.transaction WHERE org_id=$1', [plan.org])).rows[0].n);
  const placeholders = Number((await client.query(`SELECT count(*) AS n FROM core.source_account sa
    JOIN core.source_connection c USING(org_id,connection_id)
    LEFT JOIN core.account_assignment aa ON aa.org_id=sa.org_id AND aa.source_account_id=sa.source_account_id AND aa.valid @> now()
    LEFT JOIN core.account a ON a.org_id=aa.org_id AND a.account_id=aa.account_id
    WHERE sa.org_id=$1 AND c.state NOT IN ('removed','replaced') AND (a.account_id IS NULL OR a.status='placeholder')`, [plan.org])).rows[0].n);
  const values = [...table.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  console.log(`${dryRun ? 'Planned' : 'Final'} ownership totals`);
  console.log('entity slug | accounts | transactions');
  for (const e of values) console.log(`${e.slug} | ${e.accounts} | ${e.transactions}`);
  const sum = values.reduce((n, e) => n + e.transactions, 0);
  console.log(`TOTAL | ${values.reduce((n, e) => n + e.accounts, 0)} | ${sum}`);
  if (sum !== total || (!dryRun && placeholders !== 0)) {
    log('error', 'ownership totals check failed', { entity_transactions: sum, org_transactions: total, live_placeholders: placeholders });
    throw new Error('ownership invariants failed');
  }
}

let pool, client, inTransaction = false, locked = false;
try {
  const args = options(process.argv.slice(2));
  let file;
  try { file = JSON.parse(await readFile(args.file, 'utf8')); }
  catch { throw new InvalidPlan(['cannot read a valid rulings JSON file']); }
  validateFile(file);
  pool = createPool(); client = await pool.connect();
  if (args.role) await client.query(`SET ROLE "${args.role}"`);
  // Acquire the session lock before BEGIN: publication timestamps use now(),
  // so a transaction begun while waiting could predate newly inventoried accounts.
  if (args.apply) { await client.query('SELECT pg_advisory_lock(7777)'); locked = true; }
  await client.query(args.apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  inTransaction = true;
  const plan = await resolve(client, file, args.orgSlug);
  log('info', args.apply ? 'APPLY ownership plan' : 'DRY RUN ownership plan', {
    entities_to_create: plan.batches[0].length, dimensions_to_create: plan.batches[1].length,
    account_rulings: plan.batches[2].length, publications: plan.batches.filter(b => b.length).length,
  });
  for (const batch of plan.batches.slice(0, 2)) for (const row of batch) log('info', 'create', { kind: row.kind, ...row.after });
  for (const row of plan.accounts) log('info', 'account plan', { institution: row.institution, mask: row.mask,
    account_id: row.account_id, entity: row.entity, dimension: row.dimension ?? null, valid: '(,)', ...row.account });
  let publications = 0, acknowledged = 0;
  if (args.apply) {
    for (const rulings of plan.batches) {
      if (!rulings.length) continue;
      await client.query('SELECT core.apply_ruling($1,$2,$3,$4,$5)', [rulings[0].kind, rulings[0].subject_id,
        { org_id: plan.org, rulings: rulings.map(r => ({ ...r, after: { org_id: plan.org, ...r.after } })) },
        `ownership seed: ${basename(args.file)}`, file.ruled_by]);
      publications++;
    }
    acknowledged = (await client.query('SELECT ops.resolve_assigned_account_alerts($1) AS n', [plan.org])).rows[0].n;
  }
  await totals(client, plan, !args.apply);
  await client.query(args.apply ? 'COMMIT' : 'ROLLBACK'); inTransaction = false;
  log('info', args.apply && !publications && !acknowledged ? 'nothing to do' : args.apply ? 'ownership applied' : 'dry run complete; no writes',
    { publications, acknowledged_alerts: acknowledged });
} catch (error) {
  if (inTransaction) await client.query('ROLLBACK').catch(() => {});
  if (error instanceof InvalidPlan) {
    for (const offender of error.offenders) log('error', offender);
    process.exitCode = 2;
  } else { logFailure('ownership seed failed; transaction rolled back', error); process.exitCode = 1; }
} finally {
  if (locked) await client.query('SELECT pg_advisory_unlock(7777)').catch(() => {});
  if (client) client.release();
  if (pool) await pool.end();
}
