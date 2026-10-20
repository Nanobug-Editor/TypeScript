/** Unknown ecosystem semantics are supplied as immutable module configuration, never LSP replies. */
'use strict';

/** Create the selected fixture role without resolving or executing project-local plugins.
 * @param {object} context - Vue's already admitted language context and immutable contribution config.
 * @returns {object} A role-limited Vue plugin; the real compiler produces diagnostics and edits.
 */
module.exports = ({ config = {}, modules }) => {
  if (config.role === 'template') {
    return {
      version: 2.2,
      /** Compile Quill with unchanged source coordinates through the locked Vue DOM compiler.
       * @param {string} lang - SFC template language; other languages retain their normal compiler.
       * @param {string} source - Original template block text.
       * @param {object} options - The selected backend's existing compiler options.
       * @returns {object|undefined} A source-preserving AST, or no claim for another language.
       */
      compileSFCTemplate(lang, source, options) {
        if (lang === 'quill') return modules['@vue/compiler-dom'].compile(source, options);
      },
    };
  }
  if (config.role === 'style') {
    return {
      version: 2.2,
      /** Expose Ink's original expression verbatim for Vue's source mapping.
       * @param {string} lang - SFC style language; only the fixture language is claimed.
       * @param {string} source - Original style block text, without a generated intermediary.
       * @returns {object|undefined} Exact source-backed bindings, or no claim for another language.
       */
      compileSFCStyle(lang, source) {
        if (lang !== 'ink') return;
        const expression = 'shade.toUpperCase()';
        const offset = source.indexOf(expression);
        return { imports: [], classNames: [], bindings: offset < 0 ? [] : [{ text: expression, offset }] };
      },
    };
  }
  if (config.role === 'project') {
    const enabled = config.enabled ?? true;
    if (typeof enabled !== 'boolean') throw new Error('Invalid fixture project setting');
    // This data-only whitelist is combined by Vue before any project options become effective.
    return { version: 2.2, vueCompilerOptions: { checkUnknownComponents: enabled } };
  }
  const expectedType = config.expectedType ?? 'string';
  if (!['string', 'number'].includes(expectedType)) throw new Error('Invalid fixture expectedType');
  return {
    version: 2.2,
    /** Append a type constraint around an unchanged numeric token.
     * @param {string} _file - Backend file identity, unused by this source-only fixture.
     * @param {object} sfc - The same SFC snapshot used by the backend's virtual-code generator.
     * @param {object} code - Generated embedded code; only script_ts receives the extra constraint.
     */
    resolveEmbeddedCode(_file, sfc, code) {
      const block = sfc.scriptSetup ?? sfc.script;
      if (code.id !== 'script_ts' || !block) return;
      const offset = block.content.indexOf('42');
      if (offset < 0) return;
      // Negative fixture mode intentionally violates the ABI so the real sealed loader must reject it.
      const mappedOffset = config.invalidMapping ? block.content.length + 1 : offset;
      code.content.push(`\ndeclare function __unknown_check(value: ${expectedType}): void;\n__unknown_check(`,
        ['42', block.name, mappedOffset, { verification: true }], ');\n');
    },
  };
};
