export function validateChain(pages, attempt) {
  const fail = reason => ({ok:false,reason});
  if (!pages.length) return fail('empty chain');
  for (let i=0;i<pages.length;i++) {
    const p=pages[i];
    if (p.page_no !== i+1) return fail('non-consecutive page');
    if (p.attempt_id !== attempt.id || p.connection_id !== attempt.connection_id || p.org_id !== attempt.org_id) return fail('page ownership mismatch');
    if ((p.cursor_in ?? null) !== (i ? pages[i-1].cursor_out : attempt.cursor_in ?? null)) return fail(i ? 'cursor link mismatch' : 'first cursor mismatch');
    if (p.has_more !== (i < pages.length-1)) return fail('has_more mismatch');
    if (i===pages.length-1 && (typeof p.cursor_out !== 'string' || !p.cursor_out.trim())) return fail('empty cursor');
  }
  return {ok:true,reason:null};
}
export default validateChain;
