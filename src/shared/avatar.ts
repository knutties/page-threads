// Mid-tone swatches that read on both light and dark grounds with white initials.
const AVATAR_COLORS = [
  '#4a8a3f', '#3f6db5', '#b5643f', '#8a4b9c',
  '#2f8f8a', '#b53f6b', '#9c8a2f', '#5a5f8a',
]

export function avatarInitial(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? ''
  return first ? first[0]!.toUpperCase() : '?'
}

export function avatarColor(fullName: string): string {
  let sum = 0
  for (const ch of fullName) sum += ch.codePointAt(0) ?? 0
  return AVATAR_COLORS[sum % AVATAR_COLORS.length]!
}
