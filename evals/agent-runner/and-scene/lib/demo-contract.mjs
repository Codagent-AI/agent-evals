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

export const DEMO_STEP_CAPTIONS = [
  'It starts with you, a topic, and mild overconfidence.',
  'One question at a time: the topic, the look, then each beat of the story.',
  'Each answer lands as a step card — title, caption, visual — plus what morphs from one step into the next.',
  'Same shapes, new beats. Every answer extends the story without redrawing it.',
  'Spell out every step, or sketch a few and see how it looks. You hold the gate.',
  'Your steps are wired into one evolving scene, drawn with a shared scene kit — ready-made boxes, arrows, and motion that make entities morph.',
  'Before saying done, it builds and renders every step — and fixes what breaks.',
  'Point at a step and ask. The skill edits the scene in place — nothing is redrawn from scratch.',
  'This presentation was built exactly this way. Thanks for watching.',
]

export const DEMO_CONTRACT = {
  route: 'how-to-make-a-presentation',
  step_titles: DEMO_STEP_TITLES,
  step_captions: DEMO_STEP_CAPTIONS,
  step_count: DEMO_STEP_TITLES.length,
}
