import { it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import * as data from '../src/lib/data';
import SeminarPage from '../src/pages/[institute]/[courseGroup]/[seminar].astro';
import { audit, rendererFingerprint, verifyPage } from '../scripts/seminar-migration/render-audit';
type Entry = ReturnType<typeof audit>;
type Source = {id:number; learning_plan:string|null; learning_mode:string|null; recommendations:string|null};
type Proposal = {documentId:string; route:string; proposal:Record<string,unknown>};
const dir=process.env.IKPK_MIGRATION_AUDIT_DIR;
const run=process.env.IKPK_MIGRATION_RUN;
const enabled=Boolean(dir && run);
const file=(name:string)=>`${dir}/${name}`;
const report:Entry[]=enabled ? JSON.parse(readFileSync(file('render-audit-v5-20261114.json'),'utf8')).entries : [];
const proposalRows:Proposal[]=enabled ? JSON.parse(readFileSync(file('documents-migration-proposals-v7.json'),'utf8')) : [];
const sourceRows:{source:Source}[]=enabled ? JSON.parse(readFileSync(file('converter-input-real-20261113.json'),'utf8')) : [];
const proposals=new Map(proposalRows.map(p=>[p.documentId,p]));
const src=new Map(sourceRows.map(x=>[x.source.id,x.source]));
it.skipIf(!enabled)('actual canonical page preserves reviewed legacy page facts',async()=>{
 vi.spyOn(data,'getScheduleEntries').mockReturnValue([]);
 const container=await AstroContainer.create({astroConfig:{site:'https://ikpk.su'}});
 const rendererSha256=rendererFingerprint();
 const candidates=report.filter(x=>x.version==='published' && x.reasons.every(r=>['additional-legacy-anchors-need-support','documents-require-separate-structured-review'].includes(r)) && !(['learning_plan','learning_mode','recommendations'] as const).some(k=>String(src.get(x.id)?.[k]??'').trim()));
 const results=[];
 for(const entry of candidates) {
  const anchors=Object.fromEntries(entry.sections.map((key:string)=>[key,[...(entry.aliases[key]??[]),entry.ids[key]]]));
  const path=entry.path.split('/').filter(Boolean);
  try {
   const proposal=proposals.get(entry.document_id);
   if(entry.sections.includes('documents') && (!proposal || proposal.route!==entry.path)) throw new Error('missing document proposal');
   const html=await container.renderToString(SeminarPage,{request:new Request('https://ikpk.su'+entry.path),props:{institute:{name:'Институт',slug:path[0]},courseGroup:{name:'Программа',slug:path[1]},seminar:{name:'Семинар',slug:path[2],content_format:'structured',description_html:entry.fields.description,audience:entry.fields.audience,learning_plan:entry.fields.learning_plan,learning_mode:entry.fields.learning_mode,recommendations:entry.fields.recommendations,content_section_anchors:anchors,...(proposal?.proposal??{})}}});
   results.push({id:entry.id,path:entry.path,errors:verifyPage(entry,html,entry.sections.includes('documents')),entry,rendererSha256,documentProposal:proposal?.proposal??null});
  } catch(e) { results.push({id:entry.id,path:entry.path,errors:[String(e)]}); }
 }
 writeFileSync(file(`actual-render-review-${run}.json`),JSON.stringify(results,null,2),{mode:0o600,flag:'wx'});
 vi.restoreAllMocks(); expect(candidates.length).toBe(128); expect(results.filter(x=>x.errors.length)).toEqual([]);
});
