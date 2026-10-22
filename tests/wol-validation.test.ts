// Tests the real sendWakeOnLan implementation — no mocks.
import { describe, it, expect } from '@jest/globals'
import { sendWakeOnLan } from '../src/wol.js'

describe('sendWakeOnLan — MAC validation', () => {
  it('rejects invalid MAC address', async () => {
    await expect(sendWakeOnLan('not-a-mac')).rejects.toThrow('Invalid MAC address')
  })

  it('rejects MAC with wrong byte count', async () => {
    await expect(sendWakeOnLan('aa:bb:cc:dd:ee')).rejects.toThrow('Invalid MAC address')
  })

  it('rejects MAC with NaN bytes', async () => {
    await expect(sendWakeOnLan('zz:bb:cc:dd:ee:ff')).rejects.toThrow('Invalid MAC address')
  })

  it('resolves for valid MAC (sends UDP broadcast to 255.255.255.255:9)', async () => {
    await expect(sendWakeOnLan('aa:bb:cc:dd:ee:ff')).resolves.toBeUndefined()
  }, 5000)
})
