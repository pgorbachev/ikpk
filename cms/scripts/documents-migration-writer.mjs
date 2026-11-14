// Offline candidate migration only. No CLI or production database selection is provided.
import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value);
const plain = row => row == null ? row : Object.fromEntries(Object.entries(row));
const documentFields = ['document','issuer','prior_education','prior_education_note','outcome','basis','issuer_unknown','completion_scope','other_seminar_href','other_seminar_label','signed_by','qualification_topic','hours_mode','includes_completed_level','completion_required','completion_after_seminar_number','completion_cycle_name','hours_may_vary','regulation_url','document_type_unspecified','regulation_issuer','document_on_template'];
const registryFields = ['name','international','subject','url','basis'];
const nmoFields = ['status','audience','awarded_for','url','completion_required','purpose'];
const enums = {prior_education:['unspecified','none','medical','physical-or-pedagogical','other'], outcome:['completed','assessment-failed','partially-completed','expelled','assessment-not-completed'], completion_scope:['unspecified','this-seminar','full-cycle','other-seminar','course'], signed_by:['unspecified','teacher'], hours_mode:['unspecified','actual-completed'], subject:['training','document'], status:['unspecified','possible','awarded']};
const bools = new Set(['issuer_unknown','includes_completed_level','completion_required','hours_may_vary','document_type_unspecified','document_on_template','international']);
const types = {documents: ['seminar.document-record','components_seminar_document_records'], training_registries: ['seminar.registry-fact','components_seminar_registry_facts'], nmo: ['seminar.nmo-fact','components_seminar_nmo_facts']};
function fail(message) { throw new Error(message); }
function cleanRecord(record, fields, nested = false) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('Invalid component');
  for (const key of Object.keys(record)) if (!fields.includes(key) && !(nested && key === 'registry')) fail(`Unknown component field: ${key}`);
  const out = {};
  for (const key of fields) if (Object.hasOwn(record,key)) {
    const v = record[key];
    if (v !== null && (bools.has(key) ? typeof v !== 'boolean' : key === 'completion_after_seminar_number' ? !Number.isInteger(v) || v < 1 : typeof v !== 'string')) fail(`Invalid field ${key}`);
    if (v !== null && enums[key] && !enums[key].includes(v)) fail(`Invalid value for ${key}`);
    out[key] = bools.has(key) && v !== null ? Number(v) : v;
  }
  const defaults = fields === documentFields ? {prior_education:'unspecified',issuer_unknown:0,includes_completed_level:0,completion_required:0,hours_may_vary:0,document_type_unspecified:0,document_on_template:0} : fields === registryFields ? {international:0} : {completion_required:0};
  for (const [key,value] of Object.entries(defaults)) if (!Object.hasOwn(out,key)) out[key]=value;
  return out;
}
function validate(item) {
  if (!item || item.approved !== true || item.eligibleForAutomaticWrite !== true || item.readyForReviewOnly !== false) fail('Proposal is not explicitly approved for writing');
  if (typeof item.documentId !== 'string' || !item.documentId || typeof item.route !== 'string' || !/^\/(?!\/)[^?#\s]*$/.test(item.route)) fail('Invalid identity');
  if (typeof item.sourceHtml !== 'string' || sha(item.sourceHtml) !== item.sourceSha256 || !/^[a-f0-9]{64}$/.test(item.snapshotSha256 || '') || !Array.isArray(item.sourceLinks) || item.sourceLinks.some(x => typeof x !== 'string') || typeof item.rulesVersion !== 'string' || !item.rulesVersion) fail('Invalid source provenance');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.migrationDate || '') || typeof item.migrationAuthor !== 'string' || !item.migrationAuthor.trim()) fail('Missing migration date or author');
  const p = item.proposal;
  if (!p || !['issued','not-issued','unconfirmed'].includes(p.documents_state) || !Array.isArray(p.documents) || !Array.isArray(p.training_registries) || !(p.nmo === null || (p.nmo && typeof p.nmo === 'object'))) fail('Invalid proposal');
  if (Object.keys(p).some(k => !['documents_state','documents','training_registries','nmo'].includes(k))) fail('Unknown proposal field');
  for (const doc of p.documents) { const d=cleanRecord(doc,documentFields,true); if (typeof d.document !== 'string' || !d.document.trim()) fail('Missing document'); if (doc.registry !== undefined && !Array.isArray(doc.registry)) fail('Invalid registry'); for (const r of doc.registry || []) cleanRecord(r,registryFields); }
  for (const r of p.training_registries) cleanRecord(r,registryFields);
  if (p.nmo) cleanRecord(p.nmo,nmoFields);
}
function check(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') fail('SQLite integrity check failed');
  if (db.prepare('PRAGMA foreign_key_check').all().length) fail('SQLite foreign key check failed');
}
function graph(db,id) {
  const result={};
  for (const [field,[type,table]] of Object.entries(types)) {
    const links=db.prepare('SELECT * FROM seminars_cmps WHERE entity_id=? AND field=? ORDER BY "order", id').all(id,field).map(plain);
    result[field]=links.map(link => {
      if (link.component_type !== type) fail('Unexpected component type');
      const row=plain(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(link.cmp_id));
      if (!row) fail('Missing component');
      const nested=field === 'documents' ? db.prepare('SELECT * FROM components_seminar_document_records_cmps WHERE entity_id=? ORDER BY "order", id').all(link.cmp_id).map(plain).map(l => {
        if (l.component_type !== 'seminar.registry-fact' || l.field !== 'registry') fail('Unexpected nested component');
        const value=plain(db.prepare('SELECT * FROM components_seminar_registry_facts WHERE id=?').get(l.cmp_id)); if (!value) fail('Missing nested component'); return {link:l,row:value};
      }) : [];
      return {link,row,nested};
    });
  }
  return result;
}
function capture(db,id) {
  const row=plain(db.prepare('SELECT * FROM seminars WHERE id=?').get(id));
  if (!row) fail('Missing seminar');
  const routes=db.prepare(`SELECT DISTINCT i.slug AS institute, c.slug AS course FROM seminars_course_group_lnk sc
    JOIN course_groups c ON c.id=sc.course_group_id JOIN course_groups_institute_lnk ci ON ci.course_group_id=c.id
    JOIN institutes i ON i.id=ci.institute_id WHERE sc.seminar_id=?`).all(id);
  if (routes.length !== 1 || !routes[0].institute || !routes[0].course || !row.slug) fail('Seminar route is not unique');
  return {row,route:`/${routes[0].institute}/${routes[0].course}/${row.slug}`,graph:graph(db,id)};
}
function versions(db,documentId) { return db.prepare('SELECT id FROM seminars WHERE document_id=? ORDER BY id').all(documentId).map(x=>capture(db,x.id)); }
export function inspectVersions(db, documentId) { check(db); const found=versions(db,documentId); if (!found.length) fail('No physical version'); return found; }
function same(a,b) { return json(a) === json(b); }
function assertEmpty(v) {
  if (![null, undefined, 'unconfirmed'].includes(v.row.documents_state)) fail('Existing documents state requires review');
  if (v.row.documents_confirmation_date || v.row.documents_confirmation_source || v.row.documents_confirmation_author || v.row.documents_owner_verified) fail('Existing provenance requires review');
  if (Object.values(v.graph).some(a=>a.length)) fail('Existing structured components require review');
}
function transaction(db,fn) { db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; } catch(e) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original transaction error. */ } throw e; } }
function seal(payload) { return {payload, digest:sha(json(payload))}; }
function unseal(value) { if (!value || !value.payload || value.digest !== sha(json(value.payload))) fail('Modified plan or receipt'); return value.payload; }
export function capturePlan(db, proposals) {
  if (!Array.isArray(proposals) || !proposals.length) fail('Empty plan');
  check(db); const ids=new Set(), routes=new Set();
  const entries=proposals.map(item=>{ validate(item); if (ids.has(item.documentId) || routes.has(item.route)) fail('Duplicate identity'); ids.add(item.documentId); routes.add(item.route); const preimage=versions(db,item.documentId); if (!preimage.length) fail('No physical version'); if (preimage.some(v => v.route !== item.route || `/${String(v.row.legacy_id || '').replace(/^\/+/, '')}` !== item.route)) fail('Source route does not match seminar identity'); if (!same(item.reviewedPreimages,preimage)) fail('Each physical version requires a separately reviewed preimage'); return {item:structuredClone(item),preimage}; });
  return seal({version:1,entries});
}
function insert(db,table,record) {
  const keys=Object.keys(record); const sql=keys.length ? `INSERT INTO ${table} (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map(()=>'?').join(',')})` : `INSERT INTO ${table} DEFAULT VALUES`;
  return Number(db.prepare(sql).run(...keys.map(k=>record[k])).lastInsertRowid);
}
function link(db,table,entity,cmp,type,field,order) { insert(db,table,{entity_id:entity,cmp_id:cmp,component_type:type,field,order}); }
function writeGraph(db,id,item) {
  const p=item.proposal;
  const provenance=`Перенесено из опубликованной панели ${item.route}; снимок sha256:${item.snapshotSha256}; панель sha256:${item.sourceSha256}`;
  db.prepare('UPDATE seminars SET documents_state=?, documents_confirmation_date=?, documents_confirmation_source=?, documents_confirmation_author=? WHERE id=?').run(p.documents_state,item.migrationDate,provenance,item.migrationAuthor,id);
  p.documents.forEach((d,i)=>{ const cmp=insert(db,types.documents[1],cleanRecord(d,documentFields,true)); link(db,'seminars_cmps',id,cmp,types.documents[0],'documents',i+1); (d.registry||[]).forEach((r,j)=>{const rid=insert(db,types.training_registries[1],cleanRecord(r,registryFields)); link(db,'components_seminar_document_records_cmps',cmp,rid,types.training_registries[0],'registry',j+1);}); });
  p.training_registries.forEach((r,i)=>{const cmp=insert(db,types.training_registries[1],cleanRecord(r,registryFields)); link(db,'seminars_cmps',id,cmp,types.training_registries[0],'training_registries',i+1);});
  if (p.nmo) {const cmp=insert(db,types.nmo[1],cleanRecord(p.nmo,nmoFields)); link(db,'seminars_cmps',id,cmp,types.nmo[0],'nmo',1);}
}
function verifyReadback(v,p) {
  if (v.row.documents_state !== p.documents_state) fail('State readback mismatch');
  const verify=(records,expected,fields)=>{ if (records.length !== expected.length) fail('Component count mismatch'); expected.forEach((obj,i)=>{ const expectedRow=cleanRecord(obj,fields,fields===documentFields); for (const [key,value] of Object.entries(expectedRow)) if (records[i].row[key] !== value) fail(`Readback mismatch: ${key}`); }); };
  verify(v.graph.documents,p.documents,documentFields); verify(v.graph.training_registries,p.training_registries,registryFields); verify(v.graph.nmo,p.nmo?[p.nmo]:[],nmoFields);
  p.documents.forEach((d,i)=>verify(v.graph.documents[i].nested,d.registry||[],registryFields));
}
function verifyPre(db,entries) { for (const {item,preimage} of entries) {validate(item); if (!same(item.reviewedPreimages,preimage)) fail('Unreviewed physical version'); const now=versions(db,item.documentId); if (!same(now,preimage)) fail('Preimage changed'); preimage.forEach(assertEmpty); } }
export function applyPlan(db,plan,{ expectedPlanDigest, onApplied } = {}) {
  if (!expectedPlanDigest || plan?.digest !== expectedPlanDigest) fail('Reviewed plan digest mismatch');
  const payload=unseal(plan); if (payload.version !== 1 || !Array.isArray(payload.entries) || !payload.entries.length) fail('Invalid plan'); check(db); verifyPre(db,payload.entries);
  return transaction(db,()=>{ check(db); verifyPre(db,payload.entries);
    db.exec('CREATE TABLE IF NOT EXISTS ikpk_documents_migration_ledger (plan_digest TEXT PRIMARY KEY, receipt_json TEXT NOT NULL, status TEXT NOT NULL)');
    if (db.prepare('SELECT 1 FROM ikpk_documents_migration_ledger WHERE plan_digest=?').get(plan.digest)) fail('Plan already applied');
    const entries=payload.entries.map(({item,preimage})=>{ for (const v of preimage) writeGraph(db,v.row.id,item); const postimage=versions(db,item.documentId); postimage.forEach(v=>verifyReadback(v,item.proposal)); return {item,preimage,postimage}; });
    check(db); const receipt=seal({version:1,planDigest:plan.digest,entries}); db.prepare('INSERT INTO ikpk_documents_migration_ledger VALUES (?, ?, ?)').run(plan.digest,json(receipt),'applied'); const callbackResult=onApplied?.(db,receipt); if (callbackResult && typeof callbackResult.then === 'function') fail('onApplied must be synchronous'); return receipt;
  });
}
function assertExclusive(db,v) {
  for (const [field,records] of Object.entries(v.graph)) for (const rec of records) {
    const refs=db.prepare('SELECT * FROM seminars_cmps WHERE component_type=? AND cmp_id=?').all(types[field][0],rec.row.id);
    if (refs.length !== 1 || refs[0].id !== rec.link.id) fail('Component is shared');
    if (field === 'training_registries') { const n=db.prepare('SELECT count(*) AS n FROM components_seminar_document_records_cmps WHERE component_type=? AND cmp_id=?').get(types[field][0],rec.row.id); if (n.n) fail('Registry is shared'); }
    for (const nested of rec.nested) {
      const direct=db.prepare('SELECT count(*) AS n FROM seminars_cmps WHERE component_type=? AND cmp_id=?').get('seminar.registry-fact',nested.row.id);
      const refs2=db.prepare('SELECT * FROM components_seminar_document_records_cmps WHERE component_type=? AND cmp_id=?').all('seminar.registry-fact',nested.row.id);
      if (direct.n || refs2.length !== 1 || refs2[0].id !== nested.link.id) fail('Registry is shared');
    }
  }
}
function removeGraph(db,v) { for (const [field,records] of Object.entries(v.graph)) for (const rec of records) { for (const n of rec.nested) {db.prepare('DELETE FROM components_seminar_document_records_cmps WHERE id=?').run(n.link.id); db.prepare('DELETE FROM components_seminar_registry_facts WHERE id=?').run(n.row.id);} db.prepare('DELETE FROM seminars_cmps WHERE id=?').run(rec.link.id); db.prepare(`DELETE FROM ${types[field][1]} WHERE id=?`).run(rec.row.id); } }
export function rollbackPlan(db,receipt) {
  const p=unseal(receipt); check(db);
  const verify=()=>{ const ledger=db.prepare('SELECT receipt_json,status FROM ikpk_documents_migration_ledger WHERE plan_digest=?').get(p.planDigest); if (!ledger || ledger.status !== 'applied' || ledger.receipt_json !== json(receipt)) fail('Receipt not in ledger'); for (const e of p.entries) if (!same(versions(db,e.item.documentId),e.postimage)) fail('Postimage changed'); else e.postimage.forEach(v=>assertExclusive(db,v)); };
  verify(); return transaction(db,()=>{check(db);verify(); for (const e of p.entries) for (let i=0;i<e.postimage.length;i++) {const post=e.postimage[i], pre=e.preimage[i]; removeGraph(db,post); db.prepare('UPDATE seminars SET documents_state=?, documents_confirmation_date=?, documents_confirmation_source=?, documents_confirmation_author=? WHERE id=?').run(pre.row.documents_state,pre.row.documents_confirmation_date,pre.row.documents_confirmation_source,pre.row.documents_confirmation_author,pre.row.id); if (!same(capture(db,pre.row.id),pre)) fail('Rollback readback mismatch');} db.prepare('UPDATE ikpk_documents_migration_ledger SET status=? WHERE plan_digest=?').run('rolled_back',p.planDigest); check(db); });
}
