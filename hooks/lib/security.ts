// Security scan patterns: script risks and prompt-injection markers.

import type { ScanResult, Threat } from '../../types'

type Pattern = { pattern: RegExp; severity: 'warning' | 'danger'; description: string }

const SCRIPT: Pattern[] = [
  { pattern: /\bcurl\b/, severity: 'warning', description: 'Network call: curl' },
  { pattern: /\bwget\b/, severity: 'warning', description: 'Network call: wget' },
  { pattern: /\bfetch\s*\(/, severity: 'warning', description: 'Network call: fetch()' },
  { pattern: /\brequests\.(post|get|put)\b/, severity: 'warning', description: 'Network call: python requests' },
  { pattern: /\bnc\s+-/, severity: 'danger', description: 'Network call: netcat' },
  { pattern: /\brm\s+-rf\b/, severity: 'danger', description: 'Destructive: rm -rf' },
  { pattern: /\bshred\b/, severity: 'danger', description: 'Destructive: shred' },
  { pattern: /\bdd\s+if=\/dev\//, severity: 'danger', description: 'Destructive: dd from device' },
  { pattern: /curl\s.*\|\s*bash/, severity: 'danger', description: 'Remote code execution: curl pipe to bash' },
  { pattern: /\beval\s*\(/, severity: 'danger', description: 'Code execution: eval()' },
  { pattern: /\bexec\s*\(/, severity: 'warning', description: 'Code execution: exec()' },
  { pattern: /~\/\.ssh/, severity: 'danger', description: 'Credential access: ~/.ssh' },
  { pattern: /~\/\.aws/, severity: 'danger', description: 'Credential access: ~/.aws' },
  { pattern: /~\/\.env/, severity: 'warning', description: 'Credential access: ~/.env' },
  { pattern: /~\/\.npmrc/, severity: 'warning', description: 'Credential access: ~/.npmrc' },
]

const INJECTION: Pattern[] = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, severity: 'danger', description: 'Prompt injection: ignore previous instructions' },
  { pattern: /you\s+are\s+now\b/i, severity: 'danger', description: 'Prompt injection: role override' },
  { pattern: /<!--[\s\S]*?(ignore|override|forget)/i, severity: 'danger', description: 'Prompt injection: hidden command in HTML comment' },
  { pattern: /\bdo\s+not\s+follow\s+(the\s+)?(above|previous)\b/i, severity: 'danger', description: 'Prompt injection: instruction override' },
]

const hits = (text: string, file: string, set: Pattern[]): Threat[] =>
  set.filter(p => p.pattern.test(text)).map(p => ({ severity: p.severity, file, description: p.description }))

/** SKILL.md body gets injection + script checks; files under scripts/ get script checks. */
export function scanSkill(skillMdBody: string | undefined, scripts: { file: string; text: string }[]): ScanResult {
  const threats: Threat[] = []
  if (skillMdBody !== undefined) {
    threats.push(...hits(skillMdBody, 'SKILL.md', INJECTION), ...hits(skillMdBody, 'SKILL.md', SCRIPT))
  }
  for (const s of scripts) threats.push(...hits(s.text, s.file, SCRIPT))
  const riskLevel = threats.some(t => t.severity === 'danger') ? 'danger' : threats.length > 0 ? 'warning' : 'clean'
  return { threats, riskLevel }
}
