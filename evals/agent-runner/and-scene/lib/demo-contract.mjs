// The canonical demo the fixture requires the candidate to deliver.
//
// The nine step titles and their order are normative: they define the
// `verification-sample-outline` hard gate and the canonical-content criteria.
// They live here rather than inside one evaluator because both the static
// source scan and the live browser evaluation must agree on the same outline.

export const DEMO_STEP_TITLES = [
  'You have a topic',
  'The skill interviews you',
  'Answers become steps',
  'The deck grows',
  'You set the depth',
  'It assembles the scene',
  'It checks its own work',
  'Changed your mind? Loop it.',
  "You're looking at one",
]

export const DEMO_CONTRACT = {
  route: 'how-to-make-a-presentation',
  step_titles: DEMO_STEP_TITLES,
  step_count: DEMO_STEP_TITLES.length,
}
