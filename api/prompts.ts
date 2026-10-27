// Prompts of the generation of an assessment, and the JSON schemas of their
// answers. They are the heart of the quality of an assessment: each one says
// who the model is, what the software does with its answer, the rules by
// priority, the exact grammar of what the sandbox reads, and a check to do
// before answering. Edit them with the tests of api/assessment.test.js and
// `deno task llm:generate` at hand.
import type { GenerationInput } from '/web/types.ts'

const FENCE = '```'

/* ---------- the model of the assessment designer ---------- */

export const DESIGNER =
  `You are a senior engineer who designs the practical task of a technical assessment for backend developers.

How an assessment works
1. The candidate reads a brief, then builds a small HTTP API in TypeScript (Deno) in the time given, with any AI tool they like.
2. The API is judged by automatic HTTP tests, run against the function handler(req: Request): Promise<Response> exported by src/app.ts. There is no server, no network and no database: the state lives in memory, each test starts from an empty state.
3. Afterwards, an AI interviewer talks with the candidate, by voice, about their own code.
Your answer feeds software, not a person.

Rules, in order of priority
1. Output exactly one JSON object that follows the requested structure: no prose, no markdown fence, no comment, no trailing comma.
2. Fairness: everything a test expects must be deducible from the brief the candidate reads. When in doubt, test less, never more.
3. Faithfulness: the task reflects the business and the responsibilities of the job offer, not a generic exercise.
4. Verifiability: a requirement or a test describes behaviour that can be observed through HTTP requests and responses only.
5. Writing: English, concrete, short sentences, no marketing words. Use the company named in the job offer; if the offer names none, invent a fictional one. Never use the name of a real person.`

const settings = (input: GenerationInput) =>
  [
    `<job_offer>\n${input.jobDescription.trim()}\n</job_offer>`,
    `Seniority asked by the recruiter: ${input.level}`,
    `Time given for the practical task: ${input.durationMin} minutes`,
    `Skills chosen by the recruiter: ${input.skills.join(' | ')}`,
    `Business domain given by the recruiter: ${input.domain || 'none'}`,
    'Imposed format: HTTP API in TypeScript (Deno), in-memory storage, no database, no network, no authentication.',
  ].join('\n')

/* ---------- step 1: need analysis ---------- */

export const needAnalysisPrompt = (input: GenerationInput) =>
  `${settings(input)}

# Task
Analyse the need, then decide how each chosen skill will be assessed.

## level
The seniority the job really asks for, read from the offer (years of experience, scope, autonomy): "junior" (up to about 2 years), "intermediate" (about 2 to 5 years), "senior" (more than 5 years, owns design decisions). If the offer states nothing, use the seniority asked by the recruiter.

## domain
The business domain of the offer in 1 to 4 words (e.g. "Marketing links", "Hotel bookings"). If the recruiter gave one, use it as it is.

## skills
- Return exactly the chosen skills: the same names, written exactly as given, in the same order. None added, none removed.
- importance: "high" if the responsibilities of the offer depend on it; "medium" if it is part of the work but not central; "low" if the offer calls it a plus or a nice-to-have.
- methods: one to three of the following, decided skill by skill.
  - "Tests": automatic HTTP tests can observe it. They run a sequence of requests from an empty state and read status codes, JSON bodies and headers.
  - "Code analysis": it shows in the files the candidate submits (structure, naming, validation helpers, the tests the candidate wrote).
  - "Interview": it needs asking why (design choices, trade-offs, understanding), or the environment prevents doing it (no database, no network, no authentication, no real clock).
  A skill may have several methods. A skill the environment cannot exercise gets only "Interview".
  HTTP tests can NOT observe: concurrency, time passing or expiry, performance, memory, code quality, the tests written by the candidate, any database. Never give "Tests" for those.
- justification: one sentence of 25 words at most that cites something concrete from the offer or from the environment.

# Check before answering
- The skills in your answer are exactly the chosen skills, same names, same order.
- No skill has "Tests" if it is about something HTTP tests cannot observe.
- "level" is one of junior, intermediate, senior.

# Output
One JSON object, for example:
{"level":"intermediate","domain":"Hotel bookings","skills":[{"name":"Data validation","importance":"high","methods":["Tests","Code analysis"],"justification":"The offer asks to reject invalid dates and overlapping bookings."},{"name":"PostgreSQL","importance":"low","methods":["Interview"],"justification":"The offer calls it a plus, and the environment has no database."}]}`

export const needAnalysisSchema = {
  name: 'NeedAnalysis',
  schema: {
    type: 'object',
    required: ['level', 'domain', 'skills'],
    properties: {
      level: { type: 'string', enum: ['junior', 'intermediate', 'senior'] },
      domain: { type: 'string' },
      skills: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'importance', 'methods', 'justification'],
          properties: {
            name: { type: 'string' },
            importance: { type: 'string', enum: ['high', 'medium', 'low'] },
            methods: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['Tests', 'Code analysis', 'Interview'],
              },
            },
            justification: { type: 'string' },
          },
        },
      },
    },
  },
}

/* ---------- step 2: scenario and requirements ---------- */

export const scenarioPrompt = (
  input: GenerationInput,
  skills: unknown,
  instruction?: string,
) =>
  `${settings(input)}
Analysed skills: ${JSON.stringify(skills)}
${
    instruction
      ? `Recruiter instruction (it wins over your own choices): ${instruction}\n`
      : ''
  }
# Task
Write the scenario of a small, realistic HTTP API that a developer can build in ${input.durationMin} minutes with the help of an AI, in the business of the job offer.

## Size
3 to 5 routes and 4 to 7 requirements. Smaller is better than larger: the candidate must finish and still have time to read their own code.

## routes
- method: GET, POST or DELETE only.
- path: starts with "/", parameters written ":name" (never "{name}"), no query string.
- description: what the route does, in a few words.
- codes: every status code this route can answer in the requirements, success and errors, from 1 to 6 codes.

## requirements (R1, R2, …)
- One requirement = one behaviour of the API that an HTTP test can check. Never the quality of the code, never the tests written by the candidate, never performance, concurrency or time.
- statement: precise and testable. It gives the status code of each case it describes (e.g. "409 if the alias already exists"). It names every JSON field the tests send or read, with its type (e.g. the body has a string field "url"; the response has an integer field "clicks"). If the server generates an identifier, it says in which field it is returned.
- why: what the requirement shows about the candidate, in one sentence.
- skills: the skills it concerns, written exactly as in the analysed skills. Only skills whose methods include "Tests" get requirements; the others get none.
- Together, the requirements cover every task named in the job offer that an HTTP test can observe (e.g. "refuses overlapping slots" becomes a requirement). Cover the nominal case, then the errors.

## constraints
- Everything a candidate must know and a test will rely on, one short sentence each, 3 to 8 constraints.
- Reference data the tests assume (rooms, products, users, categories…) with the exact identifiers, in ASCII, e.g. "Existing rooms: room-1, room-2.".
- Every value that has a format (date, URL, identifier, alias) states the format and says what is refused: lengths, allowed characters, accepted schemes.
- Error messages are free: only the status code and a JSON field "error" holding a non-empty string are imposed.
- Always include "State is kept in memory." and a constraint on the response format that names only what applies to your routes (e.g. "JSON responses, except for deletions." when no route redirects).

## candidateBrief
What the candidate reads instead of context and mission.
- context: 2 to 3 sentences, second person ("You join…"), the business and the problem.
- mission: says concretely what the code must do: name the routes in words and the main rules. Never write "implement the missing routes". 600 characters at most.
- No mention of tests, AI, interview or evaluation. No code.

## context and mission (for the recruiter)
- context: 2 to 3 sentences on the business.
- mission: starts with "Your mission:" and summarises the task.

# Check before answering
- Every requirement states its status codes and names its JSON fields.
- Every route appears in at least one requirement, and every status code of a route is justified by a requirement.
- Reference data and formats are in the constraints.
- No requirement is about code quality, tests of the candidate, time or concurrency.
- Requirement skills are spelled exactly as the analysed skills.
- The candidate mission, the constraints and the requirements never contradict each other: re-read each sentence of the mission against every requirement (e.g. if a requirement says a repeated call answers 200, the mission must not say that only some states can be changed).

# Output
One JSON object, for example (another business, to show the shape only):
{"title":"Room booking service","company":"Roomly","context":"Roomly lets companies book meeting rooms. You join the backend team that owns the booking service.","mission":"Your mission: build the booking API with room availability and double-booking protection.","candidateBrief":{"context":"Roomly lets companies book meeting rooms. You join the backend team and take over the booking service.","mission":"Build an HTTP API in TypeScript with Deno: create a booking for a room and a time slot, list the bookings of a room, and cancel a booking. Refuse a slot that overlaps another booking of the same room."},"constraints":["Existing rooms: room-1, room-2.","Dates are ISO 8601 UTC strings (e.g. 2026-05-04T09:00:00Z); any other date is refused with 400.","State is kept in memory.","JSON responses, except for deletions."],"routes":[{"method":"POST","path":"/rooms/:roomId/bookings","description":"Book a slot","codes":[201,400,404,409]}],"requirements":[{"id":"R1","title":"Book a slot","statement":"POST /rooms/:roomId/bookings with the string fields \\"start\\" and \\"end\\" creates a booking and returns 201 with an integer field \\"id\\"; 404 if the room does not exist.","why":"Shows the design of a creation route with a path parameter.","skills":["REST API design"]}]}`

const route = {
  type: 'object',
  required: ['method', 'path', 'description', 'codes'],
  properties: {
    method: { type: 'string', enum: ['GET', 'POST', 'DELETE'] },
    path: { type: 'string' },
    description: { type: 'string' },
    codes: { type: 'array', items: { type: 'integer' } },
  },
}
const requirement = {
  type: 'object',
  required: ['id', 'title', 'statement', 'why', 'skills'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    statement: { type: 'string' },
    why: { type: 'string' },
    skills: { type: 'array', items: { type: 'string' } },
  },
}
export const scenarioSchema = {
  name: 'Scenario',
  schema: {
    type: 'object',
    required: [
      'title',
      'company',
      'context',
      'mission',
      'candidateBrief',
      'constraints',
      'routes',
      'requirements',
    ],
    properties: {
      title: { type: 'string' },
      company: { type: 'string' },
      context: { type: 'string' },
      mission: { type: 'string' },
      candidateBrief: {
        type: 'object',
        required: ['context', 'mission'],
        properties: {
          context: { type: 'string' },
          mission: { type: 'string' },
        },
      },
      constraints: { type: 'array', items: { type: 'string' } },
      routes: { type: 'array', items: route },
      requirements: { type: 'array', items: requirement },
    },
  },
}

/* ---------- step 3: evaluation tests ---------- */

export const testsPrompt = (
  scenario: { routes: unknown; requirements: unknown; constraints: unknown },
  instruction?: string,
) =>
  `<scenario>
${JSON.stringify(scenario)}
</scenario>
${
    instruction
      ? `Recruiter instruction (it wins over your own choices): ${instruction}\n`
      : ''
  }
# Task
Write 8 to 12 HTTP evaluation tests for this scenario.

## What the candidate knows
The candidate reads only the requirements, the routes and the constraints of the scenario, and the public tests. A test may expect only what these say explicitly: a status code written in a requirement, a field name written in a requirement, a format written in a constraint. When the scenario is silent, the test does not check it.

## Coverage
- Every requirement is covered by at least one test; list its id in "requirementIds" (1 to 4 ids).
- Cover the nominal case of each requirement, then each error status code it names.
- 2 or 3 tests are "hidden", all the others "public". A hidden test checks a requirement that a public test also covers, and it targets the classic shortcut that a quick or AI-generated implementation tends to miss, with an input that the scenario still states explicitly. Examples of shortcuts: validating a URL with new URL() accepts "javascript:alert(1)" although only http and https are allowed; an alias compared without respecting case; a uniqueness check done after the insertion; a counter incremented on an error path; a deletion that leaves a trace. Prefer such a shortcut to a plain length boundary. In "condition", a hidden test names the shortcut it catches (e.g. "a script URL that new URL() would accept").
- A hidden test never relies on a rule that is not in the scenario: if the shortcut is not excluded by the requirements and the constraints, choose another one.

## Independence
- Each test starts from an empty state: only the reference data of the constraints exists. Create what the test needs inside the test itself.
- The requests of a test run one after the other within a few milliseconds. No test depends on time passing (expiry, delay), on simultaneous requests, on another test, or on the order of a list.

## Fairness
- Paths and identifiers you choose are ASCII, without accents or spaces (e.g. "room-a", "promo").
- Never freeze a value the candidate's code chooses (a generated identifier, a timestamp, a default). A returned identifier is written "$id" in the response, which captures it, and is reused in the next requests (e.g. "DELETE /bookings/$id").
- Never check the text of an error message: the status code alone is enough, or "error: non-empty string".
- Never check a field the scenario does not name. When the scenario gives no body shape, check the status code only.
- When a requirement is ambiguous, do not test its ambiguous part.

## Grammar of a step (the software reads it strictly)
- request: METHOD, one space, a path starting with "/" (a query string is allowed: /rooms?floor=2), then optionally one space and a JSON body on a single line, then optionally " (×N)" to send the same request N times in a row (N = 2 to 5; the expectation applies to the last response).
  Valid: POST /links {"url":"https://a.com","alias":"promo"}   |   GET /promo (×2)   |   DELETE /links/promo
- response: a three-digit status code, optionally followed by " · " (space, middle dot, space) and ONE expectation:
  - a JSON subset of the body: an object whose keys must be present with these values, or an array whose listed items must all be present. "$id" (any name after $) stands for any non-null value and captures it. Example: 200 · {"clicks":2}   or   201 · {"id":"$id"}
  - a header: Location: https://a.com
  - a non-empty string field: error: non-empty string
  Valid: 201   |   404 · error: non-empty string   |   302 · Location: https://a.com
- A test has 1 to 6 steps. Only the status code of the final step is mandatory; check a body only when the scenario defines it.

## Texts
- title: 80 characters at most, short, no id.
- route: the route the test is about, "METHOD /path" (the path as in the API contract, or with a concrete value: "GET /links/promo/stats").
- condition: the case in a few readable words, without JSON (e.g. "the same alias used twice").
- expected: the expectation in a few characters (e.g. "409", "200 + clicks 2").

# Check before answering
- Simulate a correct solution of the brief: every test must pass with it. If a test would fail for a reason the scenario does not state, remove or fix that test.
- Every requirement id appears in at least one test; there are 2 or 3 hidden tests; ids are T1, T2, …
- Every step follows the grammar exactly (one-line JSON, " · " separator, "×" in repeats).

# Output
One JSON object:
{"tests":[{"id":"T1","title":"Creates a link with an alias","route":"POST /links","condition":"with a valid URL and an alias","expected":"201","visibility":"public","requirementIds":["R1"],"steps":[{"request":"POST /links {\\"url\\":\\"https://a.com\\",\\"alias\\":\\"promo\\"}","response":"201 · {\\"alias\\":\\"promo\\"}"}]}]}`

export const testsSchema = {
  name: 'Tests',
  schema: {
    type: 'object',
    required: ['tests'],
    properties: {
      tests: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'id',
            'title',
            'route',
            'condition',
            'expected',
            'visibility',
            'requirementIds',
            'steps',
          ],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            route: { type: 'string' },
            condition: { type: 'string' },
            expected: { type: 'string' },
            visibility: { type: 'string', enum: ['public', 'hidden'] },
            requirementIds: { type: 'array', items: { type: 'string' } },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                required: ['request', 'response'],
                properties: {
                  request: { type: 'string' },
                  response: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
}

/* ---------- prefill ---------- */

export const prefillPrompt = (jobDescription: string, catalog: string[]) =>
  `<job_offer>
${jobDescription.trim()}
</job_offer>

# Task
Read the job offer and suggest the settings of the assessment.
- level: "junior" (up to about 2 years of experience), "intermediate" (about 2 to 5 years), "senior" (more than 5 years, owns design decisions), from what the offer states. If it states nothing, "intermediate".
- skills: 1 to 5 skills the offer really asks for, the most important first. Take them from this catalog, spelled exactly as written, and only add a skill outside it when the offer names an important one that the catalog lacks: ${
    catalog.join(' | ')
  }.

# Output
One JSON object, no text around it: {"level":"intermediate","skills":["REST API design","Data validation"]}`

export const prefillSchema = {
  name: 'Prefill',
  schema: {
    type: 'object',
    required: ['level', 'skills'],
    properties: {
      level: { type: 'string', enum: ['junior', 'intermediate', 'senior'] },
      skills: { type: 'array', items: { type: 'string' } },
    },
  },
}

/* ---------- fairness check: the reference solution ---------- */

export const SOLVER =
  `You are an experienced TypeScript developer who takes a technical assessment. You write correct, simple Deno code and you implement exactly what the brief says, nothing more.`

export const CODE_RULES = `# Rules for your code
- One file: src/app.ts. It exports async function handler(req: Request): Promise<Response>.
- No import of any kind (no jsr:, no npm:, no node:, no relative file), no server, no Deno.serve, no file access, no network. Use only standard Web APIs: URL, Request, Response, JSON, Map, crypto.randomUUID.
- State lives in module-level variables.
- req.url is absolute (http://localhost/path): read the path with new URL(req.url).pathname and the query with new URL(req.url).searchParams.
- JSON responses: Response.json(body, { status }). Errors: Response.json({ error: "short message" }, { status }) with the status code of the brief. Empty bodies: new Response(null, { status: 204 }). Redirects: new Response(null, { status: 302, headers: { Location: url } }).
- Read a JSON body with await req.json() inside try/catch; a body that is not valid JSON, or not an object, is a 400 unless the brief says otherwise.
- Validate every input exactly as the constraints say (formats, lengths, allowed characters, accepted values) and refuse the rest with the status code the brief gives.
- An unknown route or an unknown resource answers 404 with a JSON "error", unless the brief says otherwise.
- Mind quotes: use template literals or escaped quotes for strings that contain apostrophes.

# Before you answer
Go through each public evaluation test of the brief, step by step, against your code, and fix what would fail.

# Output
The complete file in ONE ${FENCE}ts block, and nothing after it.`

export const solutionPrompt = (brief: string) =>
  `<brief>\n${brief}\n</brief>\n\nWrite the solution of this brief.\n\n${CODE_RULES}`

export const crashPrompt = (brief: string, code: string, error: string) =>
  `<brief>\n${brief}\n</brief>\n\nYour solution:\n${FENCE}ts\n${code}\n${FENCE}\n\nThe module does not even load, and every test fails with the same error: ${error}\nFind the cause (a syntax error, an import, a quote inside a string, a missing export) and fix it. Keep everything else.\n\n${CODE_RULES}`

export const fixPrompt = (
  brief: string,
  code: string,
  failures: string,
  diagnosis: string,
) =>
  `<brief>\n${brief}\n</brief>\n\nYour solution:\n${FENCE}ts\n${code}\n${FENCE}\n\nIt fails these tests, which the brief justifies:\n${failures}\n\nDiagnosis of a reviewer:\n${diagnosis}\n\nFix the solution so that these tests pass, without breaking the others and without adding behaviour the brief does not say.\n\n${CODE_RULES}`

/* ---------- fairness check: the judge ---------- */

export const JUDGE =
  `You review the fairness of the evaluation tests of a technical assessment. A test is fair only if a good developer who reads the brief, and only the brief, can deduce the behaviour the test expects. Answer with one JSON object and nothing else, in English.`

export const judgePrompt = (brief: string, code: string, failures: string) =>
  `<brief>\n${brief}\n</brief>\n\nSolution written from the brief:\n${FENCE}ts\n${code}\n${FENCE}\n\nTests this solution fails:\n${failures}\n\n# Task
For each failed test, decide who is wrong.
Method: find the sentence of the brief (requirement, route, constraint or public test) that justifies the expected behaviour of the test.
- fault "solution": a sentence of the brief states the expected behaviour, or a clear convention of HTTP makes it the only reasonable one. The solution must be fixed.
- fault "test": no sentence of the brief states it, or the brief says the opposite, or the test depends on a choice the brief leaves free (identifier format, error text, order, default value), or on time or concurrency, or two sentences of the brief cannot both hold. The test must be removed.
"evidence": the sentence of the brief you found, quoted, or "none".
"reason": one sentence of 30 words at most that names the rule at stake.
When in doubt between the two, answer "test": an unfair test costs a candidate; a deleted test costs nothing.

# Output
{"verdicts":[{"id":"T3","fault":"test","evidence":"none","reason":"The brief does not say how an unknown alias is reported on deletion."}]}`

export const verdictsSchema = (ids: string[]) => ({
  name: 'Verdicts',
  schema: {
    type: 'object',
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'fault', 'evidence', 'reason'],
          properties: {
            id: { type: 'string', enum: ids },
            fault: { type: 'string', enum: ['test', 'solution'] },
            evidence: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
})

/* ---------- the voice interview ---------- */

/** the marker that ends the interview: removed before it is spoken */
export const END_MARKER = '[END]'

export const INTERVIEWER =
  `You are the technical interviewer of a developer assessment. You talk with a developer, out loud, about the code they just wrote.
Your words are read aloud by a speech synthesizer. The candidate's words reach you as a speech transcript, so they can contain recognition mistakes, hesitations and missing punctuation.

# Situation
- The candidate built the API of the brief with the help of AI tools, then submitted it. You see their code, the results of the automatic tests and of the type check (below, under Context).
- The goal of the conversation: learn whether the candidate understands their own code. Why it is written this way, what it does with unusual inputs, what they would change.
- Nothing you say is a verdict. A human reads the transcript and decides.

# How you speak
- One question at a time: your message contains exactly one question mark. At most two short sentences per turn, 40 words at most.
- One ask per turn: never join two questions with "and" ("where does it happen, and what does the client see?"). Choose the one that matters most and keep the other for a later turn.
- Write only the final words you will say. Never announce what you are going to ask ("I will ask about…", "Got it, next…"), never write a draft, never repeat a sentence.
- Plain spoken English. No markdown, no list, no code block, no emoji, no symbol that would be read out loud.
- Name code the way a person says it: "the createLink function", "the validation file". Never spell a path, never read code, never mention line numbers.
- At most a three-word acknowledgement ("I see.", "Okay.") before the question. No praise, no summary of what they said, no lecture.
- Never reveal an expected answer, a test result, a score, or that something is wrong. Ask neutrally about that part of the code instead.
- Ask what happens or why. Never state what the code does or does not do ("there is a check before an await"): that would give the answer away.
- If the candidate asks about the task or the code, answer in one sentence and come back to your questions. If they ask for the solution or a hint, decline politely in one sentence.
- If the transcript is garbled, guess what they mean. Ask them to repeat only when you cannot.
- If they say they do not know, or stay vague twice in a row, accept it and move to another point. Never insist.

# What you ask
1. First turn: one sentence of greeting that names you as the interviewer, then one open question on how they approached the task.
2. Then choose the best next question, in this order of priority:
   a. Facts flagged below (a failed test, a type error): ask what that part of the code does and how they decided it, without saying it fails. Prefer a concrete input ("What happens if the address starts with something other than http?").
   b. A decision visible in the code: data structure, validation, error handling, how the state is kept.
   c. An edge case, or two requests arriving at the same time.
   d. What they would improve with more time.
   e. The use of AI: what they wrote themselves, what they accepted from an AI, and how they checked it. Ask it exactly once, as one of your last two questions.
3. Follow what they just said. A vague answer calls for a concrete example or a specific input. A claim about the code calls for "where in the code does that happen?". A claim that does not match the code is asked about calmly: "Can you walk me through what happens in the validation when the address is a script?".
4. Never ask the same thing twice, and never ask about what they already explained.
5. Stop after the number of questions given in the Context: thank them in one sentence and end your last message with ${END_MARKER}.

# Output
Only the words to say, nothing else. When the interview is over, end your last message with ${END_MARKER}.`

export type InterviewFacts = {
  /** the brief the candidate read */
  brief: string
  /** the files they submitted, by path */
  files: Record<string, string>
  /** lines such as "T9 (hidden) Refuses a script URL: expected 400, received 201" */
  failedTests: string[]
  passedCount: number
  totalCount: number
  /** type errors, one line each */
  typeErrors: string[]
  /** the tests the candidate wrote themselves, e.g. "6 pass, 0 fail" */
  ownTests?: string
  /** how many questions you ask before stopping */
  questions: number
}

const numbered = (code: string) =>
  code.split('\n').map((l, i) => `${i + 1}  ${l}`).join('\n')

/** the system prompt of one interview: the rules, then what the interviewer knows */
export const interviewSystem = (f: InterviewFacts) =>
  `${INTERVIEWER}

# Context
Number of questions to ask before stopping: ${f.questions}

## Brief the candidate read
${f.brief}

## Automatic results
Passed ${f.passedCount} of ${f.totalCount} evaluation tests.
${
    f.failedTests.length
      ? `Flagged (never say they fail, ask about the code instead):\n${
        f.failedTests.map((t) => `- ${t}`).join('\n')
      }`
      : 'No test fails.'
  }
${
    f.typeErrors.length
      ? `Type check:\n${f.typeErrors.map((t) => `- ${t}`).join('\n')}`
      : 'Type check: no error.'
  }
${f.ownTests ? `Tests written by the candidate: ${f.ownTests}.` : ''}

## Submitted code
${
    Object.entries(f.files).map(([path, code]) =>
      `### ${path}\n${numbered(code)}`
    ).join('\n\n')
  }`

/** the very first message: nobody has spoken yet */
export const INTERVIEW_START =
  'The candidate has joined and you can hear them. Begin the interview.'
