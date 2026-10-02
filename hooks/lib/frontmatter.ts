// SKILL.md frontmatter: parse, edit and normalise (flat key: value YAML, no library).

import type { SkillMeta } from '../../types'

const FM = /^---\r?\n([\s\S]*?)\r?\n---/

export function parseFrontmatter(content: string): Record<string, string> {
  const match = FM.exec(content)
  if (!match) return {}
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const kv = /^(\S[^:]*?):\s*(.*)/.exec(line)
    if (kv) fields[kv[1]!.trim()] = kv[2]!.trim()
  }
  return fields
}

const strip = (v?: string) => (v ? v.replace(/^["']|["']$/g, '') : '')
const toBool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : ['true', 'yes'].includes(strip(v).toLowerCase())

/** Null when the required name/description are missing (the skill is skipped, as in the plugin). */
export function toSkillMeta(content: string, defaultCategory: string): SkillMeta | null {
  const f = parseFrontmatter(content)
  const name = strip(f['name'])
  const description = strip(f['description'])
  if (!name || !description) return null
  const opt = (k: string) => strip(f[k]) || undefined
  return {
    name,
    description,
    category: strip(f['category']) || defaultCategory,
    disableModelInvocation: toBool(f['disable-model-invocation'], false),
    userInvocable: toBool(f['user-invocable'], true),
    version: opt('version'),
    source: opt('source'),
    originRepo: opt('origin-repo'),
    originUrl: opt('origin-url'),
    origin: opt('origin'),
    license: opt('license'),
    compatibility: opt('compatibility'),
    allowedTools: opt('allowed-tools'),
  }
}

/** Set one frontmatter field: replace when present, else insert before the closing ---. */
export function setField(content: string, field: string, value: string): string {
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const line = new RegExp(`^(${esc}:[ \\t]*).*$`, 'm')
  const fm = FM.exec(content)
  if (!fm) return content
  const head = fm[1]!
  if (line.test(head)) {
    const body = head.replace(line, `$1${value}`)
    return content.replace(head, () => body)
  }
  return content.replace(/^(---\r?\n[\s\S]*?\r?\n)(---)/, `$1${field}: ${value}\n$2`)
}

export function extractBody(content: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(content)
  return (m ? m[1]! : content).trim()
}

export const REQUIRED_FIELDS: { field: string; defaultValue: string }[] = [
  { field: 'category', defaultValue: 'uncategorized' },
  { field: 'version', defaultValue: '1.0.0' },
  { field: 'disable-model-invocation', defaultValue: 'false' },
  { field: 'user-invocable', defaultValue: 'true' },
]

export type FrontmatterDefaults = Partial<Record<'category' | 'version' | 'source' | 'origin-repo' | 'origin-url', string>>

/** Fill in missing standard fields (never overwrites). Returns the content unchanged when nothing is missing. */
export function ensureFrontmatter(content: string, defaults: FrontmatterDefaults = {}): string {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(content)
  if (!m) return content
  let fm = m[2]!
  const ensure = (field: string, value: string) => {
    if (!new RegExp(`^${field}\\s*:`, 'm').test(fm)) fm += `\n${field}: ${value}`
  }
  for (const { field, defaultValue } of REQUIRED_FIELDS) {
    ensure(field, (defaults as Record<string, string | undefined>)[field] || defaultValue)
  }
  if (defaults.source) ensure('source', defaults.source)
  if (defaults['origin-repo']) {
    ensure('origin-repo', defaults['origin-repo'])
    ensure('origin-url', defaults['origin-url'] || `https://github.com/${defaults['origin-repo']}`)
  }
  return fm === m[2] ? content : `${m[1]}${fm}${m[3]}${content.slice(m[0].length)}`
}

export const TEMPLATE_FILENAME = 'skill-frontmatter-template.md'

export const FRONTMATTER_TEMPLATE = `---
name: skill-name
description: What this skill does and when to use it
category: uncategorized
version: 1.0.0
disable-model-invocation: false
user-invocable: true
source: local
origin-repo: owner/repo
origin-url: https://github.com/owner/repo
license: MIT
compatibility:
allowed-tools:
---

# Frontmatter Field Reference

This file defines the standard frontmatter fields for SKILL.md files managed by Skills Manager.
The installer fills in missing fields automatically.

## Required Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| name | string | (folder name) | Skill identifier, used for display and triggering |
| description | string | — | What the skill does and when to use it. This is the primary trigger mechanism. |

## Standard Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| category | string | uncategorized | Grouping category for the skills manager UI |
| version | string | 1.0.0 | Semantic version of the skill |
| disable-model-invocation | boolean | false | Set to true to disable the skill without removing it |
| user-invocable | boolean | true | Whether the user can invoke this skill directly |

## Source Tracking Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| source | string | local | Installation source: local, github, or zip |
| origin-repo | string | — | GitHub owner/repo if installed from GitHub |
| origin-url | string | — | URL to the original source repository |
| license | string | — | License identifier or reference |

## Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| compatibility | string | — | Environment requirements |
| allowed-tools | string | — | Tool restrictions for the skill |

This file is auto-generated by the Skills Manager mod. Do not edit manually.
`
