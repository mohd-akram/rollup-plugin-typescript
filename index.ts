import * as fs from 'fs/promises';
import * as path from 'path';

import { glob } from 'glob';
import { Plugin, PluginContext } from 'rollup';
import * as ts from 'typescript';

import { getCodeFrame } from './utils';

const configFilename = 'tsconfig.json';
const extensions = ['.ts', '.tsx'];

const compilerOptions: ts.CompilerOptions = Object.freeze({
  importHelpers: true,
  sourceMap: true,
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.NodeJs
});

async function getCompilerOptions(options?: PluginOptions) {
  let parsed = {
    options: {} as ts.CompilerOptions, errors: [] as ts.Diagnostic[]
  };

  if (options && options.compilerOptions) {
    parsed = ts.convertCompilerOptionsFromJson(options.compilerOptions, '');
  } else {
    let text: string | undefined;
    try {
      text = await fs.readFile(configFilename, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code != 'ENOENT')
        throw [{
          messageText: (e as NodeJS.ErrnoException).message,
          category: ts.DiagnosticCategory.Error
        } as ts.Diagnostic];
    }
    if (text) {
      const result = ts.parseConfigFileTextToJson(configFilename, text);
      if (result.error)
        throw [result.error];
      parsed = ts.parseJsonConfigFileContent(result.config, ts.sys, '');
    }
  }

  if (parsed.errors.length)
    throw parsed.errors;

  return Object.assign(parsed.options, compilerOptions);
}

function printDiagnostics(
  diagnostics: readonly ts.Diagnostic[], context?: PluginContext
) {
  for (const diagnostic of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText, ts.sys.newLine
    );

    const file = diagnostic.file;
    const id = file ? file.fileName : null;
    const lc = file && diagnostic.start ?
      file.getLineAndCharacterOfPosition(diagnostic.start) : null;
    const loc = id && lc ? {
      file: id, line: lc.line + 1, column: lc.character
    } : undefined;

    if (context) {
      if (diagnostic.category == ts.DiagnosticCategory.Error)
        context.error({ message }, loc);
      else if (diagnostic.category == ts.DiagnosticCategory.Warning)
        context.warn({ message }, loc);
    } else {
      const frame = file && loc ?
        getCodeFrame(file.text, loc.line, loc.column) : null;
      throw { message, id, loc, frame };
    }
  }
}

function isTsFile(filename: string) {
  return extensions.includes(path.extname(filename));
}

async function resolve(importee: string, importer: string) {
  for (const ext of extensions) {
    const filename = `${importee}${ext}`;
    const id = path.resolve(path.dirname(importer), filename);
    try {
      await fs.access(id);
      return id;
    } catch (e) { }
  }
  return;
}

interface PluginOptions {
  compilerOptions: ts.CompilerOptions;
}

function typescript(options?: PluginOptions) {
  let input: string[] = [];
  let compilerOptions: ts.CompilerOptions;
  let program: ts.Program;

  const plugin: Plugin = {
    name: 'typescript',

    options(inputOptions) {
      if (!inputOptions.input) return;
      input = Array.isArray(inputOptions.input) ? inputOptions.input :
        typeof inputOptions.input == 'string' ? [inputOptions.input] :
          Object.values(inputOptions.input);
      return null;
    },

    async resolveId(importee, importer) {
      if (path.extname(importee) || !importer || !isTsFile(importer))
        return;

      return (
        await resolve(importee, importer) ||
        await resolve(path.join(importee, 'index'), importer)
      );
    },

    async transform(source, id) {
      if (!isTsFile(id))
        return;

      if (!compilerOptions) {
        try {
          compilerOptions = await getCompilerOptions(options);
        } catch (diagnostics) {
          printDiagnostics(diagnostics as ts.Diagnostic[]);
        }
      }

      if (!program) {
        const files = await glob(
          '**/*.d.ts', { ignore: 'node_modules/**' }
        );
        files.push(...input);
        program = ts.createProgram(files, compilerOptions);
      }

      const sourceFile = program.getSourceFile(id as string);
      if (sourceFile)
        printDiagnostics(ts.getPreEmitDiagnostics(program, sourceFile), this);

      const output = ts.transpileModule(source, { compilerOptions });

      return {
        code: output.outputText,
        map: output.sourceMapText ? JSON.parse(output.sourceMapText) : null
      };
    }
  };

  return plugin;
}

export = typescript;
