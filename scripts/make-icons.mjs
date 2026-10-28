// Generates the PWA icons with no dependencies (pure Node). Run: npm run icons
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const TEAL = [15, 118, 110]
const WHITE = [255, 255, 255]

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// Coin with an "=" (balance) sign. `radius` is the coin size in [-1,1] space;
// the maskable icon uses a smaller coin so it stays inside Android's safe zone.
function colorAt(x, y, radius) {
  if (x * x + y * y > radius * radius) return TEAL
  const bar = (cy) => Math.abs(x) < radius * 0.45 && Math.abs(y - cy) < radius * 0.1
  return bar(-radius * 0.22) || bar(radius * 0.22) ? TEAL : WHITE
}

function png(size, radius) {
  const rows = []
  const SS = 3 // 3x3 supersampling for smooth edges
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3)
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 2 - 1
          const y = ((py + (sy + 0.5) / SS) / size) * 2 - 1
          const [cr, cg, cb] = colorAt(x, y, radius)
          r += cr; g += cg; b += cb
        }
      }
      const n = SS * SS
      row.set([Math.round(r / n), Math.round(g / n), Math.round(b / n)], 1 + px * 3)
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync('public/icons', { recursive: true })
writeFileSync('public/icons/icon-192.png', png(192, 0.72))
writeFileSync('public/icons/icon-512.png', png(512, 0.72))
writeFileSync('public/icons/icon-maskable-512.png', png(512, 0.55))
console.log('icons written to public/icons')
