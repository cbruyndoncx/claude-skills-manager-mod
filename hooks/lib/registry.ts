// Marketplace registries: Skills.sh (open), SkillsMP (API key), Tessl (no public API).

import type { RegistrySkill, RegistryType } from '../../types'
export type RegistryPage = { skills: RegistrySkill[]; hasMore: boolean }

export const REGISTRIES: Record<RegistryType, { label: string; url: string; boards: { id: string; label: string }[] }> = {
  'skills-sh': {
    label: 'Skills.sh',
    url: 'https://skills.sh/api/skills',
    boards: [{ id: 'all-time', label: 'All Time' }, { id: 'trending', label: 'Trending' }, { id: 'hot', label: 'Hot' }],
  },
  skillsmp: {
    label: 'SkillsMP',
    url: 'https://skillsmp.com/api/v1/skills',
    boards: [{ id: 'stars', label: 'Most Stars' }, { id: 'recent', label: 'Recent' }],
  },
  tessl: { label: 'Tessl (CLI only)', url: 'https://tessl.io/registry', boards: [{ id: 'all', label: 'All' }] },
}

/** The request for one page; an error string when the registry cannot be browsed. */
export function registryRequest(type: RegistryType, board: string, page: number, search: string, apiKey: string):
  { url: string; headers: Record<string, string> } | { error: string } {
  if (type === 'tessl') return { error: 'Tessl has no public REST API yet. Use the Tessl CLI (tessl search).' }
  if (type === 'skills-sh') return { url: `${REGISTRIES[type].url}/${board}/${page}`, headers: {} }
  if (!apiKey) return { error: 'SkillsMP needs an API key (skillsmp.com/settings/api); set it in /config.' }
  const q = new URLSearchParams({ q: search || '*', page: String(page + 1), per_page: '20', sort: board })
  return { url: `${REGISTRIES[type].url}/search?${q}`, headers: { Authorization: `Bearer ${apiKey}` } }
}

export function parseRegistry(type: RegistryType, page: number, json: any): RegistryPage {
  if (type === 'skills-sh') {
    return {
      skills: (json.skills ?? []).map((s: any) => ({ name: s.name, source: s.source, skillId: s.skillId, installs: s.installs ?? 0, description: s.description })),
      hasMore: !!json.hasMore,
    }
  }
  if (!json.success) throw new Error('SkillsMP returned an unsuccessful response')
  const d = json.data ?? {}
  return {
    skills: (d.skills ?? []).map((s: any) => ({
      name: s.name || s.skill_name || 'Unknown',
      source: s.source || s.repo || s.github_url || '',
      skillId: s.name || s.skill_name || '',
      installs: s.install_count || 0,
      description: s.description,
      stars: s.stars,
    })),
    hasMore: d.hasNext ?? (d.totalPages ? page + 1 < d.totalPages : false),
  }
}

/** Client-side filter (Skills.sh has no server search). */
export const filterSkills = (skills: RegistrySkill[], q: string) =>
  q ? skills.filter(s => `${s.name} ${s.description ?? ''} ${s.source}`.toLowerCase().includes(q.toLowerCase())) : skills
