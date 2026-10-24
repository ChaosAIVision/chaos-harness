/** Human-response fixture at the real user-questions waterfall, not the compat approval callback. */
import { appendFileSync } from 'node:fs'

export function apply(ctx, config) {
  ctx.on('user-questions/request', (request, next) => {
    if (!request.questions.some(question => question.id === 'pstack-routes')) return next()
    appendFileSync(config.recordPath, `${JSON.stringify(request.questions)}\n`)
    return { answers: request.questions.map(question => ({ id: question.id, selected: [config.authorize ? 'Authorize routes' : 'Cancel'] })) }
  }, { global: true })
}
