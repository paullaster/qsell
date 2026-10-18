import { crc32, deflateRawSync } from 'node:zlib';

/** A minimal zip writer, enough to build a workbook for the tests (stored or deflated parts). */
export function zip(files: Record<string, string>, opts: { method?: 0 | 8; lieAboutSize?: number; encrypted?: boolean } = {}): Buffer {
  const method = opts.method ?? 8;
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const flags = opts.encrypted === true ? 1 : 0;
    const declared = opts.lieAboutSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(flags, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc32(raw), 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(declared, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export const workbook = (sheetXml: string, strings: string[] = []) => ({
  'xl/workbook.xml': '<workbook xmlns="x" xmlns:r="y"><sheets><sheet name="Statement" sheetId="1" r:id="rId7"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId7" Type="t" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml': `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheetXml}</sheetData></worksheet>`,
});
