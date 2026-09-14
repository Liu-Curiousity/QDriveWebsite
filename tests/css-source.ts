import postcss from 'postcss';

export function astroCssForAssertions(source: string): string {
  return source.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g,
    (_match, open, css, close) => `${open}\n${cssForAssertions(css)}\n${close}`);
}

// Test declarations, not whether an optimizer placed them in a shared selector
// block. Keep conditional scopes separate; this is not a browser cascade engine.
export function cssForAssertions(source: string): string {
  const root = postcss.parse(source);
  const normalize = (text: string) => text
    .replace(/\[([\w-]+)=([\w-]+)\]/g, "[$1='$2']")
    .replace(/\s+/g, ' ').trim();
  function render(container: postcss.Container): string {
    const declarations = new Map<string, string[]>();
    const rules: Array<{ selectors: string[] }> = [];
    const nested: string[] = [];
    for (const node of container.nodes ?? []) {
      if (node.type === 'atrule' && node.nodes) {
        nested.push(`@${node.name} ${node.params} {\n${render(node)}\n}`);
      } else if (node.type === 'rule') {
        const selectors = postcss.list.comma(node.selector).map(normalize);
        rules.push({ selectors });
        for (const selector of selectors) {
          const values = declarations.get(selector) ?? [];
          node.walkDecls(d => {
            const value = d.prop === 'background' && d.value === '0 0' ? 'transparent'
              : d.prop === 'clip' ? d.value.replace(/,\s*/g, ' ') : d.value;
            values.push(`${d.prop}: ${value}${d.important ? ' !important' : ''};`);
          });
          declarations.set(selector, values);
        }
      }
    }
    const singles = [...declarations].map(([selector, values]) => `${selector} {\n${values.join('\n')}\n}`);
    const groups = rules.filter(r => r.selectors.length > 1).map(r => {
      const common = declarations.get(r.selectors[0])!.filter(d => r.selectors.every(s => declarations.get(s)!.includes(d)));
      return `${r.selectors.join(',\n')} {\n${common.join('\n')}\n}`;
    });
    return [...singles, ...groups, ...nested].join('\n');
  }
  return render(root);
}
