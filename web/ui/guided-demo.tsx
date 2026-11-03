import { useState } from 'preact/hooks'
import { api } from '/web/lib/api.ts'
import { member } from '/web/lib/member-store.ts'
import { me } from '/web/lib/candidate-store.ts'
import { getAssessment } from '/web/lib/assessment-store.ts'
import { guidedDemo, setGuidedDemo } from '/web/lib/guided-demo.ts'
import { A, navigate, url } from '/web/lib/router-signal.ts'
import { paths } from '/web/paths.ts'
import { demoFiles } from '/fixtures/demo-files.ts'
import {
  evalResults,
  ownTests,
  running,
  updateFile,
} from '/web/pages/workspace/workspace-state.ts'

const STEPS = ['Assessment', 'Invitation', 'Coding', 'Interview', 'Report']

/** Inline guidance: never covers the editor or appears during a live call. */
export const GuidedDemo = () => {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [confirmExample, setConfirmExample] = useState(false)
  const [insertedFor, setInsertedFor] = useState(0)
  if (!member.value?.demo) return null
  const guide = guidedDemo.value
  const path = url.path
  if (
    ![
      paths.recruiter,
      paths.newAssessment,
      paths.review,
      paths.assessment,
      paths.report,
      paths.candidate,
      paths.workspace,
      paths.interview,
      paths.done,
    ].some((p) => p === path)
  ) return null
  const candidate = me.value
  const invited = guide && path === paths.assessment
    ? getAssessment(guide.assessmentId)?.candidates.find((c) =>
      c.id === guide.candidateId
    )
    : undefined
  const ours = guide?.candidateId === candidate?.id && !!candidate
  const workspace = path === paths.workspace
  if (!guide && path !== paths.recruiter) return null
  if (workspace && (!ours || candidate?.submittedAt)) return null
  if (path === paths.interview && !ours) return null
  if (path === paths.done && !ours) return null
  const step = !guide
    ? 0
    : path === paths.assessment && Number(url.params.id) === guide.assessmentId
    ? 1
    : path === paths.candidate || workspace
    ? 2
    : path === paths.interview
    ? 3
    : path === paths.done ||
        (path === paths.report &&
          Number(url.params.candidate) === guide.candidateId)
    ? 4
    : 0
  const openAssessment = () =>
    navigate({
      href: paths.assessment,
      params: { id: guide!.assessmentId },
    })
  const start = async () => {
    setPending(true)
    setError('')
    try {
      const { id } = await api['POST/api/demo/assessment'].fetch()
      setGuidedDemo({ assessmentId: id })
      navigate({ href: paths.assessment, params: { id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }
  return (
    <aside
      aria-label='Guided demo'
      tw={workspace
        ? 'flex-none border-b border-accent-line bg-accent-soft px-4 py-3'
        : 'w-full max-w-[1120px] mx-auto px-4 sm:px-8 pt-5'}
    >
      <div
        tw={workspace
          ? 'flex flex-col gap-2'
          : 'card p-5 flex flex-col gap-3 border-accent-line'}
      >
        <div tw='flex items-center gap-3 flex-wrap'>
          <span tw='badge badge-accent'>Guided demo</span>
          <span tw='text-[12px] text-content-secondary'>
            Step {step + 1} of 5 · {STEPS[step]}
          </span>
          {guide && (
            <button
              type='button'
              tw='btn btn-ghost ml-auto h-7 px-2 text-[12px]'
              onClick={() => setGuidedDemo(null)}
            >
              Exit guide
            </button>
          )}
        </div>
        {!guide
          ? (
            <>
              <h2 tw='m-0 text-[19px] font-semibold'>
                Try the complete journey
              </h2>
              <p tw='m-0 text-[14px] text-content-secondary leading-relaxed'>
                Start with a prepared short-link assessment, invite a fictional
                candidate, load an example solution, then talk with Oracle and
                inspect the report. The assessment and code are examples; tests
                run in the sandbox and the interview and report use the
                configured AI models. Allow about 10–15 minutes and use a
                camera, microphone and headphones.
              </p>
              <div tw='flex gap-2 flex-wrap'>
                <button
                  type='button'
                  tw='btn btn-primary'
                  disabled={pending}
                  onClick={start}
                >
                  {pending ? 'Opening the demo…' : 'Start guided demo'}
                </button>
                <A href={paths.newAssessment} tw='btn btn-secondary'>
                  Or generate your own assessment
                </A>
              </div>
            </>
          )
          : step === 1
          ? (
            <>
              <p tw='m-0 text-[14px] text-content-secondary leading-relaxed'>
                This is a prepared example, ready to try. Review the routes and
                tests in the summary below. In “Invite a candidate”, choose
                “Fill in a demo candidate”, then “Create the personal link” and
                “Open as the candidate”. The prefill turns e-mail delivery off.
                You can generate your own assessment separately.
              </p>
              {invited?.link &&
                ['Invited', 'Building', 'Interview'].includes(invited.status) &&
                (
                  <a href={invited.link} tw='btn btn-primary self-start'>
                    Continue as the demo candidate
                  </a>
                )}
              {invited?.status === 'Finished' && (
                <A
                  href={paths.report}
                  params={{ candidate: invited.id }}
                  tw='btn btn-primary self-start'
                >
                  Open this candidate’s report
                </A>
              )}
            </>
          )
          : step === 2 && !workspace
          ? (
            <p tw='m-0 text-[14px] text-content-secondary leading-relaxed'>
              You are now the fictional candidate. Read the instructions and
              data notice, then start the building phase. The next step offers
              an example solution so you can try the coding tools quickly.
            </p>
          )
          : step === 2
          ? (
            <>
              <p tw='m-0 text-[13px] text-content-secondary leading-relaxed'>
                {evalResults.value && ownTests.value
                  ? 'Both test suites have run. Review their results, then choose Submit and declare any AI tools used. Oracle will ask about this code: read it before continuing.'
                  : 'Load the example or write your own code. Run “Evaluation tests” and “My tests”, inspect the results, then choose Submit. Read the code before the spoken interview.'}
              </p>
              <div tw='flex items-center gap-2 flex-wrap'>
                {confirmExample
                  ? (
                    <>
                      <span tw='text-[13px]'>
                        Replace files with the supplied example? Existing files
                        with the same names will be overwritten.
                      </span>
                      <button
                        type='button'
                        tw='btn btn-secondary h-8 text-[12px]'
                        disabled={!!running.value}
                        onClick={() => {
                          for (
                            const [path, code] of Object.entries(demoFiles)
                          ) updateFile(path, code)
                          setInsertedFor(candidate!.id)
                          setConfirmExample(false)
                        }}
                      >
                        Confirm example
                      </button>
                      <button
                        type='button'
                        tw='btn btn-ghost h-8 text-[12px]'
                        onClick={() => setConfirmExample(false)}
                      >
                        Cancel
                      </button>
                    </>
                  )
                  : (
                    <button
                      type='button'
                      tw='btn btn-secondary h-8 text-[12px]'
                      disabled={!!running.value}
                      onClick={() => setConfirmExample(true)}
                    >
                      {insertedFor === candidate?.id
                        ? 'Reload example solution'
                        : 'Load example solution'}
                    </button>
                  )}
                <span tw='text-[12px] text-content-tertiary'>
                  Supplied demo code, not work produced by a real candidate.
                </span>
              </div>
            </>
          )
          : step === 3
          ? (
            <p tw='m-0 text-[13px] text-content-secondary leading-relaxed'>
              Test your microphone, accept the camera and audio recording
              notice, then start the interview. Explain the code in your own
              words; if you used the example, you can say so. Try creating a
              link, validation, conflicts and click counts. The guide hides
              during the call.
            </p>
          )
          : step === 4
          ? (
            <>
              <p tw='m-0 text-[14px] text-content-secondary leading-relaxed'>
                {path === paths.done
                  ? 'The interview is complete. Return to the recruiter view to inspect the report; its AI analysis may take a moment.'
                  : 'Compare the verified test results with the AI interpretation. Expand code evidence and the transcript, inspect answer times and follow-up questions. The final decision remains with the recruiter.'}
              </p>
              <div tw='flex gap-2 flex-wrap'>
                {path === paths.done && guide.candidateId && (
                  <A
                    href={paths.report}
                    params={{ candidate: guide.candidateId }}
                    tw='btn btn-primary'
                  >
                    Open this candidate’s report
                  </A>
                )}
                {path === paths.report && (
                  <button
                    type='button'
                    tw='btn btn-primary'
                    onClick={() => setGuidedDemo(null)}
                  >
                    Finish guided demo
                  </button>
                )}
              </div>
            </>
          )
          : (
            <div tw='flex items-center gap-3 flex-wrap'>
              <p tw='m-0 text-[14px] text-content-secondary'>
                Your guided demo is still available.
              </p>
              <button
                type='button'
                tw='btn btn-secondary'
                onClick={openAssessment}
              >
                Resume guided demo
              </button>
            </div>
          )}
        {error && <p role='alert' tw='m-0 text-[13px] text-err'>{error}</p>}
      </div>
    </aside>
  )
}
