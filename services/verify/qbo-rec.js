import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

export class ParseError extends Error {
  constructor(message) { super(message); this.name = 'ParseError'; }
}
const fail = message => { throw new ParseError(message); };
const moneyPattern = /(-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*$/;
const cents = value => BigInt(value.replace(/[,.]/g, ''));
const decimal = value => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value)/100n}.${String((value < 0n ? -value : value)%100n).padStart(2,'0')}`;
const money = text => text.match(moneyPattern)?.[1].replaceAll(',','') ?? fail(`missing or invalid amount: ${text.trim()}`);
export function isoDate(value) {
  let result;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) result = `${value.slice(6)}-${value.slice(0,2)}-${value.slice(3,5)}`;
  else result = value;
  const d = new Date(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0,10)!==result) fail(`invalid date: ${value}`);
  return result;
}
export const nextDate = value => new Date(new Date(`${isoDate(value)}T00:00:00Z`).getTime()+86400000).toISOString().slice(0,10);
export async function extractText(pdfPath, env = process.env) {
  if (env.LL_QBO_TEXT_FILE) return readFile(env.LL_QBO_TEXT_FILE, 'utf8'); // Explicit offline CLI fixture hook.
  const binary = env.PDFTOTEXT_BIN || 'pdftotext';
  try { return (await promisify(execFile)(binary, ['-layout', pdfPath, '-'], {maxBuffer:32*1024*1024})).stdout; }
  catch(error) {
    const e = new Error(error.code==='ENOENT' ? 'pdftotext binary missing; install poppler-utils or set PDFTOTEXT_BIN' : 'pdftotext could not extract the PDF');
    e.diagnostic=e.message; throw e;
  }
}
const headings = new Map([
  ['Checks and payments cleared','payments'],['Deposits and other credits cleared','deposits'],
  ['Charges and cash advances cleared','payments'],['Payments and credits cleared','deposits'],
]);
export function parseQboReconciliation(text) {
  if(typeof text!=='string') fail('report text must be a string');
  const rows=text.replaceAll('\r','').split('\n');
  const headerIndex=rows.findIndex(r=>/,\s*Period Ending\s+\d{2}\/\d{2}\/\d{4}\s*$/.test(r));
  if(headerIndex<1) fail('missing company/account/period header');
  const account=rows[headerIndex].trim().match(/^(.*),\s*Period Ending\s+(\S+)$/);
  const value = label => rows.find(r=>r.trim().startsWith(label))?.trim().slice(label.length).trim() ?? fail(`missing ${label}`);
  const result={company:rows.slice(0,headerIndex).filter(r=>r.trim()).at(-1).trim(),accountName:account[1],periodEnd:isoDate(account[2]),
    reconciledOn:isoDate(value('Reconciled on:')),reconciledBy:value('Reconciled by:'),
    opening:money(value('Statement beginning balance')),closing:money(value('Statement ending balance')),
    cleared:{payments:{count:0,total:'0.00',lines:[]},deposits:{count:0,total:'0.00',lines:[]}},adjustments:[],sectionsSeen:[]};
  let details=false, additional=false, active=null, columns=null;
  const summary=new Map(), detailCounts=new Map(), totals=new Map(), raw=new Map([['payments',[]],['deposits',[]]]);
  for(let index=headerIndex+1; index<rows.length; index++) {
    const row=rows[index], trimmed=row.trim();
    if(!trimmed) continue;
    if(/^Additional Information$/i.test(trimmed)) { additional=true; active=null; }
    if(additional) continue;
    if(/^Details$/i.test(trimmed)) {details=true; continue;}
    const heading=trimmed.match(/^(.*?)\s+cleared\s*\((\d+)\)(.*)$/i);
    if(heading) {
      const name=`${heading[1]} cleared`, group=headings.get(name);
      if(!group) fail(`unknown cleared heading: ${name}`);
      const count=Number(heading[2]);
      if(heading[3].trim()) {
        const total=money(heading[3]);
        if(summary.has(group)) fail(`duplicate summary: ${name}`);
        summary.set(group,{count,total});
      } else {
        if(!details) fail(`detail heading before Details: ${name}`);
        if(detailCounts.has(group) && active!==group) fail(`duplicate detail section: ${name}`);
        detailCounts.set(group,count); active=group;
      }
      continue;
    }
    const col=row.match(/DATE\s+TYPE\s+REF NO\.\s+PAYEE\s+AMOUNT(?:\s*\([^)]+\))?/);
    if(col && details) {
      columns=['DATE','TYPE','REF NO.','PAYEE','AMOUNT'].map(name=>row.indexOf(name));
      const names=['DATE','TYPE','REF NO.','PAYEE',row.slice(columns[4]).trim()];
      for(const name of names) if(!result.sectionsSeen.includes(name)) result.sectionsSeen.push(name);
      continue;
    }
    if(/adjustment/i.test(trimmed)) {
      const adjustment={description:trimmed,amount:row.match(moneyPattern)?money(row):'0.00'};
      result.adjustments.push(adjustment);
      if(active && /^\s*\d{2}\/\d{2}\/\d{4}\b/.test(row)) raw.get(active).push(adjustment);
      continue;
    }
    if(/^Total\s/.test(trimmed) && active) {totals.set(active,money(row)); active=null; continue;}
    if(/^\d{2}\/\d{2}\/\d{4}\b/.test(trimmed)) {
      if(!active || !columns) fail(`line ${index+1}: transaction outside a cleared table`);
      const amount=money(row), amountStart=row.search(moneyPattern);
      const content=row.slice(0,amountStart).padEnd(columns[4]);
      const fields=columns.slice(0,4).map((start,i)=>content.slice(start,columns[i+1]).trim());
      const item={qbo_txn_date:isoDate(fields[0]),type:fields[1],reference:fields[2],payee:fields[3],amount};
      if(!item.type) fail(`line ${index+1}: missing transaction type`);
      result.cleared[active].lines.push(item); raw.get(active).push(item); continue;
    }
    if(active && !/RECONCILIATION REPORT|Period Ending|Reconciled (on|by):|^\d+\s*\/\s*\d+$/.test(trimmed)) fail(`line ${index+1}: unrecognized cleared detail row: ${trimmed}`);
  }
  for(const group of ['payments','deposits']) {
    const s=summary.get(group); if(!s) fail(`missing ${group} summary`);
    const lines=raw.get(group), total=decimal(lines.reduce((n,l)=>n+cents(l.amount),0n));
    if(s.count!==lines.length) fail(`${group} summary count ${s.count} disagrees with ${lines.length} parsed lines`);
    if(s.total!==total) fail(`${group} summary total ${s.total} disagrees with ${total}`);
    if(detailCounts.has(group) && detailCounts.get(group)!==lines.length) fail(`${group} detail count disagrees`);
    if(lines.length && !totals.has(group)) fail(`missing ${group} detail Total`);
    if(totals.has(group) && totals.get(group)!==total) fail(`${group} detail Total disagrees`);
    result.cleared[group].count=s.count; result.cleared[group].total=s.total;
  }
  return result;
}
export function toStatementInput(parsed, {periodStart, balanceOrientation} = {}) {
  const start=isoDate(periodStart || `${parsed.periodEnd.slice(0,7)}-01`), end=nextDate(parsed.periodEnd);
  if(start>=end) fail('period start must precede period end');
  const period=`[${start},${end})`;
  // QBO card amounts have the liability balance sign. Invert the signed
  // amount, preserving refunds/reversals as well as charges and payments.
  const lines=[...parsed.cleared.payments.lines,...parsed.cleared.deposits.lines].map(l=>({
    qbo_txn_date:l.qbo_txn_date,
    amount:balanceOrientation==='liability' ? decimal(-cents(l.amount)) : l.amount,
    description:l.payee||l.type,reference:l.reference,cleared_period:period}));
  const credits=lines.reduce((n,l)=>n+(cents(l.amount)>0n?cents(l.amount):0n),0n);
  const debits=lines.reduce((n,l)=>n+(cents(l.amount)<0n?-cents(l.amount):0n),0n);
  return {header:{source:'qbo_reconciliation',opening_balance:parsed.opening,closing_balance:parsed.closing,line_count:lines.length,
    credits_total:decimal(credits),debits_total:decimal(debits),columns_seen:parsed.sectionsSeen},lines};
}
