import * as console from 'console';
import * as path from 'path';
import * as process from 'process';
import * as fs from 'fs-extra';
import * as ts from 'typescript';

const LIB_ROOT = path.resolve(process.cwd(), 'lib');

async function main() {
  const libraries = await findLibrariesToPackage();
  const packageJson = await verifyDependencies(libraries);
  await prepareSourceFiles(libraries, packageJson);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('â An error occurred: ', err.stack);
    process.exit(1);
  },
);

interface LibraryReference {
  readonly packageJson: PackageJson;
  readonly root: string;
  readonly shortName: string;
}

interface PackageJson {
  readonly bundleDependencies?: readonly string[];
  readonly bundledDependencies?: readonly string[];
  readonly dependencies?: { readonly [name: string]: string };
  readonly devDependencies?: { readonly [name: string]: string };
  readonly jsii: {
    readonly targets?: {
      readonly dotnet?: {
        readonly namespace: string;
        readonly [key: string]: unknown;
      },
      readonly java?: {
        readonly package: string;
        readonly [key: string]: unknown;
      },
      readonly python?: {
        readonly module: string;
        readonly [key: string]: unknown;
      },
      readonly [language: string]: unknown,
    },
  };
  readonly name: string;
  readonly types: string;
  readonly version: string;
  readonly [key: string]: unknown;
}

async function findLibrariesToPackage(): Promise<readonly LibraryReference[]> {
  console.log('ğ Discovering libraries that need packaging...');

  const result = new Array<LibraryReference>();

  const librariesRoot = path.resolve(process.cwd(), '..', '..', 'packages', '@aws-cdk');
  for (const dir of await fs.readdir(librariesRoot)) {
    const packageJson = await fs.readJson(path.resolve(librariesRoot, dir, 'package.json'));

    if (packageJson.private) {
      console.log(`\tâ ï¸ Skipping (private):          ${packageJson.name}`);
      continue;
    } else if (packageJson.deprecated) {
      console.log(`\tâ ï¸ Skipping (deprecated):       ${packageJson.name}`);
      continue;
    } else if (packageJson.jsii == null ) {
      console.log(`\tâ ï¸ Skipping (not jsii-enabled): ${packageJson.name}`);
      continue;
    }

    result.push({
      packageJson,
      root: path.join(librariesRoot, dir),
      shortName: packageJson.name.substr('@aws-cdk/'.length),
    });
  }

  console.log(`\tâ¹ï¸ Found ${result.length} relevant packages!`);

  return result;
}

async function verifyDependencies(libraries: readonly LibraryReference[]): Promise<PackageJson> {
  console.log('ğ§ Verifying dependencies are complete...');
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');
  const packageJson = await fs.readJson(packageJsonPath);

  let changed = false;
  const toBundle: Record<string, string> = {};

  for (const library of libraries) {
    for (const depName of library.packageJson.bundleDependencies ?? library.packageJson.bundledDependencies ?? []) {
      const requiredVersion = library.packageJson.devDependencies?.[depName]
        ?? library.packageJson.dependencies?.[depName]
        ?? '*';
      if (toBundle[depName] != null && toBundle[depName] !== requiredVersion) {
        throw new Error(`Required to bundle different versions of ${depName}: ${toBundle[depName]} and ${requiredVersion}.`);
      }
      toBundle[depName] = requiredVersion;
    }

    if (library.packageJson.name in packageJson.devDependencies) {
      const existingVersion = packageJson.devDependencies[library.packageJson.name];
      if (existingVersion !== library.packageJson.version) {
        console.log(`\tâ ï¸ Incorrect dependency: ${library.packageJson.name} (expected ${library.packageJson.version}, found ${packageJson.devDependencies[library.packageJson.name]})`);
        packageJson.devDependencies[library.packageJson.name] = library.packageJson.version;
        changed = true;
      }
      continue;
    }
    console.log(`\tâ ï¸ Missing dependency: ${library.packageJson.name}`);
    changed = true;
    packageJson.devDependencies = sortObject({
      ...packageJson.devDependencies ?? {},
      [library.packageJson.name]: library.packageJson.version,
    });
  }

  const workspacePath = path.resolve(process.cwd(), '..', '..', 'package.json');
  const workspace = await fs.readJson(workspacePath);
  let workspaceChanged = false;

  const spuriousBundledDeps = new Set<string>(packageJson.bundledDependencies ?? []);
  for (const [name, version] of Object.entries(toBundle)) {
    spuriousBundledDeps.delete(name);

    const nohoist = `${packageJson.name}/${name}`;
    if (!workspace.workspaces.nohoist?.includes(nohoist)) {
      console.log(`\tâ ï¸ Missing yarn workspace nohoist: ${nohoist}`);
      workspace.workspaces.nohoist = Array.from(new Set([
        ...workspace.workspaces.nohoist ?? [],
        nohoist,
        `${nohoist}/**`,
      ])).sort();
      workspaceChanged = true;
    }

    if (!(packageJson.bundledDependencies?.includes(name))) {
      console.log(`\tâ ï¸ Missing bundled dependency: ${name} at ${version}`);
      packageJson.bundledDependencies = [
        ...packageJson.bundledDependencies ?? [],
        name,
      ].sort();
      changed = true;
    }

    if (packageJson.dependencies?.[name] !== version) {
      console.log(`\tâ ï¸ Missing or incorrect dependency: ${name} at ${version}`);
      packageJson.dependencies = sortObject({
        ...packageJson.dependencies ?? {},
        [name]: version,
      });
      changed = true;
    }
  }
  packageJson.bundledDependencies = packageJson.bundledDependencies?.filter((dep: string) => !spuriousBundledDeps.has(dep));
  for (const toRemove of Array.from(spuriousBundledDeps)) {
    delete packageJson.dependencies[toRemove];
    changed = true;
  }

  if (workspaceChanged) {
    await fs.writeFile(workspacePath, JSON.stringify(workspace, null, 2) + '\n', { encoding: 'utf-8' });
    console.log('\tâ Updated the yarn workspace configuration. Re-run "yarn install", and commit the changes.');
  }

  if (changed) {
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', { encoding: 'utf8' });

    throw new Error('Fixed dependency inconsistencies. Commit the updated package.json file.');
  }
  console.log('\tâ Dependencies are correct!');
  return packageJson;
}

async function prepareSourceFiles(libraries: readonly LibraryReference[], packageJson: PackageJson) {
  console.log('ğ Preparing source files...');

  await fs.remove(LIB_ROOT);

  const indexStatements = new Array<string>();
  for (const library of libraries) {
    const libDir = path.join(LIB_ROOT, library.shortName);
    await transformPackage(library, packageJson.jsii.targets, libDir, libraries);

    if (library.shortName === 'core') {
      indexStatements.push(`export * from './${library.shortName}';`);
    } else {
      indexStatements.push(`export * as ${library.shortName.replace(/-/g, '_')} from './${library.shortName}';`);
    }
  }

  await fs.writeFile(path.join(LIB_ROOT, 'index.ts'), indexStatements.join('\n'), { encoding: 'utf8' });

  console.log('\tğº Success!');
}

async function transformPackage(
  library: LibraryReference,
  config: PackageJson['jsii']['targets'],
  destination: string,
  allLibraries: readonly LibraryReference[],
) {
  await fs.mkdirp(destination);

  await copyOrTransformFiles(library.root, destination, allLibraries);

  await fs.writeFile(
    path.join(destination, 'index.ts'),
    `export * from './${library.packageJson.types.replace(/(\/index)?(\.d)?\.ts$/, '')}';\n`,
    { encoding: 'utf8' },
  );

  if (library.shortName !== 'core') {
    await fs.writeJson(
      path.join(destination, '.jsiirc.json'),
      {
        targets: transformTargets(config, library.packageJson.jsii.targets),
      },
      { spaces: 2 },
    );

    await fs.writeFile(
      path.resolve(LIB_ROOT, '..', `${library.shortName}.ts`),
      `export * from './lib/${library.shortName}';\n`,
      { encoding: 'utf8' },
    );
  }
}

function transformTargets(monoConfig: PackageJson['jsii']['targets'], targets: PackageJson['jsii']['targets']): PackageJson['jsii']['targets'] {
  if (targets == null) { return targets; }

  const result: Record<string, any> = {};
  for (const [language, config] of Object.entries(targets)) {
    switch (language) {
      case 'dotnet':
        if (monoConfig?.dotnet != null) {
          result[language] = {
            namespace: (config as any).namespace,
          };
        }
        break;
      case 'java':
        if (monoConfig?.java != null) {
          result[language] = {
            package: (config as any).package,
          };
        }
        break;
      case 'python':
        if (monoConfig?.python != null) {
          result[language] = {
            module: `${monoConfig.python.module}.${(config as any).module.replace(/^aws_cdk\./, '')}`,
          };
        }
        break;
      default:
        throw new Error(`Unsupported language for submodule configuration translation: ${language}`);
    }
  }

  return result;
}

async function copyOrTransformFiles(from: string, to: string, libraries: readonly LibraryReference[]) {
  const promises = (await fs.readdir(from)).map(async name => {
    if (shouldIgnoreFile(name)) { return; }

    if (name.endsWith('.d.ts') || name.endsWith('.js')) {
      if (await fs.pathExists(path.join(from, name.replace(/\.(d\.ts|js)$/, '.ts')))) {
        // We won't copy .d.ts and .js files with a corresponding .ts file
        return;
      }
    }

    const source = path.join(from, name);
    const destination = path.join(to, name);

    const stat = await fs.stat(source);
    if (stat.isDirectory()) {
      await fs.mkdirp(destination);
      return copyOrTransformFiles(source, destination, libraries);
    }
    if (name.endsWith('.ts')) {
      return fs.writeFile(
        destination,
        await rewriteImports(source, to, libraries),
        { encoding: 'utf8' },
      );
    } else {
      return fs.copyFile(source, destination);
    }
  });

  await Promise.all(promises);
}

async function rewriteImports(fromFile: string, targetDir: string, libraries: readonly LibraryReference[]): Promise<string> {
  const sourceFile = ts.createSourceFile(
    fromFile,
    await fs.readFile(fromFile, { encoding: 'utf8' }),
    ts.ScriptTarget.ES2018,
    true,
    ts.ScriptKind.TS,
  );

  const transformResult = ts.transform(sourceFile, [importRewriter]);
  const transformedSource = transformResult.transformed[0] as ts.SourceFile;

  const printer = ts.createPrinter();
  return printer.printFile(transformedSource);

  function importRewriter(ctx: ts.TransformationContext) {
    function visitor(node: ts.Node): ts.Node {
      if (ts.isExternalModuleReference(node) && ts.isStringLiteral(node.expression)) {
        const newTarget = rewrittenImport(node.expression.text);
        if (newTarget != null) {
          return addRewrittenNote(
            ts.updateExternalModuleReference(node, newTarget),
            node.expression,
          );
        }
      } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const newTarget = rewrittenImport(node.moduleSpecifier.text);
        if (newTarget != null) {
          return addRewrittenNote(
            ts.updateImportDeclaration(
              node,
              node.decorators,
              node.modifiers,
              node.importClause,
              newTarget,
            ),
            node.moduleSpecifier,
          );
        }
      }
      return ts.visitEachChild(node, visitor, ctx);
    }
    return visitor;
  }

  function addRewrittenNote(node: ts.Node, original: ts.StringLiteral): ts.Node {
    return ts.addSyntheticTrailingComment(
      node,
      ts.SyntaxKind.SingleLineCommentTrivia,
      ` Automatically re-written from ${original.getText()}`,
      false, // hasTrailingNewline
    );
  }

  function rewrittenImport(moduleSpecifier: string): ts.StringLiteral | undefined {
    const sourceLibrary = libraries.find(
      lib =>
        moduleSpecifier === lib.packageJson.name ||
        moduleSpecifier.startsWith(`${lib.packageJson.name}/`),
    );
    if (sourceLibrary == null) { return undefined; }

    const importedFile = moduleSpecifier === sourceLibrary.packageJson.name
      ? path.join(LIB_ROOT, sourceLibrary.shortName)
      : path.join(LIB_ROOT, sourceLibrary.shortName, moduleSpecifier.substr(sourceLibrary.packageJson.name.length + 1));
    return ts.createStringLiteral(
      path.relative(targetDir, importedFile),
    );
  }
}

const IGNORED_FILE_NAMES = new Set([
  '.eslintrc.js',
  '.gitignore',
  '.jest.config.js',
  '.jsii',
  '.npmignore',
  'node_modules',
  'package.json',
  'test',
  'tsconfig.json',
  'tsconfig.tsbuildinfo',
  'LICENSE',
  'NOTICE',
]);
function shouldIgnoreFile(name: string): boolean {
  return IGNORED_FILE_NAMES.has(name);
}

function sortObject<T>(obj: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};

  for (const [key, value] of Object.entries(obj).sort((l, r) => l[0].localeCompare(r[0]))) {
    result[key] = value;
  }

  return result;
}
