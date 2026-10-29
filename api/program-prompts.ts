// Prompts of the "program" assessment: the candidate writes a program that reads
// its input on the standard input and writes its result on the standard output,
// in TypeScript or in Python. The tests are an input and the output it must
// give, the same whatever the language. Same rules as api/prompts.ts: who the
// model is, what the software does with the answer, the exact grammar, a check
// before answering.
import type { GenerationInput } from '/web/types.ts'

const FENCE = '```'

export const PROGRAM_DESIGNER =
  `You are a senior engineer who designs the practical task of a technical assessment for developers.

How an assessment works
1. The candidate reads a brief, then writes a small program, in TypeScript (Deno) or in Python, in the time given, with any AI tool they like.
2. The program reads its input on the standard input and writes its result on the standard output. It is judged by automatic tests: each test gives an input and the exact output the program must write. There is no network, no file, no database, no clock and no randomness.
3. Afterwards, an AI interviewer talks with the candidate, by voice, about their own code.
Your answer feeds software, not a person.

Rules, in order of priority
1. Output exactly one JSON object that follows the requested structure: no prose, no markdown fence, no comment, no trailing comma.
2. Fairness: everything a test expects must be deducible from the brief the candidate reads, in either language. When in doubt, test less, never more.
3. Faithfulness: the task reflects the business and the responsibilities of the job offer, not a generic exercise.
4. Determinism: one input has one possible output. Never depend on the order of a set or a map, on the current time, on randomness, on floating point rounding, or on the text of an error message.
5. Writing: English, concrete, short sentences, no marketing words. Use the company named in the job offer; if the offer names none, invent a fictional one. Never use the name of a real person.`

const settings = (input: GenerationInput) =>
  [
    `<job_offer>\n${input.jobDescription.trim()}\n</job_offer>`,
    `Seniority asked by the recruiter: ${input.level}`,
    `Time given for the practical task: ${input.durationMin} minutes`,
    `Skills chosen by the recruiter: ${input.skills.join(' | ')}`,
    `Business domain given by the recruiter: ${input.domain || 'none'}`,
    'Imposed format: a program (TypeScript or Python) that reads the standard input and writes the standard output, no database, no network, no file, no randomness, no clock.',
  ].join('\n')

/* ---------- step 1: need analysis ---------- */

export const programNeedAnalysisPrompt = (input: GenerationInput) =>
  `${settings(input)}

# Task
Analyse the need, then decide how each chosen skill will be assessed.

## level
The seniority the job really asks for, read from the offer (years of experience, scope, autonomy): "junior" (up to about 2 years), "intermediate" (about 2 to 5 years), "senior" (more than 5 years, owns design decisions). If the offer states nothing, use the seniority asked by the recruiter.

## domain
The business domain of the offer in 1 to 4 words (e.g. "Warehouse stock", "Log analysis"). If the recruiter gave one, use it as it is.

## skills
- Return exactly the chosen skills: the same names, written exactly as given, in the same order. None added, none removed.
- importance: "high" if the responsibilities of the offer depend on it; "medium" if it is part of the work but not central; "low" if the offer calls it a plus or a nice-to-have.
- methods: one to three of the following, decided skill by skill.
  - "Tests": automatic tests can observe it. They give an input to the program and compare the output with the expected one. A program can show data validation, error handling, parsing, algorithms and the correct handling of edge cases through its output.
  - "Code analysis": it shows in the files the candidate submits (structure, naming, functions, the tests the candidate wrote).
  - "Interview": it needs asking why (design choices, trade-offs, understanding), or the environment prevents doing it (no database, no network, no HTTP, no real clock).
  A skill may have several methods. A skill the environment cannot exercise gets only "Interview". Skills about HTTP, REST or databases cannot be observed by a program that only reads and writes text: give them "Interview".
- justification: one sentence of 25 words at most that cites something concrete from the offer or from the environment.

# Check before answering
- The skills in your answer are exactly the chosen skills, same names, same order.
- No skill has "Tests" if it is about something a text program cannot show (HTTP, a database, concurrency, performance).
- "level" is one of junior, intermediate, senior.

# Output
One JSON object, for example:
{"level":"intermediate","domain":"Warehouse stock","skills":[{"name":"Data validation","importance":"high","methods":["Tests","Code analysis"],"justification":"The offer asks to reject malformed stock movements."},{"name":"PostgreSQL","importance":"low","methods":["Interview"],"justification":"The offer calls it a plus, and the environment has no database."}]}`

/* ---------- step 2: scenario and requirements ---------- */

export const programScenarioPrompt = (
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
Write the scenario of a small, realistic program that a developer can write in ${input.durationMin} minutes with the help of an AI, in the business of the job offer. It reads text and writes text: a parser, a reconciliation, a scheduler, a validator, a simulation of rules.

## io (the contract of the program)
- input: the exact format of what the program reads, one short paragraph: what a line is, the separators, the order, the limits, and what an empty input means.
- output: the exact format of what the program writes: what a line is, the order of the lines (a total order, never "any order"), numbers as integers (or with a fixed number of decimals when the brief gives it), what is written for an invalid line or an empty case.

## Size
4 to 7 requirements. Smaller is better than larger: the candidate must finish and still have time to read their own code.

## requirements (R1, R2, …)
- One requirement = one behaviour of the program that a test can check by giving an input and reading the output. Never the quality of the code, never the tests written by the candidate, never performance.
- statement: precise and testable. It gives, for each case it describes, what the program writes, with a small example in the statement when the format is not obvious (e.g. "the line \\"3 4\\" gives \\"7\\"").
- why: what the requirement shows about the candidate, in one sentence.
- skills: the skills it concerns, written exactly as in the analysed skills. Only skills whose methods include "Tests" get requirements; the others get none.
- Together, the requirements cover every task named in the job offer that a text program can show. Cover the nominal case, then the invalid inputs and the edge cases (empty input, a single line, duplicates, ties).

## constraints
- Everything a candidate must know and a test will rely on, one short sentence each, 3 to 8 constraints.
- Every ambiguity is closed: ties are broken by a stated rule, duplicates are handled by a stated rule, an invalid line is handled by a stated rule (ignored, or reported with an exact line).
- Reference data the tests assume, with the exact identifiers, in ASCII.
- Always include "The program reads the whole standard input and writes only the result on the standard output."

## candidateBrief
What the candidate reads instead of context and mission.
- context: 2 to 3 sentences, second person ("You join…"), the business and the problem.
- mission: says concretely what the program must do, in words, with the main rules. 600 characters at most. Do not name a language: the candidate chooses it.
- No mention of tests, AI, interview or evaluation. No code.

## context and mission (for the recruiter)
- context: 2 to 3 sentences on the business.
- mission: starts with "Your mission:" and summarises the task.

# Check before answering
- Every requirement states what the program writes for each case it describes.
- The io section is enough to write the program: a reader could parse every input and print every output.
- Every ambiguity of order, ties, duplicates and invalid lines is closed by a constraint.
- No requirement is about code quality, tests of the candidate, time or performance.
- Requirement skills are spelled exactly as the analysed skills.
- The candidate mission, the constraints and the requirements never contradict each other.

# Output
One JSON object, for example (another business, to show the shape only):
{"title":"Stock reconciliation","company":"Stockly","context":"Stockly tracks the stock of small shops. You join the team that checks the movements of each day.","mission":"Your mission: write the program that reads the stock movements of a day and writes the final quantity of each product.","candidateBrief":{"context":"Stockly tracks the stock of small shops. You join the team that checks the stock movements of each day.","mission":"Write a program that reads stock movements, one per line, and writes the final quantity of each product, sorted by product name. Ignore the lines that are not valid movements."},"constraints":["A movement is \\"IN <product> <quantity>\\" or \\"OUT <product> <quantity>\\", with a product made of lowercase letters and a positive integer quantity.","Products are written in alphabetical order, one per line as \\"<product> <quantity>\\".","A product whose final quantity is 0 is not written.","A line that is not a valid movement is ignored.","The program reads the whole standard input and writes only the result on the standard output."],"io":{"input":"Zero or more lines, each one a stock movement, separated by a line break.","output":"One line per product with a non-zero final quantity, sorted alphabetically: the product, a space, the quantity. Nothing is written when there is no such product."},"requirements":[{"id":"R1","title":"Final quantities","statement":"For the lines \\"IN apple 5\\" and \\"OUT apple 2\\" the program writes \\"apple 3\\".","why":"Shows the basic accumulation and the output format.","skills":["Data validation"]}]}`

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

export const programScenarioSchema = {
  name: 'ProgramScenario',
  schema: {
    type: 'object',
    required: [
      'title',
      'company',
      'context',
      'mission',
      'candidateBrief',
      'constraints',
      'io',
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
      io: {
        type: 'object',
        required: ['input', 'output'],
        properties: {
          input: { type: 'string' },
          output: { type: 'string' },
        },
      },
      requirements: { type: 'array', items: requirement },
    },
  },
}

/* ---------- step 3: evaluation tests ---------- */

export const programTestsPrompt = (
  scenario: { io: unknown; requirements: unknown; constraints: unknown },
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
Write 8 to 12 evaluation tests for this scenario. A test is an input given to the program on its standard input and the exact output it must write.

## What the candidate knows
The candidate reads only the requirements, the io contract and the constraints of the scenario, and the public tests. A test may expect only what these say explicitly. When the scenario is silent, the test does not check it.

## Coverage
- Every requirement is covered by at least one test; list its id in "requirementIds" (1 to 4 ids).
- Cover the nominal case of each requirement, then each invalid input and edge case it names.
- 2 or 3 tests are "hidden", all the others "public". A hidden test checks a requirement that a public test also covers, and it targets the classic shortcut that a quick or AI-generated program tends to miss, with an input that the scenario still states explicitly. Examples of shortcuts: an off-by-one at a boundary; a tie broken by the order of arrival instead of the stated rule; a duplicate counted twice; an empty input that crashes; a last line without a line break; a value at the largest allowed size; a parsing done with split(" ") that breaks on two spaces when the brief allows them; a negative result not handled. Prefer such a shortcut to a plain happy path. In "condition", a hidden test names the shortcut it catches (e.g. "a tie broken by name, not by arrival order").
- A hidden test never relies on a rule that is not in the scenario: if the shortcut is not excluded by the requirements and the constraints, choose another one.

## Determinism and fairness
- One input, one possible output. The output follows the io contract to the letter: same order, same separators, same number format.
- Inputs and outputs are ASCII text, at most 15 lines and 600 characters each. A line break ends every line; the last line may or may not end with one, the comparison ignores the spaces at the end of lines and the line breaks at the end.
- The expected output is NEVER empty: choose inputs for which the program writes something (an input whose right answer is nothing is not a test, because a program that writes nothing would pass it). When the brief says what is written for an empty case, use that sentence.
- Never check an error message text or any detail the scenario does not state.
- When a requirement is ambiguous, do not test its ambiguous part.

## Texts
- title: 80 characters at most, short, no id.
- condition: the case in a few readable words, without the data (e.g. "two products with the same quantity").
- expected: the expectation in a few words (e.g. "sorted by name").

# Check before answering
- Simulate a correct program of the scenario by hand on every input: its output must be exactly the "output" of the test, character by character. If you are not sure, simplify the input.
- Every requirement id appears in at least one test; there are 2 or 3 hidden tests; ids are T1, T2, …
- No expected output is empty.

# Output
One JSON object:
{"tests":[{"id":"T1","title":"One product, in and out","condition":"a purchase followed by a sale","expected":"the remaining quantity","visibility":"public","requirementIds":["R1"],"input":"IN apple 5\\nOUT apple 2\\n","output":"apple 3\\n"}]}`

export const programTestsSchema = {
  name: 'ProgramTests',
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
            'condition',
            'expected',
            'visibility',
            'requirementIds',
            'input',
            'output',
          ],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            condition: { type: 'string' },
            expected: { type: 'string' },
            visibility: { type: 'string', enum: ['public', 'hidden'] },
            requirementIds: { type: 'array', items: { type: 'string' } },
            input: { type: 'string' },
            output: { type: 'string' },
          },
        },
      },
    },
  },
}

/* ---------- fairness check: the reference solution ---------- */

export const PROGRAM_SOLVER =
  `You are an experienced developer who takes a technical assessment. You write correct, simple TypeScript (Deno) code and you implement exactly what the brief says, nothing more.`

export const PROGRAM_CODE_RULES = `# Rules for your code
- One file: src/main.ts. It reads the whole standard input and writes the result on the standard output. Nothing else is written there.
- Read the input with: const input = await new Response(Deno.stdin.readable).text();
- Write with console.log (one call per line, or one call with the lines joined by "\\n").
- No import of any kind (no jsr:, no npm:, no node:, no relative file), no network, no file access, no environment variable.
- Handle exactly the formats, orders, ties, duplicates and invalid lines the brief states. When the brief states a rule, follow it to the letter; when it does not, do the simplest thing.
- An input may be empty, may have blank lines, may end without a line break, may use "\\r\\n": handle them as the brief says.
- Mind quotes: use template literals or escaped quotes for strings that contain apostrophes.

# Before you answer
Go through each public evaluation test of the brief, by hand, against your code, and fix what would give another output.

# Output
The complete file in ONE ${FENCE}ts block, and nothing after it.`

export const programSolutionPrompt = (brief: string) =>
  `<brief>\n${brief}\n</brief>\n\nWrite the solution of this brief.\n\n${PROGRAM_CODE_RULES}`

export const programCrashPrompt = (
  brief: string,
  code: string,
  error: string,
) =>
  `<brief>\n${brief}\n</brief>\n\nYour solution:\n${FENCE}ts\n${code}\n${FENCE}\n\nThe program does not even run, and every test fails with the same error: ${error}\nFind the cause (a syntax error, an import, a quote inside a string, a wrong way to read the input) and fix it. Keep everything else.\n\n${PROGRAM_CODE_RULES}`

export const programFixPrompt = (
  brief: string,
  code: string,
  failures: string,
  diagnosis: string,
) =>
  `<brief>\n${brief}\n</brief>\n\nYour solution:\n${FENCE}ts\n${code}\n${FENCE}\n\nIt fails these tests, which the brief justifies:\n${failures}\n\nDiagnosis of a reviewer:\n${diagnosis}\n\nFix the solution so that these tests pass, without breaking the others and without adding behaviour the brief does not say.\n\n${PROGRAM_CODE_RULES}`

/** the judge of api/prompts.ts is about HTTP: the same task, for a program */
export const PROGRAM_JUDGE =
  `You review the fairness of the evaluation tests of a technical assessment. A test is fair only if a good developer who reads the brief, and only the brief, can deduce the exact output the test expects for its input. Answer with one JSON object and nothing else, in English.`

export const programJudgePrompt = (
  brief: string,
  code: string,
  failures: string,
) =>
  `<brief>\n${brief}\n</brief>\n\nSolution written from the brief:\n${FENCE}ts\n${code}\n${FENCE}\n\nTests this solution fails:\n${failures}\n\n# Task
For each failed test, decide who is wrong.
Method: find the sentence of the brief (requirement, io contract, constraint or public test) that justifies the expected output of the test.
- fault "solution": a sentence of the brief states the expected output, or makes it the only reasonable one. The solution must be fixed.
- fault "test": no sentence of the brief states it, or the brief says the opposite, or the test depends on a choice the brief leaves free (order of equal items, a number format, the handling of an invalid line, a blank line), or the expected output is wrong for its input, or two sentences of the brief cannot both hold. The test must be removed.
"evidence": the sentence of the brief you found, quoted, or "none".
"reason": one sentence of 30 words at most that names the rule at stake.
When in doubt between the two, answer "test": an unfair test costs a candidate; a deleted test costs nothing.

# Output
{"verdicts":[{"id":"T3","fault":"test","evidence":"none","reason":"The brief does not say how ties between two products are ordered."}]}`
