/**
 * eslint-plugin-tapsmith
 *
 * ESLint rules that encourage accessible, maintainable locators in Tapsmith
 * tests.
 *
 * Rules:
 *   - prefer-role: Warns when `.locator({ className })` is used for standard
 *     Android widgets that have well-known accessibility roles.
 *   - no-bare-locator-xpath: Errors when `.locator({ xpath })` is used without
 *     an explanatory comment on the same or preceding line.
 *   - prefer-accessible-locators: Warns when `.getByTestId()` or
 *     `.locator({ id })` is used instead of `getByRole`, `getByText`,
 *     `getByDescription`, etc.
 *   - prefer-app-reset-option: Warns when a `beforeEach` hook only restarts
 *     or clears the app — declare `test.use({ appReset, appResetScope })`
 *     instead so the reset runs as traced fixture setup.
 */

// We define our own minimal types to avoid a hard dependency on @types/eslint.

interface ASTNode {
  type: string;
  callee?: ASTNode;
  object?: ASTNode;
  property?: ASTNode;
  computed?: boolean;
  name?: string;
  arguments?: ASTNode[];
  properties?: ASTNode[];
  key?: ASTNode;
  value?: unknown;
  loc?: { start: { line: number }; end: { line: number } };
  // Function / statement shapes used by prefer-app-reset-option.
  body?: ASTNode | ASTNode[];
  expression?: ASTNode;
  argument?: ASTNode;
  params?: ASTNode[];
}

interface Comment {
  loc?: { start: { line: number }; end: { line: number } };
}

interface SourceCode {
  getCommentsBefore(node: ASTNode): Comment[];
  getAllComments(): Comment[];
}

interface RuleContext {
  report(descriptor: {
    node: ASTNode;
    messageId: string;
    data?: Record<string, string>;
  }): void;
  sourceCode?: SourceCode;
  getSourceCode(): SourceCode;
}

interface RuleModule {
  meta: {
    type: string;
    docs: { description: string; recommended: boolean };
    messages: Record<string, string>;
    schema: unknown[];
  };
  create(context: RuleContext): Record<string, (node: ASTNode) => void>;
}

// ─── Helpers ───

/** Returns true if `node` is a CallExpression of the form `<obj>.<methodName>(...)`. */
function isMethodCall(node: ASTNode, methodName: string): boolean {
  return (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.computed !== true &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === methodName
  );
}

/** Look up a property in an ObjectExpression by its (Identifier or Literal) key. */
function getObjectProperty(obj: ASTNode | undefined, key: string): ASTNode | undefined {
  if (!obj || obj.type !== 'ObjectExpression' || !obj.properties) return undefined;
  for (const prop of obj.properties) {
    if (prop.type !== 'Property') continue;
    const k = prop.key;
    if (!k) continue;
    if (k.type === 'Identifier' && k.name === key) return prop.value as ASTNode;
    if (k.type === 'Literal' && k.value === key) return prop.value as ASTNode;
  }
  return undefined;
}

function literalString(node: ASTNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return undefined;
}

// ─── Standard widgets that should use getByRole instead of locator({className}) ───

const STANDARD_WIDGET_MAP: Record<string, string> = {
  'android.widget.Button': 'button',
  'android.widget.CheckBox': 'checkbox',
  'android.widget.EditText': 'textfield',
  'android.widget.ImageButton': 'button',
  'android.widget.ImageView': 'image',
  'android.widget.ProgressBar': 'progressbar',
  'android.widget.RadioButton': 'radio',
  'android.widget.SeekBar': 'slider',
  'android.widget.Spinner': 'combobox',
  'android.widget.Switch': 'switch',
  'android.widget.TextView': 'text',
  'android.widget.ToggleButton': 'togglebutton',
};

// ─── prefer-role ───

const preferRole: RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prefer getByRole() over locator({ className }) for standard Android widgets',
      recommended: true,
    },
    messages: {
      preferRole:
        'Use getByRole("{{role}}") instead of locator({ className: "{{className}}" }). Role-based selectors are more resilient to implementation changes.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node: ASTNode) {
        if (!isMethodCall(node, 'locator')) return;
        const arg = node.arguments?.[0];
        const classNameValue = literalString(getObjectProperty(arg, 'className'));
        if (!classNameValue) return;
        const role = STANDARD_WIDGET_MAP[classNameValue];
        if (!role) return;
        context.report({
          node,
          messageId: 'preferRole',
          data: { role, className: classNameValue },
        });
      },
    };
  },
};

// ─── no-bare-locator-xpath ───

const noBareLocatorXpath: RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require an explanatory comment when using locator({ xpath }) selectors',
      recommended: true,
    },
    messages: {
      noBareLocatorXpath:
        'locator({ xpath }) must have an explanatory comment on the same or preceding line. XPath selectors are fragile and Android-only — document why this is necessary.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node: ASTNode) {
        if (!isMethodCall(node, 'locator')) return;
        const arg = node.arguments?.[0];
        if (getObjectProperty(arg, 'xpath') === undefined) return;

        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const comments = sourceCode.getCommentsBefore(node);
        if (comments.length > 0) return;

        const allComments = sourceCode.getAllComments();
        const nodeLine = node.loc?.start.line;
        const hasInlineComment = allComments.some(
          (c) => c.loc?.start.line === nodeLine || c.loc?.end.line === nodeLine,
        );
        if (hasInlineComment) return;

        context.report({ node, messageId: 'noBareLocatorXpath' });
      },
    };
  },
};

// ─── prefer-accessible-locators ───

const preferAccessibleLocators: RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prefer accessible getters (getByRole, getByText, getByDescription) over getByTestId / locator({ id })',
      recommended: true,
    },
    messages: {
      preferAccessibleTestId:
        'Prefer getByRole(), getByText(), or getByDescription() over getByTestId(). Accessible getters make tests more resilient and verify accessibility.',
      preferAccessibleId:
        'Prefer getByRole(), getByText(), or getByDescription() over locator({ id }). Accessible getters make tests more resilient and verify accessibility.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node: ASTNode) {
        if (isMethodCall(node, 'getByTestId')) {
          context.report({ node, messageId: 'preferAccessibleTestId' });
          return;
        }
        if (isMethodCall(node, 'locator')) {
          const arg = node.arguments?.[0];
          if (getObjectProperty(arg, 'id') !== undefined) {
            context.report({ node, messageId: 'preferAccessibleId' });
          }
        }
      },
    };
  },
};

// ─── prefer-app-reset-option ───

/** `beforeEach(...)` or `test.beforeEach(...)` / `<x>.beforeEach(...)`. */
function isBeforeEachCall(node: ASTNode): boolean {
  if (node.type !== 'CallExpression' || !node.callee) return false;
  const callee = node.callee;
  if (callee.type === 'Identifier') return callee.name === 'beforeEach';
  return (
    callee.type === 'MemberExpression' &&
    callee.computed !== true &&
    callee.property?.type === 'Identifier' &&
    callee.property.name === 'beforeEach'
  );
}

/** Unwrap `await expr` → `expr`. */
function unwrapAwait(node: ASTNode | undefined): ASTNode | undefined {
  return node?.type === 'AwaitExpression' ? node.argument : node;
}

/**
 * Return the hook body as a list of top-level expressions, or undefined when
 * the body contains anything other than expression statements (then it is
 * doing more than resetting and the rule stays quiet).
 */
function hookBodyExpressions(fn: ASTNode | undefined): ASTNode[] | undefined {
  if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) return undefined;
  const body = fn.body;
  if (!body) return undefined;
  if (!Array.isArray(body)) {
    // Expression-bodied arrow: `() => device.restartApp()`
    if (body.type === 'BlockStatement') {
      const stmts = (body.body as ASTNode[] | undefined) ?? [];
      const exprs: ASTNode[] = [];
      for (const stmt of stmts) {
        if (stmt.type !== 'ExpressionStatement' || !stmt.expression) return undefined;
        exprs.push(stmt.expression);
      }
      return exprs;
    }
    return [body];
  }
  return undefined;
}

const preferAppResetOption: RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prefer test.use({ appReset }) over a beforeEach hook that only restarts or clears the app',
      recommended: true,
    },
    messages: {
      preferRestart:
        "This beforeEach only restarts the app. Declare it instead: test.use({ appReset: 'restart', appResetScope: 'test' }) — the reset then runs as traced fixture setup, shows up in the UI, and can be prepared ahead of time.",
      preferClear:
        "This beforeEach only clears and relaunches the app. Declare it instead: test.use({ appReset: 'clear', appResetScope: 'test' }) — the reset then runs as traced fixture setup, shows up in the UI, and can be prepared ahead of time.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node: ASTNode) {
        if (!isBeforeEachCall(node)) return;
        const fn = node.arguments?.[node.arguments.length - 1];
        const exprs = hookBodyExpressions(fn);
        if (!exprs || exprs.length === 0) return;

        const calls = exprs.map(unwrapAwait);
        if (calls.some((c) => !c || c.type !== 'CallExpression')) return;
        const names = calls.map((c) => {
          for (const m of ['restartApp', 'clearAppData', 'launchApp'] as const) {
            if (isMethodCall(c!, m)) return m;
          }
          return undefined;
        });
        if (names.some((n) => n === undefined)) return;

        if (names.length === 1 && names[0] === 'restartApp') {
          context.report({ node, messageId: 'preferRestart' });
          return;
        }
        if (names.length === 2 && names[0] === 'clearAppData' && names[1] === 'launchApp') {
          context.report({ node, messageId: 'preferClear' });
          return;
        }
        if (names.length === 1 && names[0] === 'launchApp') {
          const opts = calls[0]!.arguments?.[1];
          const clearData = getObjectProperty(opts, 'clearData');
          if (clearData?.type === 'Literal' && clearData.value === true) {
            context.report({ node, messageId: 'preferClear' });
          }
        }
      },
    };
  },
};

// ─── Plugin export ───

const rules: Record<string, RuleModule> = {
  'prefer-role': preferRole,
  'no-bare-locator-xpath': noBareLocatorXpath,
  'prefer-accessible-locators': preferAccessibleLocators,
  'prefer-app-reset-option': preferAppResetOption,
};

const recommendedConfig = {
  plugins: ['tapsmith'] as const,
  rules: {
    'tapsmith/prefer-role': 'warn' as const,
    'tapsmith/no-bare-locator-xpath': 'error' as const,
    'tapsmith/prefer-accessible-locators': 'warn' as const,
    'tapsmith/prefer-app-reset-option': 'warn' as const,
  },
};

export { rules, recommendedConfig as configs };
export default { rules, configs: { recommended: recommendedConfig } };
