import { it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import * as data from '../src/lib/data';
import SeminarPage from '../src/pages/[institute]/[courseGroup]/[seminar].astro';
import { audit, rendererFingerprint, verifySeparateFields } from '../scripts/seminar-migration/render-audit';
type Entry = ReturnType<typeof audit>;
type Source = Parameters<typeof verifySeparateFields>[1];
const dir=process.env.IKPK_MIGRATION_AUDIT_DIR;
const run=process.env.IKPK_MIGRATION_RUN;
const enabled=Boolean(dir && run);
const file=(name:string)=>`${dir}/${name}`;
const report:Entry[]=enabled ? JSON.parse(readFileSync(file('render-audit-v5-20261114.json'),'utf8')).entries : [];
const sourceRows:{source:Source}[]=enabled ? JSON.parse(readFileSync(file('converter-input-real-20261113.json'),'utf8')) : [];
const source=new Map(sourceRows.map(x=>[x.source.id,x.source]));
it.skipIf(!enabled)('actual page retains existing separate fields without rewriting or duplication',async()=>{
 vi.spyOn(data,'getScheduleEntries').mockReturnValue([]);
 const container=await AstroContainer.create({astroConfig:{site:'https://ikpk.su'}});
 const rendererSha256=rendererFingerprint();
 const candidates=report.filter(x=>x.version==='published' && (['learning_plan','learning_mode','recommendations'] as const).some(k=>String(source.get(x.id)?.[k]??'').trim())); const results=[];
 for(const entry of candidates) {
  const s=source.get(entry.id); const path=entry.path.split('/').filter(Boolean);
  if (!s) throw new Error(`Missing migration source ${entry.id}`);
  try { const html=await container.renderToString(SeminarPage,{request:new Request('https://ikpk.su'+entry.path),props:{institute:{name:'Институт',slug:path[0]},courseGroup:{name:'Программа',slug:path[1]},seminar:{name:'Семинар',slug:path[2],content_format:'structured',description_html:s.description,learning_plan:s.learning_plan,learning_mode:s.learning_mode,recommendations:s.recommendations}}}); results.push({id:entry.id,path:entry.path,errors:verifySeparateFields(entry,s,html),entry,rendererSha256,documentProposal:null}); }
  catch(e){results.push({id:entry.id,path:entry.path,errors:[String(e)]});}
 }
 writeFileSync(file(`actual-render-existing-fields-${run}.json`),JSON.stringify(results,null,2),{mode:0o600,flag:'wx'});
 vi.restoreAllMocks(); expect(candidates.length).toBe(5); expect(results.filter(x=>x.errors.length)).toEqual([]);
});
