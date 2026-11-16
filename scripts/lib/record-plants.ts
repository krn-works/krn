// One planted violation per enforced standards record: the plainest edit of a freshly initialised
// project that makes the record's own enforcement fail. `standards-audit.ts --planted` and the test
// run every applicable record through it; an enforced record that has no entry here fails the matrix.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Stack = 'ts' | 'python' | 'go' | 'php' | 'wp-plugin' | 'rust';

/** What a plant does to the project: files to write (null deletes), paths to untrack, a commit to make. */
export type Edit = {
  write?: Record<string, string | null>;
  untrack?: string[];
  commit?: string;
};

export type PlantContext = {
  dir: string;
  stack: Stack;
  /** The tracked files of the project before the plant. */
  files: string[];
};

export type Plant = (context: PlantContext) => Edit;

function json(context: PlantContext, file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(context.dir, file), 'utf8')) as Record<
    string,
    unknown
  >;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|_test\.go$|(^|\/)test_[^/]*\.py$|\.(test|spec)\.[cm]?[jt]sx?$/;

function without(files: string[], pattern: RegExp): Record<string, null> {
  return Object.fromEntries(
    files.filter((f) => pattern.test(f)).map((f) => [f, null]),
  );
}

/**
 * The tool a record's own enforcement needs to run at all: without it the record passes vacuously, so
 * its plant cannot bite and the matrix reports it as skipped instead of green.
 */
export const REQUIRES_TOOL: Record<string, string> = {
  's-go-gofmt': "printf 'package p\\n' | gofmt -l",
  's-rust-fmt-check': 'cargo fmt --version',
  // The contract gates run the stack's toolchain; a version-less mise shim exits 1, not 127.
  's-gate-typecheck-runs:go': 'go version',
  's-gate-typecheck-runs:rust': 'cargo --version',
};

/** The probe of a record in one stack: a stack-specific entry wins over the record-wide one. */
export function toolProbe(id: string, stack: Stack): string | undefined {
  return REQUIRES_TOOL[`${id}:${stack}`] ?? REQUIRES_TOOL[id];
}

/** The plant of every enforced record of the pack, by record id. */
export const PLANTS: Record<string, Plant> = {
  's-tests-tracked': (c) => ({ write: without(c.files, TEST_FILE) }),
  's-test-command': (c) => {
    if (c.stack === 'ts')
      return {
        write: {
          'package.json': jsonText({
            ...json(c, 'package.json'),
            scripts: { test: 'echo "Error: no test specified" && exit 1' },
          }),
        },
      };
    if (c.stack === 'php' || c.stack === 'wp-plugin') {
      const composer = json(c, 'composer.json');
      return {
        write: {
          'phpunit.xml': null,
          'composer.json': jsonText({ ...composer, scripts: {} }),
        },
      };
    }
    return { write: without(c.files, TEST_FILE) };
  },
  's-test-exit-code': () => ({
    write: { Makefile: 'test:\n\ttrue || true\n' },
  }),
  's-gate-in-ci': () => ({
    write: {
      '.github/workflows/ci.yml':
        'name: ci\non: [pull_request]\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hello\n',
    },
  }),
  's-lockfile-committed': (c) => ({
    untrack: [c.stack === 'go' ? 'go.mod' : 'package-lock.json'],
  }),
  's-no-secrets-tracked': () => ({ write: { '.env': 'TOKEN=1\n' } }),
  's-no-dependency-dirs-tracked': () => ({
    write: { 'node_modules/left-pad/index.js': 'module.exports = 1;\n' },
  }),
  's-gitignore-deps': () => ({ write: { '.gitignore': '.krn/\n' } }),
  's-gate-lint-runs': (c) => ({
    write: { 'krn.json': jsonText({ ...json(c, 'krn.json'), lint: 'false' }) },
  }),
  's-gate-typecheck-runs': (c) => ({
    write: {
      'krn.json': jsonText({ ...json(c, 'krn.json'), typecheck: 'false' }),
    },
  }),
  's-readme-test-command': () => ({
    write: { 'README.md': '# project\n\nNothing to see here.\n' },
  }),
  's-no-conflict-markers': () => ({
    write: { 'notes.txt': '<<<<<<< HEAD\nours\n>>>>>>> theirs\n' },
  }),
  's-one-instruction-file': () => ({
    write: { 'GEMINI.md': 'Rules of the project, written for one tool.\n' },
  }),
  's-clean-checkout-tests': () => ({
    write: {
      'package.json': '{ "scripts": { "test": "node --test" } }\n',
      'test/built.test.js': 'import built from "../dist/index.js";\n',
    },
  }),
  's-role-names': () => ({ write: { 'phase1.py': 'VALUE = 1\n' } }),
  's-exit-codes': () => ({
    write: {
      'swallow.py': 'try:\n    pass\nexcept Exception: sys.exit(0)\n',
    },
  }),
  's-secrets-redacted': () => ({ write: { 'leak.py': 'print(password)\n' } }),
  's-no-shared-stash': () => ({ write: { 'save.sh': 'git stash push\n' } }),
  's-task-records': () => ({
    write: { 'tasks/t-broken0.json': '{ "id": "t-broken0"\n' },
  }),
  's-repo-contract': () => ({ write: { 'krn.json': '{ not json\n' } }),
  's-agent-state': () => ({ write: { '.gitignore': 'vendor/\n' } }),
  's-finish-gate': () => ({ write: { '.claude/settings.json': '{}\n' } }),
  's-ticket-trailer': () => ({
    write: { 'notes.txt': 'x\n' },
    commit: 'feat: a change\n\nTicket: t-0000000',
  }),
  's-regression-lowest-layer': () => ({
    write: { 'notes.txt': 'fixed\n' },
    commit: 'fix: a defect without its regression test',
  }),
  's-semantic-commits': () => ({
    write: { 'notes.txt': 'x\n' },
    commit: 'did some stuff',
  }),
  's-noninteractive-remote-commands': () => ({
    write: { 'deploy.sh': 'ssh host ls\n' },
  }),
  's-no-whitespace-errors': () => ({
    write: { 'spaces.txt': 'trailing   \n' },
  }),
  's-no-private-key-tracked': () => ({
    write: { 'key.txt': '-----BEGIN RSA PRIVATE KEY-----\n' },
  }),
  's-no-wildcard-dependencies': (c) =>
    c.stack === 'php' || c.stack === 'wp-plugin'
      ? {
          write: {
            'composer.json': jsonText({
              ...json(c, 'composer.json'),
              require: { 'vendor/pkg': '*' },
            }),
          },
        }
      : {
          write: {
            'package.json': jsonText({
              ...json(c, 'package.json'),
              dependencies: { 'left-pad': '*' },
            }),
          },
        },
  's-release-notes': (c) =>
    c.stack === 'python'
      ? {
          write: {
            'pyproject.toml': `${readFileSync(join(c.dir, 'pyproject.toml'), 'utf8')}\nversion = "1.0.0"\n`,
          },
        }
      : {
          write: {
            'package.json': jsonText({
              ...json(c, 'package.json'),
              private: false,
              version: '1.0.0',
            }),
          },
        },
  's-ts-no-any': () => ({
    write: { 'src/any.ts': 'export const x: any = 1;\n' },
  }),
  's-ts-no-suppressions': () => ({
    write: { 'src/skip.ts': '// @ts-ignore\nexport const x = 1;\n' },
  }),
  's-ts-no-star-reexport': () => ({
    write: { 'src/index.ts': "export * from './any.ts';\n" },
  }),
  's-no-deep-relative-imports': () => ({
    write: { 'src/deep.ts': "import x from '../../../../a.js';\n" },
  }),
  's-node-no-empty-catch': () => ({
    write: { 'src/quiet.js': 'try { run(); } catch (error) {}\n' },
  }),
  's-ts-no-floating-promises': () => ({ write: { 'biome.json': '{}\n' } }),
  's-node-no-dynamic-code': () => ({
    write: { 'src/dynamic.js': 'eval("1");\n' },
  }),
  's-py-no-bare-except': () => ({
    write: { 'bare.py': 'try:\n    pass\nexcept:\n    pass\n' },
  }),
  's-py-no-mutable-default': () => ({
    write: { 'default.py': 'def f(a=[]):\n    return a\n' },
  }),
  's-py-no-unsafe-execution': () => ({ write: { 'unsafe.py': 'eval("1")\n' } }),
  's-py-pinned-dependencies': () => ({
    write: { 'requirements.txt': 'requests\n' },
  }),
  's-py-typecheck-configured': () => ({
    write: { 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' },
  }),
  's-py-linter-configured': () => ({
    write: { 'pyproject.toml': '[tool.mypy]\nstrict = true\n' },
  }),
  's-py-src-layout': () => ({ write: { 'package/__init__.py': '' } }),
  's-php-composer-lock': () => ({ write: { 'composer.lock': null } }),
  's-php-composer-scripts': (c) => ({
    write: {
      'composer.json': jsonText({
        ...json(c, 'composer.json'),
        scripts: { test: 'vendor/bin/phpunit' },
      }),
    },
  }),
  's-php-no-raw-request-output': () => ({
    write: { 'src/page.php': "<?php echo $_GET['name'];\n" },
  }),
  's-php-no-tracked-salts': () => ({
    write: {
      'config.php':
        "<?php define( 'AUTH_KEY', 'abcdefghijklmnopqrstuvwxyz' );\n",
    },
  }),
  's-php-no-error-suppression': () => ({
    write: { 'src/quiet.php': "<?php $text = @file_get_contents('a');\n" },
  }),
  's-php-no-empty-catch': () => ({
    write: {
      'src/swallow.php': '<?php try { run(); } catch (Exception $e) {}\n',
    },
  }),
  's-skill-acf-component': () => ({
    write: { 'acf-json/group.json': '{}\n' },
  }),
  's-skill-cube-css': () => ({
    write: { 'themes/site/style.css': 'a { color: red !important; }\n' },
  }),
  's-skill-plesk-deploy': () => ({
    write: { 'deploy/push.sh': 'ssh -o StrictHostKeyChecking=no host\n' },
  }),
  's-skill-wp-runtime': () => ({ write: { 'auth.json': '{}\n' } }),
  's-php-no-eval': () => ({
    write: { 'src/dynamic.php': '<?php eval($code);\n' },
  }),
  's-php-autoload-declared': (c) => {
    const { autoload: _dropped, ...composer } = json(c, 'composer.json');
    return {
      write: {
        'composer.json': jsonText(composer),
        'src/Thing.php': '<?php class Thing {}\n',
      },
    };
  },
  's-php-composer-no-wildcard': (c) => ({
    write: {
      'composer.json': jsonText({
        ...json(c, 'composer.json'),
        'require-dev': { 'vendor/pkg': 'dev-main' },
      }),
    },
  }),
  's-wp-escape-translations': () => ({
    write: { 'src/text.php': "<?php _e( 'Hello', 'wp-plugin' );\n" },
  }),
  's-wp-nonce-on-request': () => ({
    write: { 'src/form.php': "<?php $name = $_POST['name'];\n" },
  }),
  's-wp-prepared-queries': () => ({
    write: {
      'src/query.php':
        '<?php $wpdb->query( "SELECT * FROM {$wpdb->posts} WHERE ID = $id" );\n',
    },
  }),
  's-wp-rest-permission-callback': () => ({
    write: {
      'src/rest.php':
        "<?php register_rest_route( 'p/v1', '/x', array( 'callback' => 'f' ) );\n",
    },
  }),
  's-wp-capability-with-nonce': () => ({
    write: {
      'src/admin.php':
        "<?php check_admin_referer( 'save' ); delete_option( 'a' );\n",
    },
  }),
  's-wp-sanitize-before-store': () => ({
    write: {
      'src/store.php':
        "<?php check_admin_referer( 'save' ); if ( current_user_can( 'manage_options' ) ) { update_option( 'a', $_POST['a'] ); }\n",
    },
  }),
  's-wp-text-domain-literal': () => ({
    write: { 'src/domain.php': "<?php __( 'Hello', $domain );\n" },
  }),
  's-wp-release-version-matches-readme': () => ({
    write: { 'readme.txt': '=== wp-plugin ===\nStable tag: 9.9.9\n' },
  }),
  's-go-gofmt': () => ({
    write: { 'unformatted.go': 'package p\nfunc  f( ){}\n' },
  }),
  's-go-vet-run': () => ({
    write: {
      '.golangci.yml': null,
      '.github/workflows/ci.yml':
        'name: ci\non: [pull_request]\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: go test ./...\n',
    },
  }),
  's-go-sum-committed': () => ({
    write: {
      'go.mod':
        'module example.com/go\n\ngo 1.22\n\nrequire github.com/pkg/errors v0.9.1\n',
    },
  }),
  's-go-wrapped-errors': () => ({
    write: {
      'wrap.go':
        'package p\n\nimport "fmt"\n\nfunc W(err error) error { return fmt.Errorf("bad: %v", err) }\n',
    },
  }),
  's-go-no-library-panic': () => ({
    write: { 'lib/panic.go': 'package lib\n\nfunc F() {\n\tpanic("x")\n}\n' },
  }),
  's-go-tests-beside-code': () => ({
    write: { 'lib/code.go': 'package lib\n\nfunc F() {}\n' },
  }),
  's-go-context-first': () => ({
    write: {
      'ctx.go':
        'package p\n\nimport "context"\n\nfunc F(a int, ctx context.Context) {}\n',
    },
  }),
  's-go-pinned-toolchain': () => ({
    write: { 'go.mod': 'module example.com/go\n' },
  }),
  's-rust-lock-committed': () => ({ untrack: ['Cargo.lock'] }),
  's-rust-fmt-check': () => ({
    write: { 'src/lib.rs': 'pub fn  f( )->i32{1}\n' },
  }),
  's-rust-clippy-deny-warnings': () => ({
    write: {
      '.github/workflows/ci.yml':
        'name: ci\non: [pull_request]\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cargo clippy && cargo test\n',
    },
  }),
  's-rust-no-library-unwrap': () => ({
    write: {
      'src/risky.rs':
        'pub fn parse() -> i32 {\n    "1".parse::<i32>().unwrap()\n}\n',
    },
  }),
  's-rust-pinned-toolchain': () => ({
    write: {
      'Cargo.toml':
        '[package]\nname = "rust"\nversion = "0.1.0"\nedition = "2021"\n',
    },
  }),
  's-rust-tests-present': (c) => ({ write: without(c.files, TEST_FILE) }),
};
