// A "program" assessment as the generation makes it, with a Python solution,
// used to measure the report on programs (`deno task llm:eval`) and by the
// tests. Fictional: the stock service of an invented company.
import { demoAssessment } from '/fixtures/demo.ts'
import type { AssessmentSpec, CandidateFiles, TestCase } from '/web/types.ts'

const test = (
  id: string,
  title: string,
  visibility: 'public' | 'hidden',
  requirementIds: string[],
  input: string,
  output: string,
): TestCase => ({
  id,
  title,
  route: 'program',
  condition: title,
  expected: 'the stock',
  visibility,
  requirementIds,
  steps: [{ request: input, response: output }],
})

export const programDemo: AssessmentSpec = {
  ...demoAssessment,
  title: 'Stock reconciliation',
  company: 'Stockly',
  kind: 'program',
  languages: ['typescript', 'python'],
  format: 'Program in TypeScript or Python (standard input to standard output)',
  routes: [],
  io: {
    input: 'Zero or more lines, each one a stock movement.',
    output: 'One line per product with a non-zero quantity, sorted.',
  },
  context: 'Stockly tracks the stock of small shops.',
  mission: 'Your mission: write the program that reports the final stock.',
  candidateBrief: {
    context: 'Stockly tracks the stock of small shops. You join the team.',
    mission:
      'Write a program that reads stock movements, one per line, and writes the final quantity of each product, sorted by name. Ignore invalid lines.',
  },
  constraints: [
    'A movement is "IN <product> <quantity>" or "OUT <product> <quantity>", a product is made of lowercase letters, a quantity is a positive integer.',
    'Products are written in alphabetical order, one per line as "<product> <quantity>".',
    'A product whose final quantity is 0 is not written.',
    'A line that is not a valid movement is ignored.',
    'The program reads the whole standard input and writes only the result on the standard output.',
  ],
  requirements: [
    [
      'R1',
      'Final quantities',
      'The lines "IN apple 5" and "OUT apple 2" give "apple 3".',
      ['Data validation'],
    ],
    ['R2', 'Sorted output', 'Products are written in alphabetical order.', [
      'Data validation',
    ]],
    [
      'R3',
      'Zero is not written',
      'A product whose quantity is 0 is not written.',
      ['Error handling'],
    ],
    ['R4', 'Invalid lines', 'A line that is not a valid movement is ignored.', [
      'Error handling',
      'Data validation',
    ]],
  ].map(([id, title, statement, skills]) => ({
    id: id as string,
    title: title as string,
    statement: statement as string,
    why: 'Shows the handling of the rule.',
    skills: skills as string[],
  })),
  skills: [
    {
      name: 'Data validation',
      importance: 'high',
      methods: ['Tests', 'Code analysis'],
    },
    {
      name: 'Error handling',
      importance: 'medium',
      methods: ['Tests', 'Code analysis'],
    },
    {
      name: 'Automated tests',
      importance: 'medium',
      methods: ['Code analysis', 'Interview'],
    },
  ],
  tests: [
    test(
      'T1',
      'One product, in and out',
      'public',
      ['R1'],
      'IN apple 5\nOUT apple 2\n',
      'apple 3',
    ),
    test(
      'T2',
      'Two products, sorted',
      'public',
      ['R2'],
      'IN pear 4\nIN apple 1\n',
      'apple 1\npear 4',
    ),
    test(
      'T3',
      'A product back to zero',
      'public',
      ['R3'],
      'IN apple 2\nOUT apple 2\nIN fig 1\n',
      'fig 1',
    ),
    test(
      'T4',
      'Invalid lines are ignored',
      'public',
      ['R4'],
      'hello\nIN kiwi 3\nIN kiwi x\n',
      'kiwi 3',
    ),
    test(
      'T5',
      'Uppercase is not a product',
      'hidden',
      ['R2', 'R4'],
      'IN b 1\nIN a 1\nIN B 1\nIN a 1\n',
      'a 2\nb 1',
    ),
    test(
      'T6',
      'Out before in',
      'hidden',
      ['R1'],
      'OUT apple 3\nIN apple 5\n',
      'apple 2',
    ),
  ],
}

/** a right program, in Python: it passes the six tests */
export const pythonSolution: CandidateFiles = {
  'main.py': `import re
import sys

stock = {}
for line in sys.stdin.read().split("\\n"):
    m = re.fullmatch(r"(IN|OUT) ([a-z]+) ([1-9][0-9]*)", line.strip())
    if not m:
        continue
    quantity = int(m.group(3))
    sign = 1 if m.group(1) == "IN" else -1
    stock[m.group(2)] = stock.get(m.group(2), 0) + sign * quantity

for product in sorted(stock):
    if stock[product] != 0:
        print(product, stock[product])
`,
  'test_main.py': `import unittest


class Example(unittest.TestCase):
    def test_example(self):
        self.assertEqual(1 + 1, 2)


if __name__ == "__main__":
    unittest.main()
`,
}

/** what the candidate gets: it prints nothing, so it fails every test */
export const pythonStarter: CandidateFiles = {
  'main.py': `import sys

data = sys.stdin.read()

# TODO: write the result with print()
`,
}
