export function testSkipNode17And18(...parameters: Parameters<typeof test>) {
  const version = process.version

  if (version.startsWith('v17.') || version.startsWith('v18.')) {
    test.skip(...parameters)
  } else {
    test(...parameters)
  }
}

export function describeSkipNode17And18(...parameters: Parameters<typeof describe>) {
  const version = process.version

  if (version.startsWith('v17.') || version.startsWith('v18.')) {
    describe.skip(...parameters)
  } else {
    describe(...parameters)
  }
}
