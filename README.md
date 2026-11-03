# Defendable

**AI can write the code. Can the candidate defend it?**

[**Try the live app**](https://defendableapp.com) ·
[**Watch the demo (2:39)**](https://www.youtube.com/watch?v=qP4XjzuXGFY)

A recruiter pastes a job offer. Defendable generates a practical task and its
tests, checks them in a sandbox, and lets the candidate build it with any AI
tool: an HTTP API in TypeScript, or a program that reads and writes text, in
TypeScript or in Python, as the candidate chooses. Then an AI interviewer talks
with the candidate, by voice, about their own code. The report separates
verified facts from AI interpretations, with no overall score: the decision
stays human.

Built for the Meta Global AI Developer Hackathon, with Meta's models.

## What existed before, what was built here

- **Before the hackathon**, in Defendable 1.0 (a private repository): the
  concept, the UI pages and a first backend (accounts, assessment generation
  and review, the candidate journey, a TypeScript sandbox, written reports).
  The files this project builds on are published unchanged as an extract,
  [defendable-pre-event](https://github.com/Mirak29/defendable-pre-event), taken from the last pre-event commit of
  Defendable 1.0 (`c7bc119`, 2026-09-29).
- **Built during the hackathon**, in this repository: 61 new files, and the
  changes to 112 of the 122 pre-event files, 3 of them removed (one patch). Every AI step moved to
  Meta's models, the live voice interview with Oracle (transcription and voice),
  hidden tests checked against planted flaws, program assessments in TypeScript
  and Python, the evidence report with its second check, the product in
  English, the deployment and the evaluations.

## How this repository is organised

| Path | What it is |
| --- | --- |
| `patches/pre-event.patch` | the changes made during the event to the pre-event files |
| every other file | created during the event |
| `setup.sh` | rebuilds the full app in `./app`: downloads the extract at its pinned commit, applies the patch, adds the new files |

The extract is pinned in `setup.sh` (`PRE_EVENT_COMMIT`); nothing from before the
event is stored in this repository or in its history.

## Try the product

1. Open the [live app](https://defendableapp.com) and choose **Try with the demo
   account** on the sign-in page. No account or API key is needed to use the
   hosted demo.
2. Create a **New assessment** from a job offer (examples in
   [fixtures/offers/](fixtures/offers/)), review the brief and automatic checks,
   then approve it and create a candidate link.
3. Open the candidate link, build and submit the solution, then talk with Oracle
   using a microphone and headphones. Return to the recruiter space to inspect
   the report: test results, quotes, code evidence and follow-up questions.

The full journey takes longer than the demo video. Generation and the interview
use live model calls. A fresh local installation starts with an empty company
space.

## Run it

Three ways, from the quickest to the most hackable. Each one opens
<http://localhost:8000>: on the sign-in page, **Try with the demo account**
enters a company space with no password. Start with **New assessment** and paste
a job offer (examples in [`fixtures/offers/`](fixtures/offers/)).

The Meta model keys make the app call the models live: `MODEL_API_KEY` (Meta
Model API: reports, Oracle, listening) and `BASETEN_API_KEY` (Muse Spark Open:
generation, resume reading, prefill). Without them the app still runs: a step
that has a recorded answer replays it (grey badge), the others say why they
cannot run.

### 1. Pull the published image (nothing to build)

Docker only. The image is built and published by GitHub at every push to
`main`.

```bash
cat > defendable.env <<'ENV'
REDIRECT_URI=http://localhost:8000
DEMO_ACCESS=1
MODEL_API_KEY=
BASETEN_API_KEY=
ENV
docker run -d --name defendable -p 8000:8000 -v defendable-data:/data \
  --env-file defendable.env ghcr.io/mirak29/defendable:latest
docker logs -f defendable   # ready at "server-start"
```

Stop with `docker stop defendable`; the database stays in the `defendable-data`
volume.

### 2. Clone the repository and run it with Docker

The same image, built on your machine from the code.

```bash
git clone https://github.com/Mirak29/defendable-hackathon.git
cd defendable-hackathon
./setup.sh   # the full app, in ./app
cd app
cp .env.production.example .env.production
# in .env.production: REDIRECT_URI=http://localhost:8000, the keys, DEMO_ACCESS=1
docker compose up -d --build
docker compose logs -f app   # ready at "server-start"
```

For a server with HTTPS, backups and updates:
[`deploy/README.md`](deploy/README.md).

### 3. Clone the repository and run it with Deno (development)

Deno 2 only (no Node), hot reload, a local SQLite file.

```bash
git clone https://github.com/Mirak29/defendable-hackathon.git
cd defendable-hackathon
./setup.sh   # the full app, in ./app
cd app
deno install
echo 'MODEL_API_KEY=LLM_…' > .env   # git-ignored; add BASETEN_API_KEY= too
deno task dev    # http://localhost:8000
deno task test   # all tests, in-memory SQLite, no network
```

## What it does

- **Verified assessments:** turn a job offer into a task, public and hidden
  tests; check a reference solution and whether hidden tests catch real
  shortcuts.
- **A working candidate environment:** a file editor, sandboxed execution, type
  checks and candidate-written tests. AI tools are allowed and declared.
- **A code-aware voice interview:** Oracle asks about the submitted solution,
  follows up on explanations and resumes after a connection loss.
- **An evidence-based report:** measured results stay separate from AI
  interpretations. Quotes, code references and test IDs are checked; a second
  model call checks whether evidence supports the interpretation.
- **Human decisions:** suggested follow-up questions and a saved recruiter
  decision, with no overall score or automatic hiring recommendation.

## Meta models

| Use                                                    | Model                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| Generation (need, scenario, tests), reference solution | `muse-spark-open-1026`, **open weights, served by Baseten** |
| Prefill of the form, reading of a resume               | `muse-spark-open-1026`                                      |
| The report (interpretations, checked evidence)         | `muse-spark-1.3` at `high` (fallback `muse-spark-1.2`)      |
| The interviewer Oracle (spoken, streamed)              | `muse-wonder-1.0` (fallback Muse Spark)                     |
| Listening to the candidate                             | `muse-voice-transcribe-1.0`                                 |
| Oracle's voice (not in the Meta Model API)             | `facebook/mms-tts-eng` (Meta MMS-TTS), **on our server**    |
| Development and benchmarks with fictional data         | `muse-spark-1.3-contributor`                                |

**Built with Muse Spark Open** (the Muse Model License asks for this line in the
product, its documentation or its website: it is in the footer of the landing
page).

If the open-weights model fails or has no key, the step falls back to
`muse-spark-1.3` and the trace under the step says so. Each step shows which
model answered, where, and how long it took.

Candidate code and answers are never sent to a Contributor-mode model (Meta may
train on its content).

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
5. **Trap check**: each hidden test says which classic shortcut it catches. A
   model writes, from the reference solution, a variant that takes exactly that
   shortcut while still passing every public test, and the sandbox runs it. A
   hidden test that fails on its variant is "caught"; one that passes on it does
   not protect anything, so the draft is rewritten once from that problem, and
   the approval stays blocked until the recruiter deletes the test or
   regenerates. (Found on a real run: a test that wrote an identifier as `xxx`
   then `XXX` never exercised the shortcut it claimed to catch.)

The prompts live in [`api/prompts.ts`](api/prompts.ts) (API) and
[`api/program-prompts.ts`](api/program-prompts.ts) (program); their JSON
examples and the test grammar are checked against the real parsers by
`api/prompts.test.js`.

## Two kinds of assessment, two languages

The recruiter chooses the type of task when creating the assessment.

| Type                          | What the candidate writes                                              | A test is                                  | Languages            |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ | -------------------- |
| **HTTP API**                  | a `handler(req)` in TypeScript (Deno)                                  | a sequence of HTTP requests and answers    | TypeScript           |
| **Program (input to output)** | a program that reads the standard input and writes the standard output | an input and the exact output it must give | TypeScript or Python |

For a program, the **candidate chooses the language on the welcome page, before
the timer starts**; it is fixed afterwards (the editor opens in it, the files of
the starter, the runs and the checks follow it), and the same link resumes it on
another device. The recruiter picks which languages are offered.

- **The tests do not depend on the language**: an input and an expected output
  (line ends and spaces at the end of lines are ignored). So the fairness check
  needs one reference solution only, written in TypeScript, and the hidden tests
  are the same for everyone. The prompts ask for deterministic outputs and never
  an empty expected output (a program that writes nothing must not pass).
- **TypeScript** runs in the restricted `deno` subprocess of the API assessment.
- **Python** runs in Pyodide (CPython compiled to WebAssembly) inside the same
  restricted `deno`: read access to its own files only, no network, environment,
  subprocess or write access. The candidate's files live in Pyodide's in-memory
  file system, so nothing of the machine is reachable, and the expected outputs
  never enter the sandbox. Measured: about 1.7 s to start, a case that loops is
  stopped after 2 s and the next case gets a fresh worker. The tests of the
  candidate run with `unittest`; syntax errors are shown in the editor with
  their line.
- **Oracle and the report** are told what the candidate wrote (language, kind of
  task) and read the Python files like the TypeScript ones.

A program has one limit: Python's memory is capped by the 2 s time limit only.
Go and Rust are not offered: they need a compiler in an isolated sandbox (Judge0
or Modal Sandboxes), which is a decision for the hosting.

<details>
<summary><strong>Oracle's voice: implementation, license and CPU measurements</strong></summary>

### Oracle's voice

The Meta Model API has no speech synthesis, so the voice is Meta's own open
text-to-speech model, [MMS-TTS](https://huggingface.co/facebook/mms-tts-eng)
(`facebook/mms-tts-eng`, VITS, 36 M parameters, English), run on the server's
CPU in full precision with Transformers.js ([`api/tts.ts`](api/tts.ts)). The
weights are the ONNX conversion of that Meta model published by Hugging Face
([`Xenova/mms-tts-eng`](https://huggingface.co/Xenova/mms-tts-eng), about 110
MB, in the image). MMS-TTS is released by Meta under
[CC-BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/): it is used here
for a non-commercial hackathon prototype. It has a single voice. **The
candidate's browser downloads nothing**: the server cuts what Oracle writes into
pieces (a sentence, the first piece may stop at a comma), spells the digits out
(the model has none in its alphabet), makes each piece while the previous one
plays, and sends it as PCM at the model's own rate (16 kHz, announced once in
the `ready` event) over the interview's WebSocket. The browser plays it (the
Audio API converts to the speakers' rate) and measures its loudness, which moves
Oracle's presence (the blue light). When the candidate speaks over Oracle, the
pieces still in the making are dropped.

What is a Meta model call and what is not, in the interview:

| Part                           | What it is                                            |
| ------------------------------ | ----------------------------------------------------- |
| Listening to the candidate     | Meta model: `muse-voice-transcribe-1.0`               |
| What Oracle says               | Meta model: `muse-wonder-1.0` (fallback Muse Spark)   |
| Oracle's voice                 | Meta model: MMS-TTS, on our server                    |
| Voice when the model is absent | the browser's built-in speech synthesis (not a model) |
| Microphone, audio playback     | browser features (Web Audio), no model                |

If the model is not loaded (`TTS=off`, no weights, an error) the interview falls
back to the browser's own voice.

Measured on an 8-core laptop CPU (i7-11800H), factor = time to make the sound /
length of the sound (below 1 keeps up): **0.17** (four sentences, second round,
fp32), 0.19 inside the Docker image. Loading takes about a second, and the image
starts its voice with the network cut (the weights are in it). The load of
several interviews at once, and the delay in a real interview with this voice,
have **not been measured**. The sentences of an interview are made one after the
other.

</details>

### A second look at the evidence

The report checks every piece of evidence exists (the quote word for word in the
transcript, the lines in the code, the test ids). A reading can still cite real
evidence that does not back what it claims, so a second model call reads each
reading again with **only its evidence** (the quote with the question that came
before it, the lines, the test results) and says whether it backs the status and
the summary. The idea of a check that runs outside the author of the reading
comes from Meta's
[legal agent workshop](https://github.com/meta-models/legal-agent-workshop).

Only a clear "no" changes the report: the status goes down a level, the
confidence to low, and the card says why and asks the reader to look at the
evidence. A reading that the check backs shows "the evidence below backs this
reading"; a check that cannot run is said in the limits.

Measured on the 18 fictional candidates (70 readings,
`deno task llm:eval
--efforts=high --support`), with readings falsified on
purpose for the check:

| Reading                             | backed | "partly" | "no" |
| ----------------------------------- | ------ | -------- | ---- |
| Right readings                      | 77 %   | 23 %     | 0 %  |
| Evidence swapped between two skills | 14 %   | 50 %     | 36 % |
| Status raised to "Demonstrated"     | 5 %    | 44 %     | 51 % |

"No" is the signal: no false alarm on the right readings, and it doubts a third
to a half of the falsified ones. "Partly" is not: it is said as often of right
readings (the excerpts cannot prove that something is absent) as of wrong ones,
so it is recorded and changes nothing. One run of 70 readings per row; the first
prompt, without the rule on absences, doubted 31 % of the right readings
("partly" or "no").

### Conditions of the interview

- **One clock, kept by the server.** The interview lasts 10 minutes from the
  first time it opened (`INTERVIEW_MS`); reloading the page does not restart it.
  When time is over, Oracle hears out a candidate who is speaking, answers them
  in a few words, thanks them and closes. A page reloaded mid-interview resumes
  from the saved conversation instead of restarting the interview.
- **Facts about the session, never a verdict.** The report shows how many times
  the page was left and for how long (building and interview), whether a second
  display was seen (Chromium only, otherwise "unknown"), reloads, and copy
  attempts on the words of the interviewer. These have many innocent causes and
  say nothing about the candidate's understanding; the report says so. Nothing
  is inferred from how the code was written, since AI is allowed.
- **A microphone check and a prepared opening.** Before the interview, the
  candidate tries their microphone (a level that moves, a check once a voice is
  heard) and clicks Start; the 10 minutes start then. Oracle's first words (the
  greeting and an open question on the approach) are written by Muse Wonder
  during the preparation, after the code has run, and its voice is made while
  the transcription connects: the first sound no longer waits for the model nor
  for the transcription. Without them (no key, a failure) they are written live.
- **A silence is not a wait without end.** After a question, a candidate who
  says nothing for 10 seconds (`INTERVIEW_NUDGE_MS`, counted from the end of
  Oracle's voice) is offered, once, to hear it again; still nothing 30 seconds
  after the question (`INTERVIEW_SKIP_MS`) and Oracle moves on to another point.
  The reminder does not restart that deadline. After three consecutive questions
  with no answer, Oracle thanks the candidate and ends the interview. Any words
  reset this count: someone thinking aloud is never cut. Reloading the page
  preserves the consecutive unanswered count.
- **Answer times, per question.** The server records answer timestamps and
  estimates when each question finishes playing from the audio duration (or text
  length for browser speech). It uses these to estimate the wait before an
  answer and relates browser-reported absences to the question that was open.
  The report shows them as facts (a table per question), then Muse Spark reads
  them together as a hypothesis, with alternative explanations such as
  reflection, interruptions or connection problems. Timing alone cannot
  establish an expected answer speed or misconduct. Confidence is never above
  "medium", and a reading that calls it cheating is not kept. Candidates are
  told before they start that their answer times are recorded.

<details>
<summary><strong>Model evaluations: quality, latency and reasoning effort</strong></summary>

### Model choice, measured

Each step runs on the model and the reasoning effort that measured best for it
(`deno task llm:extraction-eval`, `llm:eval`, `llm:generate`,
`llm:interview-eval`; fictional data only; 28 October 2026). Three runs per
case: small differences may reflect run-to-run variation. These are experimental
results on the fictional scenarios tested, not estimates of accuracy on real
candidates. Every effort is a setting you can change per step with
`MODEL_EFFORTS` (for example `report=xhigh,scenario=low`).

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

The overall result ranges from 41 to 45 of 45 on these scenarios. Another
criterion is whether the report notices the planted false claims. At `low`,
Spark 1.3 and Spark Open notice 3 of 6; at `high`, 6 and 5 of 6. **Muse Spark
1.3 at `high`** is the chosen tradeoff: 44 of 45 expected readings, all six
false claims noticed, no evidence dropped and a median of 23 s. It does not have
the highest overall result. `xhigh` roughly doubles its latency without
improving that result. Muse Spark Open at `xhigh` reaches 45 of 45 and notices
all six false claims, but loses more evidence to the checks. Muse Spark 1.2
`low` scored 45 of 45 but only 43 at `medium`: a result I cannot explain, so I
do not build on it. Two criteria of the harder cases were corrected after a
first pass (they punished a reading that described the order hidden in the code,
and asked a skill to carry a claim about persistence that no skill is about);
those two cases were run again on every line.

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

**Generating a program assessment** (input to output), two offers, three runs
each, the efforts written in the code, the model doing every step:

|                        | Muse Spark Open  | Muse Spark 1.3    |
| ---------------------- | ---------------- | ----------------- |
| Six checks, approvable | 6 of 6           | 6 of 6            |
| Draft                  | 38 to 55 s       | 66 to 111 s       |
| Tokens written         | 11,300 to 16,100 | 17,200 to 29,800  |
| Tests (hidden)         | 9 to 12 (2 to 3) | 10 to 11 (2 to 3) |

Both models give a usable assessment every time, with no test excluded by the
fairness check; Muse Spark Open takes about half the time. The step stays on
Muse Spark Open, like the API assessment.

**Prefill and resume**: 5 job offers and 6 resumes with known answers (a
referee's e-mail that must not be taken, a compound name with accents, a name
written surname first, an instruction hidden in the resume), 3 runs each.

| Step, model              | `minimal`     | `low`             | `medium`       |
| ------------------------ | ------------- | ----------------- | -------------- |
| Prefill, Muse Spark 1.3  | 15/15 · 1.8 s | 15/15 · 3.0 s     | 14/15 · 6.1 s  |
| Prefill, Muse Spark Open | 15/15 · 2.3 s | **15/15 · 2.0 s** | 15/15 · 3.7 s  |
| Prefill, Muse Spark 1.2  | 15/15 · 2.7 s | 15/15 · 5.1 s     | 14/15 · 10.1 s |
| Resume, Muse Spark 1.3   | 18/18 · 1.2 s | 18/18 · 1.8 s     | 18/18 · 2.7 s  |
| Resume, Muse Spark Open  | 18/18 · 1.5 s | **18/18 · 1.6 s** | 18/18 · 2.1 s  |
| Resume, Muse Spark 1.2   | 18/18 · 2.3 s | 17/18 · 3.0 s     | 17/18 · 4.1 s  |

On these extraction cases, the lowest tested effort gives correct results for
every model, with median times around 1 to 3 seconds. Higher effort does not
improve the results consistently. These steps run on Muse Spark Open; broader
resume formats and job offers may behave differently.

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

</details>

## Deploying

One Docker image and a `docker-compose.yml` run the whole app on one machine
(API, voice interview, Oracle's voice, sandboxes, SQLite in a volume), with
backups and an optional Caddy for HTTPS. The build loads everything the server
needs offline and checks it works. Step by step:
[`deploy/README.md`](deploy/README.md).

## Development commands

With Deno (method 3 above):

| Command                                  | What it does                                                          |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `deno task llm:check`                    | one small call per model and reasoning level: key, billing, latency   |
| `deno task llm:generate --out=generated` | one real generation, step by step, with cost; writes a readable `.md` |
| `deno task llm:bench`                    | the same fictional inputs through several models and efforts: latency |
| `deno task llm:eval`                     | the report on fictional candidates with expected interpretations      |
| `deno task llm:extraction-eval`          | prefill and resume against known answers, each model at each effort   |
| `deno task llm:interview-eval`           | Oracle against six kinds of simulated candidates, its rules checked   |
| `deno task all`                          | type-check, lint and tests                                            |

`llm:generate` takes `--file=fixtures/offers/roomly.txt` (or `stockly.txt`),
`--level`, `--duration`, `--skills`, `--model`, `--runs` and `--kind=program`.
`llm:interview-eval --program` runs Oracle against a Python program.

## Environment

| Variable             | Role                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `MODEL_API_KEY`      | Meta Model API key (`LLM_…`)                                                                              |
| `MODEL_NAME`         | main model, default `muse-spark-1.3`                                                                      |
| `MODEL_FALLBACK`     | fallback model, default `muse-spark-1.2`, empty for none                                                  |
| `MODEL_EFFORT`       | default reasoning effort, `low`                                                                           |
| `MODEL_API_BASE_URL` | default `https://api.meta.ai/v1`                                                                          |
| `BASETEN_API_KEY`    | Baseten key: runs Muse Spark Open (open weights)                                                          |
| `BASETEN_BASE_URL`   | default `https://inference.baseten.co/v1`                                                                 |
| `MODEL_OPEN`         | open-weights model, default `meta-models/muse-spark-open-1026`                                            |
| `MODEL_OPEN_TASKS`   | steps run on it (comma list, empty for none)                                                              |
| `MODEL_EFFORTS`      | effort per step, e.g. `report=xhigh,scenario=low`                                                         |
| `VOICE_HOLD_MS`      | interview: pause before Oracle speaks, default `900`                                                      |
| `INTERVIEW_MS`       | duration of the interview from its first opening, default `600000` (10 min); a reload does not restart it |
| `INTERVIEW_GRACE_MS` | after that, the longest wait for a turn before Oracle closes, default `45000`                             |
| `INTERVIEW_NUDGE_MS` | silence after a question before Oracle offers to repeat it, default `10000`                               |
| `INTERVIEW_SKIP_MS`  | silence after a question before Oracle moves on, default `30000`                                          |
| `TTS`                | `off` keeps the browser's voice for Oracle (default `on`)                                                 |
| `TTS_MODEL`          | speech model of Oracle, default `Xenova/mms-tts-eng` (Meta MMS-TTS)                                       |
| `VOICE_LAB`          | `on`: the voice lab (`/dev/voice`, demo code) for members; default `off` in production, `on` elsewhere    |
| `DEMO_ACCESS`        | `1`: a demo account can be signed in without a password                                                   |
| `DATABASE_PATH`      | SQLite file (`:memory:` in tests)                                                                         |
| `RESEND_API_KEY`     | e-mail of the personal link of a candidate (Resend)                                                       |
| `RESEND_FROM`        | sender, a verified domain, e.g. `Defendable <hi@you.com>`                                                 |

## Layout

```
api/        server, routes, domain (assessment, reference, sandbox), AI client
  prompts.ts      the prompts and the JSON schemas of the generation
  sandbox.ts      runs the candidate's code in a restricted deno subprocess
  program-sandbox.ts  the same for a program: TypeScript, or Python (below)
  py-runner.ts, py-worker.ts  Pyodide in a worker, one fresh worker per looping case
  program-prompts.ts  the prompts of the program assessment
  test-steps.ts   the readable test format, and the verdicts
fixtures/   the demo assessment (Linkly) and the job offers used to measure
web/        Preact + signals: recruiter, candidate editor, voice interview and report
```

The sandbox runs the candidate's code in a `deno` subprocess: temporary folder,
no network, no environment, no subprocess, no write access, offline modules
only, 10 s and 64 KB at most. Verdicts are computed by the server: the
expectations never enter the sandbox, so the candidate's code cannot fake a
passing test.
