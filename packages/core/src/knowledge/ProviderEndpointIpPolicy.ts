export interface CanonicalIpLiteral {
  address: string;
  family: 4 | 6;
  embeddedIpv4Address: string | null;
  isMappedIpv6: boolean;
}

export interface ProviderEndpointIpClassification {
  literal: CanonicalIpLiteral;
  kind:
    | 'global'
    | 'ipv4-unspecified'
    | 'ipv4-private'
    | 'ipv4-loopback'
    | 'ipv4-link-local'
    | 'ipv4-shared'
    | 'ipv4-documentation'
    | 'ipv4-benchmarking'
    | 'ipv4-special'
    | 'ipv4-multicast'
    | 'ipv6-unspecified'
    | 'ipv6-loopback'
    | 'ipv6-mapped-ipv4'
    | 'ipv6-embedded-ipv4'
    | 'ipv6-nat64'
    | 'ipv6-6to4'
    | 'ipv6-teredo'
    | 'ipv6-discard-only'
    | 'ipv6-benchmarking'
    | 'ipv6-documentation'
    | 'ipv6-orchid'
    | 'ipv6-unique-local'
    | 'ipv6-link-local'
    | 'ipv6-site-local'
    | 'ipv6-multicast';
  isGlobalDestination: boolean;
  isExactLoopbackLiteral: boolean;
}

function normalizeIpLiteralCandidate(value: string): string {
  return value.trim().toLowerCase();
}

function parseIpv4Segments(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const segments: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    if (part.length > 1 && part.startsWith('0')) {
      return null;
    }
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    segments.push(value);
  }
  return segments;
}

function parseIpv6Segments(address: string): number[] | null {
  if (address.length === 0) {
    return null;
  }

  const compressionIndex = address.indexOf('::');
  if (compressionIndex !== -1 && address.indexOf('::', compressionIndex + 2) !== -1) {
    return null;
  }

  const [headText, tailText = ''] = compressionIndex === -1
    ? [address]
    : [address.slice(0, compressionIndex), address.slice(compressionIndex + 2)];
  const hasCompression = compressionIndex !== -1;

  const parseSide = (text: string, allowIpv4Tail: boolean): number[] | null => {
    if (text === '') {
      return [];
    }
    const parts = text.split(':');
    const segments: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (part === '') {
        return null;
      }
      const isLastPart = index === parts.length - 1;
      if (part.includes('.')) {
        if (!allowIpv4Tail || !isLastPart) {
          return null;
        }
        const ipv4Segments = parseIpv4Segments(part);
        if (!ipv4Segments) {
          return null;
        }
        segments.push((ipv4Segments[0]! << 8) | ipv4Segments[1]!);
        segments.push((ipv4Segments[2]! << 8) | ipv4Segments[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return null;
      }
      segments.push(Number.parseInt(part, 16));
    }
    return segments;
  };

  const headSegments = parseSide(headText, !hasCompression);
  const tailSegments = parseSide(tailText, true);
  if (!headSegments || !tailSegments) {
    return null;
  }

  if (!hasCompression) {
    return headSegments.length === 8 ? headSegments : null;
  }

  if (headSegments.length + tailSegments.length >= 8) {
    return null;
  }

  const zeroSegments = new Array<number>(8 - headSegments.length - tailSegments.length).fill(0);
  return [...headSegments, ...zeroSegments, ...tailSegments];
}

function canonicalizeIpv6Segments(segments: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;

  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === 0) {
      if (currentStart === -1) {
        currentStart = index;
        currentLength = 1;
      } else {
        currentLength += 1;
      }
      if (currentLength > bestLength) {
        bestStart = currentStart;
        bestLength = currentLength;
      }
      continue;
    }
    currentStart = -1;
    currentLength = 0;
  }

  if (bestLength < 2) {
    bestStart = -1;
  }

  if (bestStart === -1) {
    return segments.map((segment) => segment.toString(16)).join(':');
  }

  const before = segments.slice(0, bestStart).map((segment) => segment.toString(16)).join(':');
  const after = segments.slice(bestStart + bestLength).map((segment) => segment.toString(16)).join(':');
  if (before === '' && after === '') {
    return '::';
  }
  if (before === '') {
    return `::${after}`;
  }
  if (after === '') {
    return `${before}::`;
  }
  return `${before}::${after}`;
}

function ipv4FromTailSegments(segments: readonly number[]): string {
  const high = segments[6]!;
  const low = segments[7]!;
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join('.');
}

export function parseCanonicalIpLiteral(address: string): CanonicalIpLiteral {
  const normalized = normalizeIpLiteralCandidate(address);
  if (normalized.startsWith('[') || normalized.endsWith(']') || normalized.includes('[') || normalized.includes(']')) {
    throw new Error(`IP literal must not include brackets (${address})`);
  }
  if (normalized.includes('%')) {
    throw new Error(`IP literal must not include a zone identifier (${address})`);
  }

  const ipv4Segments = parseIpv4Segments(normalized);
  if (ipv4Segments) {
    return {
      address: ipv4Segments.join('.'),
      family: 4,
      embeddedIpv4Address: null,
      isMappedIpv6: false,
    };
  }

  const ipv6Segments = parseIpv6Segments(normalized);
  if (!ipv6Segments) {
    throw new Error(`Invalid IP literal (${address})`);
  }

  const isMappedIpv6 =
    ipv6Segments[0] === 0 &&
    ipv6Segments[1] === 0 &&
    ipv6Segments[2] === 0 &&
    ipv6Segments[3] === 0 &&
    ipv6Segments[4] === 0 &&
    ipv6Segments[5] === 0xffff;
  const isCompatibleEmbeddedIpv4 =
    ipv6Segments[0] === 0 &&
    ipv6Segments[1] === 0 &&
    ipv6Segments[2] === 0 &&
    ipv6Segments[3] === 0 &&
    ipv6Segments[4] === 0 &&
    ipv6Segments[5] === 0 &&
    !(ipv6Segments[6] === 0 && ipv6Segments[7] <= 1);
  const isNat64WellKnown =
    ipv6Segments[0] === 0x64 &&
    ipv6Segments[1] === 0xff9b &&
    ipv6Segments[2] === 0 &&
    ipv6Segments[3] === 0 &&
    ipv6Segments[4] === 0 &&
    ipv6Segments[5] === 0;
  const isNat64LocalUse =
    ipv6Segments[0] === 0x64 &&
    ipv6Segments[1] === 0xff9b &&
    ipv6Segments[2] === 0x1;
  const isTranslatedIpv4 =
    ipv6Segments[0] === 0 &&
    ipv6Segments[1] === 0 &&
    ipv6Segments[2] === 0 &&
    ipv6Segments[3] === 0 &&
    ipv6Segments[4] === 0xffff &&
    ipv6Segments[5] === 0;
  const embeddedIpv4Address = isMappedIpv6 || isCompatibleEmbeddedIpv4 || isNat64WellKnown || isNat64LocalUse || isTranslatedIpv4
    ? ipv4FromTailSegments(ipv6Segments)
    : null;

  return {
    address: canonicalizeIpv6Segments(ipv6Segments),
    family: 6,
    embeddedIpv4Address,
    isMappedIpv6,
  };
}

export function tryParseCanonicalIpLiteral(address: string): CanonicalIpLiteral | null {
  try {
    return parseCanonicalIpLiteral(address);
  } catch {
    return null;
  }
}

export function classifyProviderEndpointIp(address: string): ProviderEndpointIpClassification {
  const literal = parseCanonicalIpLiteral(address);
  const isExactLoopbackLiteral = literal.address === '127.0.0.1' || literal.address === '::1';
  const kind = literal.family === 4 ? classifyIpv4Literal(literal.address) : classifyIpv6Literal(literal);
  return {
    literal,
    kind,
    isGlobalDestination: kind === 'global',
    isExactLoopbackLiteral,
  };
}

function classifyIpv4Literal(address: string): ProviderEndpointIpClassification['kind'] {
  const octets = address.split('.').map((segment) => Number(segment));
  const [first = 0, second = 0, third = 0, fourth = 0] = octets;
  if (first === 0) {
    return 'ipv4-unspecified';
  }
  if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) {
    return 'ipv4-private';
  }
  if (first === 127) {
    return 'ipv4-loopback';
  }
  if (first === 169 && second === 254) {
    return 'ipv4-link-local';
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return 'ipv4-shared';
  }
  if (first === 192 && second === 0 && third === 2) {
    return 'ipv4-documentation';
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return 'ipv4-benchmarking';
  }
  if (first === 198 && second === 51 && third === 100) {
    return 'ipv4-documentation';
  }
  if (first === 203 && second === 0 && third === 113) {
    return 'ipv4-documentation';
  }
  if (first === 192 && second === 0 && third === 0 && (fourth === 9 || fourth === 10)) {
    return 'global';
  }
  if (first === 192 && second === 88 && third === 99) {
    return 'ipv4-special';
  }
  if (first >= 224 && first <= 239) {
    return 'ipv4-multicast';
  }
  if (first >= 224) {
    return 'ipv4-special';
  }
  if (first === 192 && second === 0 && third === 0) {
    return 'ipv4-special';
  }
  return 'global';
}

function classifyIpv6Literal(literal: CanonicalIpLiteral): ProviderEndpointIpClassification['kind'] {
  const segments = parseIpv6Segments(literal.address);
  if (!segments) {
    throw new Error(`Invalid canonical IPv6 literal (${literal.address})`);
  }
  const [first = 0, second = 0, third = 0, fourth = 0, fifth = 0, sixth = 0, seventh = 0, eighth = 0] = segments;

  if (first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0 && sixth === 0 && seventh === 0 && eighth === 0) {
    return 'ipv6-unspecified';
  }
  if (first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0 && sixth === 0 && seventh === 0 && eighth === 1) {
    return 'ipv6-loopback';
  }
  if (literal.isMappedIpv6) {
    return 'ipv6-mapped-ipv4';
  }
  if (literal.embeddedIpv4Address !== null) {
    const isNat64 =
      (first === 0x64 && second === 0xff9b && third === 0 && fourth === 0 && fifth === 0 && sixth === 0) ||
      (first === 0x64 && second === 0xff9b && third === 0x1);
    if (isNat64) {
      return 'ipv6-nat64';
    }
    return 'ipv6-embedded-ipv4';
  }
  if (first === 0x100 && second === 0 && third === 0 && fourth === 0) {
    return 'ipv6-discard-only';
  }
  if (first === 0x2001 && second === 0x2 && third === 0) {
    return 'ipv6-benchmarking';
  }
  if (first === 0x2001 && second === 0xdb8) {
    return 'ipv6-documentation';
  }
  if (first === 0x2001 && (second & 0xfff0) === 0x10) {
    return 'ipv6-orchid';
  }
  if (first === 0x2001 && (second & 0xfff0) === 0x20) {
    return 'ipv6-orchid';
  }
  if (first === 0x2002) {
    return 'ipv6-6to4';
  }
  if (first === 0x2001 && second === 0) {
    return 'ipv6-teredo';
  }
  if ((first & 0xfe00) === 0xfc00) {
    return 'ipv6-unique-local';
  }
  if ((first & 0xffc0) === 0xfe80) {
    return 'ipv6-link-local';
  }
  if ((first & 0xffc0) === 0xfec0) {
    return 'ipv6-site-local';
  }
  if ((first & 0xff00) === 0xff00) {
    return 'ipv6-multicast';
  }
  return 'global';
}
