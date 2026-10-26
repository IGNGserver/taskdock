// Read only meta-tag attributes; this is not a general-purpose HTML parser.
// Quoted values can contain whitespace and >, and formatting may use />.
export function readMetaTags(html) {
  const source = html.replace(/<!--[\s\S]*?-->/g, '');
  return [...source.matchAll(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)].map(([tag]) => {
    const attributes = new Map();
    for (const match of tag.matchAll(
      /\s+([a-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi,
    )) {
      const name = match[1].toLowerCase();
      // HTML keeps the first occurrence of a duplicate attribute.
      if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    }
    return attributes;
  });
}
