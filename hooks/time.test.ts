import { expect, test } from 'claude-code/testing'

import { fmtRange, fmtTC, parseWhen } from './time'

test('the Go to field reads seconds, frames, timecode and ranges', async () => {
  expect(parseWhen('12.5', 24)).toEqual({ f0: 300, f1: 300 })
  expect(parseWhen('f300', 24)).toEqual({ f0: 300, f1: 300 })
  expect(parseWhen('300f', 24)).toEqual({ f0: 300, f1: 300 })
  expect(parseWhen('0:12:12', 24)).toEqual({ f0: 300, f1: 300 })
  expect(parseWhen('0:12.5', 24)).toEqual({ f0: 300, f1: 300 })
  expect(parseWhen('12.5-14', 24)).toEqual({ f0: 300, f1: 336 })
  expect(parseWhen('f300 to f336', 24)).toEqual({ f0: 300, f1: 336 })
  expect(parseWhen('0:12:12 – 0:14:00', 24)).toEqual({ f0: 300, f1: 336 })
  expect('error' in parseWhen('14-12', 24)).toBe(true)
  expect('error' in parseWhen('soon', 24)).toBe(true)
  expect(fmtTC(300, 24)).toBe('00:12:12')
  expect(fmtRange(300, 336, 24)).toBe('F0300–F0336 · 12.50–14.00 s')
})
