import { describe, expect, test } from 'vitest'
import { avatarColor, avatarInitial } from './avatar'

describe('avatarInitial', () => {
  test('uppercases the first letter of the first word', () => {
    expect(avatarInitial('Ada Lovelace')).toBe('A')
    expect(avatarInitial('  ravi kumar')).toBe('R')
  })
  test('empty or blank name falls back to ?', () => {
    expect(avatarInitial('')).toBe('?')
    expect(avatarInitial('   ')).toBe('?')
  })
})

describe('avatarColor', () => {
  test('is deterministic for the same name', () => {
    expect(avatarColor('Ada Lovelace')).toBe(avatarColor('Ada Lovelace'))
  })
  test('returns a hex from the palette', () => {
    expect(avatarColor('Ravi Kumar')).toMatch(/^#[0-9a-f]{6}$/)
  })
})
