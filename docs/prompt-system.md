# The prompt system

Three jobs, one shared foundation, and a rule that governs all of it: **the model may never invent work.**

That isn't a style preference. The output of this product goes to someone's manager, or attaches to an invoice. A tool that gets caught embellishing once is finished — so "don't fabricate" had to be enforced at the prompt level, repeatedly, in the specific ways models actually drift.

## Composition

Every generation composes a shared `CORE` block with a mode-specific block:

```
PARSE            → free text → discrete work events
CORE + DAILY     → one capture → that day's account
CORE + RANGE     → many sessions → a period report
```

`CORE` sets the voice and the honesty contract. It opens:

> *You are a ghostwriter with a historian's discipline. You write on behalf of a working professional, in their voice, turning their logged work into an account they can send as their own. The ghostwriter half means the words must sound like the person wrote them — first person, natural, confident. The historian half means the account must be accurate, evidence-bound, and honest about what is known versus inferred.*

`CORE` is composed **last**, so it wins conflicts with mode blocks. That ordering is deliberate and it has a consequence worth documenting: when a mode needed a genuine exception to a `CORE` rule, the exception had to be written *into* `CORE` itself. Otherwise `CORE` would land afterward and silently override it — a bug that would look like the model ignoring instructions.

## Versioning

```js
const PROMPT_VERSION = {
  daily: { en: `${MODEL}/daily-8-en`, es: `${MODEL}/daily-8-es` },
  range: `${MODEL}/range-5`,
  parse: `${MODEL}/parse-3`,
};
```

**The model is part of the version string, deliberately.** A prompt version alone would claim two summaries are comparable when a model swap had already made them different — the pinned model is as much an input as the prompt text.

Every generated summary is stamped with its version and stored in `original_summary`, a column written once and never updated. User edits go to a separate column. That gives a permanent evaluation corpus: *this is what the writing looked like under these exact conditions*, and the diff between original and edited is the clearest signal available about what the model gets wrong.

`daily` is versioned per language because the prompts forked (below) and now evolve independently — two prompts producing two populations of output, which must be labelled as two or the comparison is quietly ruined.

## How changes were evaluated

Prompt changes shipped through a loop that ended up mattering more than any individual rule:

1. Generate N outputs on real, varied inputs — before and after.
2. Have a **second model** review them blind, with the outputs anonymized so it couldn't tell which was the change.
3. Only then deploy.

The sample size was set by failure: N=3 got burned twice by ordinary generation variance before it was raised to 6. Two summaries differing is not evidence; it's the noise floor.

Every prompt change goes through the second-model review before deploy — a practice adopted after three changes shipped without it mid-iteration and two of them carried real defects.

## The Spanish fork

The most interesting failure in the project.

The English prompts taught first-person voice through **English surface patterns**: does the sentence use "I" or "my"? That test is *vacuously true* in Spanish. Spanish is pro-drop — grammatically correct sentences omit the subject pronoun entirely, so "lacks I/my" describes perfectly good Spanish as readily as bad.

Running the shared prompt on Spanish input produced invented collaborators — *"hicimos el standup con el equipo"* ("we did standup with the team") — in **six out of six runs**, on input that never mentioned a team. The voice rule wasn't being ignored; it was being satisfied by a test that meant nothing in the target language, and the model filled the gap with a plural that felt natural.

The fix was not translation. Translating the rules would have carried the same broken test across. It was a **fork with native exemplars**: rules taught through Spanish surface patterns, showing that *"Terminé el borrador"* **is** first person, and naming the constructions to avoid by example. A blind review preferred the forked output roughly 70/30.

Language selection is a **wordlist-and-accent heuristic in code**, not a model call — deterministic, testable offline, free, and biased toward English when ambiguous. One less nondeterministic hop in the pipeline.

## The digest doctrine

The most common failure in daily summaries wasn't fabrication — it was the model restating the entries table as prose. Every summary already ships above a table of the entries; a paragraph that lists the same items in sentence form adds length and no information.

The governing rule became: **the prose is a summary, not a second list.** The table owns the inventory. The prose weaves — but only through relationships the entries actually support. An early draft of that rule taught the opposite by accident: its example wove two independent tasks into a causal sequence, which taught the model to invent connective tissue. The corrected version says it outright: *let independent work stand as independent.*

## The root cause worth remembering

The most stubborn defect in the whole system: daily summaries kept narrating **how long things took** — "the bulk of the morning went to…" — despite three separate rules forbidding exactly that. Durations belong to the table, never the prose, because a duration in narrative form is one step from a proportion the data can't support.

The cause wasn't a weak rule. It was a **positive example inside `CORE`** — a sentence demonstrating good work-led phrasing that happened to contain the banned time-share construction while illustrating something else entirely. The model was following the example over the rule, which is what models do.

The generalizable lesson: **your examples are stronger than your instructions.** Audit them against your own bans.

## An incident

A prompt edit removed a region of the file — and swallowed the function that assembled the user message, which happened to sit between the two deletion markers. Every range report threw `user is not defined` for about fifteen minutes.

`node --check` passed. The maiming was syntactically valid JavaScript.

Standing practice since: prompt files are verified by **executing the real functions against a stubbed fetch** before deploy, and any region deletion asserts what the cut does *not* contain.

## Things the prompts refuse to do

- **No durations in prose.** The daily prompt doesn't even receive them; the range prompt receives pre-computed totals and may quote at most one, exactly as supplied — never itemized, never converted into a fraction.
- **No verdicts.** The model doesn't grade the day, call a session "productive," or rank what mattered most.
- **No future work.** The parser excludes plans and to-dos; the record is what happened. The single deliberate exception is a note-to-self stated in the raw text, carried at most once, with its modality frozen — never strengthened into a commitment the person didn't make.
- **No invented duration.** If the user's words don't support a number, the field stays empty. An invented duration becoming a line on an invoice is a liability problem, not a UX nitpick.
