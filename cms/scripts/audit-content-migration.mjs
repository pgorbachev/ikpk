// Independent read-only verification of one content data-step and its ledger.
import { createHash } from 'node:crypto';

const LEDGER='ikpk_content_migration_ledger';
const RUNNER=new Set(['ikpk_migration_lineage','ikpk_migration_operations','ikpk_data_migration_history']);
const FIELDS=new Set(['description','full_text','audience','learning_plan','learning_mode','recommendations','content_format','content_section_anchors']);
const SECTIONS=new Set(['audience','learning_plan','learning_mode','documents','recommendations']);
const hash=value=>createHash('sha256').update(value).digest('hex');
function fail(message){throw new Error(`independent content audit: ${message}`);}
function canon(v){if(Array.isArray(v))return v.map(canon);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])]));return v;}
function eq(a,b){return JSON.stringify(canon(a))===JSON.stringify(canon(b));}
function quote(v){return `"${v.replaceAll('"','""')}"`;}
function tables(db){return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);}
function schema(db,skip){return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name").all().filter(r=>!skip.has(r.tbl_name)).map(r=>({...r}));}
function rows(db,table){return db.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all().map(row=>({...row}));}
function bag(list){return list.map(r=>JSON.stringify(canon(r))).sort();}
function healthy(db){const result=db.prepare('PRAGMA integrity_check').all();return result.length===1 && Object.values(result[0])[0]==='ok' && !db.prepare('PRAGMA foreign_key_check').all().length;}
function graph(db,id){
 const result={}, definitions={documents:['seminar.document-record','components_seminar_document_records'],training_registries:['seminar.registry-fact','components_seminar_registry_facts'],nmo:['seminar.nmo-fact','components_seminar_nmo_facts']};
 for(const [field,[type,table]] of Object.entries(definitions)){
  result[field]=db.prepare('SELECT * FROM seminars_cmps WHERE entity_id=? AND field=? ORDER BY "order",id').all(id,field).map(link=>{
   if(link.component_type!==type)fail('unexpected component type');const row=db.prepare(`SELECT * FROM ${quote(table)} WHERE id=?`).get(link.cmp_id);if(!row)fail('missing component');
   const nested=field==='documents'?db.prepare('SELECT * FROM components_seminar_document_records_cmps WHERE entity_id=? ORDER BY "order",id').all(link.cmp_id).map(edge=>{
    if(edge.component_type!=='seminar.registry-fact'||edge.field!=='registry')fail('unexpected nested component');const value=db.prepare('SELECT * FROM components_seminar_registry_facts WHERE id=?').get(edge.cmp_id);if(!value)fail('missing nested component');return {link:{...edge},row:{...value}};
   }):[];
   return {link:{...link},row:{...row},nested};
  });
 }
 return result;
}
function assertExclusive(db,components){
 for(const [field,records] of Object.entries(components)) for(const record of records){
  const type=record.link.component_type;
  if(db.prepare('SELECT count(*) AS n FROM seminars_cmps WHERE component_type=? AND cmp_id=?').get(type,record.row.id).n!==1)fail('document graph is shared');
  if(field==='training_registries'&&db.prepare('SELECT count(*) AS n FROM components_seminar_document_records_cmps WHERE component_type=? AND cmp_id=?').get(type,record.row.id).n)fail('document registry is shared');
  for(const nested of record.nested){
   const root=db.prepare('SELECT count(*) AS n FROM seminars_cmps WHERE component_type=? AND cmp_id=?').get('seminar.registry-fact',nested.row.id).n;
   const refs=db.prepare('SELECT count(*) AS n FROM components_seminar_document_records_cmps WHERE component_type=? AND cmp_id=?').get('seminar.registry-fact',nested.row.id).n;
   if(root||refs!==1)fail('document registry is shared');
  }
 }
}
function route(db,id){
 const values=db.prepare(`SELECT DISTINCT i.slug AS institute,c.slug AS course,s.slug AS seminar FROM seminars s
 JOIN seminars_course_group_lnk sc ON sc.seminar_id=s.id JOIN course_groups c ON c.id=sc.course_group_id
 JOIN course_groups_institute_lnk ci ON ci.course_group_id=c.id JOIN institutes i ON i.id=ci.institute_id WHERE s.id=?`).all(id);
 if(values.length!==1||Object.values(values[0]).some(value=>!value))fail('invalid route');
 return `/${values[0].institute}/${values[0].course}/${values[0].seminar}`;
}
function validateTarget(item,renderer){
 const evidence=item.reviewEvidence,report=evidence?.entry,src=item.source,post=item.post;
 if(!report||!src||!post||evidence.rendererSha256!==renderer||evidence.errors?.length!==0||evidence.path!==item.path||report.path!==item.path||report.document_id!==item.document_id||src.id!==item.id||src.document_id!==item.document_id||src.path!==item.path||src.version!==item.version)fail('render evidence identity');
 if(item.version==='published'&&(report.id!==item.id||evidence.id!==item.id||hash(JSON.stringify(src))!==report.source_sha256))fail('source fingerprint');
 if(report.version!=='published'||!Array.isArray(report.sections)||!report.fields||!report.ids||!report.aliases)fail('invalid render report');
 const hasSeparate=['learning_plan','learning_mode','recommendations'].some(key=>String(src[key]??'').trim());if(item.separate!==hasSeparate||(item.separate&&(report.sections.length||src.full_text||src.recommendations)))fail('unsupported separate content');
 const anchors={},seen=new Set();
 for(const section of report.sections){if(!SECTIONS.has(section)||Object.hasOwn(anchors,section)||!Array.isArray(report.aliases[section])||typeof report.ids[section]!=='string')fail('invalid section');anchors[section]=[...report.aliases[section],report.ids[section]];for(const anchor of anchors[section]){if(typeof anchor!=='string'||!/^[A-Za-z0-9_.:-]+$/.test(anchor)||seen.has(anchor))fail('duplicate or invalid anchor');seen.add(anchor);}}
 let actual;try{actual=JSON.parse(post.content_section_anchors);}catch{fail('invalid anchor JSON');}
 if(!eq(actual,anchors)||post.content_format!=='structured')fail('anchors differ from evidence');
 const expected={content_format:'structured',content_section_anchors:post.content_section_anchors};
 if(!item.separate)Object.assign(expected,{description:report.fields.description,full_text:null,audience:report.fields.audience??null,learning_plan:report.fields.learning_plan??null,learning_mode:report.fields.learning_mode??null,recommendations:report.fields.recommendations??null});
 if(!eq(post,expected)||Object.keys(post).some(k=>!FIELDS.has(k)))fail('postimage does not match evidence');
 if(!report.sections.includes('documents')&&evidence.documentProposal!=null)fail('unexpected document proposal');
 return report.sections.includes('documents');
}

/** `includeRunnerMetadata` is only safe after a separate runner ledger audit. */
export function auditContentMigration(source,candidate,{plan,expectedPlanDigest,includeRunnerMetadata=false}={}){
 if(!/^[a-f0-9]{64}$/.test(expectedPlanDigest??'')||plan?.digest!==expectedPlanDigest||hash(JSON.stringify(plan?.payload))!==expectedPlanDigest||plan.payload?.version!==1||!Array.isArray(plan.payload.entries)||!plan.payload.entries.length)fail('reviewed plan mismatch');
 if(!healthy(source)||!healthy(candidate))fail('integrity check');
 const skip=new Set([LEDGER,...(includeRunnerMetadata?RUNNER:[])]),oldTables=tables(source).filter(t=>!skip.has(t)),newTables=tables(candidate).filter(t=>!skip.has(t));
 if(!eq(oldTables,newTables)||!eq(schema(source,skip),schema(candidate,skip)))fail('unrelated schema changed');
 if(!tables(candidate).includes(LEDGER))fail('missing content ledger');
 const columns=candidate.prepare(`PRAGMA table_info(${quote(LEDGER)})`).all().map(({name,type,notnull,pk,dflt_value})=>({name,type,notnull,pk,dflt_value}));
 if(!eq(columns,[{name:'plan_digest',type:'TEXT',notnull:0,pk:1,dflt_value:null},{name:'receipt_json',type:'TEXT',notnull:1,pk:0,dflt_value:null},{name:'status',type:'TEXT',notnull:1,pk:0,dflt_value:null}]))fail('unexpected content ledger schema');
 const objects=candidate.prepare("SELECT type,name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all(LEDGER).map(r=>({...r}));if(!eq(objects,[{type:'table',name:LEDGER}]))fail('unexpected content ledger objects');
 for(const table of oldTables.filter(t=>t!=='seminars'))if(!eq(bag(rows(source,table)),bag(rows(candidate,table))))fail(`unrelated data changed: ${table}`);
 const before=new Map(rows(source,'seminars').map(r=>[r.id,r])),after=new Map(rows(candidate,'seminars').map(r=>[r.id,r]));if(before.size!==after.size)fail('seminar count changed');
 const groups=new Map(),expected=new Map();let documentsReceipt;const docIds=new Set();
 for(const item of plan.payload.entries){
  if(!Number.isSafeInteger(item.id)||expected.has(item.id)||!['draft','published'].includes(item.version)||typeof item.separate!=='boolean')fail('invalid physical identity');
  const old=before.get(item.id),current=after.get(item.id);
  if(!old||!current||!eq(old,item.preimage)||old.document_id!==item.document_id||(old.published_at?'published':'draft')!==item.version||route(source,item.id)!==item.path||`/${String(old.legacy_id??'').replace(/^\/+/, '')}`!==item.path)fail('source version or route changed');
  if(![null,'legacy'].includes(old.content_format??null)||old.audience||old.content_section_anchors)fail('structured content already exists');
  for(const field of ['id','document_id','locale','description','full_text','learning_plan','learning_mode','recommendations'])if(!eq(item.source?.[field],old[field]))fail('source fields mismatch');
  const hasDocuments=validateTarget(item,plan.payload.rendererSha256);expected.set(item.id,{...old,...item.post});if(!eq(current,expected.get(item.id)))fail('unexpected seminar postimage');
  const group=groups.get(item.document_id)??[];group.push(item);groups.set(item.document_id,group);
  if(hasDocuments){
   if(!documentsReceipt){const ledger=source.prepare('SELECT receipt_json,status FROM ikpk_documents_migration_ledger WHERE plan_digest=?').get(plan.payload.documentsPlanDigest);if(!ledger||ledger.status!=='applied')fail('missing documents ledger');try{documentsReceipt=JSON.parse(ledger.receipt_json);}catch{fail('invalid documents receipt');}if(documentsReceipt.digest!==plan.payload.documentsReceiptDigest||documentsReceipt.payload?.planDigest!==plan.payload.documentsPlanDigest||hash(JSON.stringify(documentsReceipt.payload))!==documentsReceipt.digest)fail('document receipt digest');}
   const match=documentsReceipt.payload.entries.filter(entry=>entry.item?.documentId===item.document_id);if(match.length!==1||match[0].item.approved!==true||match[0].item.eligibleForAutomaticWrite!==true||match[0].item.readyForReviewOnly!==false||match[0].item.route!==item.path||!eq(match[0].item.proposal,item.reviewEvidence.documentProposal))fail('document proposal mismatch');
   const components=graph(source,item.id);assertExclusive(source,components);
   const postimages=match[0].postimage.filter(version=>version.row?.id===item.id);if(postimages.length!==1||!eq(postimages[0],{row:old,route:item.path,graph:components}))fail('document graph mismatch');docIds.add(item.document_id);
  }
 }
 for(const [id,items] of groups){if(items.length!==2||new Set(items.map(x=>x.version)).size!==2||!eq(items[0].reviewEvidence,items[1].reviewEvidence)||items[0].path!==items[1].path||items[0].separate!==items[1].separate||!eq(items[0].source.locale,items[1].source.locale))fail(`divergent versions ${id}`);const inventory=[...before.values()].filter(row=>row.document_id===id).map(row=>row.id).sort((a,b)=>a-b);if(!eq(inventory,items.map(item=>item.id).sort((a,b)=>a-b)))fail(`physical version inventory changed: ${id}`);for(const key of ['description','full_text','learning_plan','learning_mode','recommendations'])if(!eq(items[0].source[key],items[1].source[key]))fail('draft and published content differs');}
 for(const [id,row] of before)if(!expected.has(id)&&!eq(row,after.get(id)))fail('unplanned seminar change');
 const prior=tables(source).includes(LEDGER)?rows(source,LEDGER):[],current=rows(candidate,LEDGER),additions=current.filter(row=>!prior.some(old=>eq(old,row)));
 if(current.length!==prior.length+1||additions.length!==1||additions[0].plan_digest!==expectedPlanDigest||additions[0].status!=='applied')fail('content ledger mismatch');
 let receipt;try{receipt=JSON.parse(additions[0].receipt_json);}catch{fail('invalid content receipt');}
 if(receipt.digest!==hash(JSON.stringify(receipt.payload))||receipt.payload?.version!==1||receipt.payload.planDigest!==expectedPlanDigest||!Array.isArray(receipt.payload.entries)||receipt.payload.entries.length!==plan.payload.entries.length||!eq(receipt.payload.documentIds,[...docIds])||receipt.payload.documentsReceiptDigest!==plan.payload.documentsReceiptDigest||receipt.payload.documentsPlanDigest!==plan.payload.documentsPlanDigest)fail('content receipt mismatch');
 for(let i=0;i<plan.payload.entries.length;i++){const item=plan.payload.entries[i];if(!eq(receipt.payload.entries[i],{id:item.id,preimage:item.preimage,postimage:expected.get(item.id)}))fail('receipt row mismatch');}
 return {passed:true,versions:expected.size,seminars:groups.size,documents:docIds.size};
}
