// Playbook notes (type: playbook): parse, filter, and the prompt that runs one.
import type { PlaybookRow, PlaybookView } from '../../types'
import { parseFrontmatter, parseList } from './frontmatter'

const strip = (v?: string) => (v ? v.replace(/^["']|["']$/g, '').trim() : '')

/** Null unless the note's frontmatter says `type: playbook`. */
export function toPlaybook(path: string, content: string, pinned: string[]): PlaybookRow | null {
  const f = parseFrontmatter(content)
  if (strip(f['type']).toLowerCase() !== 'playbook') return null
  const base = path.split('/').pop()!.replace(/\.md$/, '')
  const steps = Number(strip(f['total-steps']))
  return {
    path,
    title: strip(f['title']) || base,
    trigger: strip(f['trigger']),
    outcome: strip(f['outcome']),
    status: strip(f['status']) || 'draft',
    valueChain: strip(f['value-chain']),
    coverage: parseList(content, 'chain-coverage'),
    maturity: parseList(content, 'maturity'),
    tags: parseList(content, 'tags'),
    steps: Number.isFinite(steps) && strip(f['total-steps']) !== '' ? steps : undefined,
    duration: strip(f['estimated-duration']),
    pricingTier: strip(f['pricing-tier']),
    isPinned: pinned.includes(path),
  }
}

export function filterPlaybooks(rows: PlaybookRow[], v: PlaybookView): PlaybookRow[] {
  const q = v.search.toLowerCase()
  return rows
    .filter(p => !v.status || p.status === v.status)
    .filter(p => !v.chain || (v.chain === '(none)' ? !p.valueChain : p.valueChain === v.chain))
    .filter(p => !v.maturity || p.maturity.includes(v.maturity))
    .filter(p => !q || `${p.title} ${p.trigger} ${p.outcome} ${p.tags.join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || a.title.localeCompare(b.title))
}

export function findPlaybook(rows: PlaybookRow[], name: string): PlaybookRow | undefined {
  const n = name.toLowerCase()
  return rows.find(p => p.path === name) ?? rows.find(p => p.title.toLowerCase() === n)
    ?? rows.find(p => p.path.split('/').pop()!.replace(/\.md$/, '').toLowerCase() === n)
}

/**
 * The turn that runs a playbook: the vault's `/playbook-runner` skill when it
 * is installed (what BOB's Playbook Runner sends), else a direct instruction.
 */
export function runPrompt(p: PlaybookRow, hasRunnerSkill: boolean, extra = ''): string {
  if (hasRunnerSkill) return `/playbook-runner ${p.title}${extra ? ` ${extra}` : ''}`
  return [
    `Run the playbook "${p.title}" (${p.path}).`,
    'Read the file first, then work through its steps in order with me: say which step you are on, do what you can, and ask me before anything irreversible.',
    p.outcome && `Done means: ${p.outcome}`,
    extra && `Context: ${extra}`,
  ].filter(Boolean).join('\n')
}
