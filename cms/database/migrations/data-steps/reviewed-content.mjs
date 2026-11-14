import { readReviewedDocumentsFile } from './reviewed-documents.mjs';
import { applyContentPlan } from '../../../scripts/content-migration-writer.mjs';

/** Both digests come from a separately reviewed operation receipt. */
export function apply(db,{reviewFilePath,expectedReviewFileSha256,expectedPlanDigest,onApplied}={}) {
  const plan=readReviewedDocumentsFile(reviewFilePath,expectedReviewFileSha256,expectedPlanDigest);
  return applyContentPlan(db,plan,{expectedPlanDigest,onApplied});
}
