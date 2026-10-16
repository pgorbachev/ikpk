// The executable implementation stays in cms/scripts so its existing focused CLI
// and tests continue to use the same logic. This packaged entrypoint is the exact
// immutable payload named by the release plan.
export { applyClassification as apply } from '../../../scripts/institute-method-author-classification.mjs';
