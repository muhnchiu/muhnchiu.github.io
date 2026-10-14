// Presentation only: keep source Markdown and non-article collections intact.
export default function articlePresentation({ fileURL, data }) {
  const path = fileURL?.pathname ?? '';
  const frontmatter = data.astro?.frontmatter ?? {};
  if (!/\/src\/content\/(radar|research)\//.test(path)
      && frontmatter.type !== 'research' && !frontmatter.radar) return null;
  return {
    name: 'article-presentation',
    before(root, ctx) {
      const first = root.children.find(node => node.type !== 'yaml' && node.type !== 'toml');
      if (first?.type === 'heading' && first.depth === 1) ctx.removeNode(first);
      // Legacy collectors output one plain-text status paragraph. Render each
      // source as a separate row without changing its recorded status.
      for (let i = 0; i < root.children.length - 1; i++) {
        const heading = root.children[i];
        const paragraph = root.children[i + 1];
        if (heading.type !== 'heading' || ctx.textContent(heading) !== '数据状态' || paragraph.type !== 'paragraph') continue;
        const lines = ctx.textContent(paragraph).trim().split('\n');
        if (!lines.length || !lines.every(line => /\s+(OK|FAIL)\s*$/.test(line))) continue;
        ctx.replaceNode(paragraph, {
          type: 'list', ordered: false, spread: false,
          children: lines.map(line => {
            const [, source, status] = line.match(/^(.*?)\s+(OK|FAIL)\s*$/);
            return { type: 'listItem', spread: false, children: [{ type: 'paragraph', children: [
              { type: 'text', value: `${source.trim()} · ` },
              { type: 'strong', children: [{ type: 'text', value: status === 'OK' ? '采集成功' : '采集失败' }] },
            ] }] };
          }),
        });
      }
    },
  };
}
