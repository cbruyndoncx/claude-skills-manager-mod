export type SkillMeta = {
  name: string
  description: string
  category: string
  disableModelInvocation: boolean
  userInvocable: boolean
  version?: string
  source?: string
  originRepo?: string
  originUrl?: string
  origin?: string
  license?: string
  compatibility?: string
  allowedTools?: string
  valueChains: string[]
}

export type Threat = { severity: 'warning' | 'danger'; file: string; description: string }
export type ScanResult = { threats: Threat[]; riskLevel: 'clean' | 'warning' | 'danger' }

export type RegistryType = 'skills-sh' | 'skillsmp' | 'tessl'
export type RegistrySkill = { name: string; source: string; skillId: string; installs: number; description?: string; stars?: number }

export type SkillSource = 'local' | 'zip' | 'github'

/** Install bookkeeping, persisted in $.store (the plugin's data.json). */
export type SkillState = {
  source: SkillSource
  repo?: string
  version?: string
  frozen: boolean
  installedAt: string
  lastUpdated?: string
}

export type SkillRow = { folder: string; meta: SkillMeta; state?: SkillState; risk: ScanResult['riskLevel'] }

export type Tab = 'installed' | 'playbooks' | 'chains' | 'marketplace' | 'add'

export type View = {
  tab: Tab
  search: string
  includeDesc: boolean
  source: 'all' | SkillSource
  expanded: string[]
  selected: string
  confirmDelete: string
  updates: Record<string, string>
}

export type Detail = { folder: string; files: string[]; body: string; scan: ScanResult } | null

export type Market = {
  registry: RegistryType
  board: string
  search: string
  page: number
  results: RegistrySkill[]
  hasMore: boolean
  status: string
  log: string[]
  installed: string[]
}

export type AddForm = {
  input: string
  versions: string[]
  version: string
  status: string
  zip: { tmp: string; skills: { dir: string; folder: string; name: string }[] } | null
}

export type PlaybookRow = {
  path: string
  title: string
  trigger: string
  outcome: string
  status: string
  valueChain: string
  coverage: string[]
  maturity: string[]
  tags: string[]
  steps?: number
  duration: string
  pricingTier: string
  isPinned: boolean
}

export type PlaybookView = { search: string; status: string; chain: string; maturity: string; selected: string }
export type PlaybookDetail = { path: string; body: string } | null
export type ChainView = { expanded: string[]; showEmpty: boolean }

declare module 'claude-code' {
  interface PluginState {
    'skills-manager': {
      skills: SkillRow[]
      view: View
      detail: Detail
      market: Market
      add: AddForm
      busy: string
      playbooks: PlaybookRow[]
      pbView: PlaybookView
      pbDetail: PlaybookDetail
      chainView: ChainView
    }
  }
}
