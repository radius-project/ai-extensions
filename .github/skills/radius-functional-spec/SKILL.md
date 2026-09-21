---
name: radius-functional-spec
description: 'Author a NEW functional spec for a planned user-facing capability in the ai-extensions repo — what the developer experiences, screen by screen. Use when the user asks for a functional spec, product spec, UX spec, or a document describing the user experience and behaviors of a feature (e.g. AWS support in the canvas, a new onboarding flow). Choose this over radius-design-doc whenever the audience is product rather than engineering: a functional spec contains no Design, API, Implementation, Test plan, Security, or Development plan sections.'
argument-hint: 'The capability to specify, plus the shipped feature it should reach parity with (or the closest existing experience)'
user-invocable: true
---

# Author a functional spec

Write a **functional spec** for a planned user-facing capability in `radius-project/ai-extensions`: every screen the developer meets, in the order they meet them, and what the product does at each one. The audience is product. The question it answers is *what does a developer experience*, never *how is it built*.

Output goes to `docs/design/YYYY-MM-short-name.md` using [`docs/design/functional-spec-template.md`](../../../docs/design/functional-spec-template.md). For a worked example, see the AWS support spec in [pull request #839](https://github.com/radius-project/ai-extensions/pull/839) (`docs/design/2026-09-aws-support-canvas.md` once merged).

## Functional spec or design doc?

| You want to…                                                 | Use                                                |
|--------------------------------------------------------------|----------------------------------------------------|
| Specify **what the developer experiences** on each screen    | **this skill**                                     |
| Propose **how to build it**, weigh options, pick an approach | [radius-design-doc](../radius-design-doc/SKILL.md) |
| Explain how something **already works**                      | `radius-architecture-documenter`                   |

The two documents are complements, not competitors. A functional spec settles the experience; a design doc settles the mechanism. Both may exist for one feature, and the functional spec is written first — it is the input to the design doc, not a summary of it.

**Do not merge them.** The design-note template requires `Design`, `API design`, `Implementation details`, `Test plan`, `Security`, `Compatibility`, `Monitoring and logging`, and `Development plan`. A functional spec contains **none** of these. If the user asks for "a spec" and the content is user-facing, write a functional spec and say which genre you chose.

## When to use

- A new user-facing capability: a new cloud provider, a new onboarding flow, a new canvas page or wizard.
- A significant change to an existing experience where the screens, controls, or messages change.
- Any work where the real risk is ambiguity about behavior rather than uncertainty about implementation.

Do **not** use this skill for internal refactors, packaging changes, or anything with no user-visible surface. Those need a design doc or nothing at all.

## Inputs

1. **The capability** to specify.
2. **A parity baseline** — the shipped feature the new one should match. Almost every capability here has one (Azure for a new cloud, an existing wizard for a new one). If there is genuinely none, say so; the spec then leans harder on scenarios and screenshots.
3. **Screenshots or a live build**, if one exists. Ask for them. See Step 2.
4. **A prototype, if one exists — and its status.** If the user points at prototype code, confirm in writing: *the prototype shows what is possible; this spec decides what should happen.* Never let prototype behavior settle a product question.

## The section set

Exactly these sections, in this order. Do not add engineering sections; do not drop a required one.

| Section                    | Holds                                                                                                      |
|----------------------------|------------------------------------------------------------------------------------------------------------|
| `## Overview`              | What the capability is and who it is for, in a few sentences                                               |
| `## Terms and definitions` | Only terms the reader cannot be assumed to know. Delete rows that define the obvious                       |
| `## Objectives`            | `### Goals` (user outcomes first, parity after), `### Non-goals`, `### User scenarios`, `### Dependencies` |
| `## User experience`       | The numbered journey. The heart of the document                                                            |
| `## Error handling`        | What the developer is told when something fails, grouped by journey step                                   |
| `## Open questions`        | Genuinely undecided product questions only                                                                 |

`Risks`, `Scope`, and `Alternatives considered` are **not** part of this template. A Definition of done under `Goals` does the work of a scope section. Do not reintroduce them.

## Procedure

### Step 1 · Confirm the genre and the baseline

State which genre you are writing and why. Name the parity baseline. If the user asked for "a plan or a spec", pick one explicitly rather than producing a hybrid — a hybrid costs more to unwind than it saves.

### Step 2 · Get the screenshots first

Capture or request the flow end to end **before** writing the journey. Screenshots are the cheapest correctness mechanism in the document: they fix the screen order, they show the real controls, and they make invented UI copy impossible to sustain.

- Store them in `docs/design/YYYY-MM-short-name/`, named for the step (`wizard-step-2-environment-aws.png`).
- Write alt text that describes what is on screen, including the strings visible in it.
- Where a screenshot does not exist yet, leave a marked placeholder saying what it should show. Do not substitute ASCII art — it drifts from the product silently and invites invented copy.

### Step 3 · Establish the parity baseline from shipped code

Read the shipped feature before describing it. For each screen, record what it does today and cite the file. This is the only part of the process that reads code in depth, and it reads the **baseline**, not the new work.

### Step 4 · Draft the skeleton, then stop

Produce only the section headings and the journey step list. Stop and get agreement.

This checkpoint is the highest-value moment in the process. A wrong genre or a wrong journey shape costs one turn here and dozens later.

### Step 5 · Write the journey

Number the steps in the order the developer meets them (`### Step 1 · Model the application`). Each step gets:

- **An opener that states the developer's situation**, not the mechanism. "A developer arrives with source code and no environment" — not "Environment creation is a two-step wizard."
- **What the developer does**, and what the product does in response.
- **A screenshot** (or a marked placeholder).
- **At most one parity table**, six rows or fewer.

Keep each step to roughly five paragraphs. A step that needs more is usually two steps, or is carrying mechanism that belongs nowhere in this document.

Place material where the developer meets it. A view that only means something after deployment belongs with deployment, not with the screen that precedes it.

### Step 6 · Write error handling against the journey

Group failures by the step that produces them, and give each row the condition and what the developer is told. Do not record who acts internally — that is mechanism. If a condition has no message, that is a finding: say what the message should be.

### Step 7 · Trim, then audit grounding

- Delete anything the prose already says. Parity tables attract rows that restate the paragraph above them.
- Check every backticked string against the code that renders it.
- Check every parity row still records a difference.
- Check every **(new)** marker is still accurate.

### Step 8 · Review, lint, and open a pull request

Run a product-owner review (`/rubber-duck` framed as a PO) on the full draft before the pull request. Then run the `radius-markdown-lint` skill. The spec is reviewed on its own pull request, separate from any implementation. A docs-only change needs no changeset — see `monorepo-changeset`.

## Writing rules

These are the rules that are expensive to discover late.

### Voice

- **Every heading opens with the developer's situation or need.** Never "This section…", never "Section 3 reports…", never a feature inventory.
- **Product-owner register.** State behavior as a requirement. Drop hedges — "worth considering", "it may be useful to", "reading it plainly".
- **Declarative present tense.** "The button stays unavailable until the profile verifies." Avoid "must"; the document is the requirement, so the word adds nothing.
- **No build status.** "Shipped", "in progress", and milestone references date the document within a sprint.

### Parity tables

- A row records a **difference**. Delete any row whose new-capability column reads "the same, unchanged" — the absence of a requirement is not a requirement.
- Where several rows would all say "no change", replace them with one sentence above the table.
- One table per step, six rows or fewer. A longer table is a sign the step is carrying implementation detail.

### Grounding

- **Quoted copy is real copy.** Every string in backticks is a string the product renders. If you have not read it in the code, do not quote it.
- **The baseline is read, the new capability is decided.** Describe shipped behavior from code. Describe new behavior as what the product *will* do. Never write "Radius supports X" about behavior this spec is proposing.
- **A prototype is evidence, never authority.** If prototype behavior looks wrong, specify the right behavior and note the gap. Do not describe a prototype defect as a product rule, and do not frame a product decision as a bug report.
- **Mark unbuilt behavior** with a bold **(new)** marker so a reader can tell specification from description.
- **Keep code paths out of the journey.** A file path mid-sentence serves an engineer, not a product reader. Cite the baseline where a claim would otherwise be unverifiable, and keep it brief.

### Length

400–500 lines for a capability the size of a new cloud provider. If the draft is materially longer, the cause is almost always engineering detail that belongs in a design doc, or tables restating prose.

## Verification

- The file is `docs/design/YYYY-MM-short-name.md`; assets are in the matching directory.
- The section set matches the table above — no `Design`, `API design`, `Implementation details`, `Test plan`, `Security`, `Compatibility`, `Monitoring and logging`, `Development plan`, `Risks`, or `Scope`.
- Journey steps are numbered and ordered as the developer meets them; every step opens with the developer's situation.
- Every screenshot resolves, or is a marked placeholder saying what it should show. No ASCII mocks.
- Every backticked UI string is real. Every parity row records a difference. Every **(new)** marker is accurate.
- Error handling is grouped by journey step and states what the developer is told.
- Open questions are undecided **product** questions — not engineering tasks, and not questions the document already answers.
- Markdown lints clean and prose is not hard-wrapped (`radius-markdown-lint`).
