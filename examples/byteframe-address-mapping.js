/** Convert raw file offsets to loaded-image addresses only when headers provide
 * an unambiguous mapping. File offsets are NOT memory addresses. */
const safe = value => Number.isSafeInteger(value) && value >= 0;
const toHex = value => `0x${value.toString(16).toUpperCase()}`;

export function addressAtFileOffset(structure, fileOffset) {
  if (!safe(fileOffset) || !structure) return null;
  const sections = structure.sections || [];
  if (structure.format?.startsWith('PE')) {
    const item = sections.find(s => s.rva !== undefined && s.rva !== null &&
      safe(s.start) && safe(s.size) && fileOffset >= s.start && fileOffset - s.start < s.size);
    if (!item) return null;
    const rva = item.rva + fileOffset - item.start;
    const virtualAddress = safe(structure.imageBase) && safe(structure.imageBase + rva)
      ? structure.imageBase + rva : null;
    return { kind:'PE', rva, virtualAddress, section:item.name };
  }
  if (structure.format?.startsWith('ELF')) {
    const item = sections.find(s => safe(s.virtualAddress) && safe(s.start) && safe(s.size) &&
      fileOffset >= s.start && fileOffset - s.start < s.size);
    if (!item) return null;
    const virtualAddress = item.virtualAddress + fileOffset - item.start;
    return safe(virtualAddress) ? {kind:'ELF',virtualAddress,section:item.name} : null;
  }
  return null;
}

export function resolveRelativeTarget(structure, startFileOffset, instruction) {
  if (!Number.isSafeInteger(instruction?.displacement) || !safe(startFileOffset)) return null;
  const nextFileOffset = startFileOffset + instruction.size;
  const mapped = addressAtFileOffset(structure, startFileOffset);
  const result = { nextFileOffset, displacement:instruction.displacement, fileOffsetTarget:null,
    addressKind:'unmapped', address:null, rva:null, virtualAddress:null };
  if (!mapped) return result; // Never mistake a file offset for an RVA or VA.
  if (mapped.kind === 'PE') {
    const nextRva = mapped.rva + instruction.size;
    const targetRva = nextRva + instruction.displacement;
    if (!safe(targetRva)) return result;
    result.addressKind = 'RVA'; result.rva = targetRva; result.address = toHex(targetRva);
    const va = safe(structure.imageBase) ? structure.imageBase + targetRva : null;
    if (safe(va)) result.virtualAddress = va;
    const section = structure.sections.find(s => safe(s.rva) && safe(s.start) && safe(s.size) &&
      targetRva >= s.rva && targetRva - s.rva < s.size);
    if (section) result.fileOffsetTarget = section.start + targetRva - section.rva;
  } else if (mapped.kind === 'ELF') {
    const targetVA = mapped.virtualAddress + instruction.size + instruction.displacement;
    if (!safe(targetVA)) return result;
    result.addressKind = 'VA'; result.virtualAddress = targetVA; result.address = toHex(targetVA);
    const section = structure.sections.find(s => safe(s.virtualAddress) && safe(s.start) && safe(s.size) &&
      targetVA >= s.virtualAddress && targetVA - s.virtualAddress < s.size);
    if (section) result.fileOffsetTarget = section.start + targetVA - section.virtualAddress;
  }
  return result;
}
