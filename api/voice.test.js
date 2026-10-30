// The voice interview against local mocks of the Meta Model API: the realtime
// transcription (a WebSocket) and the chat model (streamed). A browser is
// played by a WebSocket client that sends a few frames of "audio".
import { eq, test } from '/api/lib/test.ts'
import { llmConfig } from '/api/llm.ts'
import { handleVoice, keywordsOf, nextPiece, voiceConfig } from '/api/voice.ts'
import { tts } from '/api/tts.ts'

const facts = {
  brief: 'Context: Linkly.\n\nMission: build the API.',
  files: {
    'src/links_repository.ts':
      'export function createLink(url: string) {\n  return url\n}',
  },
  failedTests: ['T9 (hidden) Refuses a script URL: expected 400, received 201'],
  passedCount: 10,
  totalCount: 11,
  typeErrors: [],
  questions: 2,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** a mock of the realtime transcription: `onAudio` plays the recognition */
const mockAsr = (onAudio) => {
  const seen = { handshake: undefined, frames: 0 }
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req)
    const send = (event) => socket.send(JSON.stringify(event))
    socket.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const message = JSON.parse(e.data)
        if (message.type === 'endStream') return
        seen.handshake = message
        send({ sessionId: 'session-1' })
        return
      }
      // the second frame: the first one waited for the handshake
      if (++seen.frames === 2) onAudio(send)
    }
    return response
  })
  return { server, seen, url: `ws://localhost:${server.addr.port}` }
}

/** a mock of the chat model: one streamed reply per call */
const mockModel = (replies) => {
  const calls = []
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const body = await req.json()
    calls.push(body)
    const reply = replies[Math.min(calls.length, replies.length) - 1]
    const pieces = typeof reply === 'string' ? [reply] : reply.pieces
    const gap = typeof reply === 'string' ? 0 : reply.gap
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        for (const piece of pieces) {
          if (gap) await sleep(gap)
          controller.enqueue(enc.encode(
            `data: ${
              JSON.stringify({ choices: [{ delta: { content: piece } }] })
            }\n\n`,
          ))
        }
        controller.enqueue(enc.encode(
          `data: ${
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 50, completion_tokens: 10 },
            })
          }\n\ndata: [DONE]\n\n`,
        ))
        controller.close()
      },
    })
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  return { server, calls, url: `http://localhost:${server.addr.port}/v1` }
}

/** a browser: opens the interview and records what it receives */
const browser = async (port) => {
  const events = []
  const waiters = []
  const ws = new WebSocket(`ws://localhost:${port}/api/voice`)
  ws.onmessage = (e) => {
    events.push(JSON.parse(e.data))
    waiters.forEach((check) => check())
  }
  await new Promise((resolve) => ws.onopen = resolve)
  const waitFor = (predicate, ms = 6000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(Error(`timeout, got: ${
            JSON.stringify(events.map((e) =>
              e.type === 'ai-done' || e.type === 'heard'
                ? [e.type, e.text, e.interrupted]
                : e.type
            ))
          }`)),
        ms,
      )
      const check = () => {
        const found = events.find(predicate)
        if (found) {
          clearTimeout(timer)
          resolve(found)
        }
      }
      waiters.push(check)
      check()
    })
  const frame = () => ws.send(new Uint8Array(3840))
  return { ws, events, waitFor, frame }
}

/** the whole setup: server, mocks, configuration restored afterwards */
const withInterview = async (
  { replies, recognise, interviewFacts = facts },
  fn,
) => {
  const asr = mockAsr(recognise)
  const model = mockModel(replies)
  const front = Deno.serve(
    { port: 0, onListen() {} },
    (req) =>
      handleVoice(req, {
        facts: () => Promise.resolve(interviewFacts),
        authorize: () => Promise.resolve(true),
      }),
  )
  const savedLlm = { ...llmConfig }
  const savedVoice = { ...voiceConfig }
  Object.assign(llmConfig, { key: 'test-key', baseUrl: model.url })
  Object.assign(voiceConfig, { asrUrl: asr.url })
  try {
    await fn({ port: front.addr.port, asr, model })
  } finally {
    Object.assign(llmConfig, savedLlm)
    Object.assign(voiceConfig, savedVoice)
    await front.shutdown()
    await asr.server.shutdown()
    await model.server.shutdown()
  }
}

test('voice interview: a candidate who goes on is not answered twice', async (step) => {
  await withInterview({
    replies: [
      'Hello, I am your interviewer. How did you approach the task?',
      'Okay. What about the validation?',
    ],
    recognise: async (send) => {
      await sleep(30)
      send({ type: 'transcript', transcript: 'I started with', final: false })
      send({ type: 'speechEnd', turnId: 1, audioProcessedMs: 900 })
      send({
        type: 'speechComplete',
        turnId: 1,
        transcript: 'I started with the file',
      })
      // the candidate takes up the thread while the answer is held back
      await sleep(150)
      send({ type: 'transcript', transcript: 'and then the', final: false })
      await sleep(50)
      send({ type: 'speechEnd', turnId: 2, audioProcessedMs: 2000 })
      send({
        type: 'speechComplete',
        turnId: 2,
        transcript: 'and then the handler',
      })
    },
  }, async ({ port, model }) => {
    Object.assign(voiceConfig, { holdMs: 600 })
    const b = await browser(port)
    b.frame()
    await b.waitFor((e) => e.type === 'ai-done')
    b.frame()
    await b.waitFor((e) => e.type === 'heard' && e.merge)
    await b.waitFor((e) => e.type === 'ai-done' && e.text.startsWith('Okay'))

    await step('the two turns become one line', () => {
      const heard = b.events.filter((e) => e.type === 'heard')
      eq(heard.map((e) => [e.text, !!e.merge]), [
        ['I started with the file', false],
        ['I started with the file and then the handler', true],
      ])
    })

    await step('the withdrawn answer was never sent nor kept', () => {
      const answers = b.events.filter((e) => e.type === 'ai-done')
      eq(answers.length, 2) // the greeting and one answer
      eq(model.calls.length, 3) // greeting, the withdrawn answer, the merged one
      eq(model.calls[2].messages.map((m) => m.role), [
        'system',
        'user',
        'assistant',
        'user',
      ])
      eq(
        model.calls[2].messages.at(-1).content,
        'I started with the file and then the handler',
      )
    })
    b.ws.close()
  })
})

test('voice interview: a candidate who goes on after the hold is not answered either', async (step) => {
  await withInterview({
    replies: [
      'Hello, I am your interviewer. How did you approach the task?',
      // the model is slower than the hold: the candidate resumes before its first word
      { pieces: ['Okay. ', 'What about the validation?'], gap: 400 },
      'Okay. What about the validation?',
    ],
    recognise: async (send) => {
      await sleep(30)
      send({ type: 'speechEnd', turnId: 1, audioProcessedMs: 900 })
      send({
        type: 'speechComplete',
        turnId: 1,
        transcript: 'I started with the file',
      })
      await sleep(150)
      send({ type: 'transcript', transcript: 'and then the', final: false })
      await sleep(50)
      send({ type: 'speechEnd', turnId: 2, audioProcessedMs: 2000 })
      send({
        type: 'speechComplete',
        turnId: 2,
        transcript: 'and then the handler',
      })
    },
  }, async ({ port, model }) => {
    Object.assign(voiceConfig, { holdMs: 50 })
    const b = await browser(port)
    b.frame()
    await b.waitFor((e) => e.type === 'ai-done')
    b.frame()
    await b.waitFor((e) => e.type === 'ai-done' && e.text.startsWith('Okay'))

    await step('the two turns are one line and the answer comes once', () => {
      eq(
        b.events.filter((e) => e.type === 'heard').map((e) => e.text),
        [
          'I started with the file',
          'I started with the file and then the handler',
        ],
      )
      eq(b.events.filter((e) => e.type === 'ai-done').length, 2)
      eq(
        model.calls.at(-1).messages.at(-1).content,
        'I started with the file and then the handler',
      )
    })
    b.ws.close()
  })
})

test('voice interview: an answer nobody could make out is asked again', async (step) => {
  await withInterview({
    replies: [
      'Hello, I am your interviewer. How did you approach the task?',
      'Sorry, I did not catch that. Could you say it again? [END]',
    ],
    recognise: async (send) => {
      await sleep(30)
      send({ type: 'speechEnd', turnId: 1, audioProcessedMs: 900 })
      send({ type: 'speechComplete', turnId: 1, transcript: '15' })
    },
  }, async ({ port, model }) => {
    Object.assign(voiceConfig, { holdMs: 0 })
    const b = await browser(port)
    b.frame()
    await b.waitFor((e) => e.type === 'ai-done')
    b.frame()
    await b.waitFor((e) => e.type === 'ai-done' && e.text.startsWith('Sorry'))
    await sleep(100)

    await step('the model is told to ask again, not to move on', () => {
      const last = model.calls[1].messages.at(-1).content
      eq(last.includes('could not make out'), true)
      eq(last.includes('"15"'), true)
    })

    await step('the interview does not end on a turn nobody understood', () => {
      eq(b.events.some((e) => e.type === 'end'), false)
    })
    b.ws.close()
  })
})

test('voice interview: a full conversation', async (step) => {
  await withInterview({
    replies: [
      'Hello, I am your interviewer. How did you approach the task?',
      // the end marker arrives split in two pieces
      { pieces: ['Thank you, that is all. ', '[E', 'ND]'], gap: 5 },
    ],
    recognise: async (send) => {
      await sleep(50)
      send({ type: 'speechStart', turnId: 1, audioProcessedMs: 100 })
      send({ type: 'transcript', transcript: 'I started with', final: false })
      await sleep(20)
      send({ type: 'speechEnd', turnId: 1, audioProcessedMs: 900 })
      await sleep(30)
      send({
        type: 'speechComplete',
        turnId: 1,
        transcript: 'I started with the repository file.',
      })
    },
  }, async ({ port, asr, model }) => {
    const b = await browser(port)
    b.frame() // audio sent before the transcription is ready is not lost
    await b.waitFor((e) => e.type === 'ai-done') // the greeting
    b.frame() // the candidate answers
    await b.waitFor((e) => e.type === 'end')

    await step(
      'the handshake asks for turns, with the words of the code',
      () => {
        const h = asr.seen.handshake
        eq(h.authorization.accessToken, 'Bearer test-key')
        eq([h.mode, h.audioEncoding, h.model], [
          'ENDPOINTING',
          'PCM_24KHZ',
          'muse-voice-transcribe-1.0',
        ])
        eq(h.languageBias, ['English'])
        eq(h.keywords.includes('createLink'), true)
        eq(asr.seen.frames >= 2, true) // the buffered frame was sent too
      },
    )

    await step(
      'the interviewer speaks first, then answers the candidate',
      () => {
        const types = b.events.map((e) => e.type)
        eq(types[0], 'ready')
        const done = b.events.filter((e) => e.type === 'ai-done')
        eq(done.map((e) => e.text), [
          'Hello, I am your interviewer. How did you approach the task?',
          'Thank you, that is all.',
        ])
        eq(done.every((e) => !e.interrupted), true)
        const heard = b.events.find((e) => e.type === 'heard')
        eq(heard.text, 'I started with the repository file.')
        eq(b.events.find((e) => e.type === 'partial').text, 'I started with')
      },
    )

    await step('the end marker is never sent to be spoken', () => {
      const spoken = b.events.filter((e) => e.type === 'ai-delta')
        .map((e) => e.text).join('')
      eq(spoken.includes('[E'), false)
      eq(spoken.includes('END'), false)
      eq(spoken.endsWith('Thank you, that is all. '), true)
    })

    await step('the model knows the code, the facts and the history', () => {
      const [first, second] = model.calls
      const system = first.messages[0].content
      eq(first.messages[0].role, 'system')
      eq(system.includes('technical interviewer'), true)
      eq(system.includes('1  export function createLink'), true)
      eq(system.includes('T9 (hidden) Refuses a script URL'), true)
      eq(system.includes('Passed 10 of 11'), true)
      eq(first.stream, true)
      eq(first.model, 'muse-wonder-1.0') // the interviewer model
      eq(first.reasoning_effort, 'minimal')
      eq(second.messages.map((m) => m.role), [
        'system',
        'user',
        'assistant',
        'user',
      ])
      eq(second.messages.at(-1).content, 'I started with the repository file.')
    })

    await step('the delays a listener feels are measured', () => {
      const { metrics } = b.events.find((e) => e.type === 'metrics')
      eq(metrics.turnId, 1)
      for (
        const k of [
          'transcribeMs',
          'modelFirstWordMs',
          'silenceToFirstWordMs',
          'answerMs',
        ]
      ) {
        eq(typeof metrics[k], 'number', k)
        eq(metrics[k] >= 0, true, k)
      }
      eq(
        metrics.silenceToFirstWordMs >= metrics.transcribeMs,
        true,
      )
    })
    b.ws.close()
  })
})

test('voice interview: speaking over the interviewer', async (step) => {
  await withInterview({
    replies: [
      // a long first question, written slowly
      { pieces: Array.from({ length: 30 }, (_, i) => `word${i} `), gap: 40 },
      'Fair enough. What would you improve?',
    ],
    recognise: async (send) => {
      await sleep(300) // the interviewer is in the middle of its question
      send({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 })
      // words that are not the interviewer's own: a real interruption
      send({ type: 'transcript', transcript: 'Wait', final: false })
      await sleep(30)
      send({ type: 'speechEnd', turnId: 1, audioProcessedMs: 500 })
      send({
        type: 'speechComplete',
        turnId: 1,
        transcript: 'Wait, one second.',
      })
    },
  }, async ({ port, model }) => {
    const b = await browser(port)
    b.frame()
    await b.waitFor((e) => e.type === 'ai-delta') // the question is being written
    b.frame() // the candidate starts to speak
    await b.waitFor((e) =>
      e.type === 'ai-done' && !e.interrupted && e.text.startsWith('Fair')
    )

    await step('the question in progress is cut short', () => {
      const done = b.events.filter((e) => e.type === 'ai-done')
      eq(done[0].interrupted, true)
      eq(done[0].text.startsWith('word0 '), true)
      eq(done[0].text.includes('word29'), false)
    })
    await step('the model is told where it was interrupted', () => {
      const second = model.calls[1].messages
      const assistant = second.find((m) => m.role === 'assistant').content
      eq(assistant.endsWith('[the candidate interrupted here]'), true)
      eq(second.at(-1).content, 'Wait, one second.')
    })
    b.ws.close()
  })
})

test('voice interview: a sound or an echo is not an interruption', async (step) => {
  await withInterview({
    replies: [
      { pieces: Array.from({ length: 20 }, (_, i) => `word${i} `), gap: 30 },
    ],
    recognise: async (send) => {
      await sleep(150)
      // a breath: a sound, no words
      send({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 })
      await sleep(30)
      // the interviewer's own words, back through the speakers
      send({
        type: 'transcript',
        transcript: 'word0 word1 word2',
        final: false,
      })
      await sleep(30)
      send({ type: 'speechEnd', turnId: 1, audioProcessedMs: 300 })
      send({ type: 'speechComplete', turnId: 1, transcript: '' })
    },
  }, async ({ port, model }) => {
    const b = await browser(port)
    b.frame()
    await b.waitFor((e) => e.type === 'ai-delta')
    b.frame()
    const done = await b.waitFor((e) => e.type === 'ai-done')

    await step('the question is written to the end', () => {
      eq(done.interrupted, false)
      eq(done.text.includes('word19'), true)
    })
    await step(
      'nothing was heard, so nothing is asked of the model',
      async () => {
        await sleep(100)
        eq(b.events.some((e) => e.type === 'heard'), false)
        eq(model.calls.length, 1)
      },
    )
    b.ws.close()
  })
})

test('voice interview: what goes wrong is said', async (step) => {
  await step('without a key the browser is told', async () => {
    const front = Deno.serve(
      { port: 0, onListen() {} },
      (req) =>
        handleVoice(req, {
          facts: () => Promise.resolve(facts),
          authorize: () => Promise.resolve(true),
        }),
    )
    const saved = llmConfig.key
    llmConfig.key = ''
    try {
      const b = await browser(front.addr.port)
      const error = await b.waitFor((e) => e.type === 'error')
      eq(error.message.includes('MODEL_API_KEY'), true)
      b.ws.close()
    } finally {
      llmConfig.key = saved
      await front.shutdown()
    }
  })

  await step(
    'a plain request, a stranger and another site are refused',
    async () => {
      const options = {
        facts: () => Promise.resolve(facts),
        authorize: () => Promise.resolve(false),
      }
      const ws = { upgrade: 'websocket' }
      eq(
        (await handleVoice(new Request('http://localhost/api/voice'), options))
          .status,
        426,
      )
      eq(
        (await handleVoice(
          new Request('http://localhost/api/voice', { headers: ws }),
          options,
        )).status,
        401,
      )
      eq(
        (await handleVoice(
          new Request('http://localhost/api/voice', {
            headers: { ...ws, origin: 'https://evil.example' },
          }),
          { ...options, authorize: () => Promise.resolve(true) },
        )).status,
        403,
      )
    },
  )
})

test('voice interview: the words of the code', async (step) => {
  await step(
    'identifiers are taught to the recogniser, common words are not',
    () => {
      const words = keywordsOf({
        'a.ts':
          'export async function createLink(url: string) { const aliasTaken = true; return createLink }',
        'b.ts': 'function createLink() {}\nconst recordClick = 1',
      })
      eq(words.slice(0, 2), ['Deno', 'TypeScript'])
      eq(words[2], 'createLink') // the most used first
      eq(words.includes('aliasTaken'), true)
      eq(words.includes('recordClick'), true)
      eq(words.includes('function'), false)
      eq(words.includes('const'), false)
    },
  )
})

/** the voice of the server, made of nothing: each sentence takes a while */
const withServerVoice = async (makeMs, fn) => {
  const saved = { ...tts }
  tts.loaded = () => true
  tts.rate = () => 16_000
  tts.synthesize = async (text, alive) => {
    await sleep(makeMs)
    return alive() ? btoa(`sound of: ${text}`) : undefined
  }
  try {
    await fn()
  } finally {
    Object.assign(tts, saved)
  }
}

test('voice interview: the server reads each sentence aloud, in order', async (step) => {
  await withServerVoice(30, () =>
    withInterview({
      replies: [
        'Hi there, I am Oracle. Take your time with this. How did you start?',
      ],
      recognise: () => {},
    }, async ({ port }) => {
      const b = await browser(port)
      b.frame()
      await b.waitFor((e) =>
        e.type === 'speech' && e.text === 'How did you start?'
      )

      await step('the browser is told who speaks', () => {
        eq(b.events.find((e) => e.type === 'ready').voice, 'server')
      })
      await step('and at which rate the sounds are played', () => {
        eq(b.events.find((e) => e.type === 'ready').rate, 16_000)
      })
      await step(
        'one sound per sentence, in the order they were written',
        () => {
          const spoken = b.events.filter((e) => e.type === 'speech')
          eq(spoken.map((e) => e.text), [
            'Hi there, I am Oracle.',
            'Take your time with this.',
            'How did you start?',
          ])
          eq(atob(spoken[0].pcm), 'sound of: Hi there, I am Oracle.')
        },
      )
      b.ws.close()
    }))
})

test('voice interview: the browser reads when the server cannot', async (step) => {
  await withInterview({
    replies: ['Hi there, I am Oracle. How did you start?'],
    recognise: () => {},
  }, async ({ port }) => {
    const b = await browser(port)
    b.frame()
    await b.waitFor((e) => e.type === 'ai-done')

    await step('the browser is told it reads the words itself', () => {
      eq(b.events.find((e) => e.type === 'ready').voice, 'browser')
      eq(b.events.some((e) => e.type === 'speech'), false)
    })
    b.ws.close()
  })
})

test('voice interview: speaking over Oracle drops the sentences in the making', async (step) => {
  await withServerVoice(500, () =>
    withInterview({
      replies: [
        {
          pieces: [
            'First sentence is long enough. ',
            'Second sentence is long enough. ',
            'Third sentence is long enough.',
          ],
          gap: 150,
        },
        'Fair enough. What would you improve?',
      ],
      recognise: async (send) => {
        await sleep(350)
        send({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 })
        send({ type: 'transcript', transcript: 'Wait', final: false })
        await sleep(30)
        send({ type: 'speechEnd', turnId: 1, audioProcessedMs: 500 })
        send({
          type: 'speechComplete',
          turnId: 1,
          transcript: 'Wait, one second.',
        })
      },
    }, async ({ port }) => {
      const b = await browser(port)
      b.frame()
      await b.waitFor((e) => e.type === 'ai-delta')
      b.frame()
      await b.waitFor((e) =>
        e.type === 'speech' && e.text === 'What would you improve?'
      )

      await step('nothing of the question that was cut is played', () => {
        const spoken = b.events.filter((e) => e.type === 'speech')
        eq(spoken.some((e) => e.text.includes('sentence')), false)
        eq(spoken.map((e) => e.text), [
          'Fair enough.',
          'What would you improve?',
        ])
      })
      b.ws.close()
    }))
})

test('voice interview: how speech is cut into pieces', async (step) => {
  await step('a short sentence goes with the next one', () => {
    eq(nextPiece('Hi Sam. How are you doing today? Fine'), [
      'Hi Sam. How are you doing today?',
      'Fine',
    ])
  })
  await step('the first piece may end at a comma, the others may not', () => {
    const text = "Hi, I'm Oracle, and this is a calm chat. Then more."
    eq(nextPiece(text, true), [
      "Hi, I'm Oracle,",
      'and this is a calm chat. Then more.',
    ])
    eq(nextPiece(text)?.[0], "Hi, I'm Oracle, and this is a calm chat.")
  })
  await step('a sentence still being written is not cut', () => {
    eq(nextPiece('Hi Sam. How are you'), undefined)
    eq(nextPiece('Version 3.5 is out'), undefined)
  })
})

test('voice interview: a candidate who reloads the page goes on, not again', async (step) => {
  const previous = [
    { who: 'ai', text: 'Hello, I am Oracle. How did you start?' },
    { who: 'candidate', text: 'I began with the repository.' },
    { who: 'ai', text: 'Thanks. Why that order?' },
    { who: 'candidate', text: 'It felt simplest.' },
  ]
  await withInterview({
    interviewFacts: { ...facts, previous },
    replies: ['Glad you are back. What would you change in it?'],
    recognise: () => {},
  }, async ({ port, model }) => {
    const b = await browser(port)
    b.frame()
    await b.waitFor((e) => e.type === 'ai-done')

    await step('the browser gets back what was already said', () => {
      eq(b.events.find((e) => e.type === 'ready').history, previous)
    })
    await step('the model knows the conversation and is told to go on', () => {
      const messages = model.calls[0].messages.filter((m) =>
        m.role !== 'system'
      )
      eq(messages.map((m) => m.role), [
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ])
      eq(messages[1].content, 'Hello, I am Oracle. How did you start?')
      // the words that were not answered yet are carried in the note
      eq(messages.at(-1).content.includes('It felt simplest.'), true)
      eq(messages.at(-1).content.includes('reloaded'), true)
      eq(
        messages.filter((m) => m.content.includes('Begin the interview'))
          .length,
        1,
      )
    })
    b.ws.close()
  })
})

test('voice interview: the time is counted from the first opening, a reload does not restart it', async (step) => {
  await withInterview({
    // the interview opened eleven minutes ago: it closes at once
    interviewFacts: {
      ...facts,
      previous: [{
        who: 'ai',
        text: 'Hello, I am Oracle. How did you start?',
      }],
      interviewStartedAt: Date.now() - 11 * 60_000,
    },
    // the model forgets the end marker: the interview ends anyway
    replies: ['Thank you for your time, a person will read this.'],
    recognise: () => {},
  }, async ({ port, model }) => {
    const b = await browser(port)
    b.frame()
    await b.waitFor((e) => e.type === 'end')

    await step(
      'the interviewer is told the time is over, and asks nothing more',
      () => {
        const last = model.calls[0].messages.at(-1).content
        eq(last.includes('time of the interview is over'), true)
        eq(model.calls.length, 1)
      },
    )
    b.ws.close()
  })
})

test('voice interview: the interview closes when the time is over, even in silence', async (step) => {
  await withInterview({
    replies: [
      'Hello, I am Oracle. How did you start?',
      'Thank you, a person will read our conversation. [END]',
    ],
    recognise: () => {},
  }, async ({ port, model }) => {
    // a few hundred milliseconds instead of ten minutes
    Object.assign(voiceConfig, { interviewMs: 800, graceMs: 300 })
    const b = await browser(port)
    b.frame()
    await b.waitFor((e) => e.type === 'end')

    await step('a question, then the closing, then the end', () => {
      eq(model.calls.length, 2)
      eq(
        model.calls[1].messages.at(-1).content.includes(
          'time of the interview is over',
        ),
        true,
      )
      eq(b.events.filter((e) => e.type === 'ai-done').length, 2)
    })
    b.ws.close()
  })
})

test('voice interview: a candidate who is speaking when the time is over is heard out', async (step) => {
  await withInterview({
    replies: [
      'Hello, I am Oracle. How did you start?',
      'Thank you, a person will read our conversation. [END]',
    ],
    recognise: async (send) => {
      // the candidate starts to speak before the time is over, and goes on
      await sleep(300)
      send({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 })
      await sleep(2600)
      send({ type: 'speechEnd', turnId: 1, audioProcessedMs: 2900 })
      send({
        type: 'speechComplete',
        turnId: 1,
        transcript: 'One last thing I wanted to say about the order.',
      })
    },
  }, async ({ port, model }) => {
    Object.assign(voiceConfig, { interviewMs: 1500, graceMs: 500 })
    const opened = Date.now()
    const b = await browser(port)
    b.frame()
    await sleep(100)
    b.frame()
    // the time is over at 1.5 s and the timer fires at 2 s, while they speak
    await sleep(Math.max(0, opened + 2400 - Date.now()))
    await step(
      'the interviewer does not talk over a candidate who speaks',
      () => {
        eq(model.calls.length, 1)
        eq(b.events.some((e) => e.type === 'end'), false)
      },
    )
    await b.waitFor((e) => e.type === 'end')

    await step(
      'their words are heard, then the interviewer concludes and stops',
      () => {
        const types = b.events.map((e) => e.type)
        eq(types.indexOf('heard') < types.lastIndexOf('ai-done'), true)
        const last = model.calls[1].messages.at(-1).content
        eq(last.includes('One last thing I wanted to say'), true)
        eq(last.includes('time of the interview is over'), true)
        eq(types.at(-1), 'end')
      },
    )
    b.ws.close()
  })
})
