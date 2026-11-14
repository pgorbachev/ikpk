// Apply only an externally reviewed plan produced by the render rehearsal.
// The caller is responsible for admission, private storage, and independent audit.
import { createHash } from 'node:crypto';
import { inspectVersions } from './documents-migration-writer.mjs';

const LEDGER = 'ikpk_content_migration_ledger';
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = ['description','full_text','audience','learning_plan','learning_mode','recommendations','content_format','content_section_anchors'];
const SECTIONS = new Set(['audience','learning_plan','learning_mode','documents','recommendations']);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = JSON.stringify;
function fail(message) { throw new Error(`reviewed content migration: ${message}`); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function same(a,b) { return json(canonical(a)) === json(canonical(b)); }
function check(db) {
  const integrity=db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('SQLite integrity check failed');
}
function route(db,row) {
  const paths=db.prepare(`SELECT DISTINCT i.slug AS institute,c.slug AS course FROM seminars_course_group_lnk sc
    JOIN course_groups c ON c.id=sc.course_group_id JOIN course_groups_institute_lnk ci ON ci.course_group_id=c.id
    JOIN institutes i ON i.id=ci.institute_id WHERE sc.seminar_id=?`).all(row.id);
  if(paths.length!==1 || !paths[0].institute || !paths[0].course || !row.slug) fail('invalid seminar route');
  return `/${paths[0].institute}/${paths[0].course}/${row.slug}`;
}
function assertRowRoute(db,row) {
  if(!row || route(db,row)!==`/${String(row.legacy_id??'').replace(/^\/+/, '')}`) fail('seminar route changed');
}
function assertDocumentGraphs(db, documentIds, planDigest, receiptDigest) {
  if(!Array.isArray(documentIds) || new Set(documentIds).size!==documentIds.length) fail('invalid document inventory');
  if(!documentIds.length) return;
  const ledger=db.prepare('SELECT receipt_json,status FROM ikpk_documents_migration_ledger WHERE plan_digest=?').get(planDigest);
  if(!ledger || ledger.status!=='applied') fail('document receipt no longer applied');
  let receipt;try{receipt=JSON.parse(ledger.receipt_json);}catch{fail('invalid document receipt');}
  if(receipt.digest!==receiptDigest || receipt.payload?.planDigest!==planDigest || sha(json(receipt.payload))!==receiptDigest) fail('document receipt changed');
  for(const id of documentIds) {
    const proofs=receipt.payload.entries.filter(entry=>entry.item?.documentId===id),actual=inspectVersions(db,id);
    if(proofs.length!==1 || actual.length!==proofs[0].postimage.length || actual.some((version,index)=>version.row.id!==proofs[0].postimage[index].row.id || version.route!==proofs[0].postimage[index].route || !same(version.graph,proofs[0].postimage[index].graph))) fail('document graph changed');
    for(const version of actual) for(const [field,records] of Object.entries(version.graph)) for(const record of records) {
      const type=record.link.component_type;
      const root=db.prepare('SELECT count(*) AS n FROM seminars_cmps WHERE component_type=? AND cmp_id=?').get(type,record.row.id).n;
      if(root!==1) fail('document graph is shared');
      if(field==='training_registries' && db.prepare('SELECT count(*) AS n FROM components_seminar_document_records_cmps WHERE component_type=? AND cmp_id=?').get(type,record.row.id).n) fail('document registry is shared');
      for(const nested of record.nested) {
        const nestedRoot=db.prepare('SELECT count(*) AS n FROM seminars_cmps WHERE component_type=? AND cmp_id=?').get('seminar.registry-fact',nested.row.id).n;
        const nestedCount=db.prepare('SELECT count(*) AS n FROM components_seminar_document_records_cmps WHERE component_type=? AND cmp_id=?').get('seminar.registry-fact',nested.row.id).n;
        if(nestedRoot || nestedCount!==1) fail('document registry is shared');
      }
    }
  }
}
function verifyEvidence(item, rendererSha) {
  const evidence=item.reviewEvidence, report=evidence?.entry, src=item.source;
  if(!src || !report || evidence.rendererSha256!==rendererSha || !Array.isArray(evidence.errors) || evidence.errors.length || evidence.path!==item.path || report.path!==item.path || report.document_id!==item.document_id) fail('render evidence identity mismatch');
  if(src.id!==item.id || src.document_id!==item.document_id || src.path!==item.path || src.version!==item.version || sha(json(src))!==report.source_sha256 && item.version==='published') fail('source evidence mismatch');
  if(report.version!=='published' || !Array.isArray(report.sections) || !report.fields || !report.ids || !report.aliases) fail('malformed render evidence');
  const hasSeparate=['learning_plan','learning_mode','recommendations'].some(key=>String(src[key]??'').trim());
  if(item.separate!==hasSeparate || (item.separate && (report.sections.length || src.full_text || src.recommendations))) fail('unsupported separate content');
  const anchors={}, ids=new Set();
  for(const key of report.sections) {
    if(!SECTIONS.has(key) || Object.hasOwn(anchors,key) || !Array.isArray(report.aliases[key]) || typeof report.ids[key]!=='string') fail('invalid reviewed section');
    const values=[...report.aliases[key],report.ids[key]];
    for(const value of values) { if(typeof value!=='string' || !/^[A-Za-z0-9_.:-]+$/.test(value) || ids.has(value)) fail('invalid or duplicate anchor'); ids.add(value); }
    anchors[key]=values;
  }
  let actualAnchors;try{actualAnchors=JSON.parse(item.post.content_section_anchors);}catch{fail('invalid anchor postimage');}
  if(item.post.content_format!=='structured' || !same(actualAnchors,anchors)) fail('anchor postimage differs from rendered target');
  const expected={content_format:'structured',content_section_anchors:item.post.content_section_anchors};
  if(!item.separate) Object.assign(expected,{description:report.fields.description,full_text:null,audience:report.fields.audience??null,learning_plan:report.fields.learning_plan??null,learning_mode:report.fields.learning_mode??null,recommendations:report.fields.recommendations??null});
  if(!same(item.post,expected) || Object.keys(item.post).some(key=>!FIELDS.includes(key))) fail('content postimage differs from rendered target');
  if(!report.sections.includes('documents') && evidence.documentProposal != null) fail('unexpected document proposal');
  return report.sections.includes('documents');
}

/** Seal a plan produced by the read-only Python planner. Review the resulting
 * digest independently; this helper does not itself authorize its contents. */
export function sealContentPlan(payload) {
  if(!payload || payload.version!==1 || !Array.isArray(payload.entries) || !payload.entries.length) fail('invalid payload');
  return {payload,digest:sha(json(payload))};
}
function verify(db,plan) {
  const payload=plan?.payload;
  if(!payload || payload.version!==1 || !Array.isArray(payload.entries) || !payload.entries.length || !HASH.test(payload.rendererSha256??'') || sha(json(payload))!==plan.digest) fail('modified or invalid plan');
  const ids=new Set(), groups=new Map(), documents=new Map();
  let documentReceipt;
  for(const item of payload.entries) {
    if(!item || !Number.isSafeInteger(item.id) || ids.has(item.id) || !['draft','published'].includes(item.version) || typeof item.document_id!=='string' || !item.document_id || typeof item.path!=='string' || !item.preimage || !item.post || typeof item.separate!=='boolean') fail('invalid or duplicate version');
    ids.add(item.id);
    const current=db.prepare('SELECT * FROM seminars WHERE id=?').get(item.id);
    if(!current || !same(current,item.preimage) || current.document_id!==item.document_id || (current.published_at?'published':'draft')!==item.version || route(db,current)!==item.path || `/${String(current.legacy_id??'').replace(/^\/+/, '')}`!==item.path) fail('source version or route changed');
    if(![null,'legacy'].includes(current.content_format??null) || current.audience || current.content_section_anchors) fail('structured content already exists');
    for(const key of ['id','document_id','locale','description','full_text','learning_plan','learning_mode','recommendations']) if(!same(item.source?.[key],current[key])) fail(`source ${key} mismatch`);
    const hasDocuments=verifyEvidence(item,payload.rendererSha256);
    const group=groups.get(item.document_id)??[];group.push(item);groups.set(item.document_id,group);
    if(hasDocuments) {
      if(!HASH.test(payload.documentsReceiptDigest??'') || !HASH.test(payload.documentsPlanDigest??'')) fail('missing external document proof');
      if(!documentReceipt) {
        const ledger=db.prepare('SELECT receipt_json,status FROM ikpk_documents_migration_ledger WHERE plan_digest=?').get(payload.documentsPlanDigest);
        if(!ledger || ledger.status!=='applied') fail('document ledger not applied');
        try{documentReceipt=JSON.parse(ledger.receipt_json);}catch{fail('invalid document receipt');}
        if(documentReceipt.digest!==payload.documentsReceiptDigest || documentReceipt.payload?.planDigest!==payload.documentsPlanDigest || sha(json(documentReceipt.payload))!==payload.documentsReceiptDigest) fail('document receipt digest mismatch');
      }
      if(!documents.has(item.document_id)) {
        const matches=documentReceipt.payload.entries.filter(entry=>entry.item?.documentId===item.document_id);
        if(matches.length!==1 || matches[0].item.approved!==true || matches[0].item.eligibleForAutomaticWrite!==true || matches[0].item.readyForReviewOnly!==false || matches[0].item.route!==item.path || !same(matches[0].item.proposal,item.reviewEvidence.documentProposal) || !same(inspectVersions(db,item.document_id),matches[0].postimage)) fail('document proposal or graph changed');
        documents.set(item.document_id,matches[0]);
      } else if(!same(documents.get(item.document_id).item.proposal,item.reviewEvidence.documentProposal)) fail('document proposal mismatch');
    }
  }
  for(const [id,items] of groups) {
    if(items.length!==2 || new Set(items.map(item=>item.version)).size!==2 || !same(items[0].reviewEvidence,items[1].reviewEvidence) || items[0].path!==items[1].path || items[0].separate!==items[1].separate || !same(items[0].source.locale,items[1].source.locale)) fail(`incomplete or divergent physical versions: ${id}`);
    const allVersions=db.prepare('SELECT id FROM seminars WHERE document_id=? ORDER BY id').all(id).map(row=>row.id);
    if(!same(allVersions,items.map(item=>item.id).sort((a,b)=>a-b))) fail(`physical version inventory changed: ${id}`);
    const pub=items.find(item=>item.version==='published');
    if(pub.reviewEvidence.id!==pub.id || pub.reviewEvidence.entry.id!==pub.id) fail('renderer did not review the published version');
    for(const key of ['description','full_text','learning_plan','learning_mode','recommendations']) if(!same(items[0].source[key],items[1].source[key])) fail('draft and published content differs');
  }
  return payload;
}

/** All content rows, local ledger and synchronous runner callback commit together. */
export function applyContentPlan(db,plan,{expectedPlanDigest,onApplied}={}) {
  if(!HASH.test(expectedPlanDigest??'') || expectedPlanDigest!==plan?.digest) fail('externally reviewed plan digest mismatch');
  check(db);verify(db,plan);
  return db.transaction(()=>{
    check(db);const payload=verify(db,plan);
    db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER} (plan_digest TEXT PRIMARY KEY, receipt_json TEXT NOT NULL, status TEXT NOT NULL)`);
    if(db.prepare(`SELECT 1 FROM ${LEDGER} WHERE plan_digest=?`).get(plan.digest)) fail('plan already applied');
    const entries=[];
    for(const item of payload.entries) {
      const keys=Object.keys(item.post),stmt=db.prepare(`UPDATE seminars SET ${keys.map(key=>`"${key}"=?`).join(',')} WHERE id=?`);
      stmt.run(...keys.map(key=>item.post[key]),item.id);
      const after={...db.prepare('SELECT * FROM seminars WHERE id=?').get(item.id)},expected={...item.preimage,...item.post};
      if(!same(after,expected)) fail('content postimage mismatch');
      entries.push({id:item.id,preimage:item.preimage,postimage:after});
    }
    check(db);const documentIds=[...new Set(payload.entries.filter(item=>item.reviewEvidence.entry.sections.includes('documents')).map(item=>item.document_id))];
    const receipt={payload:{version:1,planDigest:plan.digest,entries,documentIds,documentsReceiptDigest:payload.documentsReceiptDigest,documentsPlanDigest:payload.documentsPlanDigest},digest:null};receipt.digest=sha(json(receipt.payload));
    const expectedReceiptJson=json(receipt), expectedReceipt=JSON.parse(expectedReceiptJson);
    db.prepare(`INSERT INTO ${LEDGER} VALUES (?,?,?)`).run(expectedPlanDigest,expectedReceiptJson,'applied');
    const result=onApplied?.(db,receipt);if(result&&typeof result.then==='function') fail('onApplied must be synchronous');
    if(json(receipt)!==expectedReceiptJson || plan.digest!==expectedPlanDigest || sha(json(plan.payload))!==expectedPlanDigest) fail('final receipt or plan changed');
    for(const entry of expectedReceipt.payload.entries) {
      const row=db.prepare('SELECT * FROM seminars WHERE id=?').get(entry.id);
      if(!same(row,entry.postimage)) fail('final content postimage changed');
      assertRowRoute(db,row);
    }
    const groups=new Map();for(const entry of expectedReceipt.payload.entries){const id=entry.preimage.document_id;const ids=groups.get(id)??[];ids.push(entry.id);groups.set(id,ids);}
    for(const [id,ids] of groups) if(!same(db.prepare('SELECT id FROM seminars WHERE document_id=? ORDER BY id').all(id).map(row=>row.id),ids.sort((a,b)=>a-b))) fail('final physical version inventory changed');
    assertDocumentGraphs(db,expectedReceipt.payload.documentIds,expectedReceipt.payload.documentsPlanDigest,expectedReceipt.payload.documentsReceiptDigest);
    const recorded=db.prepare(`SELECT receipt_json,status FROM ${LEDGER} WHERE plan_digest=?`).get(expectedPlanDigest);
    if(!recorded || recorded.status!=='applied' || recorded.receipt_json!==expectedReceiptJson) fail('final receipt changed');
    check(db);
    return receipt;
  }).immediate();
}

/** Rollback is refused if any edited row or receipt has changed since apply. */
export function rollbackContentPlan(db,receipt) {
  if(!receipt?.payload || sha(json(receipt.payload))!==receipt.digest || receipt.payload.version!==1 || !Array.isArray(receipt.payload.entries)) fail('invalid receipt');
  const expectedReceiptJson=json(receipt), expectedReceipt=JSON.parse(expectedReceiptJson);
  return db.transaction(()=>{
    check(db);const ledger=db.prepare(`SELECT receipt_json,status FROM ${LEDGER} WHERE plan_digest=?`).get(expectedReceipt.payload.planDigest);
    if(!ledger || ledger.status!=='applied' || ledger.receipt_json!==expectedReceiptJson) fail('receipt not in applied ledger');
    for(const entry of expectedReceipt.payload.entries) if(!same(db.prepare('SELECT * FROM seminars WHERE id=?').get(entry.id),entry.postimage)) fail('postimage changed');
    assertDocumentGraphs(db,expectedReceipt.payload.documentIds,expectedReceipt.payload.documentsPlanDigest,expectedReceipt.payload.documentsReceiptDigest);
    for(const entry of expectedReceipt.payload.entries) {
      const stmt=db.prepare(`UPDATE seminars SET ${FIELDS.map(key=>`"${key}"=?`).join(',')} WHERE id=?`);
      stmt.run(...FIELDS.map(key=>entry.preimage[key]),entry.id);
      if(!same(db.prepare('SELECT * FROM seminars WHERE id=?').get(entry.id),entry.preimage)) fail('rollback readback mismatch');
    }
    db.prepare(`UPDATE ${LEDGER} SET status=? WHERE plan_digest=?`).run('rolled_back',expectedReceipt.payload.planDigest);
    if(json(receipt)!==expectedReceiptJson) fail('rollback receipt changed');
    for(const entry of expectedReceipt.payload.entries) {
      const row=db.prepare('SELECT * FROM seminars WHERE id=?').get(entry.id);
      if(!same(row,entry.preimage)) fail('final rollback preimage changed');
      assertRowRoute(db,row);
    }
    const groups=new Map();for(const entry of expectedReceipt.payload.entries){const id=entry.preimage.document_id;const ids=groups.get(id)??[];ids.push(entry.id);groups.set(id,ids);}
    for(const [id,ids] of groups) if(!same(db.prepare('SELECT id FROM seminars WHERE document_id=? ORDER BY id').all(id).map(row=>row.id),ids.sort((a,b)=>a-b))) fail('final physical version inventory changed');
    assertDocumentGraphs(db,expectedReceipt.payload.documentIds,expectedReceipt.payload.documentsPlanDigest,expectedReceipt.payload.documentsReceiptDigest);
    const recorded=db.prepare(`SELECT receipt_json,status FROM ${LEDGER} WHERE plan_digest=?`).get(expectedReceipt.payload.planDigest);
    if(!recorded || recorded.status!=='rolled_back' || recorded.receipt_json!==expectedReceiptJson) fail('final rollback receipt changed');check(db);
  }).immediate();
}
