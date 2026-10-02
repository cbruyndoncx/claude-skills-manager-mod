// GitHub reference parsing and pure helpers for releases and monorepo trees.
import { coerce, compare } from './semver'

export type Release = { tag_name: string; prerelease: boolean; assets: { name: string; browser_download_url: string }[] }

export type SkillRef =
  | { type: 'github'; repo: string }
  | { type: 'github-monorepo'; repo: string; subpath: string }
  | { type: 'skills-sh'; skillsShId: string }

/** "owner/repo" or a GitHub URL → owner/repo. */
export function parseRepo(input: string): string | null {
  const cleaned = input.trim().replace(/\.git$/, '')
  const url = /github\.com\/([^/]+\/[^/]+)/.exec(cleaned)
  if (url) return url[1]!
  return /^[^/\s]+\/[^/\s]+$/.test(cleaned) ? cleaned : null
}

/** owner/repo, owner/repo/sub/path, GitHub (tree) URLs, skills.sh URLs. */
export function parseSkillRef(input: string): SkillRef | null {
  const t = input.trim()
  if (!t) return null
  if (/^https?:\/\/(www\.)?skills\.sh\//i.test(t)) {
    const m = /skills\.sh\/(.+)/i.exec(t)
    return m ? { type: 'skills-sh', skillsShId: m[1]!.replace(/\/+$/, '') } : null
  }
  const tree = /github\.com\/([^/]+\/[^/]+)\/tree\/[^/]+\/(.+)/.exec(t)
  if (tree) return { type: 'github-monorepo', repo: tree[1]!, subpath: tree[2]!.replace(/\/+$/, '') }
  const url = /github\.com\/([^/]+\/[^/]+?)\/?$/.exec(t)
  if (url) return { type: 'github', repo: url[1]!.replace(/\.git$/, '') }
  if (t.includes('://')) return null
  const seg = t.split('/')
  if (seg.length > 2) return { type: 'github-monorepo', repo: `${seg[0]}/${seg[1]}`, subpath: seg.slice(2).join('/') }
  return /^[^/\s]+\/[^/\s]+$/.test(t) ? { type: 'github', repo: t } : null
}

/** Stable releases (all when none are stable), newest semver first. */
export function sortReleases(releases: Release[]): Release[] {
  const stable = releases.filter(r => !r.prerelease)
  return [...(stable.length > 0 ? stable : releases)].sort((a, b) => {
    const va = coerce(a.tag_name)
    const vb = coerce(b.tag_name)
    return va && vb ? compare(vb, va) : 0
  })
}

/**
 * Pick the folder holding a monorepo skill from the repo's SKILL.md paths:
 * the only one, an exact folder match, then a partial match. Undefined means
 * "read each SKILL.md and match by name" (see matchByName).
 */
export function pickSkillSubpath(skillMdPaths: string[], skillId: string): string | undefined {
  const dirs = skillMdPaths.map(p => p.replace(/\/?SKILL\.md$/, ''))
  const base = (d: string) => d.split('/').pop() ?? ''
  if (dirs.length === 1) return dirs[0]
  return dirs.find(d => base(d) === skillId) ?? dirs.find(d => skillId.includes(base(d)) || base(d).includes(skillId))
}

export function matchByName(skillMd: string, skillId: string): boolean {
  const m = /^name:\s*["']?(.+?)["']?\s*$/m.exec(skillMd)
  if (!m) return false
  const name = m[1]!.toLowerCase().replace(/\s+/g, '-')
  const id = skillId.toLowerCase()
  return name === id || id.includes(name)
}

export const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/')
