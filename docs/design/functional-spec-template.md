# Functional Spec: TODO

<!-- Spec conventions
  Quoted copy is copy the product renders; nothing here is paraphrased or invented.
  Parity tables record differences only — a row saying "the same, unchanged" is noise.
  (new) marks behavior this spec specifies but that is not built yet.
  Prose is present tense and describes what the developer experiences.
-->

| Field    | Value                                             |
|----------|---------------------------------------------------|
| Author   | TODO                                              |
| Issue    | TODO                                              |
| Status   | `Draft` / `In review` / `Approved` / `Superseded` |
| Baseline | The shipped experience this reaches parity with   |

## Overview

<!--
  What the capability is, who it is for, and why it matters — in a few sentences.
  Open with the developer's situation, not with how the system works.
-->

TODO

## Terms and definitions

<!--
  Only terms a product reader cannot be assumed to know, or whose meaning here is
  narrower than its general meaning. Delete rows that define the obvious.
-->

| Term | Meaning |
|------|---------|
| TODO | TODO    |

## Objectives

<!-- One sentence: what this capability sets out to achieve for the developer. -->

TODO

### Goals

<!--
  User outcomes first, parity second. Each goal is something a developer can do
  when this ships, not a task the team performs.
-->

1. TODO

**Definition of done.** TODO — what a developer can do when this is complete, stated so anyone can check it.

### Non-goals

<!--
  What this deliberately does not do, and the consequence of leaving it out.
  A non-goal without a consequence is a list entry, not a decision.
-->

- TODO

### User scenarios

<!--
  Concrete developers with concrete situations. Name the role, what they have,
  what they want, and what the product gives them.
-->

TODO

### Dependencies

<!-- What must exist or be true outside this work for the experience to hold. -->

- TODO

## User experience

<!--
  The longest section, and where the direction set in Objectives becomes concrete.
  Every screen, in the order the developer meets them.
  Number the steps. Each step: the developer's situation, what they do, what the
  product does, a screenshot, and at most one parity table of six rows or fewer.
-->

TODO — one-sentence framing of the journey, then the step list.

1. **TODO** — one line each.

### Step 1 · TODO

<!--
  Open with the developer's situation, never the mechanism.
  Good: "A developer arrives with source code in a repository and no environment."
  Bad:  "Environment creation is a two-step wizard."
-->

TODO

![TODO — describe what is on screen, including the strings visible in it.](YYYY-MM-short-name/step-1.png)

<!-- No screenshot yet? Replace the image with a marked placeholder:
     > **Screenshot needed.** TODO — what it should show.
-->

**Parity with TODO**

<!--
  Differences only. Delete any row whose right-hand column reads "the same,
  unchanged". Where several rows would all say "no change", replace them with a
  single sentence above the table.
-->

| Capability | Baseline today | What this requires |
|------------|----------------|--------------------|
| TODO       | TODO           | TODO               |

### Step 2 · TODO

TODO

<!-- Repeat per step. Keep each to roughly five paragraphs. -->

## Error handling

<!--
  Grouped by the journey step that produces the failure. Give the condition and
  what the developer is told. Do not record who acts internally.
  A condition with no message is a finding: say what the message should be.
-->

### Step 1 · TODO

| Condition | What the developer is told |
|-----------|----------------------------|
| TODO      | TODO                       |

## Open questions

<!--
  Genuinely undecided product questions. Not engineering tasks, and not questions
  the document already answers. Each states the question, why it matters to the
  developer, and what a decision would change.
-->

- **Q1.** TODO
