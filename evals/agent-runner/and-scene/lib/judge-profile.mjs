import { JUDGE_REASONING_EFFORT } from '../../../lib/panel-judging/codex-invoker.mjs'
export const PRODUCT_JUDGE_PROFILE = Object.freeze({
  protocol: 'cross-family-panel-v2',
  panel: Object.freeze([
    Object.freeze({ family: 'claude', model: 'claude-sonnet-5-5', effort: JUDGE_REASONING_EFFORT }),
    Object.freeze({ family: 'claude', model: 'claude-sonnet-5-5', effort: JUDGE_REASONING_EFFORT }),
    Object.freeze({ family: 'codex', model: 'gpt-6.1-sol', effort: JUDGE_REASONING_EFFORT }),
  ]),
  decider: Object.freeze({ family: 'claude', model: 'claude-opus-5-5', effort: JUDGE_REASONING_EFFORT }),
})
