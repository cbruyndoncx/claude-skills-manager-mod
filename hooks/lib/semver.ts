// Minimal semver coerce/compare (what the plugin used from the `semver` package).

export type Version = [number, number, number]

export function coerce(v: string | undefined): Version | null {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v ?? '')
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null
}

export function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]! ? 1 : -1
  return 0
}

/** True when `remote` is newer than `local`; null when either is not a version. */
export function isNewer(remote: string, local: string): boolean | null {
  const r = coerce(remote)
  const l = coerce(local)
  return r && l ? compare(r, l) > 0 : null
}
