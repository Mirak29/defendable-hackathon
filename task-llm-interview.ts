// `deno task llm:interview`: the voice interview without the voice. The
// interviewer (the real prompt, the real model) talks about the demo
// candidate's code; you type the candidate's answers, or `--auto` lets a
// second model play a candidate who half understands code written with an AI.
// Prints the words as they are written and the delay to the first word.
//
//   deno task llm:interview [--auto] [--questions=6] [--model=muse-wonder-1.0]
//                           [--effort=minimal] [--chunks]
// --chunks shows where the stream cuts the words (‖), to debug a repeated text.
import { parseArgs } from 'jsr:@std/cli/parse-args'
import { converse, hasAiKey, llmConfig, type Message } from '/api/llm.ts'
import { END_MARKER, INTERVIEW_START, interviewSystem } from '/api/prompts.ts'
import { labFacts } from '/api/voice-lab.ts'

const args = parseArgs(Deno.args, {
  boolean: ['auto', 'chunks'],
  string: ['model', 'effort'],
  default: { questions: 6 },
})
if (!hasAiKey()) {
  console.error('MODEL_API_KEY is empty: add it to .env')
  Deno.exit(1)
}

const model = args.model ?? llmConfig.interviewModel
const effort = (args.effort ?? 'minimal') as 'minimal'
console.log(`model ${model}, effort ${effort}`)

const facts = { ...await labFacts(), questions: Number(args.questions) }
const system = interviewSystem(facts)

const CANDIDATE =
  `You play a developer in a technical interview. You wrote the code below with the help of an AI assistant, and you accepted most of what it proposed. You remember the general design and the main routes, but you are unsure about details, you did not test unusual inputs, and you never noticed that some behaviour is wrong. Answer the interviewer in one to three spoken sentences, naturally, with some hesitation, in plain English. Never mention that you are a simulation. Never reveal what you do not know unless asked directly.

${
    Object.entries(facts.files).map(([path, code]) => `### ${path}\n${code}`)
      .join('\n\n')
  }`

const history: Message[] = [{ role: 'user', content: INTERVIEW_START }]
console.log('— the interviewer knows:')
console.log(`  ${facts.passedCount}/${facts.totalCount} tests pass`)
for (const t of facts.failedTests) console.log(`  flagged: ${t}`)
console.log('')

for (let turn = 1; turn <= facts.questions + 2; turn++) {
  const encoder = new TextEncoder()
  Deno.stdout.writeSync(encoder.encode('Interviewer: '))
  const started = performance.now()
  const answer = await converse({
    task: 'interview',
    model,
    system,
    messages: history,
    effort,
    maxTokens: 1_200,
    onDelta: (d) =>
      Deno.stdout.writeSync(
        encoder.encode(
          (args.chunks ? '‖' : '') + d.replace(END_MARKER, ''),
        ),
      ),
  })
  console.log(
    `\n   [first word ${answer.firstDeltaMs} ms · whole answer ${
      Math.round(performance.now() - started)
    } ms · ${answer.trace.tokensOut} tokens]\n`,
  )
  history.push({
    role: 'assistant',
    content: answer.text.replace(END_MARKER, '').trim(),
  })
  if (answer.text.includes(END_MARKER)) break

  let said: string
  if (args.auto) {
    // roles are swapped for the second model: the interviewer speaks to it
    const swapped: Message[] = history.slice(1).map((m) => ({
      role: m.role === 'assistant' ? 'user' : 'assistant',
      content: m.content,
    }))
    const candidate = await converse({
      task: 'candidate',
      system: CANDIDATE,
      messages: swapped,
      effort: 'minimal',
      maxTokens: 800,
    })
    said = candidate.text.trim()
    console.log(`Candidate: ${said}\n`)
  } else {
    said = (prompt('Candidate (your answer):') ?? '').trim()
    if (!said) break
    console.log('')
  }
  history.push({ role: 'user', content: said })
}
Deno.exit(0)
