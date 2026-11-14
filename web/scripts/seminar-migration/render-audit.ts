import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment, serialize } from 'parse5';
import { cleanBodyHtml, stripLegacySeminarTail, terminalSanitize } from '../../src/lib/html-cleaner';
import { localizeAssetUrls } from '../../src/lib/media';
import { withPublicOfferDocument } from '../../src/lib/public-offer';

type Node = { nodeName: string; value?: string; attrs?: {name:string;value:string}[]; childNodes?: Node[] };
type Source = { id:number; document_id:string; version:string; path:string; description:string | null; full_text:string | null; learning_mode:string | null; learning_plan:string | null; recommendations:string | null; [key:string]:unknown };
const TITLE: Record<string,string> = {'Для кого подойдет':'audience','Для кого подойдёт':'audience','Учебный план':'learning_plan','Как проходит обучение':'learning_mode','Выдаваемые документы':'documents','Рекомендации':'recommendations'};
const ORDER = ['audience','learning_plan','learning_mode','documents','recommendations'];
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
/** Keep in sync with rehearse.py; evidence is invalidated by renderer changes. */
export function rendererFingerprint():string {
  const web=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  const paths:string[]=[];
  function collect(dir:string) {
    for (const entry of readdirSync(dir)) {
      const path=join(dir,entry), stat=lstatSync(path);
      if(stat.isSymbolicLink()) throw new Error('Renderer source must not contain symlinks');
      if(stat.isDirectory()) collect(path);
      // The derivative manifest is generated from each snapshot during build;
      // its media inputs are bound by the sealed capture and media checks.
      else if(stat.isFile() && relative(web,path).replaceAll('\\','/') !== 'src/lib/media-manifest.json') paths.push(path);
    }
  }
  collect(join(web,'src'));
  for(const name of ['astro.config.mjs','package-lock.json','scripts/seminar-migration/render-audit.ts','scripts/seminar-migration/rehearse.py','tests/seminar-real-migration.migration.test.ts','tests/seminar-separate-fields.migration.test.ts']) paths.push(join(web,name));
  const out=createHash('sha256');
  for(const path of paths.sort((a,b)=>relative(web,a)<relative(web,b)?-1:relative(web,a)>relative(web,b)?1:0)) {
    if(lstatSync(path).isSymbolicLink()) throw new Error('Renderer source must not contain symlinks');
    const digest=createHash('sha256').update(readFileSync(path)).digest('hex');
    out.update(relative(web,path).replaceAll('\\','/')+'\0'+digest+'\n');
  }
  return out.digest('hex');
}
function text(n:Node):string { return n.nodeName === '#text' ? n.value ?? '' : (n.childNodes ?? []).map(text).join(''); }
function walk(n:Node, fn:(n:Node)=>void) { fn(n); for(const c of n.childNodes ?? []) walk(c,fn); }
const normal = (s:string) => s.replace(/\s+/gu,' ').trim();
function facts(html:string) {
  const root = parseFragment(html) as unknown as Node;
  const refs:string[]=[]; const ids:string[]=[]; const semantic:string[]=[];
  const meaningful=new Set(['p','h1','h2','h3','h4','h5','h6','ul','ol','li','strong','b','em','i','blockquote','table','thead','tbody','tr','th','td','a','img','video','iframe','source','br']);
  walk(root, n => { if(meaningful.has(n.nodeName)) semantic.push(n.nodeName); for(const a of n.attrs ?? []) { if(['href','src','srcset','poster'].includes(a.name)) refs.push(`${n.nodeName}:${a.name}:${a.value}`); if(a.name==='id') ids.push(a.value); if(['alt','title','aria-label'].includes(a.name)) refs.push(`${n.nodeName}:${a.name}:${a.value}`); } });
  return {text:normal(text(root)),refs,ids,semantic};
}
function sanitise(html:string) { const safe=cleanBodyHtml(html,{sourceType:'seminar',sourceId:'migration-audit'}); return terminalSanitize(safe.html,'authenticated',{sourceType:'seminar',sourceId:'migration-audit'}); }

function documentProjection(html:string) {
  const root=parseFragment(html) as unknown as Node; let details:Node | undefined;
  walk(root,n=>{if(n.nodeName==='details' && (n.childNodes ?? []).some(c=>c.nodeName==='summary' && normal(text(c))==='Выдаваемые документы')) { if(details) throw new Error('multiple document panels'); details=n; }});
  let documentRefs:string[]=[];
  if(details) { const body={...details,childNodes:(details.childNodes ?? []).filter(c=>c.nodeName!=='summary')}; documentRefs=facts(serialize(body as never)).refs; details.childNodes=(details.childNodes ?? []).filter(c=>c.nodeName==='summary'); }
  return {html:serialize(root as never),documentRefs};
}
/** Read-only diagnostic. A passing comparison is evidence for review, never authorization to write. */
export function audit(source:Source, panelMap:Record<string, Record<string,string>>) {
  const reasons:string[]=[];
  if (!source.path || !source.document_id || !['draft','published'].includes(source.version)) throw new Error('invalid source identity');
  const sections:string[]=[]; const ids:Record<string,string>={}; const fields:Record<string,string>={description:''};
  const htmlParts=[stripLegacySeminarTail(source.description ?? ''),source.full_text ?? '',source.learning_mode ? `<h2>Как проходит обучение</h2>${source.learning_mode}`:'',source.learning_plan ? `<h2>Учебный план</h2>${source.learning_plan}`:'',source.recommendations ?? ''].filter(s=>s.trim());
  const ctx={sourceType:'page',sourceId:source.path};
  const clean=cleanBodyHtml(localizeAssetUrls(htmlParts.join('\n')),{...ctx,panels:withPublicOfferDocument(source.path,panelMap[source.path])});
  const legacy=terminalSanitize(clean.html,'authenticated',ctx);
  const root=parseFragment(legacy) as unknown as Node;
  const aliases: Record<string,string[]> = {}; let pendingAliases:string[]=[];
  const renderNode = (n:Node) => serialize({nodeName:'#document-fragment',childNodes:[n]} as never);
  const containsDetails=(n:Node) => { let found=false; walk(n,x=>{if(x.nodeName==='details') found=true;}); return found; };
  const scan=(child:Node) => {
    if(child.nodeName === 'details') {
      const summary=child.childNodes?.find(n=>n.nodeName==='summary');
      const title=normal(summary ? text(summary) : ''); const key=TITLE[title];
      const id=child.attrs?.find(a=>a.name==='id')?.value ?? '';
      if(!key) { reasons.push(`unknown-section:${title}`); return; }
      if(fields[key] !== undefined) reasons.push(`duplicate-section:${key}`);
      if(!/^section-[1-9]\d*$/.test(id)) reasons.push(`invalid-section-id:${id}`);
      const copy={...child,childNodes:(child.childNodes ?? []).filter(n=>n!==summary)};
      fields[key]=serialize(copy as never); ids[key]=id; aliases[key]=pendingAliases; pendingAliases=[]; sections.push(key);
      return;
    }
    if(containsDetails(child)) {
      if(!['div','section'].includes(child.nodeName)) reasons.push(`unsupported-section-wrapper:${child.nodeName}`);
      const attrs=child.attrs ?? [];
      if(attrs.some(a=>!['id'].includes(a.name))) reasons.push('section-wrapper-has-extra-attributes');
      const wrapperId=attrs.find(a=>a.name==='id')?.value;
      if(wrapperId && /^[A-Za-z0-9_.:-]+$/.test(wrapperId)) pendingAliases.push(wrapperId);
      else if(wrapperId) reasons.push('unsupported-wrapper-anchor');
      for(const n of child.childNodes ?? []) scan(n);
      return;
    }
    if(sections.length && normal(text(child))) reasons.push('content-between-or-after-sections');
    if(pendingAliases.length) { reasons.push('anchor-on-content-outside-section'); pendingAliases=[]; }
    fields.description += renderNode(child);
  };
  for(const child of root.childNodes ?? []) scan(child);
  if(pendingAliases.length) reasons.push('unassigned-anchor');
  if(Object.values(aliases).some(x=>x.length)) reasons.push('additional-legacy-anchors-need-support');
  if(sections.some((key,i)=>i && ORDER.indexOf(key)<ORDER.indexOf(sections[i-1]))) reasons.push('section-order-change');
  if(fields.documents !== undefined) reasons.push('documents-require-separate-structured-review');
  if(source.version === 'draft') reasons.push('draft-sidecar-origin-requires-proof');
  const targetParts = [sanitise(fields.description),...sections.map(key=>`${(aliases[key] ?? []).map(id=>`<span id="${id}"></span>`).join('')}<details id="${ids[key]}"><summary>${Object.entries(TITLE).find(([,v])=>v===key)?.[0] ?? ''}</summary>${sanitise(fields[key])}</details>`)];
  const expected=facts(legacy), candidate=facts(targetParts.join(''));
  // Headings in target have site-provided spelling, so compare text after stripping summaries separately below.
  const contentFacts=(html:string) => { const node=parseFragment(html) as unknown as Node; const remove=(n:Node)=>{n.childNodes=n.childNodes?.filter(c=>c.nodeName!=='summary'); for(const c of n.childNodes ?? []) remove(c);}; remove(node); return facts(serialize(node as never)); };
  const oldContent=contentFacts(legacy), newContent=contentFacts(targetParts.join(''));
  const projected=documentProjection(legacy), projectedContent=contentFacts(projected.html), projectedFull=facts(projected.html);
  if(oldContent.text!==newContent.text) reasons.push('content-text-differs');
  if(JSON.stringify(oldContent.semantic)!==JSON.stringify(newContent.semantic)) reasons.push('content-semantics-differ');
  if(JSON.stringify(expected.refs.filter(x=>!x.includes(':srcset:')))!==JSON.stringify(candidate.refs.filter(x=>!x.includes(':srcset:'))) || expected.refs.filter(x=>x.includes(':srcset:')).some(x=>!candidate.refs.includes(x))) reasons.push('links-or-media-differ');
  if(JSON.stringify(expected.ids)!==JSON.stringify(candidate.ids)) reasons.push('anchors-differ');
  return {id:source.id, document_id:source.document_id,version:source.version,path:source.path,status:'review-only',reasons:[...new Set(reasons)],sections,ids,aliases,source_sha256:hash(JSON.stringify(source)),rendered_sha256:hash(legacy),content_text_sha256:hash(oldContent.text),semantic:oldContent.semantic,expectedIds:expected.ids,refs:expected.refs, nonDocumentTextSha256:hash(projectedContent.text),nonDocumentSemantic:projectedContent.semantic,nonDocumentRefs:projectedFull.refs,documentRefs:projected.documentRefs, candidateRefs:candidate.refs, /* private report */ fields};
}
export function verifyPage(entry: ReturnType<typeof audit>, pageHtml:string, structuredDocuments = false): string[] {
  const root=parseFragment(pageHtml) as unknown as Node; let content:Node | undefined;
  walk(root,n=>{ if((n.attrs?.find(a=>a.name==='class')?.value ?? '').split(/\s+/).includes('seminar-content')) { if(content) throw new Error('multiple seminar content regions'); content=n; } });
  if(!content) return ['missing-seminar-content'];
  const originalHtml=serialize(content as never);
  const pageProjection=structuredDocuments ? documentProjection(originalHtml) : null;
  if(pageProjection) content=parseFragment(pageProjection.html) as unknown as Node;
  const full = facts(serialize(content as never));
  const remove=(n:Node)=>{n.childNodes=n.childNodes?.filter(c=>c.nodeName!=='summary'); for(const c of n.childNodes ?? []) remove(c);}; remove(content);
  const withoutSummaries = facts(serialize(content as never));
  const result:string[]=[];
  if(hash(withoutSummaries.text)!==(structuredDocuments ? entry.nonDocumentTextSha256 : entry.content_text_sha256)) result.push('actual-page-text-differs');
  if(JSON.stringify(withoutSummaries.semantic)!==JSON.stringify(structuredDocuments ? entry.nonDocumentSemantic : entry.semantic)) result.push('actual-page-semantics-differ');
  if(JSON.stringify(full.ids)!==JSON.stringify(entry.expectedIds)) result.push('actual-page-ids-differ');
  const oldRefs=structuredDocuments ? entry.nonDocumentRefs : entry.refs;
  if(JSON.stringify(full.refs.filter(x=>!x.includes(':srcset:')))!==JSON.stringify(oldRefs.filter(x=>!x.includes(':srcset:'))) || oldRefs.filter(x=>x.includes(':srcset:')).some(x=>!full.refs.includes(x))) result.push('actual-page-media-or-links-differ');
  if(pageProjection) { let i=0; for(const ref of pageProjection.documentRefs) if(ref===entry.documentRefs[i]) i++; if(i!==entry.documentRefs.length) result.push('document-media-or-links-differ'); }
  return result;
}
/** Verify unchanged separately-entered CMS fields against the actual structured page. */
export function verifySeparateFields(entry:ReturnType<typeof audit>, source:Source, pageHtml:string): string[] {
  const result:string[]=[];
  if(entry.sections.length || source.recommendations) return ['unsupported-existing-sections'];
  const intro=sanitise(localizeAssetUrls([stripLegacySeminarTail(source.description ?? ''),source.full_text ?? ''].filter(Boolean).join('\n')));
  const blocks=[['learning_mode','Как проходит обучение'],['learning_plan','Учебный план']] as const;
  const bodies=blocks.map(([key,title])=>({key,title,html:source[key] ? sanitise(localizeAssetUrls(source[key] as string)) : ''})).filter(x=>x.html);
  const reconstituted=facts([intro,...bodies.map(x=>`<h2>${x.title}</h2>${x.html}`)].filter(Boolean).join('\n'));
  if(hash(reconstituted.text)!==entry.content_text_sha256 || JSON.stringify(reconstituted.semantic)!==JSON.stringify(entry.semantic) || JSON.stringify(reconstituted.refs)!==JSON.stringify(entry.refs) || JSON.stringify(reconstituted.ids)!==JSON.stringify(entry.expectedIds)) result.push('separate-fields-do-not-reconstitute-legacy-render');
  const root=parseFragment(pageHtml) as unknown as Node; let content:Node | undefined;
  walk(root,n=>{if((n.attrs?.find(a=>a.name==='class')?.value ?? '').split(/\s+/).includes('seminar-content')) {if(content) throw new Error('multiple content regions');content=n;}});
  if(!content) return [...result,'missing-seminar-content'];
  const sections=(content.childNodes ?? []).filter(n=>n.nodeName==='details');
  if(sections.length!==bodies.length) result.push('unexpected-section-count');
  const introActual={...content,childNodes:(content.childNodes ?? []).filter(n=>n.nodeName!=='details')};
  const before=facts(intro), after=facts(serialize(introActual as never));
  if(JSON.stringify(before)!==JSON.stringify(after)) result.push('intro-differs');
  for(const body of bodies) {
    const matches=sections.filter(n=>n.childNodes?.some(c=>c.nodeName==='summary' && normal(text(c))===body.title));
    if(matches.length!==1) {result.push(`missing-or-duplicate:${body.key}`); continue;}
    const section={...matches[0],childNodes:(matches[0].childNodes ?? []).filter(n=>n.nodeName!=='summary')};
    if(JSON.stringify(facts(body.html))!==JSON.stringify(facts(serialize(section as never)))) result.push(`field-differs:${body.key}`);
  }
  return result;
}
if(process.argv[1]?.endsWith('render-audit.ts')) {
 const [inputPath,panelPath,outputPath]=process.argv.slice(2); if(!inputPath||!panelPath||!outputPath) throw new Error('usage: render-audit.ts INPUT SIDECAR OUTPUT');
 const input=JSON.parse(readFileSync(inputPath,'utf8')); const bytes=readFileSync(panelPath); const digest=hash(bytes.toString('utf8')); if(digest!=='db77136e25d403c16d0d38b488578a92adcf0b8361b5c2b1afa9dac52346e8ff') throw new Error('sidecar digest mismatch');
 const panels=JSON.parse(localizeAssetUrls(bytes.toString('utf8'))); const entries=input.map((e:{source:Source})=>{ try { return audit(e.source,panels); } catch (error) { return {id:e.source.id,document_id:e.source.document_id,version:e.source.version,path:e.source.path,status:'blocked',reasons:['render-failed'],error:error instanceof Error ? error.message : 'unknown error'}; } });
 writeFileSync(outputPath,JSON.stringify({version:1,sidecar_sha256:digest,entries},null,2),{mode:0o600,flag:'wx'});
}
