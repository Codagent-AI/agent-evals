# Labelling brief (v1)

You are one of two independent labellers. Classify every item in the inventory into exactly one class. Work alone: do not read any other `labels-*.json` file in this directory, do not modify any input file, and do not search the web.

## Context

An evaluation gives an agent only the starting prompt below, plus a small starter repository. The agent then writes its own proposal, specifications, design, and test plan, asking a simulated user questions along the way. The simulated user answers from a hidden, reviewed reference change. The agent's definition is then judged item by item against this inventory. Your labels decide which items are graded and how:

- A **mandatory** item is graded as stated. A definition that misses or contradicts it loses credit.
- An **acceptable-alternative** item is graded on its `intent` only. Any reasonable design that achieves the intent passes.
- A **preference** item is not graded.

## Inputs

- `starting-prompt.md`: the exact prompt the agent receives. **Label relative to this prompt.**
- `items.json`: the 120 items. Each has a statement and verbatim source quotes from the reference change, which is the and-scene repository at commit `ad667a965a0e1ea0b028c36c04d57bf0411d30d9`, `openspec/changes/create-and-scene/`. You may read the sources for context. The reference's own emphasis does not decide the class.

## Classes

The test for each item: **would a reasonable user who sent this prompt consider a result that lacks this item, or does it differently, incomplete or incorrect?**

- **mandatory**: Yes, as stated. Choose this when either of these holds:
  - The prompt asks for or clearly hints at the item.
  - Any competent, complete realization of what the prompt asks for needs it: correctness, robustness, error handling, and obviously implied basics in the areas the prompt names.
- **acceptable-alternative**: The underlying need is required, but the reference's specific mechanism, form, structure, or value is one of several reasonable choices. Write an `intent` stating what any acceptable alternative must achieve, without the reference's specifics.
- **preference**: No. The item is opinion, taste, naming, wording, a specific value or layout, or another incidental choice, and a different choice or its absence would not make the result less complete or correct. Use this for exact values and verbatim content that the prompt does not imply, such as specific dimensions, the sample's exact step titles and captions, or specific key bindings beyond common conventions.

## Rules

1. Judge against the prompt and a reasonable user, not against how likely an agent is to think of the item or ask about it.
2. When an item bundles a needed behavior with an incidental value, label by the behavior. Use acceptable-alternative with an intent that omits the value, unless the value itself is implied by the prompt.
3. **Scope exclusions** (`kind: scope-exclusion`): mandatory if adding that scope would clearly be unrequested expansion a user would object to. Preference if including or excluding it would be harmless either way.
4. **Design decisions** (`kind: decision`): mandatory only if the decision's observable consequence is required by the prompt or by correctness. Otherwise acceptable-alternative, with the intent the decision serves, or preference.
5. Prompt hints are deliberately broad. A hinted area makes its core behavior mandatory, but not every detail the reference chose within it.
6. Do not reword, merge, split, or skip items. Label every item exactly once. If an item looks malformed, label it anyway and say so in the rationale.

## Output

Write `labels-<labeller>.json` in this directory, where `<labeller>` is the name you were given (`opus` or `codex`):

```json
{
  "labeller": "<opus|codex>",
  "model": "<model id you are running as>",
  "brief_version": 1,
  "labels": [
    {
      "id": "INV-001",
      "class": "mandatory | acceptable-alternative | preference",
      "intent": "<required for acceptable-alternative; null otherwise>",
      "rationale": "<one or two sentences tied to the prompt>",
      "confidence": "high | medium | low"
    }
  ]
}
```

Before finishing, verify programmatically that the file is valid JSON and that every item ID in `items.json` appears exactly once. Check that every `class` is one of the three values, and that every acceptable-alternative has a non-empty `intent`. Report your class counts and the items you marked low confidence.
