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

| Use                                             | Model                                        |
| ----------------------------------------------- | -------------------------------------------- |
| Generation, reference solution, judge, analysis | `muse-spark-1.3` (fallback `muse-spark-1.2`) |
| The interviewer (spoken, streamed)              | `muse-wonder-1.0` (fallback Muse Spark)      |
| Listening to the candidate                      | `muse-voice-transcribe-1.0`                  |
| Development and benchmarks with fictional data  | `muse-spark-1.3-contributor`                 |

Candidate code and answers are never sent to a Contributor-mode model (Meta may
train on its content). Measured on three job offers: 74 to 105 s and about $0.07
to $0.10 per assessment.

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
| `deno task llm:interview-eval`           | Oracle against six kinds of simulated candidates, its rules checked   |
| `deno task all`                          | type-check, lint and tests                                            |

`llm:generate` takes `--file=fixtures/offers/roomly.txt` (or `stockly.txt`),
`--level`, `--duration`, `--skills`, `--model` and `--runs`.

## Environment

| Variable             | Role                                                      |
| -------------------- | --------------------------------------------------------- |
| `MODEL_API_KEY`      | Meta Model API key (`LLM_…`)                              |
| `MODEL_NAME`         | main model, default `muse-spark-1.3`                      |
| `MODEL_FALLBACK`     | fallback model, default `muse-spark-1.2`, empty for none  |
| `MODEL_EFFORT`       | default reasoning effort, `low`                           |
| `MODEL_API_BASE_URL` | default `https://api.meta.ai/v1`                          |
| `DEMO_ACCESS`        | `1`: a demo account can be signed in without a password   |
| `DATABASE_PATH`      | SQLite file (`:memory:` in tests)                         |
| `RESEND_API_KEY`     | e-mail of the personal link of a candidate (Resend)       |
| `RESEND_FROM`        | sender, a verified domain, e.g. `Defendable <hi@you.com>` |

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
