# Defendable

**An AI technical interviewer that understands your code.**

A recruiter pastes a job offer. Defendable generates a practical task and its
tests, checks them in a sandbox, and lets the candidate build the API with any
AI tool. Then an AI interviewer talks with the candidate, by voice, about their
own code. The report separates verified facts from AI interpretations, with no
overall score: the decision stays human.

Built for the Meta Global AI Developer Hackathon, with Meta's models.

- Origin: the concept and a first prototype (Defendable 1.0) were built before
  the hackathon, in a separate private repository. Everything in this repository
  after the first commit is hackathon work (see `git log`).

## Status

| Part                                                                   | State |
| ---------------------------------------------------------------------- | ----- |
| Accounts of a company space (sign-up, sessions, lockout)               | done  |
| Landing page                                                           | done  |
| Meta Model API client (streaming, retries, fallback, schemas)          | done  |
| Generation of an assessment from a job offer (4 steps, fairness check) | done  |
| Sandbox: runs the candidate's code, judges the tests on the server     | done  |
| Recruiter pages (list, new assessment, review, approval, invitation)   | done  |
| Candidate journey (link, consent, editor, submission)                  | done  |
| Voice interview: server, interviewer prompt, test page (`/dev/voice`)  | done  |
| Voice interview inside the candidate journey (Oracle)                  | done  |
| Report (facts, checked interpretations) and human decision             | done  |
| E-mail of the personal link, CV import                                 | done  |

## How an assessment is generated

1. **Need analysis**: level, domain, and how each chosen skill is assessed (HTTP
   tests, code analysis, interview).
2. **Scenario**: a small realistic API, its requirements and constraints, and
   the brief the candidate reads.
3. **Tests**: 8 to 12 HTTP tests in a readable step format; hidden tests target
   the classic shortcut that a quick or AI-generated implementation misses.
4. **Fairness check**: a model writes a reference solution from the candidate
   brief alone, the sandbox runs every test on it, and a judge decides for each
   failure whether the test or the solution is wrong. A test the brief does not
   justify is excluded before the recruiter reviews anything.

The prompts live in [`api/prompts.ts`](api/prompts.ts); their JSON examples and
the test grammar are checked against the real parsers by `api/prompts.test.js`.

## Meta models

| Use                                                    | Model                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| Generation (need, scenario, tests), reference solution | `muse-spark-open-1026`, **open weights, served by Baseten** |
| Prefill of the form, reading of a CV                   | `muse-spark-open-1026`                                      |
| The report (interpretations, checked evidence)         | `muse-spark-1.3` at `high` (fallback `muse-spark-1.2`)      |
| The interviewer Oracle (spoken, streamed)              | `muse-wonder-1.0` (fallback Muse Spark)                     |
| Listening to the candidate                             | `muse-voice-transcribe-1.0`                                 |
| Development and benchmarks with fictional data         | `muse-spark-1.3-contributor`                                |

**Built with Muse Spark Open** (the Muse Model License asks for this line in the
product, its documentation or its website: it is in the footer of the landing
page).

If the open-weights model fails or has no key, the step falls back to
`muse-spark-1.3` and the trace under the step says so. Each step shows which
model answered, where, and how long it took.

Candidate code and answers are never sent to a Contributor-mode model (Meta may
train on its content).

### Model choice, measured

Each step runs on the model and the reasoning effort that measured best for it
(`deno task llm:extraction-eval`, `llm:eval`, `llm:generate`,
`llm:interview-eval`; fictional data only; 28 October 2026). Three runs per
case: a difference of one or two cases is noise, so read the tables as a
direction, not as a benchmark. Every effort is a setting you can change per step
with `MODEL_EFFORTS` (for example `report=xhigh,scenario=low`).

**The report**: 15 fictional candidates whose right reading is known, 3 runs
each (45 readings per line). Eight are easy (a strong candidate, an empty one, a
bluffer, someone who tells a false claim, a prompt injection…). Seven are
harder: two small false claims, a claim that is wrong and then corrected, a
half-truth, an honest "the AI wrote it", a false claim about the tests, a wrong
number of tests, and an order to the model hidden in a comment of the code.

| Model, effort              | Right reading | False claims noticed (6) | Evidence dropped by the checks | Median / p95  |
| -------------------------- | ------------- | ------------------------ | ------------------------------ | ------------- |
| Muse Spark 1.3, `minimal`  | 42 of 45      | 4                        | 2                              | 6.6 / 8.3 s   |
| Muse Spark 1.3, `low`      | 41 of 45      | 3                        | 0                              | 9.8 / 13.8 s  |
| Muse Spark 1.3, `medium`   | 41 of 45      | 4                        | 0                              | 18.8 / 22.9 s |
| **Muse Spark 1.3, `high`** | **44 of 45**  | **6**                    | **0**                          | 23.3 / 30.4 s |
| Muse Spark 1.3, `xhigh`    | 44 of 45      | 6                        | 2                              | 49.5 / 69.3 s |
| Muse Spark Open, `low`     | 41 of 45      | 3                        | 4                              | 8.8 / 10.9 s  |
| Muse Spark Open, `medium`  | 43 of 45      | 4                        | 6                              | 15.4 / 19.1 s |
| Muse Spark Open, `high`    | 44 of 45      | 5                        | 0                              | 21.1 / 28.3 s |
| Muse Spark Open, `xhigh`   | 45 of 45      | 6                        | 5                              | 27.3 / 34.7 s |
| Muse Spark 1.2, `low`      | 45 of 45      | 6                        | 2                              | 17.4 / 21.2 s |
| Muse Spark 1.2, `medium`   | 43 of 45      | 4                        | 0                              | 23.3 / 28.1 s |

The overall score hardly moves (41 to 45 of 45); what moves is the one thing a
recruiter cannot see by themselves: the false claim of a candidate. At `low`,
Spark 1.3 and Spark Open notice 3 of 6; at `high`, 6 and 5 of 6. The report is a
job that runs after the interview, so a few seconds more cost nothing: **Muse
Spark 1.3 at `high`**, the setting with the best score, no evidence dropped and
a median of 23 s. `xhigh` doubles the time for the same result. Muse Spark Open
reaches the same quality at `xhigh` (45 of 45) and is a measured alternative,
but it loses more evidence to the checks. Muse Spark 1.2 `low` scored 45 of 45
but only 43 at `medium`: a result I cannot explain, so I do not build on it. Two
criteria of the harder cases were corrected after a first pass (they punished a
reading that described the order hidden in the code, and asked a skill to carry
a claim about persistence that no skill is about); those two cases were run
again on every line.

**Generating an assessment**: the real pipeline with its six automatic checks
and a reference solution that must pass every test. All 18 generations pass the
six checks and are approvable, at every effort; what changes is the time and, at
`low` on Spark Open, the fairness.

| Model, efforts                           | Draft          | Tokens written   | Unfair tests excluded |
| ---------------------------------------- | -------------- | ---------------- | --------------------- |
| **Spark Open, the efforts of the code**  | **27 to 31 s** | 8,200 to 9,500   | none                  |
| Spark Open, everything at `low`          | 15 to 31 s     | 4,300 to 4,700   | in 2 runs of 3        |
| Spark Open, scenario and tests at `high` | 44 to 63 s     | 13,400 to 20,600 | none                  |
| Spark 1.3, the efforts of the code       | 54 to 66 s     | 14,500 to 17,000 | none                  |
| Spark 1.3, everything at `low`           | 28 to 35 s     | 7,300 to 8,600   | none                  |
| Spark 1.3, scenario and tests at `high`  | 64 to 118 s    | 17,400 to 19,900 | none                  |

A higher effort writes twice the tokens and finds nothing more; `low` on Spark
Open produces tests the fairness check has to remove. The efforts written in the
code (low for the need, medium for the scenario and the tests, high for the
judge) are the best compromise, on Muse Spark Open. The speed gap with Spark 1.3
is mostly the effort: at `low` Spark 1.3 is as fast as Spark Open at its
defaults.

**Prefill and CV**: 5 job offers and 6 CVs with known answers (a referee's
e-mail that must not be taken, a compound name with accents, a name written
surname first, an instruction hidden in the CV), 3 runs each.

| Step, model              | `minimal`     | `low`             | `medium`       |
| ------------------------ | ------------- | ----------------- | -------------- |
| Prefill, Muse Spark 1.3  | 15/15 · 1.8 s | 15/15 · 3.0 s     | 14/15 · 6.1 s  |
| Prefill, Muse Spark Open | 15/15 · 2.3 s | **15/15 · 2.0 s** | 15/15 · 3.7 s  |
| Prefill, Muse Spark 1.2  | 15/15 · 2.7 s | 15/15 · 5.1 s     | 14/15 · 10.1 s |
| CV, Muse Spark 1.3       | 18/18 · 1.2 s | 18/18 · 1.8 s     | 18/18 · 2.7 s  |
| CV, Muse Spark Open      | 18/18 · 1.5 s | **18/18 · 1.6 s** | 18/18 · 2.1 s  |
| CV, Muse Spark 1.2       | 18/18 · 2.3 s | 17/18 · 3.0 s     | 17/18 · 4.1 s  |

These two steps are solved: any model at the lowest effort is right and takes 2
s, and more reasoning only costs time. They run on Muse Spark Open.

**The interview**: six kinds of simulated candidates, twice each (12
conversations per line), the rules of the prompt checked on every turn (one
question, no verdict, no praise, nothing leaked from the tests).

| Model, effort              | Rules kept   | Leaks of a failed test | First word, median / p95 |
| -------------------------- | ------------ | ---------------------- | ------------------------ |
| **Muse Wonder, `minimal`** | **12 of 12** | **0**                  | **1.6 s / 3.5 s**        |
| Muse Wonder, `low`         | 12 of 12     | 0                      | 3.4 s / 8.1 s            |
| Muse Wonder, `medium`      | 11 of 12     | 0                      | 4.4 s / 10.7 s           |
| Muse Spark 1.3, `minimal`  | 4 of 12      | 2                      | 1.1 s / 2.5 s            |
| Muse Spark 1.3, `low`      | 1 of 12      | 0                      | 2.7 s / 5.0 s            |
| Muse Spark Open, `low`     | 7 of 12      | 4                      | 1.9 s / 4.7 s            |
| Muse Spark Open, `medium`  | 0 of 12      | 7                      | 3.3 s / 6.4 s            |

Muse Wonder at `minimal` keeps every rule and answers first; a voice
conversation cannot wait for more. The Spark models name the content of a failed
test or ask two questions at once.

## Getting started

Deno 2 only (no Node).

```bash
deno install
echo 'MODEL_API_KEY=LLM_…' > .env   # your Meta Model API key (git-ignored)
deno task dev           # http://localhost:8000, hot reload
deno task test          # all tests, in-memory SQLite, no network
```

Without `MODEL_API_KEY`, a step that has a recorded answer replays it (grey
badge) and the others fail with a readable error: the app and the tests run
without any key.

| Command                                  | What it does                                                          |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `deno task llm:check`                    | one small call per model and reasoning level: key, billing, latency   |
| `deno task llm:generate --out=generated` | one real generation, step by step, with cost; writes a readable `.md` |
| `deno task llm:bench`                    | the same fictional inputs through several models and efforts: latency |
| `deno task llm:eval`                     | the report on six fictional candidates whose right reading is known   |
| `deno task llm:extraction-eval`          | prefill and CV against known answers, each model at each effort       |
| `deno task llm:interview-eval`           | Oracle against six kinds of simulated candidates, its rules checked   |
| `deno task all`                          | type-check, lint and tests                                            |

`llm:generate` takes `--file=fixtures/offers/roomly.txt` (or `stockly.txt`),
`--level`, `--duration`, `--skills`, `--model` and `--runs`.

## Environment

| Variable             | Role                                                           |
| -------------------- | -------------------------------------------------------------- |
| `MODEL_API_KEY`      | Meta Model API key (`LLM_…`)                                   |
| `MODEL_NAME`         | main model, default `muse-spark-1.3`                           |
| `MODEL_FALLBACK`     | fallback model, default `muse-spark-1.2`, empty for none       |
| `MODEL_EFFORT`       | default reasoning effort, `low`                                |
| `MODEL_API_BASE_URL` | default `https://api.meta.ai/v1`                               |
| `BASETEN_API_KEY`    | Baseten key: runs Muse Spark Open (open weights)               |
| `BASETEN_BASE_URL`   | default `https://inference.baseten.co/v1`                      |
| `MODEL_OPEN`         | open-weights model, default `meta-models/muse-spark-open-1026` |
| `MODEL_OPEN_TASKS`   | steps run on it (comma list, empty for none)                   |
| `MODEL_EFFORTS`      | effort per step, e.g. `report=xhigh,scenario=low`              |
| `VOICE_HOLD_MS`      | interview: pause before Oracle speaks, default `900`           |
| `DEMO_ACCESS`        | `1`: a demo account can be signed in without a password        |
| `DATABASE_PATH`      | SQLite file (`:memory:` in tests)                              |
| `RESEND_API_KEY`     | e-mail of the personal link of a candidate (Resend)            |
| `RESEND_FROM`        | sender, a verified domain, e.g. `Defendable <hi@you.com>`      |

## Layout

```
api/        server, routes, domain (assessment, reference, sandbox), AI client
  prompts.ts      the prompts and the JSON schemas of the generation
  sandbox.ts      runs the candidate's code in a restricted deno subprocess
  test-steps.ts   the readable test format, and the verdicts
fixtures/   the demo assessment (Linkly) and the job offers used to measure
web/        Preact + signals front end (landing and auth; more as it is built)
```

The sandbox runs the candidate's code in a `deno` subprocess: temporary folder,
no network, no environment, no subprocess, no write access, offline modules
only, 10 s and 64 KB at most. Verdicts are computed by the server: the
expectations never enter the sandbox, so the candidate's code cannot fake a
passing test.
