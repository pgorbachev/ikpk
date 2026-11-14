import { createHash } from 'node:crypto';

const DOCUMENT = ['document','issuer','prior_education','prior_education_note','outcome','basis','issuer_unknown','completion_scope','other_seminar_href','other_seminar_label','signed_by','qualification_topic','hours_mode','includes_completed_level','completion_required','completion_after_seminar_number','completion_cycle_name','hours_may_vary','regulation_url','document_type_unspecified','regulation_issuer','document_on_template'];
const REGISTRY = ['name','international','subject','url','basis'];
const NMO = ['status','audience','awarded_for','url','completion_required','purpose'];
const TABLES = {documents:'components_seminar_document_records',registry:'components_seminar_registry_facts',nmo:'components_seminar_nmo_facts'};
const TYPES = {documents:'seminar.document-record',registry:'seminar.registry-fact',nmo:'seminar.nmo-fact'};
const DEFAULTS = {documents:{prior_education:'unspecified',issuer_unknown:0,includes_completed_level:0,completion_required:0,hours_may_vary:0,document_type_unspecified:0,document_on_template:0},registry:{international:0},nmo:{completion_required:0}};
const BOOLS = new Set(['issuer_unknown','includes_completed_level','completion_required','hours_may_vary','document_type_unspecified','document_on_template','international']);
const APPENDED = ['seminars_cmps',TABLES.documents,'components_seminar_document_records_cmps',TABLES.registry,TABLES.nmo];
const LEDGER = 'ikpk_documents_migration_ledger';
const RUNNER_TABLES = new Set(['ikpk_migration_lineage','ikpk_migration_operations','ikpk_data_migration_history']);
const hash = bytes=>createHash('sha256').update(bytes).digest('hex');
const serial = JSON.stringify;
const quote = s=>`"${s.replaceAll('"','""')}"`;
function fail(message){throw new Error(`independent documents audit: ${message}`);}
function canonical(value){if(typeof value==='bigint')return {integer:value.toString()};if(value instanceof Uint8Array)return {blob:Buffer.from(value).toString('base64')};if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
function rows(db,table){return db.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all().map(x=>({...x}));}
function tables(db){return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);}
function schema(db){return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND tbl_name <> ? ORDER BY type,name,tbl_name").all(LEDGER).map(x=>({...x}));}
function bag(list){return list.map(v=>serial(canonical(v))).sort();}
function equal(a,b){return serial(canonical(a))===serial(canonical(b));}
function healthy(db){const v=db.prepare('PRAGMA integrity_check').all();return v.length===1&&Object.values(v[0])[0]==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0;}
function byId(list,label){const result=new Map();for(const row of list){if(!Number.isSafeInteger(row.id)||result.has(row.id))fail(`invalid ${label} identity`);result.set(row.id,row);}return result;}
function expectedRecord(kind,proposal){
 const fields=kind==='documents'?DOCUMENT:kind==='registry'?REGISTRY:NMO;
 const result={};for(const field of fields){const value=Object.hasOwn(proposal,field)?proposal[field]:(DEFAULTS[kind][field]??null);result[field]=BOOLS.has(field)&&value!==null?Number(value):value;}return result;
}
function verifyRecord(kind,actual,proposal){
 const expected=expectedRecord(kind,proposal),keys=Object.keys(actual).filter(k=>k!=='id').sort();
 if(!equal(keys,Object.keys(expected).sort()))fail(`unexpected ${kind} columns`);
 for(const key of keys)if(!equal(actual[key],expected[key]))fail(`${kind} field mismatch: ${key}`);
}

/** Verify a separately reviewed and hash-bound writer plan against an unchanged
 * source and its migrated candidate. Opens no DB and performs no writes.
 * Both arguments must be stable read-only snapshots in the same schema stage.
 */
export function auditDocumentsMigration(source,candidate,{plan,expectedPlanDigest,includeRunnerMetadata=false}){
 if(!/^[a-f0-9]{64}$/.test(expectedPlanDigest??'')||plan?.digest!==expectedPlanDigest||hash(serial(plan.payload))!==expectedPlanDigest||plan.payload?.version!==1||!Array.isArray(plan.payload.entries)||!plan.payload.entries.length)fail('reviewed plan digest mismatch');
 if(!healthy(source)||!healthy(candidate))fail('integrity or foreign key check failed');
 const beforeTables=tables(source),afterTables=tables(candidate),added=afterTables.filter(t=>!beforeTables.includes(t));
 if(!equal(added,beforeTables.includes(LEDGER)?[]:[LEDGER])||beforeTables.some(t=>!afterTables.includes(t)))fail('unexpected table set');
 if(!equal(schema(source),schema(candidate)))fail('unrelated schema changed');
 const ledgerColumns=candidate.prepare(`PRAGMA table_info(${quote(LEDGER)})`).all().map(({name,type,notnull,pk,dflt_value})=>({name,type,notnull,pk,dflt_value}));
 if(!equal(ledgerColumns,[{name:'plan_digest',type:'TEXT',notnull:0,pk:1,dflt_value:null},{name:'receipt_json',type:'TEXT',notnull:1,pk:0,dflt_value:null},{name:'status',type:'TEXT',notnull:1,pk:0,dflt_value:null}]))fail('unexpected ledger schema');
 const ledgerObjects=candidate.prepare("SELECT type,name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all(LEDGER).map(x=>({...x}));
 if(!equal(ledgerObjects,[{type:'table',name:LEDGER}]))fail('unexpected ledger indexes or triggers');
 const before={},after={};for(const table of beforeTables){before[table]=rows(source,table);after[table]=rows(candidate,table);}
 const original=byId(before.seminars,'seminar'),updated=byId(after.seminars,'seminar');
 const expectedVersions=new Map(),documents=new Set();
 for(const entry of plan.payload.entries){
  const {item,preimage}=entry;
  if(!item?.approved||item.eligibleForAutomaticWrite!==true||item.readyForReviewOnly!==false||documents.has(item.documentId)||!Array.isArray(preimage)||!preimage.length)fail('unapproved or duplicate proposal');
  if(hash(item.sourceHtml)!==item.sourceSha256||!Array.isArray(item.reviewedPreimages)||!equal(item.reviewedPreimages,preimage))fail('proposal or preimage not bound');
  documents.add(item.documentId);
  const actual=before.seminars.filter(r=>r.document_id===item.documentId);
  if(actual.length!==preimage.length)fail('physical version coverage');
  for(const version of preimage){const row=original.get(version.row?.id);if(!row||row.document_id!==item.documentId||!equal(row,version.row)||expectedVersions.has(row.id))fail('source version mismatch');
   const routes=source.prepare(`SELECT DISTINCT i.slug AS institute,c.slug AS course FROM seminars_course_group_lnk sc JOIN course_groups c ON c.id=sc.course_group_id JOIN course_groups_institute_lnk ci ON ci.course_group_id=c.id JOIN institutes i ON i.id=ci.institute_id WHERE sc.seminar_id=?`).all(row.id);
   if(routes.length!==1||`/${routes[0].institute}/${routes[0].course}/${row.slug}`!==item.route||`/${String(row.legacy_id??'').replace(/^\/+/, '')}`!==item.route)fail('route identity mismatch');
   expectedVersions.set(row.id,item);
  }
 }
 if(original.size!==updated.size)fail('seminar count changed');
 for(const [id,row] of original){
  const current=updated.get(id);if(!current)fail('seminar removed');const item=expectedVersions.get(id);
  const expected={...row};if(item){expected.documents_state=item.proposal.documents_state;expected.documents_confirmation_date=item.migrationDate;expected.documents_confirmation_author=item.migrationAuthor;expected.documents_confirmation_source=`Перенесено из опубликованной панели ${item.route}; снимок sha256:${item.snapshotSha256}; панель sha256:${item.sourceSha256}`;}
  if(!equal(current,expected))fail(`seminar or provenance changed: ${id}`);
 }
 const newRows={};
 for(const table of beforeTables){
  if(table==='seminars'||table===LEDGER)continue;
  if(includeRunnerMetadata&&RUNNER_TABLES.has(table))continue; // Must be checked by auditMigrationStageLedger.
  if(!APPENDED.includes(table)){if(!equal(bag(before[table]),bag(after[table])))fail(`unrelated data changed: ${table}`);continue;}
  const a=byId(before[table],table),b=byId(after[table],table);for(const [id,row] of a)if(!equal(row,b.get(id)))fail(`existing component changed: ${table}`);
  newRows[table]=new Map([...b].filter(([id])=>!a.has(id)));
 }
 for(const table of APPENDED)if(!newRows[table])fail(`missing component table ${table}`);
 const seen={};for(const table of APPENDED)seen[table]=new Set();
 function consume(table,id){const result=newRows[table].get(id);if(!result||seen[table].has(id))fail(`missing, shared or old component: ${table}`);seen[table].add(id);return result;}
 function graph(entity,field,type,items,kind){
  const links=[...newRows.seminars_cmps.values()].filter(l=>l.entity_id===entity&&l.field===field).sort((a,b)=>a.order-b.order||a.id-b.id);
  if(links.length!==items.length)fail(`component count mismatch: ${entity}.${field}`);
  items.forEach((value,i)=>{const link=consume('seminars_cmps',links[i].id);if(link.component_type!==type||link.order!==i+1)fail('component type or order mismatch');const record=consume(TABLES[kind],link.cmp_id);verifyRecord(kind,record,value);
   if(kind==='documents'){
    const nested=[...newRows.components_seminar_document_records_cmps.values()].filter(l=>l.entity_id===record.id).sort((a,b)=>a.order-b.order||a.id-b.id);const wanted=value.registry??[];if(nested.length!==wanted.length)fail('nested registry count mismatch');
    wanted.forEach((registry,j)=>{const edge=consume('components_seminar_document_records_cmps',nested[j].id);if(edge.component_type!==TYPES.registry||edge.field!=='registry'||edge.order!==j+1)fail('nested registry link mismatch');verifyRecord('registry',consume(TABLES.registry,edge.cmp_id),registry);});
   }
  });
 }
 for(const [id,item] of expectedVersions){
  if(before.seminars_cmps.some(l=>l.entity_id===id&&['documents','training_registries','nmo'].includes(l.field)))fail('source has existing document graph');
  graph(id,'documents',TYPES.documents,item.proposal.documents,'documents');
  graph(id,'training_registries',TYPES.registry,item.proposal.training_registries,'registry');
  graph(id,'nmo',TYPES.nmo,item.proposal.nmo?[item.proposal.nmo]:[],'nmo');
 }
 for(const table of APPENDED)if(seen[table].size!==newRows[table].size)fail(`orphan or unexpected new graph row: ${table}`);
 const rootLinks=after.seminars_cmps,nestedLinks=after.components_seminar_document_records_cmps;
 for(const [kind,table] of Object.entries(TABLES))for(const id of seen[table]){
  const references=[...rootLinks,...nestedLinks].filter(link=>link.component_type===TYPES[kind]&&link.cmp_id===id);
  if(references.length!==1)fail(`component is shared or unreferenced: ${kind}`);
 }
 const ledger=rows(candidate,LEDGER),previous=before[LEDGER]??[];const additions=ledger.filter(row=>!previous.some(old=>equal(old,row)));
 if(additions.length!==1||ledger.length!==previous.length+1||additions[0].plan_digest!==expectedPlanDigest||additions[0].status!=='applied')fail('migration ledger mismatch');
 let receipt;try{receipt=JSON.parse(additions[0].receipt_json);}catch{fail('invalid ledger receipt');}
 if(!receipt?.payload||receipt.payload.planDigest!==expectedPlanDigest||hash(serial(receipt.payload))!==receipt.digest)fail('receipt digest mismatch');
 if(receipt.payload.version!==1||!Array.isArray(receipt.payload.entries)||receipt.payload.entries.length!==plan.payload.entries.length)fail('receipt entry set mismatch');
 const candidateDocs=byId(after[TABLES.documents],'document'),candidateRegistries=byId(after[TABLES.registry],'registry'),candidateNmo=byId(after[TABLES.nmo],'nmo');
 function postimage(id,route){
  const graph={};
  for(const [field,recordMap] of [['documents',candidateDocs],['training_registries',candidateRegistries],['nmo',candidateNmo]]){
   graph[field]=rootLinks.filter(link=>link.entity_id===id&&link.field===field).sort((a,b)=>a.order-b.order||a.id-b.id).map(link=>{
    const row=recordMap.get(link.cmp_id),nested=field==='documents'?nestedLinks.filter(edge=>edge.entity_id===row.id).sort((a,b)=>a.order-b.order||a.id-b.id).map(edge=>({link:edge,row:candidateRegistries.get(edge.cmp_id)})):[];
    return {link,row,nested};
   });
  }
  return {row:updated.get(id),route,graph};
 }
 for(let i=0;i<plan.payload.entries.length;i++){
  const expected=plan.payload.entries[i],observed=receipt.payload.entries[i];
  if(!equal(observed.item,expected.item)||!equal(observed.preimage,expected.preimage)||!Array.isArray(observed.postimage)||!equal(observed.postimage,expected.preimage.map(version=>postimage(version.row.id,expected.item.route))))fail('receipt preimage or postimage mismatch');
 }
 return {passed:true,documents:documents.size,versions:expectedVersions.size,components:Object.fromEntries(APPENDED.map(t=>[t,seen[t].size]))};
}
