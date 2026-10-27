import { eq, test } from '/api/lib/test.ts'
import { isEcho } from '/web/lib/echo.ts'

const said =
  'Okay. What happens in the validation when someone posts a URL starting with javascript rather than http?'

test('the interviewer heard through the microphone', async (step) => {
  await step('nothing, or a run of its own words, is an echo', () => {
    eq(isEcho('', said), true)
    eq(isEcho('   ', said), true)
    eq(isEcho('what happens in the validation', said), true)
    eq(isEcho('Posts a URL starting with', said), true)
  })

  await step('a recogniser that rewrites a word is still an echo', () => {
    // 5 of 6 words are the interviewer's own
    eq(isEcho('what happens in the validations when', said), true)
  })

  await step('the words of the candidate are not', () => {
    eq(isEcho('Wait', said), false)
    eq(isEcho('Can you repeat that', said), false)
    eq(isEcho('I think it accepts anything', said), false)
    eq(isEcho("I don't know", said), false)
  })
})
