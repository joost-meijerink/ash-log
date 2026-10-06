// Helpers shared by the server tests. Not a test file itself.

/** The first bytes of a PNG: signature and IHDR with the given size. Enough for pngSize. */
export function pngHeader(width: number, height: number): Buffer {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    u32(13),
    Buffer.from('IHDR', 'latin1'),
    u32(width),
    u32(height),
    Buffer.from([8, 6, 0, 0, 0]),
    u32(0),
  ])
}
