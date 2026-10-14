// Porting contract for Step 2b: use these exact keys (no cause/connection keys).
// 1. Fold added, modified, removed in that order within each page, pages in
// caller order. Last observation for an external id wins, including re-adds.
// 2. Group the surviving full objects by pending_transaction_id.
// 3. Resolve in C/binary external-id order: all competing claimants quarantine;
// an already-promoted P may only be claimed again by its authoritative Q.
// 4. Emit sorted claims, ordinary upserts, removals minus promoted P, then
// quarantines. A competing claim does not suppress P's independent lifecycle.

// Prior authority is an explicit immutable input, keeping reduction pure. SQL
// reads this same context from aliases; no page-only function can infer history.
export function reducePages(pages, { connectionId, authorities = [] } = {}) {
  const final = new Map();
  for (const page of pages) {
    for (const obj of [...(page.payload.added || []), ...(page.payload.modified || [])]) {
      final.set(obj.transaction_id, { kind:'upsert', external_id:obj.transaction_id, api_call_id:Number(page.api_call_id), obj });
    }
    for (const obj of page.payload.removed || []) {
      final.set(obj.transaction_id, { kind:'removed', external_id:obj.transaction_id, api_call_id:Number(page.api_call_id) });
    }
  }
  const groups = new Map();
  for (const t of final.values()) {
    const p = t.obj?.pending_transaction_id;
    if (t.kind === 'upsert' && p) groups.set(p, (groups.get(p) || 0) + 1);
  }
  const claims=[], upserts=[], removals=[], quarantines=[], claimed=new Set();
  const sorted = [...final.keys()].sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const ext of sorted) {
    const t = final.get(ext), p=t.obj?.pending_transaction_id;
    if (t.kind === 'upsert' && p) {
      const duplicate = authorities.some(a => a.pending_id === p &&
        !(a.connection_id === connectionId && (a.external_id === p || a.external_id === ext)));
      if (groups.get(p)>1 || duplicate) quarantines.push({ ...t, kind:'quarantine',
        quarantine_kind:groups.get(p)>1 ? 'competing_claim' : 'duplicate_claim' });
      else { claims.push({ ...t, kind:'pending_claim', object_external_id:p }); claimed.add(p); }
    } else if (t.kind === 'upsert') upserts.push(t);
  }
  for (const ext of sorted) {
    const t=final.get(ext);
    if (t.kind === 'removed' && !claimed.has(ext)) removals.push(t);
  }
  return [...claims,...upserts,...removals,...quarantines];
}
export default reducePages;
