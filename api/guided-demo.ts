import { respond } from '@01edu/api/response'
import { Assessment, demoCompanyId, demoMemberId, Entry } from '/api/schema.ts'
import { demoAssessment } from '/fixtures/demo.ts'

const existing = Assessment.sql<'assessmentId', number>`
  SELECT assessmentId FROM assessment
  WHERE companyId = ? AND assessmentDomain = 'guided-demo-v1'
  ORDER BY assessmentId LIMIT 1
`.get

/** A prepared example, explicitly separate from live assessment generation. */
export const prepareGuidedDemo = (memberId: number) => {
  if (Deno.env.get('DEMO_ACCESS') !== '1' || memberId !== demoMemberId) {
    throw new respond.NotFoundError({ message: 'Demo unavailable.' })
  }
  const found = existing(demoCompanyId)
  if (found) return { id: found.assessmentId }
  const assessmentId = Assessment.insert({
    companyId: demoCompanyId,
    assessmentCreatedBy: demoMemberId,
    assessmentTitle: demoAssessment.title,
    assessmentLevel: demoAssessment.level,
    assessmentDuration: demoAssessment.durationMin,
    assessmentJobDescription: demoAssessment.jobDescription,
    assessmentSpec: demoAssessment,
    assessmentSkills: demoAssessment.skills.map((s) => s.name),
    assessmentDomain: 'guided-demo-v1',
    assessmentKind: 'api',
    assessmentLanguages: ['typescript'],
    assessmentStatus: 'approved',
    assessmentCreatedAt: Date.now(),
    assessmentApprovedAt: Date.now(),
  })
  Entry.insert.ASSESSMENT_CREATED({ companyId: demoCompanyId, assessmentId })
  return { id: assessmentId }
}
