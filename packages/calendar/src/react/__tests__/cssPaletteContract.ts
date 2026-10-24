/** Resolve root palette indirection for the existing literal CSS contracts.
 * Both branches are retained: defaults, and ONLY system roots in dark media.
 * Missing variables fail rather than hiding a removed palette declaration.
 */
export function paletteContractCss(css: string): string {
  const media = css.indexOf('@media (prefers-color-scheme: dark)');
  if (media < 0) throw new Error('Missing system dark media query');
  const defaults = css.match(/\.calendar-pane,\s*\.calendar-selector\s*\{([^}]+)\}/)?.[1];
  const dark = css.slice(media).match(/\.calendar-pane\[data-calendar-theme='system'\],\s*\.calendar-selector\[data-calendar-theme='system'\]\s*\{([^}]+)\}/)?.[1];
  if (!defaults || !dark) throw new Error('Missing independent root palette');
  function resolve(declarations: string) {
    const tokens = Object.fromEntries([...declarations.matchAll(/(--calendar-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
    return css.replace(/var\((--calendar-[\w-]+)\)/g, (_, name: string) => {
      if (name === '--calendar-footer-height') return `var(${name})`;
      if (!(name in tokens)) throw new Error(`Unresolved palette token ${name}`);
      return tokens[name];
    });
  }
  return `${resolve(defaults)}\n@media (prefers-color-scheme: dark) {\n${resolve(defaults + dark)}\n}`;
}
