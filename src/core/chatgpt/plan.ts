/** The one spelling of a plan name, shared by the CLI, the browser and the phone. */
export function chatGptPlanName(plan?: string): string | undefined {
  if (!plan) return undefined
  return plan.charAt(0).toUpperCase() + plan.slice(1)
}
