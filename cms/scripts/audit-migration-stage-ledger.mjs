const NAMES=['ikpk_migration_lineage','ikpk_migration_operations','ikpk_data_migration_history'];
const COLUMNS={ikpk_migration_lineage:['singleton','lineage_id','source_snapshot_sha256','source_schema_sha256','created_at'],ikpk_migration_operations:['operation_id','lineage_id','source_snapshot_sha256','source_schema_sha256','created_at'],ikpk_data_migration_history:['lineage_id','operation_id','step_id','payload_sha256','result_json','completed_at']};
const HASH=/^[a-f0-9]{64}$/;
const serial=JSON.stringify;
function fail(message){throw new Error(`stage ledger audit: ${message}`);}
function rows(db,table){return db.prepare(`SELECT * FROM "${table}"`).all().map(x=>({...x}));}
function schema(db,table){return db.prepare(`PRAGMA table_info("${table}")`).all().map(x=>x.name);}
function definitions(db,table){return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all(table).map(x=>({...x}));}
function keyed(items,key,label){const map=new Map();for(const item of items){const value=key(item);if(value==null||map.has(value))fail(`duplicate or missing ${label} key`);map.set(value,item);}return map;}
function retained(base,actual,key,label){const current=keyed(actual,key,label);for(const row of base){const found=current.get(key(row));if(!found||serial(found)!==serial(row))fail(`${label} history was changed`);}return current;}
function validTime(s){return typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;}

/** Validate runner metadata in all retained stage snapshots, so a higher-level
 * data audit can exclude exactly these tables without ignoring their contents.
 * Expected steps, result values, operation/source digests and stage order must
 * come from a separately bound operation receipt and reviewed migration plan.
 */
export function auditMigrationStageLedger(source,{stages,operationId,lineageId,sourceSnapshotSha256,sourceSchemaSha256}){
 if(!Array.isArray(stages)||!stages.length||typeof operationId!=='string'||!operationId||![lineageId,sourceSnapshotSha256,sourceSchemaSha256].every(x=>HASH.test(x??'')))fail('invalid independent receipt binding');
 for(const db of [source,...stages.map(x=>x.db)])for(const name of NAMES)if(serial(schema(db,name))!==serial(COLUMNS[name]))fail(`unsupported ledger schema ${name}`);
 for(const stage of stages)for(const name of NAMES)if(serial(definitions(source,name))!==serial(definitions(stage.db,name)))fail(`ledger schema changed: ${name}`);
 const initialLineage=rows(source,NAMES[0]),initialOps=rows(source,NAMES[1]),initialHistory=rows(source,NAMES[2]);
 if(initialLineage.length!==1||initialLineage[0].singleton!==1||initialLineage[0].lineage_id!==lineageId)fail('source lineage mismatch');
 if(initialOps.some(row=>row.operation_id===operationId))fail('operation must be new in source');
 const required=new Map();let priorOperations,priorHistory;const ids=new Set(initialHistory.map(x=>`${x.lineage_id}\0${x.step_id}`));
 for(const stage of stages){
  if(!Array.isArray(stage.newSteps))fail('each stage must declare its exact new step set');
  for(const step of stage.newSteps){if(!step||typeof step.id!=='string'||!step.id||!HASH.test(step.sha256??'')||required.has(step.id)||ids.has(`${lineageId}\0${step.id}`))fail('invalid or previously applied step identity');required.set(step.id,step);}
  if(serial(rows(stage.db,NAMES[0]))!==serial(initialLineage))fail('lineage changed');
  const operations=rows(stage.db,NAMES[1]);retained(initialOps,operations,x=>x.operation_id,'operation');
  if(operations.length!==initialOps.length+1)fail('operation set mismatch');
  const operation=operations.find(x=>x.operation_id===operationId);
  if(!operation||operation.lineage_id!==lineageId||operation.source_snapshot_sha256!==sourceSnapshotSha256||operation.source_schema_sha256!==sourceSchemaSha256||!validTime(operation.created_at))fail('operation source binding mismatch');
  if(priorOperations&&serial(operations)!==serial(priorOperations))fail('operation changed between stages');priorOperations=operations;
  const history=rows(stage.db,NAMES[2]);retained(initialHistory,history,x=>`${x.lineage_id}\0${x.step_id}`,'step');
  if(history.length!==initialHistory.length+required.size)fail('unexpected history count');
  for(const [id,step] of required){const found=history.filter(x=>x.lineage_id===lineageId&&x.step_id===id);if(found.length!==1)fail(`missing step ${id}`);const row=found[0];if(row.operation_id!==operationId||row.payload_sha256!==step.sha256||row.result_json!==serial(step.result??{})||!validTime(row.completed_at))fail(`step receipt mismatch: ${id}`);}
  if(priorHistory)retained(priorHistory,history,x=>`${x.lineage_id}\0${x.step_id}`,'stage step');priorHistory=history;
 }
 return {passed:true,stages:stages.length,newSteps:required.size};
}
