// Value chains: the end-to-end business flows skills and playbooks serve.
import type { PlaybookRow, SkillRow } from '../../types'

export const VALUE_CHAINS: { id: string; label: string }[] = [
  { id: 'lead-to-cash', label: 'Lead to Cash' },
  { id: 'market-to-order', label: 'Market to Order' },
  { id: 'order-to-fulfill', label: 'Order to Fulfill' },
  { id: 'deliver-to-satisfaction', label: 'Deliver to Satisfaction' },
  { id: 'service-to-renew', label: 'Service to Renew' },
  { id: 'concept-to-launch', label: 'Concept to Launch' },
  { id: 'create-to-publish', label: 'Create to Publish' },
  { id: 'plan-to-produce', label: 'Plan to Produce' },
  { id: 'procure-to-pay', label: 'Procure to Pay' },
  { id: 'hire-to-productivity', label: 'Hire to Productivity' },
  { id: 'record-to-insight', label: 'Record to Insight' },
  { id: 'plan-to-perform', label: 'Plan to Perform' },
  { id: 'operating-controls', label: 'Operating Controls' },
  { id: 'infrastructure', label: 'Infrastructure (skills only)' },
]

const titleCase = (id: string) => id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

/** The configured chains, then any chain the notes use that the list lacks. */
export function chainList(configured: string[], skills: SkillRow[], playbooks: PlaybookRow[]): { id: string; label: string }[] {
  const base = configured.length > 0
    ? configured.map(id => VALUE_CHAINS.find(c => c.id === id) ?? { id, label: titleCase(id) })
    : VALUE_CHAINS
  const seen = new Set(base.map(c => c.id))
  const extra = [...skills.flatMap(s => s.meta.valueChains), ...playbooks.map(p => p.valueChain)]
    .filter(id => id && !seen.has(id) && (seen.add(id), true))
    .map(id => ({ id, label: `${titleCase(id)} (not in list)` }))
  return [...base, ...extra]
}

export type ChainRow = {
  id: string
  label: string
  playbooks: PlaybookRow[]
  skills: SkillRow[]
  stages: string[]
  activePlaybooks: number
  enabledSkills: number
}

/** One row per chain plus the unassigned bucket ('' id), with coverage stages and gap counts. */
export function chainMatrix(chains: { id: string; label: string }[], skills: SkillRow[], playbooks: PlaybookRow[]): ChainRow[] {
  const row = (id: string, label: string, pbs: PlaybookRow[], sks: SkillRow[]): ChainRow => ({
    id, label, playbooks: pbs, skills: sks,
    stages: [...new Set(pbs.flatMap(p => p.coverage))],
    activePlaybooks: pbs.filter(p => p.status === 'active').length,
    enabledSkills: sks.filter(s => !s.meta.disableModelInvocation).length,
  })
  const rows = chains.map(c => row(c.id, c.label,
    playbooks.filter(p => p.valueChain === c.id),
    skills.filter(s => s.meta.valueChains.includes(c.id))))
  rows.push(row('', 'Unassigned', playbooks.filter(p => !p.valueChain), skills.filter(s => s.meta.valueChains.length === 0)))
  return rows
}

export function formatMatrix(rows: ChainRow[]): string {
  const lines = ['Value chain · playbooks (active) · skills (enabled) · stages covered']
  for (const r of rows) {
    const gap = r.id && (r.playbooks.length === 0 || r.skills.length === 0) ? '  ← gap' : ''
    lines.push(`${r.label.padEnd(30)} ${String(r.playbooks.length).padStart(3)} (${r.activePlaybooks})  ${String(r.skills.length).padStart(3)} (${r.enabledSkills})  ${r.stages.join(', ')}${gap}`)
  }
  return lines.join('\n')
}
