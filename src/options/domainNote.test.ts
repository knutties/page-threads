import { describe, expect, test } from 'vitest'
import { registrableNote } from './domainNote'

describe('registrableNote', () => {
  test('a subdomain returns a note naming the registrable domain', () => {
    expect(registrableNote('mail.example.com')).toBe(
      'This affects all of example.com (subdomains collapse to the registrable domain).'
    )
  })
  test('a registrable domain returns null', () => {
    expect(registrableNote('example.com')).toBeNull()
  })
  test('blank or unparseable input returns null', () => {
    expect(registrableNote('')).toBeNull()
    expect(registrableNote('   ')).toBeNull()
    expect(registrableNote('localhost')).toBeNull()
  })
})
